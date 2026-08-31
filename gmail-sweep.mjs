#!/usr/bin/env node

/**
 * gmail-sweep.mjs — turn a batch of fetched emails into tracker status updates.
 *
 * The classification half of this already existed: `reply-matcher.mjs` decides
 * what a reply means and which tracker row it belongs to, and `reply-watch.mjs`
 * drives that interactively. What was missing was a **non-interactive** path so
 * the sweep can run as a step inside `/career-ops pipeline` rather than as a
 * separate command the user has to remember, and a set of guards strict enough
 * that a mailbox read is allowed to move a row at all.
 *
 * This script does not talk to Gmail. It takes messages the caller already
 * fetched — via the Gmail MCP connector, `node plugins.mjs run gmail`, or a
 * hand-written file — which keeps mailbox credentials out of this codebase and
 * makes the whole sweep testable from a fixture.
 *
 * Usage:
 *   node gmail-sweep.mjs query [--days 30]        print the Gmail search query to run
 *   node gmail-sweep.mjs plan  --file msgs.json   classify + match, print the plan
 *   node gmail-sweep.mjs apply --file msgs.json   plan, then execute it
 *   node gmail-sweep.mjs --help
 *
 * Message file format — a JSON array of:
 *   { "id": "...", "from": "...", "subject": "...", "body": "...", "date": "..." }
 *
 * Every message is also appended to `data/reply-candidates.json`, so anything
 * the sweep declines to auto-apply is still waiting for `node reply-watch.mjs`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

import { matchCandidates, classifyReply } from './reply-matcher.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { appendCandidate } from './paste-reply.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = resolveTrackerPath(ROOT);
const FOLLOWUPS_FILE = join(ROOT, 'data', 'follow-ups.md');
const SWEEP_STATE_PATH = process.env.CAREER_OPS_GMAIL_SWEEP_STATE
  || join(ROOT, 'data', 'gmail-sweep-state.json');

// ── Transition guards ───────────────────────────────────────────────────────

/**
 * Progress ordering over the canonical states in `templates/states.yml`.
 *
 * An inbox is not ordered: a "thanks for applying" autoresponder can arrive
 * after the interview invite, and a recruiter mass-mail can name a company the
 * candidate is already deep in process with. Without this ranking the sweep
 * happily walks `Interview` back to `Responded`, which is worse than not
 * sweeping at all — the tracker stops being trustworthy.
 */
export const STATUS_RANK = {
  Evaluated: 0, Applied: 1, Responded: 2, Interview: 3, Offer: 4, Hired: 5,
};

/** States the sweep will never move a row OUT of — those are the user's call. */
export const TERMINAL_STATES = new Set(['Hired', 'Rejected', 'Discarded', 'SKIP']);

/**
 * Decide whether a proposed transition may be applied automatically.
 *
 * @returns {{allow: boolean, reason: string}}
 */
export function screenTransition(current, next, confidence) {
  if (!next || next === 'none' || next === 'Needs Review') {
    return { allow: false, reason: 'no actionable status in the reply' };
  }
  if (current === next) return { allow: false, reason: 'already at that status' };
  if (TERMINAL_STATES.has(current)) {
    return { allow: false, reason: `row is terminal (${current}) — reopening is the user's call` };
  }
  if (confidence !== 'high') {
    return { allow: false, reason: `match confidence is ${confidence}, not high` };
  }
  // A rejection is the one signal that can legitimately arrive at any stage,
  // including out of order, so it is exempt from the forward-progress rule.
  if (next === 'Rejected') return { allow: true, reason: 'rejection at any stage' };
  if (!(next in STATUS_RANK)) {
    return { allow: false, reason: `${next} is not a forward-rankable state` };
  }
  const from = STATUS_RANK[current];
  if (from === undefined) return { allow: false, reason: `unrecognized current status "${current}"` };
  if (STATUS_RANK[next] <= from) {
    return { allow: false, reason: `would move backwards (${current} → ${next})` };
  }
  return { allow: true, reason: 'forward progress, high-confidence match' };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

function loadTrackerApps() {
  if (!existsSync(APPS_FILE)) return [];
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

/**
 * Follow-up rows, in the shape `reply-matcher.getAppDomains()` reads: it filters
 * on `appNum` and pulls a domain out of `contact`. Parsed the same way
 * reply-watch.mjs parses them so both tools resolve the same sender domains.
 */
function loadFollowups() {
  if (!existsSync(FOLLOWUPS_FILE)) return [];
  const followups = [];
  for (const line of readFileSync(FOLLOWUPS_FILE, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (Number.isNaN(num) || Number.isNaN(appNum)) continue;
    followups.push({
      num, appNum, date: parts[3], company: parts[4],
      role: parts[5], channel: parts[6], contact: parts[7], notes: parts[8] || '',
    });
  }
  return followups;
}

function loadSweepState() {
  if (!existsSync(SWEEP_STATE_PATH)) return { processed_message_ids: [] };
  try {
    const parsed = JSON.parse(readFileSync(SWEEP_STATE_PATH, 'utf-8'));
    return { processed_message_ids: parsed.processed_message_ids || [] };
  } catch {
    return { processed_message_ids: [] };
  }
}

function saveSweepState(ids) {
  mkdirSync(dirname(SWEEP_STATE_PATH), { recursive: true });
  const tmp = `${SWEEP_STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
  renameSync(tmp, SWEEP_STATE_PATH);
}

/** Normalize a fetched message into the candidate shape reply-matcher expects. */
export function toCandidate(message) {
  return {
    message_id: String(message?.id ?? message?.message_id ?? `gmail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    from: String(message?.from ?? ''),
    subject: String(message?.subject ?? ''),
    // Bodies arrive as full threads; the classifier only reads keywords, and an
    // unbounded body would bloat data/reply-candidates.json without changing a
    // single verdict.
    body_snippet: String(message?.body ?? message?.snippet ?? '').slice(0, 4000),
    date: message?.date ? String(message.date) : null,
    signal: null,
  };
}

// ── Query builder ───────────────────────────────────────────────────────────

/**
 * Build a Gmail search scoped to the companies actually in flight.
 *
 * Sweeping the whole inbox would read mail that has nothing to do with the job
 * search. Scoping to companies in `Applied`/`Responded`/`Interview`/`Offer`
 * keeps the read proportionate to the task and cuts the message count the agent
 * has to pull through context.
 */
// Legal forms stripped when deriving a searchable variant. A recruiter writes
// "moresophy", not "MORESOPHY GmbH".
const LEGAL_FORM_RE = /[\s,]*\b(?:gmbh(?:\s*&\s*co\.?\s*kgaa?)?|mbh|ag|se|kgaa|kg|ohg|eg|e\.?\s?v\.?|ltd\.?|limited|inc\.?|corp\.?|co\.?|b\.?v\.?|n\.?v\.?|s\.?a\.?|s\.?r\.?l\.?|plc|oy|ab|a\/s)\.?$/i;

// Recruiting vocabulary. Two jobs: it rescues mail from outsourced ATS domains
// that never name the employer in a matchable way (a Primetals rejection came
// from donotreply@mssa.com, a Craftview acknowledgement from noreply@hrworks.de),
// and it qualifies company names too common to search bare.
const JOB_CONTEXT = ['Bewerbung', 'Absage', 'Vorstellungsgespräch', 'application', 'interview', 'Werkstudent', 'Praktikum', 'recruiting'];

// Single short words that are also ordinary nouns or huge consumer brands.
// Searching "Amazon" bare returns vouchers and newsletters, burying the one
// real reply. Paired with JOB_CONTEXT they still match recruiting mail.
const TOO_GENERIC = new Set(['amazon', 'apple', 'orange', 'shell', 'next', 'sky', 'meta', 'square', 'oracle', 'sap']);

/**
 * Search terms for one tracker company name.
 *
 * A tracker label is not a search string. "FAU Erlangen-Nuernberg (Lehrstuhl
 * FAPS)" is an internal disambiguator: it carries an ASCII-folded "Nuernberg"
 * and a parenthetical, and no real email contains it — so the row it covers was
 * invisible to the sweep while being a live application. Emit the shapes a
 * sender would actually write instead.
 */
export function companySearchTerms(rawName) {
  const name = String(rawName || '').trim();
  if (!name || name === '?') return [];
  const terms = new Set();
  const add = (t) => {
    const v = String(t || '').trim().replace(/"/g, '');
    if (v.length >= 3) terms.add(v);
  };

  const noParen = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  add(noParen);
  add(noParen.replace(LEGAL_FORM_RE, '').trim());

  // A parenthetical often holds the distinctive part ("(Lehrstuhl FAPS)"), so
  // mine it for the longest all-caps token or a multi-word remainder.
  for (const inner of name.match(/\(([^)]*)\)/g) || []) {
    const body = inner.slice(1, -1).trim();
    const caps = (body.match(/\b[A-Z]{3,}\b/g) || []);
    caps.forEach(add);
    if (!caps.length) add(body.replace(LEGAL_FORM_RE, '').trim());
  }
  // The leading token of a compound label is usually the institution ("FAU").
  const lead = noParen.split(/[\s,-]+/)[0];
  if (lead && lead.length >= 3 && lead.toLowerCase() !== noParen.toLowerCase()) add(lead);

  return [...terms];
}

/** True when a term is too common to be searched on its own. */
export function isTooGenericTerm(term) {
  const t = String(term || '').trim();
  if (!t || /\s/.test(t)) return false;          // multi-word terms are specific enough
  return TOO_GENERIC.has(t.toLowerCase()) || t.length <= 4;
}

/**
 * Build a Gmail search scoped to the companies actually in flight.
 *
 * Sweeping the whole inbox would read mail that has nothing to do with the job
 * search. Scoping to companies in `Applied`/`Responded`/`Interview`/`Offer`
 * keeps the read proportionate to the task and cuts the message count the agent
 * has to pull through context.
 *
 * Measured failure this was written against: the old builder emitted the raw
 * tracker label for every company, so a live FAU application matched nothing
 * while a bare "Amazon" matched every voucher mail — and the query named none
 * of the three companies that had actually replied that day.
 */
export function buildGmailQuery(apps, { days = 30, maxLength = 1800 } = {}) {
  const active = new Set(['Applied', 'Responded', 'Interview', 'Offer']);
  const companies = [...new Set(
    apps.filter((a) => active.has(a.status))
      .map((a) => String(a.company || '').trim())
      .filter((c) => c && c !== '?'),
  )];
  if (companies.length === 0) return null;

  const context = JOB_CONTEXT.join(' OR ');
  const clauses = [];
  for (const company of companies) {
    const variants = companySearchTerms(company);
    if (!variants.length) continue;
    const generic = variants.filter(isTooGenericTerm);
    const specific = variants.filter((v) => !isTooGenericTerm(v));
    const quote = (t) => (/\s/.test(t) ? `"${t}"` : t);
    if (specific.length) clauses.push(specific.map(quote).join(' OR '));
    // A too-generic name still gets in, but only alongside recruiting words.
    for (const g of generic) clauses.push(`(${quote(g)} (${context}))`);
  }
  if (!clauses.length) return null;

  // Cap the length so Gmail does not reject the query outright; dropping the
  // tail is visible in `companies`, unlike an unusable query.
  const kept = [];
  let used = 0;
  for (const c of clauses) {
    if (used + c.length + 4 > maxLength) break;
    kept.push(c); used += c.length + 4;
  }
  return `newer_than:${days}d ((${kept.join(') OR (')}) OR (${context}))`;
}

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * Classify every message, match it to a tracker row, and screen the resulting
 * transition. Pure apart from the tracker read done by the caller.
 *
 * @returns {{updates: object[], review: object[], noise: object[]}}
 */
/**
 * Requisition IDs, the one signal that survives near-identical titles.
 *
 * Every ATS rejection quotes the req it is about — "(516786)", "(301278)",
 * "JR_1047706" — and the tracker row carries the same id in its notes and in
 * its posting URL. The fuzzy company+role matcher cannot see any of it, so a
 * Siemens rejection for req 516786 was matched to a DIFFERENT Siemens row
 * (#77, Climate Data & Analytics) at "high" confidence, while #115, whose own
 * notes read "Job ID 516786", was never considered. An employer with many open
 * roles is exactly where a wrong match is both most likely and most costly.
 *
 * merge-tracker.mjs already treats a req ID as decisive for the same reason
 * (AGENTS.md, #1524/#2009). This applies the same rule to inbound mail.
 *
 * Bare digit runs need SIX or more, so German postcodes (five) cannot collide.
 */
const REQ_LABELLED_RE = /\b(?:job\s*id|requisition|req|posting\s*id|ref|jr|r)[\s_#:-]*([a-z]*\d[a-z0-9_-]*)/gi;
const REQ_PREFIXED_RE = /\b([a-z]{1,3})[_-](\d{4,10})\b/gi;
const REQ_BARE_RE = /\b(\d{6,10})\b/g;

export function extractReqIds(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(REQ_LABELLED_RE)) {
    const id = m[1].replace(/[_-]/g, '').toUpperCase();
    if (/\d/.test(id) && id.length >= 4) out.add(id);
  }
  // A short alpha prefix is distinguishing (JR-10423 and R-10423 are different
  // requisitions), so keep the prefixed form AS WELL AS the bare digits — the
  // labelled rule above eats the separator and would otherwise collapse them.
  // Both sides of a comparison run through here, so emitting both is safe.
  for (const m of s.matchAll(REQ_PREFIXED_RE)) {
    out.add(`${m[1]}${m[2]}`.toUpperCase());
    out.add(m[2]);
  }
  for (const m of s.matchAll(REQ_BARE_RE)) out.add(m[1].toUpperCase());
  return out;
}

/**
 * How strongly a row CLAIMS an id, so a passing mention cannot outrank the row
 * the id actually belongs to.
 *
 * Notes are prose and prose talks about other rows. Row #85 (Sana) carries the
 * sentence "Every other application that evening (Siemens 516786, Siemens
 * Energy 301278, Thieme, Trench) produced a genuine acknowledgement" — written
 * during an earlier session — which made it a bare-number match for two ids
 * belonging to entirely different employers. Three rows matched 516786 and the
 * resolver, requiring uniqueness, gave up and let the wrong fuzzy match stand.
 *
 *   2  the id is in the row's posting URL — the row IS that requisition
 *   1  the id is labelled in the notes ("Job ID 516786", "req JR-10423")
 *   0  a bare number somewhere in the prose — could be about anything
 *
 * The best tier wins, and only if exactly one row holds it.
 */
function reqIdTier(app, ids) {
  const raw = String(app?.raw ?? '');
  const notes = String(app?.notes ?? '');
  const urls = raw.match(/https?:\/\/\S+/g) ?? [];
  for (const id of ids) {
    if (urls.some((u) => u.toUpperCase().includes(id))) return 2;
  }
  const labelled = new Set();
  for (const m of notes.matchAll(REQ_LABELLED_RE)) {
    const v = m[1].replace(/[_-]/g, '').toUpperCase();
    if (/\d/.test(v) && v.length >= 4) labelled.add(v);
  }
  for (const id of ids) if (labelled.has(id)) return 1;
  const bare = extractReqIds(`${notes} ${raw}`);
  for (const id of ids) if (bare.has(id)) return 0;
  return -1;
}

/**
 * Re-point a match using the requisition id the message quotes. Deliberately
 * conservative: it acts only when ONE row holds the id at the strongest tier
 * present, so a genuinely ambiguous id changes nothing and the fuzzy result
 * stands.
 */
export function resolveByReqId(candidate, apps, matchedNum) {
  const text = `${candidate.subject ?? ''} ${candidate.body_snippet ?? ''} ${candidate.body ?? ''}`;
  const msgIds = extractReqIds(text);
  if (msgIds.size === 0) return null;

  const scored = apps
    .map((a) => ({ app: a, tier: reqIdTier(a, msgIds) }))
    .filter((x) => x.tier >= 0);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((x) => x.tier));
  const top = scored.filter((x) => x.tier === best);
  if (top.length !== 1) return null;
  if (matchedNum != null && top[0].app.num === matchedNum) return null;
  return top[0].app;
}

export function buildPlan(candidates, apps, followups = []) {
  const matches = matchCandidates(candidates, apps, followups);
  const updates = [], review = [], noise = [];

  for (const match of matches) {
    const candidate = candidates.find((c) => c.message_id === match.message_id);
    if (!candidate) continue;
    const classification = classifyReply(candidate);
    let app = apps.find((a) => a.num === match.application_num) || null;

    // A requisition id quoted in the mail outranks the fuzzy company+role
    // guess: it is the only signal that separates two open roles at the same
    // employer. Applied whether the fuzzy pass matched the wrong row or none.
    const byReq = resolveByReqId(candidate, apps, app ? app.num : null);
    if (byReq) {
      match.signals = Array.from(new Set([...(match.signals ?? []), 'req-id']));
      match.confidence = 'high';
      match.rematchedFrom = app ? app.num : null;
      app = byReq;
    }

    const entry = {
      message_id: match.message_id,
      subject: candidate.subject,
      from: candidate.from,
      type: classification.type,
      evidence: classification.evidence || [],
      suggested: classification.suggestedTrackerUpdate,
      row: app ? app.num : null,
      company: app ? app.company : match.company_hint,
      role: app ? app.role : match.role_hint,
      currentStatus: app ? app.status : null,
      confidence: match.confidence,
      signals: match.signals,
      ...(match.rematchedFrom !== undefined ? { rematchedFrom: match.rematchedFrom } : {}),
    };

    if (classification.type === 'Noise' || classification.type === 'Auto-confirmation') {
      noise.push({ ...entry, skipReason: `classified ${classification.type}` });
      continue;
    }
    if (!app) {
      review.push({ ...entry, skipReason: 'no tracker row matched this sender' });
      continue;
    }

    const screen = screenTransition(app.status, classification.suggestedTrackerUpdate, match.confidence);
    if (screen.allow) updates.push({ ...entry, newStatus: classification.suggestedTrackerUpdate, why: screen.reason });
    else review.push({ ...entry, skipReason: screen.reason });
  }
  return { updates, review, noise };
}

// ── Apply ───────────────────────────────────────────────────────────────────

/**
 * Execute the plan through `set-status.mjs` — the canonical locked, validated,
 * atomic tracker write path from AGENTS.md. Re-implementing the write here
 * would be a second writer to `data/applications.md`, which is exactly what
 * that rule exists to prevent.
 */
function applyUpdates(updates, { dryRun = false } = {}) {
  const applied = [], failed = [];
  for (const update of updates) {
    const note = `gmail sweep: ${update.type}${update.evidence.length ? ` (${update.evidence.slice(0, 3).join('; ')})` : ''}`;
    const args = ['set-status.mjs', '--row', String(update.row), update.newStatus, '--note', note, '--json'];
    if (dryRun) args.push('--dry-run');
    const res = spawnSync('node', args, { cwd: ROOT, encoding: 'utf-8' });
    if (!res.error && res.status === 0) {
      applied.push({ row: update.row, company: update.company, from: update.currentStatus, to: update.newStatus });
    } else {
      failed.push({
        row: update.row,
        company: update.company,
        error: (res.stderr || res.stdout || res.error?.message || 'unknown error').trim().split('\n').slice(-1)[0],
      });
    }
  }
  return { applied, failed };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `gmail-sweep.mjs — classify fetched emails into tracker status updates

  query [--days N]              print the Gmail search query for the in-flight companies
  plan  --file <messages.json>  classify + match + screen; print the plan, change nothing
  apply --file <messages.json>  run the plan through set-status.mjs [--dry-run] [--all]

Message file: JSON array of { id, from, subject, body, date }.
Fetch them with the Gmail MCP connector or \`node plugins.mjs run gmail\` — this
script never touches the mailbox itself.

Guards: only high-confidence matches, only forward transitions (plus Rejected at
any stage), never out of Hired/Rejected/Discarded/SKIP. Everything else lands in
"review" for you to decide, and stays in data/reply-candidates.json for
\`node reply-watch.mjs\`.`;

function readMessages(file) {
  if (!file || file === true) throw new Error('--file <messages.json> is required.');
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  const list = Array.isArray(parsed) ? parsed : parsed?.messages;
  if (!Array.isArray(list)) throw new Error(`${file} must contain a JSON array of messages.`);
  return list;
}

/** Shared front half of `plan` and `apply`: dedup, normalize, persist, classify. */
function sweep(flags) {
  const messages = readMessages(flags.file);
  const state = loadSweepState();
  const processed = new Set(state.processed_message_ids);

  const fresh = flags.all ? messages : messages.filter((m) => !processed.has(String(m?.id ?? m?.message_id ?? '')));
  const candidates = fresh.map(toCandidate);

  // Persist first: if classification throws, the mail is still queued for
  // reply-watch rather than silently lost from a one-shot mailbox read.
  for (const candidate of candidates) appendCandidate(candidate);

  const apps = loadTrackerApps();
  const plan = buildPlan(candidates, apps, loadFollowups());
  return { messages, fresh, candidates, plan, processed };
}

function cmdQuery(flags) {
  const days = Number.isFinite(flags.days) ? flags.days : 30;
  const apps = loadTrackerApps();
  const query = buildGmailQuery(apps, { days });
  return {
    query,
    days,
    companies: query ? query.match(/"[^"]+"/g)?.length ?? 0 : 0,
    note: query
      ? 'Run this against the Gmail connector, then feed the messages to `gmail-sweep.mjs plan --file`.'
      : 'No applications are in flight (Applied/Responded/Interview/Offer) — nothing to sweep.',
  };
}

function cmdPlan(flags) {
  const { messages, fresh, plan } = sweep(flags);
  return {
    messagesIn: messages.length,
    newMessages: fresh.length,
    willUpdate: plan.updates.length,
    needsReview: plan.review.length,
    ignored: plan.noise.length,
    ...plan,
  };
}

function cmdApply(flags) {
  const { messages, fresh, plan, processed, candidates } = sweep(flags);
  const result = applyUpdates(plan.updates, { dryRun: !!flags['dry-run'] });

  if (!flags['dry-run']) {
    for (const candidate of candidates) processed.add(candidate.message_id);
    saveSweepState(processed);
  }
  return {
    messagesIn: messages.length,
    newMessages: fresh.length,
    ...result,
    needsReview: plan.review,
    ignored: plan.noise.length,
    reviewHint: plan.review.length
      ? `${plan.review.length} reply/replies were not auto-applied — review them, or run \`node reply-watch.mjs\`.`
      : undefined,
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[name] = true; continue; }
    const num = Number(next);
    flags[name] = Number.isFinite(num) && next.trim() !== '' ? num : next;
    i++;
  }
  return flags;
}

const COMMANDS = { query: cmdQuery, plan: cmdPlan, apply: cmdApply };

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`gmail-sweep: unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(handler(parseFlags(argv.slice(1))), null, 2));
  } catch (err) {
    console.error(`gmail-sweep: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
