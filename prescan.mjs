#!/usr/bin/env node

/**
 * prescan.mjs — unattended, zero-token weekly prescan.
 *
 * WHY: `node run-retro.mjs --summary` measured the last full pass at 934
 * minutes in the SCAN stage against 27 for evaluation and 24 for kits. Scan is
 * zero-token end to end (scan.mjs, scan-ats-full.mjs, triage-prefilter.mjs,
 * fetch-jds.mjs never call a model) but it keeps dying when it runs inside an
 * interactive session that hits a usage limit partway through a multi-hour
 * sweep. The fix is not a faster scan — it's running the zero-token stages
 * UNATTENDED, ahead of time, so the interactive `/career-ops run` pass that
 * follows only has to do the two stages that actually need a model (evaluate,
 * kits) against an inbox that is already scanned, pre-screened and JD-fetched.
 *
 * This script is that unattended stage. It does NOT evaluate anything, build
 * a CV, or touch the tracker. It only widens `data/pipeline.md` and prepares
 * it for the next interactive pass:
 *
 *   1. node scan.mjs                              — portals.yml, zero-token
 *   2. node scan-ats-full.mjs --ats <cfg> --since 7 [--resume] — reverse-ATS sweep
 *   3. node triage-prefilter.mjs --mark-skips --write — zero-token pre-screen
 *   4. node fetch-jds.mjs --file ... --out data/cache/prescan-jds.json
 *      — pre-fetches JDs for everything still pending, so the next interactive
 *        pass triages from a local file instead of paying WebFetch/browser
 *        tokens per posting; expired postings are marked processed in-place.
 *
 * Config comes from `config/profile.yml` -> `loop:` — the SAME block the scan
 * loop and `/career-ops run` already read (`skip_strategies`, `ats_sources`,
 * `min_score`, ...) — via loop-core.mjs's resolveLoopConfig/effectiveStrategies
 * /applyAtsSources, and scan-loop.mjs's buildWaveArgs for the --resume decision.
 * None of that logic is duplicated here; it is imported.
 *
 * Only two rungs of the scan-loop ladder run here: `portals` and `ats-recent`
 * (last 7 days). Nothing from the `agent-web` rung (WebSearch across LinkedIn/
 * XING — see run-core.mjs's AGENT_DRIVEN_SOURCES) and nothing that requires an
 * agent turn at all. `interamt` only runs if the user removes it from
 * `loop.skip_strategies` AND adds it to prescan's own wanted-rung list, which
 * this version does not do (measured yield: 16,328 scanned, 0 tracker rows —
 * see config/profile.yml's own comment on skip_strategies).
 *
 * Guards:
 *   - Refuses to start (exit 0, logs "skipped: pass in progress") when
 *     data/run-state.json shows a `/career-ops run` pass that is neither
 *     finished nor halted — run-core.mjs's own STAGES/isFinished decide that,
 *     not a re-derived copy of the rule.
 *   - Refuses to start when another prescan already holds
 *     data/cache/prescan.lock, reusing portal-health-lock.mjs's existing
 *     directory-lock protocol (mkdir-atomic, owner.json, stale-after
 *     reclaim) rather than a fifth hand-rolled lock in this repo — just
 *     pointed at a different file and given a 6-hour staleness window instead
 *     of its 30-second default, since a prescan step can legitimately run for
 *     hours.
 *
 * Usage:
 *   node prescan.mjs               # run the unattended pass
 *   node prescan.mjs --dry-run     # print the planned steps + argv, run nothing
 *   node prescan.mjs --help
 *
 * Output:
 *   data/cache/prescan-summary.json — machine-readable result of the last run
 *   data/prescan-log.md             — one appended line per run (audit trail)
 *   data/cache/prescan-jds.json     — fetch-jds.mjs's compacted JD batch
 *   data/pipeline.md, data/discard.log — updated in place (skips + expired)
 *
 * Does NOT commit, push, switch branches, or register a scheduled task.
 * scripts/register-prescan-task.ps1 does the registration — reviewed and run
 * separately, never by this file.
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

import {
  resolveLoopConfig, effectiveStrategies, applyAtsSources, candidateKey,
} from './loop-core.mjs';
// buildWaveArgs is the ONE place that decides --resume from an on-disk
// scan-ats-full.mjs checkpoint. Reused rather than re-derived (see file doc).
import { buildWaveArgs } from './scan-loop.mjs';
// STAGES/isFinished are the SAME stage-completeness rule `/career-ops run`
// itself uses to know whether a pass is still open. Reused rather than
// re-derived so this guard can never disagree with run-core.mjs about what
// "in progress" means.
import { isFinished as runIsFinished } from './run-core.mjs';
import { parsePipeline, parsePipelineLine, buildReport } from './triage-prefilter.mjs';
import { acquirePortalHealthLock } from './portal-health-lock.mjs';

const CAREER_OPS = getCareerOpsRoot();
const DATA_DIR = join(CAREER_OPS, 'data');
const CACHE_DIR = join(DATA_DIR, 'cache');
const RUN_STATE_PATH = process.env.CAREER_OPS_RUN_STATE || join(DATA_DIR, 'run-state.json');
const PIPELINE_PATH = join(DATA_DIR, 'pipeline.md');
const DISCARD_LOG_PATH = join(DATA_DIR, 'discard.log');
const SCAN_RUNS_PATH = join(DATA_DIR, 'scan-runs.tsv');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(CAREER_OPS, 'config', 'profile.yml');
const SUMMARY_PATH = join(CACHE_DIR, 'prescan-summary.json');
const PRESCAN_LOG_PATH = join(DATA_DIR, 'prescan-log.md');
const JD_BATCH_PATH = join(CACHE_DIR, 'prescan-jds-batch.json');
const JD_OUT_PATH = join(CACHE_DIR, 'prescan-jds.json');
// portal-health-lock.mjs derives the actual lock directory as `${path}.lock`,
// so passing the path WITHOUT the trailing `.lock` here is what makes the
// on-disk lock directory be exactly `data/cache/prescan.lock`, as documented.
const LOCK_TARGET = join(CACHE_DIR, 'prescan');
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // ~6h — a prescan step can legitimately run for hours.

const WANTED_SCAN_RUNGS = ['portals', 'ats-recent'];

const USAGE = `Usage:
  node prescan.mjs               # run the unattended zero-token prescan
  node prescan.mjs --dry-run     # print planned steps + argv, run nothing
  node prescan.mjs --help        # print this usage block and exit`;

// ── pure helpers (exported + unit-tested; no fs/network/child_process) ─────

/**
 * True when `data/run-state.json` describes a `/career-ops run` pass that is
 * neither finished nor halted. A halted pass is stopped and waiting on the
 * user, not actively running, so it does not block a prescan.
 *
 * @param {object|null} state - Parsed run-state.json, or null when absent/unreadable.
 * @returns {boolean}
 */
export function isPassRunning(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.halted_reason) return false;
  const completed = Array.isArray(state.completed) ? state.completed : [];
  const skipped = Array.isArray(state.skipped) ? state.skipped : [];
  try {
    return !runIsFinished({ completed, skipped });
  } catch {
    return false;
  }
}

/**
 * The `portals` and `ats-recent` rungs of the scan-loop ladder, scoped by
 * `config/profile.yml` -> `loop:` (skip_strategies, ats_sources) and given the
 * `--resume` flag when a compatible scan-ats-full.mjs checkpoint is on disk.
 *
 * Deliberately narrower than the full scan-loop ladder (see file doc): only
 * these two rungs are zero-token AND unattended-safe. `interamt` is a browser
 * scan the user has already opted out of at this repo's measured yield;
 * `ats-wide`/`ats-deep`/`agent-web` are the loop's own widening rungs for when
 * the ladder is short of its target, not what a weekly prescan wants to spend
 * hours on before anyone has looked at what the first pass found.
 *
 * @param {ReturnType<typeof resolveLoopConfig>} config
 * @param {{dryRun?: boolean}} [options]
 * @returns {Array<{id: string, command: string, args: string[], describe: string}>}
 */
export function planScanSteps(config, { dryRun = false } = {}) {
  const strategies = effectiveStrategies(config).filter((s) => WANTED_SCAN_RUNGS.includes(s.id));
  return strategies.map((s) => {
    const scoped = applyAtsSources(s, config);
    const args = buildWaveArgs(scoped, { 'dry-run': dryRun });
    return {
      id: s.id, command: scoped.command, args, describe: scoped.describe,
    };
  });
}

/**
 * Build fetch-jds.mjs's `--file` batch from every still-pending, non-local
 * `data/pipeline.md` entry — the same `{key, url, company, title, location}`
 * shape `scan-loop.mjs`'s `score` step hands it.
 *
 * @param {string} pipelineMd
 * @returns {Array<{key: string, url: string, company: string, title: string, location: string}>}
 */
export function buildJdBatch(pipelineMd) {
  const { pending } = parsePipeline(pipelineMd);
  return pending
    .filter((e) => e && !e.done && e.url)
    .map((e) => ({
      key: candidateKey(e.url) || e.url,
      url: e.url,
      company: e.company || '',
      title: e.title || '',
      location: e.location || '',
    }));
}

/**
 * Tally fetch-jds.mjs's `--out` results into `{ok, expired, other}`. Every
 * non-'ok'/'expired' status (robots-blocked, robots-unconfirmed, unsafe-url,
 * blocked, error) collapses into `other` — this is a prescan-level summary,
 * not a substitute for reading data/cache/prescan-jds.json when something
 * needs debugging.
 *
 * @param {Array<{status?: string}>} results
 * @returns {{ok: number, expired: number, other: number}}
 */
export function tallyJdStatuses(results) {
  const counts = { ok: 0, expired: 0, other: 0 };
  for (const r of Array.isArray(results) ? results : []) {
    if (r?.status === 'ok') counts.ok += 1;
    else if (r?.status === 'expired') counts.expired += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * Mark every `data/pipeline.md` row fetch-jds.mjs reported `expired` as
 * processed, in place — `- [x] #-- | <rest> | skipped (posting closed:
 * liveness <code>)`, where `<rest>` is the row's own content unchanged (url |
 * company | title | location | posted: ...) and `#--` is the "no report
 * number" sentinel: an expired posting was never evaluated, so it never
 * earned a report number the way an evaluated row does (see
 * triage-prefilter.mjs's markEvaluated, which uses the same `[x] #N | <rest>`
 * shape for a real report link).
 *
 * A companion writer to triage-prefilter.mjs's own markPrescreenSkips/
 * markEvaluated rather than a call into either: neither produces this exact
 * `#-- | ... | skipped (posting closed: liveness <code>)` format, and
 * reshaping one to fit would risk the OTHER caller's format. Same technique
 * (checkbox flip + reason suffix, only pending/non-local rows touched, nothing
 * deleted), new function.
 *
 * @param {string} md - current data/pipeline.md
 * @param {Array<{url: string, code?: string}>} expiredEntries
 * @returns {{text: string, marked: number, lines: string[]}} `lines` are
 *   ready to append to data/discard.log, one per marked row.
 */
export function markExpiredInPipeline(md, expiredEntries) {
  const codeByUrl = new Map(
    (expiredEntries || []).filter((e) => e && e.url).map((e) => [e.url, e.code || 'unknown']),
  );
  if (codeByUrl.size === 0) return { text: md, marked: 0, lines: [] };

  const out = [];
  const lines = [];
  let marked = 0;
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const entry = parsePipelineLine(line);
    if (!entry || entry.done || !codeByUrl.has(entry.url)) { out.push(line); continue; }
    const code = codeByUrl.get(entry.url);
    const rest = line.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '');
    const reason = `posting closed: liveness ${code}`;
    out.push(`- [x] #-- | ${rest} | skipped (${reason})`);
    lines.push(`${new Date().toISOString()}\t${entry.url}\t${reason}`);
    marked += 1;
  }
  return { text: out.join('\n'), marked, lines };
}

/**
 * Parse a TSV's header + LAST row into `{columnName: value}`, reading by
 * header name (never position) — the same contract scan.mjs documents for
 * data/scan-runs.tsv, so a file with columns appended since this was written
 * still parses correctly.
 *
 * @param {string} text
 * @returns {Record<string, string>|null} null when the file has no data rows.
 */
export function parseTsvLastRow(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].split('\t');
  const last = lines[lines.length - 1].split('\t');
  const row = {};
  header.forEach((h, i) => { row[h] = last[i]; });
  return row;
}

/** Non-empty line count — used to detect whether a TSV grew during a step. */
export function countLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0).length;
}

/**
 * Summarize one `scan-ats-full.mjs --json` payload: total companies scanned,
 * new matches, and new-matches-per-`ats_sources`-entry (grouped by each
 * offer's own `.source`). There is no separate "found before dedup" figure in
 * this payload — scan-ats-full.mjs only ever reports offers already deduped
 * against data/scan-history.tsv — so "new" is reported, not a fabricated
 * "found".
 *
 * @param {object|null} json - parsed stdout from `--json`, or null if unparseable.
 * @returns {{companiesScanned: number|null, new: number|null, bySource: Record<string, number>}}
 */
export function summarizeAtsJson(json) {
  const bySource = {};
  for (const o of json?.offers ?? []) {
    const src = o?.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  return {
    companiesScanned: typeof json?.companiesScanned === 'number' ? json.companiesScanned : null,
    new: typeof json?.postingsKept === 'number' ? json.postingsKept : (json?.offers?.length ?? null),
    bySource,
  };
}

/** `12m34s` / `45s` — compact, for the one-line log entry. */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Run every step in `stepList`, independently: a step whose `run()` throws or
 * rejects is recorded with `exitCode: 1` and an `error` message, and every
 * OTHER step still runs — a failing scan rung must never block triage-prefilter
 * or fetch-jds from doing their (independent) work on whatever the inbox
 * already holds.
 *
 * @param {Array<{id: string, run: () => Promise<object>|object}>} stepList
 * @returns {Promise<{steps: Record<string, object>, anyRan: boolean}>}
 *   `anyRan` is true once at least one step's `run()` was actually invoked —
 *   used to decide prescan's own exit code ("exit non-zero only if nothing ran").
 */
export async function orchestrateSteps(stepList) {
  const steps = {};
  let anyRan = false;
  for (const step of stepList || []) {
    const startedAt = Date.now();
    try {
      const result = await step.run();
      steps[step.id] = { exitCode: 0, ...result, durationMs: Date.now() - startedAt };
      anyRan = true;
    } catch (err) {
      steps[step.id] = { exitCode: 1, durationMs: Date.now() - startedAt, error: err?.message || String(err) };
      anyRan = true;
    }
  }
  return { steps, anyRan };
}

/**
 * Assemble the machine-readable `data/cache/prescan-summary.json` payload.
 * Pure — every value is handed in, nothing is read from disk here.
 *
 * @param {object} parts
 * @returns {object}
 */
export function buildSummary({
  startedAt, finishedAt, steps, jdCounts, freeRejected, pendingLeft,
}) {
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    steps: steps || {},
    jd: jdCounts || { ok: 0, expired: 0, other: 0 },
    free_rejected: freeRejected ?? null,
    pending_left: pendingLeft ?? null,
  };
}

/** One `data/prescan-log.md` line for `summary` — dense, pipe-separated, human-scannable. */
export function renderPrescanLogLine(summary) {
  const steps = summary?.steps || {};
  const fmtScan = (id) => {
    const st = steps[id];
    if (!st) return `${id}: not run`;
    const bits = [`exit=${st.exitCode}`, formatDuration(st.durationMs)];
    if (typeof st.found === 'number') bits.push(`found=${st.found}`);
    if (typeof st.new === 'number') bits.push(`new=${st.new}`);
    if (st.bySource && Object.keys(st.bySource).length) {
      bits.push(Object.entries(st.bySource).map(([k, v]) => `${k}=${v}`).join(','));
    }
    if (st.error) bits.push(`error="${st.error}"`);
    return `${id} ${bits.join(' ')}`;
  };
  const fmtSimple = (id, extra = '') => {
    const st = steps[id];
    if (!st) return `${id}: not run`;
    const bits = [`exit=${st.exitCode}`, formatDuration(st.durationMs)];
    if (extra) bits.push(extra);
    if (st.error) bits.push(`error="${st.error}"`);
    return `${id} ${bits.join(' ')}`;
  };
  const jd = summary?.jd || { ok: 0, expired: 0, other: 0 };
  return `- ${summary?.started_at ?? '?'} → ${summary?.finished_at ?? '?'} `
    + `| ${fmtScan('portals')} `
    + `| ${fmtScan('ats-recent')} `
    + `| ${fmtSimple('triage-prefilter', `free-rejected=${summary?.free_rejected ?? '?'}`)} `
    + `| ${fmtSimple('fetch-jds', `jd-ok=${jd.ok} jd-expired=${jd.expired} jd-other=${jd.other}`)} `
    + `| pending-left=${summary?.pending_left ?? '?'}`;
}

// ── disk / process helpers (not unit-tested directly; exercised via --dry-run) ─

function readFileSafe(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch (err) {
    console.error(`prescan: could not parse ${PROFILE_PATH} — ${err.message}`);
    return {};
  }
}

function relToRoot(path) {
  return path.startsWith(CAREER_OPS) ? path.slice(CAREER_OPS.length + 1).replace(/\\/g, '/') : path;
}

function printDryRunPlan(scanSteps) {
  const jdBatch = readFileSafe(PIPELINE_PATH);
  const pendingCount = buildJdBatch(jdBatch).length;
  console.log('prescan --dry-run: planned steps (nothing will run)\n');
  let n = 1;
  for (const s of scanSteps) {
    console.log(`  ${n}. ${s.command} ${s.args.join(' ')}   # ${s.describe}`);
    n += 1;
  }
  console.log(`  ${n}. node triage-prefilter.mjs --mark-skips --write`);
  n += 1;
  console.log(`  ${n}. node fetch-jds.mjs --file ${relToRoot(JD_BATCH_PATH)} --out ${relToRoot(JD_OUT_PATH)}`
    + `   # ${pendingCount} pending entr${pendingCount === 1 ? 'y' : 'ies'} today`);
}

// ── step implementations (spawn real children; timing added by orchestrateSteps) ─

function runChild(command, args, { captureStdout = false } = {}) {
  const stdio = captureStdout ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'];
  const result = spawnSync(command, args, { cwd: CAREER_OPS, stdio });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  }
  return result;
}

function stepPortalsRun(step) {
  const beforeLines = countLines(readFileSafe(SCAN_RUNS_PATH));
  const result = runChild(step.command, step.args);
  const after = readFileSafe(SCAN_RUNS_PATH);
  let found = null;
  let newAdded = null;
  if (countLines(after) > beforeLines) {
    const row = parseTsvLastRow(after);
    if (row) {
      found = Number(row.found);
      newAdded = Number(row.new_added);
      if (!Number.isFinite(found)) found = null;
      if (!Number.isFinite(newAdded)) newAdded = null;
    }
  }
  return { exitCode: result.status ?? 1, found, new: newAdded };
}

function stepAtsRecentRun(step) {
  const args = step.args.includes('--json') ? step.args : [...step.args, '--json'];
  const result = runChild(step.command, args, { captureStdout: true });
  let json = null;
  try { json = JSON.parse(result.stdout?.toString('utf-8') || 'null'); } catch { json = null; }
  const summarized = json ? summarizeAtsJson(json) : { companiesScanned: null, new: null, bySource: {} };
  return {
    exitCode: result.status ?? 1,
    companiesScanned: summarized.companiesScanned,
    new: summarized.new,
    bySource: summarized.bySource,
  };
}

function stepTriagePrefilterRun() {
  const before = readFileSafe(PIPELINE_PATH);
  let freeRejected = null;
  try { freeRejected = buildReport(parsePipeline(before)).counts.skip; } catch { /* best-effort */ }

  const result = runChild('node', ['triage-prefilter.mjs', '--mark-skips', '--write']);

  let pendingLeft = null;
  try {
    const after = readFileSync(PIPELINE_PATH, 'utf-8');
    pendingLeft = buildReport(parsePipeline(after)).counts.pending;
  } catch { /* best-effort */ }

  return { exitCode: result.status ?? 1, freeRejected, pendingLeft };
}

function stepFetchJdsRun() {
  const md = readFileSafe(PIPELINE_PATH);
  const batch = buildJdBatch(md);
  if (batch.length === 0) {
    return {
      exitCode: 0, batchSize: 0, jd: { ok: 0, expired: 0, other: 0 }, expiredMarked: 0,
    };
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(JD_BATCH_PATH, JSON.stringify(batch, null, 2), 'utf-8');
  const result = runChild('node', ['fetch-jds.mjs', '--file', JD_BATCH_PATH, '--out', JD_OUT_PATH]);

  let jd = { ok: 0, expired: 0, other: 0 };
  let expiredMarked = 0;
  try {
    const results = JSON.parse(readFileSync(JD_OUT_PATH, 'utf-8'));
    jd = tallyJdStatuses(results);
    const expiredEntries = results
      .filter((r) => r?.status === 'expired' && r?.url)
      .map((r) => ({ url: r.url, code: r.liveness }));
    if (expiredEntries.length) {
      const current = readFileSync(PIPELINE_PATH, 'utf-8');
      const { text, marked, lines } = markExpiredInPipeline(current, expiredEntries);
      if (marked) {
        writeFileSync(PIPELINE_PATH, text, 'utf-8');
        appendFileSync(DISCARD_LOG_PATH, `${lines.join('\n')}\n`, 'utf-8');
      }
      expiredMarked = marked;
    }
  } catch (err) {
    console.error(`prescan: fetch-jds output could not be read/applied — ${err.message}`);
  }

  return {
    exitCode: result.status ?? 1, batchSize: batch.length, jd, expiredMarked,
  };
}

// ── orchestration ───────────────────────────────────────────────────────────

async function runAll(scanSteps) {
  const startedAt = new Date().toISOString();

  const stepList = [
    ...scanSteps.map((s) => ({
      id: s.id,
      run: async () => (s.id === 'portals' ? stepPortalsRun(s) : stepAtsRecentRun(s)),
    })),
    { id: 'triage-prefilter', run: async () => stepTriagePrefilterRun() },
    { id: 'fetch-jds', run: async () => stepFetchJdsRun() },
  ];

  const { steps, anyRan } = await orchestrateSteps(stepList);
  const finishedAt = new Date().toISOString();

  const summary = buildSummary({
    startedAt,
    finishedAt,
    steps,
    jdCounts: steps['fetch-jds']?.jd,
    freeRejected: steps['triage-prefilter']?.freeRejected,
    pendingLeft: steps['triage-prefilter']?.pendingLeft,
  });

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf-8');
  appendFileSync(PRESCAN_LOG_PATH, `${renderPrescanLogLine(summary)}\n`, 'utf-8');

  console.log(`\nprescan: done — summary written to ${relToRoot(SUMMARY_PATH)}, logged to ${relToRoot(PRESCAN_LOG_PATH)}`);
  if (!anyRan) process.exitCode = 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, ['--dry-run', '--help', '-h'], USAGE);

  const profile = loadProfile();
  const config = resolveLoopConfig(profile);
  const dryRun = argv.includes('--dry-run');
  const scanSteps = planScanSteps(config, { dryRun });

  if (dryRun) {
    printDryRunPlan(scanSteps);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const runState = readJsonSafe(RUN_STATE_PATH);
  if (isPassRunning(runState)) {
    console.log('prescan: skipped: pass in progress');
    return;
  }

  let lock;
  try {
    lock = await acquirePortalHealthLock(LOCK_TARGET, { staleMs: LOCK_STALE_MS, timeoutMs: 500, retryMs: 100 });
  } catch {
    console.log('prescan: skipped: another prescan holds data/cache/prescan.lock');
    return;
  }

  try {
    await runAll(scanSteps);
  } finally {
    lock.release();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`prescan: fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
