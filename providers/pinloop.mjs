// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Pinloop provider — wraps the `pinloop` CLI (a free-tier job-search account
// the user already has; credentials live in ~/.pinloop and this file never
// reads, prints, or copies them). Unlike every other provider here, this one
// is NOT an HTTP fetcher: Pinloop has no public API, only a CLI a person logs
// into once with `pinloop login`. So — same shape as `providers/local-parser.mjs`
// and `providers/stepstone.mjs` — it shells out (`execFile`, no shell) instead
// of using `ctx.fetchJson`/`ctx.fetchText`.
//
// Wire in via a `job_boards:` entry with `provider: pinloop`:
//
//   - name: Pinloop — career sites, Werkstudent data/AI (Germany)
//     provider: pinloop
//     enabled: true
//     pinloop:
//       from: "career sites"        # or "job boards"; default "career sites"
//       country: Germany            # default Germany
//       title_query: "(werkstudent OR praktikum) AND (data OR AI)"  # required
//       words: "Erlangen"           # optional extra terms, see note below
//       lookback_days: 2            # default 2 -> --posted-after
//       daily_pull_budget: 5        # default 5 (the free plan's daily cap)
//
// ── The free plan's budget, and why this file has to track it itself ───────
// `pinloop pull` hands over at most `daily_pull_budget` (free plan: 5) NEW
// postings per UTC day, board-wide across every entry sharing this account —
// not per portals.yml entry. Pinloop's server is the actual enforcer (a pull
// past the cap comes back as a `refused` field — see below — or a non-zero
// exit), but a scan that always asks anyway would burn a request on a refusal
// every single run once the day's budget is gone, and `verify-portals`/
// `audit-portals` run this same fetch() outside a real scan too. So
// `data/pinloop-state.json` remembers how much of today's (UTC) budget this
// machine has already used and short-circuits before touching the network at
// all once it's gone — no request, no refusal, no retry loop.
//
// ── `words`, and why it never reaches the CLI ───────────────────────────────
// `pinloop pull`'s `--in <part>` flag scopes its ENTIRE `[words...]` argument
// to one part of a posting (currently only "title" is documented) — there is
// no way to ask for some words in the title and others anywhere else in one
// call. `title_query` is the boolean title expression this provider sends
// with `--in title`; an optional `words` value (e.g. a city) is therefore
// applied client-side instead, as a plain case-insensitive substring check
// against the text `pull`'s list rows already carry (title + company +
// location) — `pull` doesn't return `description_text` at all (only
// `pinloop fetch <id>` does, per-posting, and this provider never calls it),
// so "description words" can only mean the visible fields it does return.
// This costs no extra request and no extra quota.
//
// ── LinkedIn / XING rows ─────────────────────────────────────────────────
// Pinloop's `job_boards` place can include aggregator listings whose `url`
// resolves to linkedin.com or xing.com. Both are robots.txt-Disallowed for
// this project (see the "KNOWN GAPS" block at the bottom of portals.yml) —
// the user can open them by hand, but nothing here ever fetches them, and a
// posting URL this pipeline can't itself verify or archive is worse than no
// posting at all. Dropped unless `pinloop.allow_job_board_urls: true`.

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'fs';
import { join, dirname } from 'path';

import { intInRange } from './_config-utils.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { classifyReach } from '../triage-prefilter.mjs';

const execFileAsync = promisify(execFile);

// POSIX: the installed `pinloop` shebang script runs directly under
// execFile/shell:false, same as any other CLI.
//
// Windows is NOT the same story. npm installs a global bin as a `.cmd` shim
// (plus a `.ps1` one PowerShell blocks — see the file header), and Node 24
// refuses to spawn a `.cmd` at all under `shell:false`: `execFile('pinloop.cmd',
// [...], {shell:false})` throws `spawn EINVAL` SYNCHRONOUSLY, before any
// Promise is even created (reproduced on this machine). Switching to
// `shell:true` would reopen the exact argument-injection hole `local-parser.mjs`
// and every HTTP provider's `redirect:'error'` guard exist to close — a
// `title_query`/`words` value from portals.yml would flow into a real shell.
//
// The fix is to skip the shim entirely: resolve the CLI's own JS entry point
// (`<npm global root>/pinloop/dist/cli/pinloop.js`) and run it directly with
// this same Node binary — `execFile(process.execPath, [entry, ...args])` is a
// plain, shell-free argv exec, identical in shape to how `local-parser.mjs`
// invokes an in-repo script through `node`.
const PINLOOP_POSIX_BIN = 'pinloop';

const ALLOWED_FROM = new Set(['career sites', 'job boards']);
const DEFAULT_FROM = 'career sites';
const DEFAULT_COUNTRY = 'Germany';
const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_DAILY_PULL_BUDGET = 5;
// A generous ceiling for a future paid-plan override — never a promise that
// Pinloop's own server allows this many; it still enforces its own limit.
const MAX_DAILY_PULL_BUDGET = 200;

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 5_000_000;

const STATE_FILENAME = 'pinloop-state.json';
const LEADS_FILENAME = 'pinloop-leads.json';
// ~2 years of headroom at the free plan's 5/day, so a machine that runs this
// for a long time never silently loses old leads to the cap mid-search.
const MAX_LEADS = 4_000;

const LINKEDIN_XING_RE = /(^|\.)(?:linkedin|xing)\.com$/i;

// ── pure helpers (exported for direct unit testing) ────────────────────────

/**
 * Reads and sanitizes the entry's `pinloop:` config block.
 * @param {{ pinloop?: any, name?: string }} entry
 */
export function parsePinloopConfig(entry) {
  const cfg = (entry && entry.pinloop) || {};
  const titleQuery = typeof cfg.title_query === 'string' ? cfg.title_query.trim() : '';
  const from = typeof cfg.from === 'string' && cfg.from.trim() ? cfg.from.trim() : DEFAULT_FROM;
  const country = typeof cfg.country === 'string' && cfg.country.trim() ? cfg.country.trim() : DEFAULT_COUNTRY;
  const words = Array.isArray(cfg.words)
    ? cfg.words.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : (typeof cfg.words === 'string' && cfg.words.trim() ? [cfg.words.trim()] : []);
  const lookbackDays = intInRange(cfg.lookback_days, DEFAULT_LOOKBACK_DAYS, 1, 3650);
  const dailyPullBudget = intInRange(cfg.daily_pull_budget, DEFAULT_DAILY_PULL_BUDGET, 0, MAX_DAILY_PULL_BUDGET);
  const allowJobBoardUrls = cfg.allow_job_board_urls === true;
  return {
    titleQuery, from, country, words, lookbackDays, dailyPullBudget, allowJobBoardUrls,
  };
}

/**
 * `--posted-after` value for a given lookback window, anchored to UTC so a
 * scan run near midnight doesn't drift a day depending on the local zone.
 * @param {number} lookbackDays
 * @param {number} [nowMs]
 */
export function computePostedAfter(lookbackDays, nowMs = Date.now()) {
  return new Date(nowMs - lookbackDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Today's UTC calendar day as `YYYY-MM-DD` — the unit the free plan's budget
 * resets on, independent of the machine's local timezone.
 * @param {number} [nowMs]
 */
export function todayUtc(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The exact `pinloop pull` argv this provider sends, built once budget has
 * already confirmed `remaining > 0`. `--limit` is capped to what's left of
 * today's budget so a run never asks the server for more than it could use.
 * @param {ReturnType<typeof parsePinloopConfig>} cfg
 * @param {number} remaining
 * @param {number} [nowMs]
 */
export function buildPullArgs(cfg, remaining, nowMs = Date.now()) {
  return [
    'pull',
    cfg.titleQuery,
    '--in', 'title',
    '--from', cfg.from,
    '--country', cfg.country,
    '--posted-after', computePostedAfter(cfg.lookbackDays, nowMs),
    '--limit', String(Math.max(1, remaining)),
    '--json',
  ];
}

/**
 * Joins Pinloop's `locations[]` into the single display string the Job
 * contract expects (mirrors `providers/arbeitsagentur.mjs`'s buildLocation).
 * @param {unknown} locations
 */
export function joinLocations(locations) {
  if (Array.isArray(locations)) {
    return locations.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim()).join(', ');
  }
  if (typeof locations === 'string') return locations.trim();
  return '';
}

/**
 * True when a URL's host is linkedin.com/xing.com (or a subdomain) — see the
 * file-header note on why those rows are dropped by default.
 * @param {string} url
 */
export function isJobBoardUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  return LINKEDIN_XING_RE.test(parsed.hostname);
}

/**
 * A date *string or number* through `Date.parse`/passthrough can yield `NaN`;
 * this drops the value rather than emitting a wrong `postedAt` (the
 * `toEpochMs` pattern — see ADDING_A_PROVIDER.md).
 * @param {unknown} value
 */
function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalizes one Pinloop `--json` pull row into a Job. Returns null when the
 * row lacks a usable title or an absolute http(s) URL.
 * @param {any} row
 */
export function normalizePinloopJob(row) {
  if (!row || typeof row !== 'object') return null;
  const title = String(row.title || '').trim();
  const rawUrl = String(row.url || '').trim();
  if (!title || !rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  /** @type {any} */
  const job = {
    title,
    url: rawUrl,
    company: String(row.company || '').trim(),
    location: joinLocations(row.locations),
    source: 'pinloop',
  };
  const postedAt = toEpochMs(row.posted_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/**
 * True when every configured `words` term appears (case-insensitively) in the
 * job's own title/company/location text — see the file-header note on why
 * this runs client-side instead of through the CLI.
 * @param {{title:string, company:string, location:string}} job
 * @param {string[]} words
 */
export function passesWordsFilter(job, words) {
  if (!Array.isArray(words) || words.length === 0) return true;
  const haystack = `${job.title} ${job.company} ${job.location}`.toLowerCase();
  return words.every((w) => haystack.includes(String(w).toLowerCase()));
}

// ── budget state (data/pinloop-state.json) ──────────────────────────────────

function stateFilePath() {
  return join(getCareerOpsRoot(), 'data', STATE_FILENAME);
}

/**
 * Reads today's (UTC) persisted pull budget. A file from a previous UTC day,
 * a missing file, or an unreadable/malformed one all resolve to a fresh
 * zero-used day — the safe default is "budget available", never "exhausted",
 * so a corrupt state file can only cost a wasted request, not a silently
 * skipped board.
 * @param {number} [nowMs]
 */
export function loadPinloopState(nowMs = Date.now()) {
  const today = todayUtc(nowMs);
  const fresh = () => ({
    day: today, pulls_used: 0, exhausted: false, last_error: '',
  });
  let raw;
  try {
    if (!existsSync(stateFilePath())) return fresh();
    raw = JSON.parse(readFileSync(stateFilePath(), 'utf-8'));
  } catch {
    return fresh();
  }
  if (!raw || typeof raw !== 'object' || raw.day !== today) return fresh();
  const used = Number(raw.pulls_used);
  return {
    day: today,
    pulls_used: Number.isFinite(used) ? Math.max(0, Math.trunc(used)) : 0,
    exhausted: raw.exhausted === true,
    last_error: typeof raw.last_error === 'string' ? raw.last_error : '',
  };
}

/**
 * Persists the budget state. Best-effort: a write failure (read-only FS,
 * permissions) is logged and swallowed rather than thrown — losing the local
 * budget memory means the next run may waste one request on a refusal, which
 * is recoverable; crashing the whole scan over it is not proportionate.
 * @param {{day:string, pulls_used:number, exhausted:boolean, last_error:string}} state
 */
export function savePinloopState(state) {
  try {
    const dir = join(getCareerOpsRoot(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      stateFilePath(),
      JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.error(`⚠️  pinloop: failed to persist budget state — ${err?.message ?? err}`);
  }
}

// ── leads file (data/pinloop-leads.json) ────────────────────────────────────

function leadsFilePath() {
  return join(getCareerOpsRoot(), 'data', LEADS_FILENAME);
}

/**
 * Merges freshly kept rows into the persisted leads file by `id` (falling
 * back to `url` when a row carries no id), capped at MAX_LEADS. A re-merged
 * id moves to the end so the cap trims the OLDEST leads first, not the
 * most-recently-seen ones.
 * @param {any[]} existing
 * @param {any[]} incoming
 * @param {number} [cap]
 */
export function mergePinloopLeads(existing, incoming, cap = MAX_LEADS) {
  const byKey = new Map();
  for (const lead of Array.isArray(existing) ? existing : []) {
    const key = lead && (lead.id || lead.url);
    if (key) byKey.set(key, lead);
  }
  for (const lead of incoming) {
    const key = lead && (lead.id || lead.url);
    if (!key) continue;
    byKey.delete(key); // re-insert at the end so it reads as most-recent
    byKey.set(key, lead);
  }
  const merged = [...byKey.values()];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/**
 * Reads-merges-writes `data/pinloop-leads.json`. Best-effort, same rationale
 * as savePinloopState: this file feeds `harvest-companies.mjs --in
 * data/pinloop-leads.json` on a LATER run, so a write failure here should
 * never take down the scan that found these leads in the first place.
 * @param {any[]} keptRows
 */
export function persistPinloopLeads(keptRows) {
  if (!keptRows.length) return;
  try {
    const dir = join(getCareerOpsRoot(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let existing = [];
    try {
      if (existsSync(leadsFilePath())) {
        const parsed = JSON.parse(readFileSync(leadsFilePath(), 'utf-8'));
        if (Array.isArray(parsed)) existing = parsed;
      }
    } catch {
      existing = []; // corrupt file: start over rather than crash the scan
    }
    const merged = mergePinloopLeads(existing, keptRows);
    writeFileSync(leadsFilePath(), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error(`⚠️  pinloop: failed to persist data/pinloop-leads.json — ${err?.message ?? err}`);
  }
}

// ── CLI invocation ──────────────────────────────────────────────────────────

/**
 * Decides HOW to invoke the pinloop CLI on this machine: `{command, args}`,
 * where `args` is a PREFIX to prepend to the actual `pull`/`--version` argv
 * (empty on POSIX, `[entryPath]` on Windows). Every input is injectable
 * (`platform`/`env`/`exists`/`execPath`) so tests can exercise the Windows
 * branch — including its failure path — deterministically on any host OS,
 * without touching this machine's real filesystem or `process.platform`.
 *
 * Windows: resolves the CLI's own JS entry rather than spawning `pinloop.cmd`
 * (see the file-header note on Node 24's `spawn EINVAL`). Resolution order:
 *   1. `PINLOOP_ENTRY` env var — explicit override, e.g. for a non-default
 *      global prefix or a local dev checkout.
 *   2. `%APPDATA%\npm\node_modules\pinloop\dist\cli\pinloop.js` — the default
 *      npm global install location on Windows (confirmed live on this
 *      machine: `node <that path> --version` → `0.8.1`).
 *   3. `<node install dir>\node_modules\pinloop\dist\cli\pinloop.js` — covers
 *      a Node distribution that bundles its own global npm prefix.
 * None found → throws a descriptive, `ENOENT`-coded error, caught by the same
 * "CLI unavailable → zero jobs + warning" path as a real missing binary
 * (never a crash).
 *
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, execPath?: string}} [opts]
 * @returns {{command: string, args: string[]}}
 */
export function resolvePinloopInvocation({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  execPath = process.execPath,
} = {}) {
  if (platform !== 'win32') {
    return { command: PINLOOP_POSIX_BIN, args: [] };
  }

  const override = typeof env.PINLOOP_ENTRY === 'string' ? env.PINLOOP_ENTRY.trim() : '';
  if (override) return { command: execPath, args: [override] };

  const candidates = [];
  if (typeof env.APPDATA === 'string' && env.APPDATA.trim()) {
    candidates.push(join(env.APPDATA.trim(), 'npm', 'node_modules', 'pinloop', 'dist', 'cli', 'pinloop.js'));
  }
  candidates.push(join(dirname(execPath), 'node_modules', 'pinloop', 'dist', 'cli', 'pinloop.js'));

  const found = candidates.find((c) => {
    try {
      return exists(c);
    } catch {
      return false;
    }
  });
  if (found) return { command: execPath, args: [found] };

  const err = new Error(
    'pinloop: could not resolve the installed CLI\'s JS entry on Windows (Node refuses to spawn `pinloop.cmd` '
    + `directly under shell:false — see the file header). Checked: PINLOOP_ENTRY env var, ${candidates.join(', ')}. `
    + 'Set PINLOOP_ENTRY to the CLI\'s pinloop.js path, or reinstall with `npm i -g pinloop`.',
  );
  err.code = 'ENOENT';
  throw err;
}

/**
 * Runs the pinloop CLI with `args` appended after the resolved invocation's
 * prefix. `ctx.exec` is injectable for tests (never spawns a real process
 * when a test supplies one) and `ctx.resolveInvocation` likewise, so a test
 * can force the Windows branch, its failure, or a synchronous exec() throw
 * without depending on the host OS. `shell: false` is passed explicitly —
 * `execFile` never invokes a shell by default, but spelling it out here
 * documents the guard inline rather than relying on a reader to know that
 * default, same rationale as every HTTP provider's explicit `redirect: 'error'`.
 *
 * Both the invocation resolution and the `exec()` call itself are wrapped so
 * a SYNCHRONOUS throw from either (an unresolvable Windows entry, or a
 * spawn-time error the runtime raises before returning a Promise at all —
 * exactly what Node 24 does for `pinloop.cmd` under shell:false) becomes an
 * ordinary rejection. Without this, that throw would escape `fetch()`'s
 * `await` entirely and never reach the `catch` that turns it into the soft
 * "CLI unavailable" path — it would crash the scan instead.
 *
 * @param {string[]} args
 * @param {{ exec?: (cmd: string, args: string[], opts: object) => Promise<{stdout:string, stderr:string}>, resolveInvocation?: () => {command:string, args:string[]} }} [ctx]
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function runPinloop(args, ctx) {
  const exec = typeof ctx?.exec === 'function' ? ctx.exec : execFileAsync;
  const resolveInvocation = typeof ctx?.resolveInvocation === 'function' ? ctx.resolveInvocation : resolvePinloopInvocation;
  try {
    const invocation = resolveInvocation();
    return Promise.resolve(exec(invocation.command, [...invocation.args, ...args], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      shell: false,
    }));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Best-effort JSON.parse of a failed invocation's stdout. `pinloop pull
 * --json` still prints a JSON object on stdout for a 402 (quota refusal,
 * `refused` field) or a 502 (`error` field) even though the process exits
 * non-zero in the latter case — this recovers that machine-readable text
 * instead of falling through to the generic stderr-pattern guesswork below.
 * @param {unknown} stdout
 */
function parseFailureStdout(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try {
    const json = JSON.parse(stdout);
    if (json && typeof json === 'object' && (typeof json.refused === 'string' || typeof json.error === 'string')) {
      return json;
    }
  } catch {
    // not JSON — fall through to the generic handling below
  }
  return null;
}

/**
 * Turns an exec() rejection into `[]` (soft failure, logged) or a thrown
 * Error (a genuine "this run is broken" case), and updates budget state when
 * the failure is a quota/limit refusal. Never retries — one exec() attempt
 * per fetch() call, matching ADDING_A_PROVIDER.md's "never retry in a loop"
 * for a confirmed quota exhaustion.
 * @param {any} err
 * @param {{name?:string}} entry
 * @param {{day:string, pulls_used:number, exhausted:boolean, last_error:string}} state
 * @returns {any[]}
 */
function handlePinloopFailure(err, entry, state) {
  const label = entry?.name ?? '(unnamed)';
  const fromStdout = parseFailureStdout(err?.stdout);
  if (fromStdout) {
    const msg = fromStdout.refused || fromStdout.error;
    if (fromStdout.refused) {
      state.exhausted = true;
      state.last_error = msg;
      savePinloopState(state);
    }
    console.error(`⚠️  pinloop: pull failed for "${label}" — ${msg}`);
    return [];
  }

  const code = err?.code;
  const message = String(err?.message ?? err ?? '');
  const stderrText = typeof err?.stderr === 'string' ? err.stderr : '';
  const combined = `${stderrText}\n${message}`;

  if (code === 'ENOENT' || /is not recognized|command not found/i.test(combined)) {
    // resolvePinloopInvocation()'s own throw already names exactly what it
    // checked (PINLOOP_ENTRY, the candidate paths) — prefer that verbatim
    // over a generic message. A real ENOENT from exec() itself (pinloop truly
    // missing on POSIX, or node.exe somehow unresolvable) falls back to one.
    const detail = message.startsWith('pinloop:')
      ? message.slice('pinloop:'.length).trim()
      : `the pinloop CLI is not available for "${label}" — install it (npm i -g pinloop) or disable this board.`;
    console.error(`⚠️  pinloop: ${detail} Returning zero jobs.`);
    return [];
  }
  if (/no saved login|login has expired|pinloop login/i.test(combined)) {
    console.error(`⚠️  pinloop: not logged in for "${label}" — run \`pinloop login\`. Returning zero jobs.`);
    return [];
  }
  if (/quota|exceeded|too many|upgrade|limit reached|try again later|rate.?limit/i.test(combined)) {
    state.exhausted = true;
    state.last_error = stderrText || message;
    savePinloopState(state);
    console.error(
      `⚠️  pinloop: quota/limit refusal for "${label}" — ${stderrText || message}. `
      + 'Marking today\'s budget exhausted.',
    );
    return [];
  }

  throw new Error(`pinloop: pull failed for "${label}" — ${stderrText || message}`);
}

/** @type {Provider} */
export default {
  id: 'pinloop',

  // No detect(): Pinloop has no per-entry careers_url/api to pattern-match —
  // an entry only reaches this provider via an explicit `provider: pinloop`.

  /**
   * Fetches and normalizes postings from the `pinloop` CLI, respecting the
   * free plan's daily pull budget (see file header).
   * @param {{ name?: string, pinloop?: any }} entry
   * @param {{ exec?: Function }} [ctx]
   * @returns {Promise<Array<{title:string,url:string,company:string,location:string,source:string,postedAt?:number}>>}
   */
  async fetch(entry, ctx) {
    const cfg = parsePinloopConfig(entry);
    const label = entry?.name ?? '(unnamed)';
    if (!cfg.titleQuery) {
      throw new Error(`pinloop: board "${label}" has no pinloop.title_query — nothing to search.`);
    }
    if (!ALLOWED_FROM.has(cfg.from)) {
      throw new Error(
        `pinloop: board "${label}" has invalid pinloop.from ${JSON.stringify(cfg.from)} `
        + '— must be "career sites" or "job boards".',
      );
    }

    const state = loadPinloopState();
    if (cfg.dailyPullBudget <= 0 || state.exhausted || state.pulls_used >= cfg.dailyPullBudget) {
      console.error(
        `⚠️  pinloop: daily pull budget (${cfg.dailyPullBudget}) already used for ${state.day} `
        + `(UTC) — skipping "${label}" until tomorrow. Returning zero jobs.`,
      );
      return [];
    }

    const remaining = cfg.dailyPullBudget - state.pulls_used;
    const args = buildPullArgs(cfg, remaining);

    let stdout;
    try {
      ({ stdout } = await runPinloop(args, ctx));
    } catch (err) {
      return handlePinloopFailure(err, entry, state);
    }

    let json;
    try {
      json = JSON.parse(stdout);
    } catch {
      console.error(`⚠️  pinloop: non-JSON output from \`pinloop pull\` for "${label}" — returning zero jobs.`);
      return [];
    }

    // A quota refusal on a --json pull exits 0 and carries a `refused` field
    // instead of throwing (the CLI's own contract) — same handling as the
    // thrown 402 case above, just reached through the success path.
    if (typeof json?.refused === 'string' && json.refused) {
      state.exhausted = true;
      state.last_error = json.refused;
      savePinloopState(state);
      console.error(`⚠️  pinloop: pull refused for "${label}" — ${json.refused}. Marking today's budget exhausted.`);
      return [];
    }

    const rows = Array.isArray(json?.rows) ? json.rows : [];

    // Budget accounting prefers the server's own numbers (`postings.left`,
    // authoritative) over counting rows ourselves, so a partial page or a
    // dedup-on-the-server difference can't drift the local ledger.
    const numbers = json?.postings;
    if (numbers && typeof numbers === 'object' && numbers.period === 'day' && Number.isFinite(Number(numbers.left))) {
      const left = Math.max(0, Number(numbers.left));
      state.pulls_used = Math.max(state.pulls_used, cfg.dailyPullBudget - left);
      if (left <= 0) state.exhausted = true;
    } else {
      state.pulls_used += rows.length;
    }
    if (state.pulls_used >= cfg.dailyPullBudget) state.exhausted = true;
    savePinloopState(state);

    const jobs = [];
    const leadRows = [];
    for (const row of rows) {
      const job = normalizePinloopJob(row);
      if (!job) continue;
      if (!cfg.allowJobBoardUrls && isJobBoardUrl(job.url)) continue;
      if (!passesWordsFilter(job, cfg.words)) continue;
      // Structured-location reach filter (#pinloop): only 'abroad' is dropped
      // here, matching classifyReach's own contract — 'unknown' must never be
      // treated as evidence a role is out of reach, and 'home'/'munich'/
      // 'germany'/'remote' all stay in scope for downstream scoring.
      if (classifyReach(job.location, job.title, job.url) === 'abroad') continue;
      jobs.push(job);
      leadRows.push({
        id: (row && row.id) || job.url,
        company: job.company,
        title: job.title,
        url: job.url,
        location: job.location,
        posted_at: (row && row.posted_at) ?? null,
      });
    }

    persistPinloopLeads(leadRows);

    return jobs;
  },
};
