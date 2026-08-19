#!/usr/bin/env node

/**
 * scan-loop.mjs — the driver for the career-ops scan loop.
 *
 * `loop-core.mjs` decides what happens next; this file performs it and persists
 * the result. Together they implement the loop-engineering pattern
 * (github.com/cobusgreyling/loop-engineering) over career-ops' existing
 * zero-token scanners: durable state outside the conversation, an escalation
 * ladder, explicit budgets and a circuit breaker, and a human review gate that
 * the loop can never step past.
 *
 * The agent drives it by calling `next` and doing what it says:
 *
 *   node scan-loop.mjs start                # begin a run (target/min-score from config)
 *   node scan-loop.mjs next                 # {action: scan|score|finish|halt} + payload
 *   node scan-loop.mjs wave                 # run the next scan rung (action: scan)
 *   node scan-loop.mjs ingest --file o.json # hand-scanned offers in (agent-web rung)
 *   node scan-loop.mjs record --file s.json # feed triage scores back (action: score)
 *   node scan-loop.mjs finish               # promote to shortlist + tracker
 *   node scan-loop.mjs status [--summary]
 *   node scan-loop.mjs abort --note "..."   # end a stuck run without promoting
 *
 * Zero Claude tokens on its own — every token the loop spends is spent by the
 * agent inside a `score` step, which is why `loop.maxScored` is the budget that
 * actually matters.
 *
 * State: data/loop-state.json · Review gate: data/loop-shortlist.md
 * Audit trail: data/loop-run-log.md · Loop definition: LOOP.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import {
  DEFAULT_LOOP_CONFIG, WAVE_STRATEGIES,
  resolveLoopConfig, newState, normalizeState, ingestOffers, recordScores,
  parseTriageOutput, decideNextAction, summarize, qualifiedCandidates,
  renderShortlist, renderRunLogEntry,
} from './loop-core.mjs';
import { parsePipeline } from './triage-prefilter.mjs';

// Every artifact the driver writes is redirectable, following the one-env-var-
// per-artifact convention the rest of the repo uses (CAREER_OPS_TRACKER,
// CAREER_OPS_FOLLOWUPS, CAREER_OPS_ADDITIONS, ...). Only the state file was
// overridable before, which left the audit trail, the shortlist and the tracker
// TSVs pinned to the real repo: any test of `start`/`ingest`/`finish` appended
// to the user's own data/loop-run-log.md and dropped rows into their tracker
// queue. An untestable write path is an untested one, and this is the path that
// promotes candidates. CAREER_OPS_ADDITIONS is deliberately the same variable
// merge-tracker.mjs reads, so redirecting it moves both ends of the handoff.
const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.CAREER_OPS_LOOP_STATE || join(ROOT, 'data', 'loop-state.json');
const SHORTLIST_PATH = process.env.CAREER_OPS_LOOP_SHORTLIST || join(ROOT, 'data', 'loop-shortlist.md');
const RUN_LOG_PATH = process.env.CAREER_OPS_LOOP_RUN_LOG || join(ROOT, 'data', 'loop-run-log.md');
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(ROOT, 'data', 'pipeline.md');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(ROOT, 'config', 'profile.yml');
const TSV_DIR = process.env.CAREER_OPS_ADDITIONS || join(ROOT, 'batch', 'tracker-additions');

// ── State I/O ───────────────────────────────────────────────────────────────

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch (err) {
    console.error(`scan-loop: could not parse ${PROFILE_PATH} — ${err.message}`);
    return {};
  }
}

function loadState() {
  const config = resolveLoopConfig(loadProfile());
  if (!existsSync(STATE_PATH)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_PATH, 'utf-8')), config);
  } catch (err) {
    throw new Error(`loop state at ${STATE_PATH} is unreadable (${err.message}). `
      + 'Inspect it, or start a fresh run with `node scan-loop.mjs start --reset`.');
  }
}

/** Write-then-rename: an interrupted write must never leave a half-run on disk. */
function saveState(state) {
  state.updated_at = new Date().toISOString();
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_PATH);
}

function log(state, event, detail = '') {
  mkdirSync(dirname(RUN_LOG_PATH), { recursive: true });
  if (!existsSync(RUN_LOG_PATH)) {
    writeFileSync(RUN_LOG_PATH, '# Loop run log\n\nAppend-only. Written by `scan-loop.mjs`.\n\n', 'utf-8');
  }
  appendFileSync(RUN_LOG_PATH, `${renderRunLogEntry(state, event, detail)}\n`, 'utf-8');
}

function requireState() {
  const state = loadState();
  if (!state) {
    throw new Error('no loop run in progress — start one with `node scan-loop.mjs start`.');
  }
  return state;
}

// ── Pipeline snapshot ───────────────────────────────────────────────────────

/**
 * Read the scanner's own output surface rather than parsing each scanner's
 * stdout. `scan.mjs` and `scan-ats-full.mjs` print different summaries and only
 * one of them speaks `--json`, but both write the same `data/pipeline.md` rows —
 * so diffing the inbox is the one snapshot that works for every rung, including
 * rungs added later.
 */
function pipelineSnapshot() {
  if (!existsSync(PIPELINE_PATH)) return [];
  return parsePipeline(readFileSync(PIPELINE_PATH, 'utf-8')).pending;
}

function diffPipeline(before) {
  const seen = new Set(before.map((e) => e.url));
  return pipelineSnapshot().filter((e) => !seen.has(e.url));
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdStart(flags) {
  const config = resolveLoopConfig(loadProfile());
  if (Number.isFinite(flags.target)) config.target = flags.target;
  if (Number.isFinite(flags['min-score'])) config.minScore = flags['min-score'];

  const existing = existsSync(STATE_PATH) ? loadState() : null;
  if (existing && existing.phase !== 'done' && !flags.reset) {
    const stats = summarize(existing);
    throw new Error(`a run is already in progress (${stats.qualified}/${stats.target} qualified, `
      + `${stats.waves} wave(s)). Continue it with \`next\`, or discard it with \`start --reset\`.`);
  }

  const state = newState(config);
  saveState(state);
  log(state, 'start', `target=${config.target} minScore=${config.minScore}`);
  return { started: true, config, next: decideNextAction(state) };
}

function cmdNext() {
  const state = requireState();
  const decision = decideNextAction(state);
  // A halt is a real outcome, not a transient view — record it so `status` and
  // the shortlist both explain why the run stopped short.
  if (decision.action === 'halt' && !state.halted_reason) {
    state.halted_reason = decision.reason;
    saveState(state);
    log(state, 'halt', decision.reason);
  }
  // Say which COMMAND advances the loop, not just which strategy is due.
  //
  // A scan decision carries `strategy.command`/`strategy.args`, and an agent
  // reading that naturally runs it directly — but only `wave` snapshots the
  // inbox, records the rung and advances the state. Running the strategy by
  // hand scans for real, adds postings, and leaves the loop exactly where it
  // was, so the next `next` returns the identical wave: a loop that never
  // terminates while looking like it is working. Observed on a wave-2
  // reverse-ATS sweep that added 311 postings and moved the counters zero.
  if (decision.action === 'scan') {
    decision.instructions = decision.strategy?.kind === 'agent'
      ? 'Run `node scan-loop.mjs wave` — it will hand this rung back to you with an ingest contract.'
      : 'Run `node scan-loop.mjs wave` (NOT strategy.command directly — only `wave` records the rung '
        + 'and advances the loop). `strategy` is shown so you know what it will run.';
  }
  return decision;
}

function cmdWave(flags) {
  const state = requireState();
  const decision = decideNextAction(state);
  if (decision.action !== 'scan') {
    throw new Error(`next action is "${decision.action}", not "scan" — ${decision.reason}`);
  }

  const { strategy, wave } = decision;
  if (strategy.kind === 'agent') {
    // No script exists for open-ended web discovery. Hand the rung back to the
    // agent with an explicit contract instead of pretending it ran.
    return {
      action: 'agent-scan',
      wave,
      strategy: strategy.id,
      instructions: `Run ${strategy.describe}. Collect {url, company, title, location} for every `
        + 'hit that passes portals.yml title_filter/location_filter, write them as a JSON array, '
        + 'then run `node scan-loop.mjs ingest --file <that file>`.',
    };
  }

  const before = pipelineSnapshot();
  const started = new Date().toISOString();
  const args = flags['dry-run'] ? [...strategy.args, '--dry-run'] : strategy.args;
  // The scanner's progress goes to OUR stderr, not our stdout: a rung runs for
  // minutes so its output has to stream live, but this command's contract is a
  // single JSON object on stdout and an agent piping it to a parser must not
  // get the scanner's summary mixed into it. `2` maps the child's stdout onto
  // fd 2 — still live, just on the other stream.
  const result = spawnSync(strategy.command, args, { cwd: ROOT, stdio: ['ignore', 2, 'inherit'] });

  if (result.error) {
    throw new Error(`wave ${wave} (${strategy.id}) could not start: ${result.error.message}`);
  }
  // A scanner exiting non-zero is a partial wave, not a dead loop — record it
  // and let the ladder widen rather than stranding the run.
  const found = diffPipeline(before);
  const { added, duplicate } = ingestOffers(state, found, wave);

  state.waves.push({
    n: wave,
    strategy: strategy.id,
    started_at: started,
    finished_at: new Date().toISOString(),
    exit_code: result.status ?? null,
    found: found.length,
    added,
    duplicate,
  });
  saveState(state);
  log(state, 'wave', `${strategy.id} exit=${result.status} found=${found.length} new=${added}`);

  return { wave, strategy: strategy.id, exitCode: result.status, found: found.length, added, duplicate, next: decideNextAction(state) };
}

function cmdIngest(flags) {
  const state = requireState();
  if (!flags.file) throw new Error('ingest needs `--file <offers.json>` (a JSON array of {url, company, title, location}).');
  const offers = JSON.parse(readFileSync(flags.file, 'utf-8'));
  if (!Array.isArray(offers)) throw new Error(`${flags.file} must contain a JSON array of offers.`);

  const wave = state.waves.length + 1;
  const strategy = WAVE_STRATEGIES[state.waves.length];
  const counts = ingestOffers(state, offers, wave);
  state.waves.push({
    n: wave,
    strategy: strategy ? strategy.id : 'manual',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    exit_code: 0,
    found: offers.length,
    added: counts.added,
    duplicate: counts.duplicate,
  });
  saveState(state);
  log(state, 'ingest', `wave=${wave} found=${offers.length} new=${counts.added}`);
  return { wave, ...counts, next: decideNextAction(state) };
}

/**
 * Accept scores in either shape the agent can produce:
 *   - a JSON array of `{key, score, verdict?, reason?}` (preferred, unambiguous)
 *   - raw text containing `key<TAB>TRIAGE: ...` lines straight from triage mode
 *
 * The TSV form exists because asking a subagent for strict JSON and getting
 * prose-wrapped JSON back is the most common failure in this loop; a tab and a
 * TRIAGE line survive that.
 */
function parseScoreFile(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('score file JSON must be an array.');
    return parsed;
  }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [verdict] = parseTriageOutput(line.slice(tab + 1));
    if (verdict) out.push({ key: line.slice(0, tab).trim(), ...verdict });
  }
  return out;
}

function cmdRecord(flags) {
  const state = requireState();
  if (!flags.file) throw new Error('record needs `--file <scores.json>` (JSON array, or key<TAB>TRIAGE lines).');
  const results = parseScoreFile(readFileSync(flags.file, 'utf-8'));
  const counts = recordScores(state, results);
  saveState(state);
  log(state, 'score', `scored=${counts.scored} qualified=${counts.qualified} unmatched=${counts.unknown.length}`);

  if (counts.scored === 0) {
    // Silently recording nothing would look like a barren wave and trip the
    // circuit breaker for the wrong reason.
    throw new Error(`no score in ${flags.file} matched a candidate in this run `
      + `(${counts.unknown.length} unmatched key(s)). Re-run \`next\` and use the exact \`key\` values it returned.`);
  }
  return { ...counts, next: decideNextAction(state) };
}

function cmdStatus() {
  const state = loadState();
  if (!state) return { running: false };
  return {
    running: state.phase !== 'done',
    run_id: state.run_id,
    phase: state.phase,
    halted_reason: state.halted_reason,
    ...summarize(state),
    waves: state.waves,
    next: decideNextAction(state),
  };
}

// ── finish: promote to the review gate and the dashboard ────────────────────

/** `reserve-report-num.mjs` refuses a `--count` above this, in one call or one release. */
const RESERVE_CHUNK = 50;

/**
 * Claim tracker numbers for the rows about to be written.
 *
 * Returns the reservation ranges alongside the numbers instead of releasing
 * them here: the sentinels are what stops a second process taking the same
 * numbers, and the tracker rows only start holding them once `merge-tracker.mjs`
 * has run. `cmdFinish` releases after the merge — see `releaseNumbers`.
 */
function reserveNumbers(count) {
  const numbers = [];
  const ranges = [];
  for (let claimed = 0; claimed < count; claimed += RESERVE_CHUNK) {
    const size = Math.min(RESERVE_CHUNK, count - claimed);
    const args = size === 1 ? [] : ['--count', String(size)];
    const res = spawnSync('node', ['reserve-report-num.mjs', ...args], { cwd: ROOT, encoding: 'utf-8' });
    if (res.error || res.status !== 0) {
      // Hand back whatever was already claimed — an abandoned sentinel would sit
      // there for 4h blocking those numbers for no reason.
      releaseNumbers(ranges);
      throw new Error(`could not reserve tracker numbers: ${(res.stderr || res.error?.message || '').trim()}`);
    }
    const out = res.stdout.trim();
    ranges.push(out);
    const [first, last] = out.split('-');
    const start = parseInt(first, 10);
    const end = last ? parseInt(last, 10) : start;
    for (let n = start; n <= end; n++) numbers.push(n);
  }
  return { numbers, ranges };
}

/**
 * Drop the reservation sentinels. Best-effort by design: the numbers are held by
 * the tracker rows themselves from here on, and a leftover sentinel is
 * garbage-collected after 4h anyway, so a failure here must not fail the run.
 */
function releaseNumbers(ranges) {
  for (const range of ranges) {
    spawnSync('node', ['reserve-report-num.mjs', '--release', range], { cwd: ROOT, encoding: 'utf-8' });
  }
}

/**
 * One TSV per row, merged by `merge-tracker.mjs` — never edit the tracker directly.
 *
 * The posting URL is appended as the optional trailing field, and that is
 * load-bearing rather than decorative: merge-tracker matches on URL FIRST and
 * treats a confirmed mismatch on both sides as proof two rows are NOT
 * duplicates. Without it the only signal left is fuzzy company+role, which
 * collapses distinct postings whenever the board publishes no employer.
 *
 * Observed 2026-08-19: stellenwerk lists postings without a company, so two
 * different Nuremberg HiWi roles ("Prototype Engineer" and "Test Engineer")
 * arrived as company `?` with near-identical titles, fuzzy-matched, and the
 * second overwrote the first as a "downgrade" — nine promoted candidates became
 * eight tracker rows and one real posting vanished silently. The loop held both
 * URLs the whole time and was discarding them here.
 */
function writeTrackerAdditions(candidates, date) {
  mkdirSync(TSV_DIR, { recursive: true });
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  let written = 0;
  for (const c of candidates) {
    if (!c.reportNum) continue;
    const slug = (cell(c.company) || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const note = `triage-only from loop wave ${c.wave} — full evaluation pending`;
    const url = cell(c.url);
    const row = [
      c.reportNum, date, cell(c.company) || '?', cell(c.title) || 'Unknown role',
      'Evaluated', `${c.score.toFixed(1)}/5`, '❌', '—', note,
      // Detected by its http(s):// prefix, so it stays order-independent with
      // the optional location/via fields. Omitted entirely when absent rather
      // than written empty, which would read as a confirmed-blank URL.
      ...(/^https?:\/\//i.test(url) ? [url] : []),
    ].join('\t');
    writeFileSync(join(TSV_DIR, `${String(c.reportNum).padStart(3, '0')}-${slug}.tsv`), `${row}\n`, 'utf-8');
    written++;
  }
  return written;
}

function cmdFinish(flags) {
  const state = requireState();
  const decision = decideNextAction(state);
  if (decision.action === 'score' && !flags.force) {
    throw new Error(`${decision.stats.unscored} candidate(s) are still unscored — finish them first, `
      + 'or pass `--force` to promote only what has been scored.');
  }

  const rows = qualifiedCandidates(state);
  const unnumbered = rows.filter((c) => !c.reportNum);
  // Destructure: reserveNumbers returns {numbers, ranges}, and indexing the
  // object itself handed every candidate `undefined ?? null`, so
  // writeTrackerAdditions skipped all of them on its `!c.reportNum` guard —
  // `finish` promoted to the shortlist and silently wrote zero tracker rows.
  const { numbers, ranges } = reserveNumbers(unnumbered.length);
  unnumbered.forEach((c, i) => { c.reportNum = numbers[i] ?? null; });

  const date = new Date().toISOString().slice(0, 10);
  const tsvCount = writeTrackerAdditions(rows, date);

  // merge-tracker is the only sanctioned writer of data/applications.md, and
  // data/applications.md is what the dashboard reads.
  // Same split as `wave`: merge-tracker's report stays visible, but on stderr,
  // so `finish` keeps emitting exactly one JSON object on stdout.
  const merge = spawnSync('node', ['merge-tracker.mjs'], { cwd: ROOT, stdio: ['ignore', 2, 'inherit'] });
  const merged = !merge.error && merge.status === 0;
  // The tracker rows hold the numbers from here on, so the sentinels have done
  // their job. reserveNumbers' own docblock says the release happens after the
  // merge; it never did, and every finished run left its reservations sitting
  // for the full 4h GC window, pushing the next run's numbers up for nothing.
  releaseNumbers(ranges);

  writeFileSync(SHORTLIST_PATH, renderShortlist(state), 'utf-8');
  state.phase = 'done';
  saveState(state);
  log(state, 'finish', `promoted=${rows.length} tsv=${tsvCount} merged=${merged}`);

  return {
    promoted: rows.length,
    trackerRows: tsvCount,
    merged,
    shortlist: 'data/loop-shortlist.md',
    haltedReason: state.halted_reason,
    reviewGate: 'Review data/loop-shortlist.md, then run `/career-ops pipeline`.',
  };
}

function cmdAbort(flags) {
  const state = requireState();
  state.phase = 'done';
  state.halted_reason = flags.note || 'aborted by the user';
  saveState(state);
  log(state, 'abort', state.halted_reason);
  return { aborted: true, reason: state.halted_reason };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `scan-loop.mjs — loop controller for /career-ops scan

  start [--target N] [--min-score X] [--reset]   begin a run
  next                                            what to do next (JSON)
  wave [--dry-run]                                run the next scan rung
  ingest --file <offers.json>                     hand-scanned offers in
  record --file <scores.json>                     feed triage scores back
  finish [--force]                                promote to shortlist + tracker
  status [--summary]                              current run state
  abort [--note "..."]                            end a run without promoting

Config lives in config/profile.yml -> loop:. Defaults: ${JSON.stringify(DEFAULT_LOOP_CONFIG)}
The loop definition, budgets and gates are documented in LOOP.md.`;

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

function printSummary(result) {
  if (result.running === false) { console.log('No loop run in progress. Start one: node scan-loop.mjs start'); return; }
  const s = result;
  console.log(`Loop run ${s.run_id ?? ''}`.trim());
  console.log(`  waves       ${s.waves?.length ?? s.waves ?? 0}`);
  console.log(`  discovered  ${s.discovered}`);
  console.log(`  triaged     ${s.scored}  (${s.unscored} pending)`);
  console.log(`  qualified   ${s.qualified}/${s.target} at or above ${s.minScore}`);
  if (s.halted_reason) console.log(`  halted      ${s.halted_reason}`);
  if (s.next) console.log(`  next        ${s.next.action} — ${s.next.reason}`);
}

const COMMANDS = {
  start: cmdStart, next: cmdNext, wave: cmdWave, ingest: cmdIngest,
  record: cmdRecord, finish: cmdFinish, status: cmdStatus, abort: cmdAbort,
};

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`scan-loop: unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }

  const flags = parseFlags(argv.slice(1));
  try {
    const result = handler(flags);
    if (flags.summary) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`scan-loop: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
