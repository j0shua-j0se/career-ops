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
export function buildGmailQuery(apps, { days = 30 } = {}) {
  const active = new Set(['Applied', 'Responded', 'Interview', 'Offer']);
  const companies = [...new Set(
    apps.filter((a) => active.has(a.status))
      .map((a) => String(a.company || '').trim())
      .filter((c) => c && c !== '?'),
  )];
  if (companies.length === 0) return null;
  const terms = companies.map((c) => `"${c.replace(/"/g, '')}"`).join(' OR ');
  return `newer_than:${days}d (${terms})`;
}

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * Classify every message, match it to a tracker row, and screen the resulting
 * transition. Pure apart from the tracker read done by the caller.
 *
 * @returns {{updates: object[], review: object[], noise: object[]}}
 */
export function buildPlan(candidates, apps, followups = []) {
  const matches = matchCandidates(candidates, apps, followups);
  const updates = [], review = [], noise = [];

  for (const match of matches) {
    const candidate = candidates.find((c) => c.message_id === match.message_id);
    if (!candidate) continue;
    const classification = classifyReply(candidate);
    const app = apps.find((a) => a.num === match.application_num) || null;

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
