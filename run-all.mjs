#!/usr/bin/env node

/**
 * run-all.mjs — the driver for `/career-ops run`, the end-to-end pass.
 *
 * `run-core.mjs` decides which stage is next; this file performs it and
 * persists the result. Same split as `loop-core.mjs` / `scan-loop.mjs`, for the
 * same reason: the control law stays unit-testable without a live job board,
 * and exactly one file touches disk.
 *
 * Four stages, in dependency order — each consumes what the previous produced:
 *
 *   1. scan      deep search (scan-loop.mjs) until enough new postings qualify
 *   2. pipeline  evaluate every pending URL into a report + tracker row
 *   3. kits      a tailored CV *and* cover letter for each qualifying row
 *   4. sync      reconcile the tracker, PDF flags, follow-up seeds, dashboard
 *
 * The agent drives it by calling `next` and doing what it says:
 *
 *   node run-all.mjs start [--skip-scan] [--reset]
 *   node run-all.mjs next               # {stage, action, reason, instructions}
 *   node run-all.mjs advance            # mark the current stage complete
 *   node run-all.mjs sync               # perform stage 4 (zero tokens)
 *   node run-all.mjs status [--summary]
 *   node run-all.mjs abort [--note "..."]
 *
 * Stages 1 and 4 are zero-token: `sync` runs entirely here, and `scan` is a
 * thin wrapper over scan-loop.mjs, which is itself zero-token except for its
 * triage steps. Stages 2 and 3 need a model, so they are handed back with an
 * explicit contract rather than faked.
 *
 * **This command never submits anything.** It produces drafts — reports, CVs,
 * cover letters — for the user to review. `AGENTS.md` -> Ethical Use holds in
 * full: no form is filled, no message is sent, no Apply button is clicked.
 *
 * State: data/run-state.json · Audit trail: data/run-log.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import {
  STAGES, STAGE_INFO, DEFAULT_RUN_CONFIG,
  resolveRunConfig, newRun, normalizeRun, decideNextStage,
  currentStage, isFinished, kitCandidates, summarize, renderRunLogEntry,
} from './run-core.mjs';
import { parsePipeline } from './triage-prefilter.mjs';
import { HALT_ABORTED, classifyHaltReason } from './loop-core.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

// Every artifact is redirectable through the one-env-var-per-artifact
// convention the rest of the repo uses, so the suite can exercise the real
// write paths without touching the user's own run state or tracker.
const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.CAREER_OPS_RUN_STATE || join(ROOT, 'data', 'run-state.json');
const RUN_LOG_PATH = process.env.CAREER_OPS_RUN_LOG || join(ROOT, 'data', 'run-log.md');
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(ROOT, 'data', 'pipeline.md');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(ROOT, 'config', 'profile.yml');
const TRACKER_PATH = process.env.CAREER_OPS_TRACKER || join(ROOT, 'data', 'applications.md');

// ── State I/O ───────────────────────────────────────────────────────────────

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch (err) {
    console.error(`run-all: could not parse ${PROFILE_PATH} — ${err.message}`);
    return {};
  }
}

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return normalizeRun(JSON.parse(readFileSync(STATE_PATH, 'utf-8')), resolveRunConfig(loadProfile()));
  } catch (err) {
    throw new Error(`run state at ${STATE_PATH} is unreadable (${err.message}). `
      + 'Inspect it, or start a fresh pass with `node run-all.mjs start --reset`.');
  }
}

/** Write-then-rename: an interrupted write must never leave half a run on disk. */
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
    writeFileSync(RUN_LOG_PATH, '# End-to-end run log\n\nAppend-only. Written by `run-all.mjs`.\n\n', 'utf-8');
  }
  appendFileSync(RUN_LOG_PATH, `${renderRunLogEntry(state, event, detail)}\n`, 'utf-8');
}

function requireState() {
  const state = loadState();
  if (!state) throw new Error('no run in progress — start one with `node run-all.mjs start`.');
  return state;
}

// ── Observations the control law needs ──────────────────────────────────────

/**
 * Ask scan-loop.mjs where its run stands.
 *
 * Shelling out rather than reading data/loop-state.json directly keeps
 * scan-loop the sole interpreter of its own state file — the loop normalizes
 * older state shapes on load, and a second reader would silently skip that.
 */
function loopFacts() {
  const res = spawnSync('node', ['scan-loop.mjs', 'status'], { cwd: ROOT, encoding: 'utf-8' });
  if (res.error || res.status !== 0) return { done: false, phase: null, qualified: 0, available: false };
  try {
    const status = JSON.parse(res.stdout);
    if (status.running === false && !status.run_id) return { done: false, phase: null, qualified: 0, available: true };
    // `abort` and `finish` both set phase='done' — byte-identical state apart
    // from halted_reason (scan-loop.mjs cmdAbort vs cmdFinish). Reading phase
    // alone therefore cannot tell "the scan completed" from "the scan was
    // abandoned", and a run pass started after an abort SKIPPED THE ENTIRE SCAN
    // STAGE believing discovery had already happened. Observed live: a pass
    // jumped straight to Stage 1b, silently missing wave 1 (portals — including
    // newly added providers) and wave 2 (interamt).
    //
    // The phase value itself is deliberately not changed: three places depend on
    // `phase === 'done'` (loop-core's decideNextAction, cmdStart's
    // already-running guard, and the `running` flag), so the inference is fixed
    // here rather than the vocabulary everywhere.
    // Not "was there a halt" — "was it a GIVING UP".
    //
    // Every reason the loop can halt on by itself is a bound it was given:
    // scoring budget, wave budget, ladder exhausted, or the circuit breaker
    // after consecutive barren waves. All four are the loop working — it
    // looked, the cheap sources were empty, and it declined to escalate into a
    // multi-hour sweep to prove it a second time. Only an explicit `abort` is a
    // run that delivered nothing.
    //
    // Reading the mere PRESENCE of halted_reason as abnormal meant a pass whose
    // scan honestly found nothing was told to start a FRESH loop. That loop ran
    // the same two waves, tripped the same breaker, and produced the same
    // instruction — a retry that could only repeat itself, up to
    // maxStageAttempts full portal scans (~11,500 postings each) to relearn
    // what the first one had already established.
    const endedAbnormally = (status.halted_kind ?? classifyHaltReason(status.halted_reason)) === HALT_ABORTED;
    return {
      done: status.phase === 'done' && !endedAbnormally,
      // The loop's own start timestamp. decideNextStage compares it against the
      // pass's `started_at` so a completed loop from a PREVIOUS pass cannot
      // satisfy this one's scan stage.
      runId: status.run_id ?? null,
      endedAbnormally,
      haltedReason: status.halted_reason ?? null,
      phase: status.phase ?? null,
      qualified: status.qualified ?? 0,
      available: true,
    };
  } catch {
    return { done: false, phase: null, qualified: 0, available: false };
  }
}

function pendingUrlCount() {
  if (!existsSync(PIPELINE_PATH)) return 0;
  return parsePipeline(readFileSync(PIPELINE_PATH, 'utf-8')).pending.length;
}

/** Parse the tracker into rows, tolerating both the root and data/ locations. */
function trackerRows() {
  if (!existsSync(TRACKER_PATH)) return [];
  const lines = readFileSync(TRACKER_PATH, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

/**
 * Observe only what the current stage's decision actually depends on.
 *
 * The naive version gathered all three every call, which meant every `next` and
 * every `status` spawned a `scan-loop.mjs` subprocess and re-parsed the tracker
 * even when the scan stage had been complete for hours. The control law only
 * reads the fact belonging to the stage it is deciding, so gathering the rest is
 * pure cost — and the subprocess was the expensive part.
 *
 * The `stage-complete` path still needs the NEXT stage's fact on the following
 * call, which it gets because `cmdNext` re-gathers after advancing.
 */
function gatherFacts(state) {
  const stage = currentStage(state);
  const facts = {};
  if (stage === 'scan') {
    facts.loop = loopFacts();
    // Recorded by `note-sources`. Kept in run state, not derived, because
    // "did the agent sweep Indeed this pass" is not observable from any file —
    // an ingest that found nothing looks identical to one that never ran.
    facts.agentSourcesSwept = Boolean(state.agent_sources_swept);
  }
  if (stage === 'pipeline') facts.pendingUrls = pendingUrlCount();
  if (stage === 'kits') facts.kitCandidates = kitCandidates(trackerRows(), state.config.kitThreshold);
  return facts;
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdStart(flags) {
  const config = resolveRunConfig(loadProfile());
  if (Number.isFinite(flags.target)) config.target = flags.target;
  if (Number.isFinite(flags['min-score'])) config.minScore = flags['min-score'];
  if (Number.isFinite(flags['kit-threshold'])) config.kitThreshold = flags['kit-threshold'];

  const existing = existsSync(STATE_PATH) ? loadState() : null;
  if (existing && !isFinished(existing) && !existing.halted_reason && !flags.reset) {
    const s = summarize(existing);
    throw new Error(`a pass is already in progress (stage "${s.stage}", ${s.completed}/${s.total} done). `
      + 'Continue it with `next`, or discard it with `start --reset`.');
  }

  const skip = STAGES.filter((stage) => flags[`skip-${stage}`] === true);
  const state = newRun(config, { skip });
  saveState(state);
  log(state, 'start', `skip=[${skip.join(',')}] kitThreshold=${config.kitThreshold}`);
  return { started: true, config: state.config, skipped: skip, next: decideNextStage(state, gatherFacts(state)) };
}

/**
 * Report the next action, auto-completing any stage whose exit condition is
 * already satisfied.
 *
 * The auto-complete is what makes a resumed pass cheap: an inbox that another
 * session already drained should roll straight past the pipeline stage rather
 * than asking the agent to go and look. It loops because clearing one stage can
 * reveal that the next is also already satisfied.
 */
function cmdNext() {
  const state = requireState();

  for (let guard = 0; guard <= STAGES.length; guard++) {
    const decision = decideNextStage(state, gatherFacts(state));

    if (decision.action === 'stage-complete') {
      state.completed.push(decision.stage);
      saveState(state);
      log(state, 'stage-complete', `${decision.stage} — ${decision.reason}`);
      continue;
    }

    // A halt is a real outcome, not a transient view — persist it so `status`
    // explains why the pass stopped, instead of silently re-deciding next time.
    if (decision.action === 'halt' && !state.halted_reason) {
      state.halted_reason = decision.reason;
      saveState(state);
      log(state, 'halt', decision.reason);
    }

    // Count the attempt only for stages handed back to the agent. Counting
    // `sync` here would burn the budget on the one stage the driver performs
    // itself, and counting a completed stage would be meaningless.
    if (decision.agent) {
      state.attempts[decision.stage] = (state.attempts[decision.stage] ?? 0) + 1;
      saveState(state);
    }

    return decision;
  }

  // Unreachable while STAGES is finite and each pass either completes a stage or
  // returns; kept so a future stage-graph change fails loudly instead of hanging.
  throw new Error('stage resolution did not converge — inspect data/run-state.json');
}

function cmdAdvance(flags) {
  const state = requireState();
  const stage = flags.stage || currentStage(state);
  if (!stage) return { advanced: false, reason: 'the pass is already finished' };
  if (!STAGES.includes(stage)) {
    throw new Error(`unknown stage "${stage}" — one of: ${STAGES.join(', ')}`);
  }
  if (state.completed.includes(stage)) {
    return { advanced: false, stage, reason: `stage "${stage}" is already complete` };
  }

  state.completed.push(stage);
  // Advancing past a halted stage is the sanctioned way to unstick a pass, so
  // the halt has to clear with it — otherwise `next` would keep reporting the
  // halt for a stage that is no longer pending.
  if (state.halted_reason) state.halted_reason = null;
  saveState(state);
  log(state, 'advance', `${stage}${flags.note ? ` — ${flags.note}` : ''}`);
  return { advanced: true, stage, next: decideNextStage(state, gatherFacts(state)) };
}

// ── sync: reconcile everything the dashboard reads ──────────────────────────

/**
 * The sync stage, in order.
 *
 * `required` steps are writes: if one fails the tracker is left inconsistent
 * and the pass must exit non-zero. The last two are not writes — `verify` is a
 * health check whose findings are the user's to act on, and the dashboard build
 * needs a Go toolchain that is genuinely optional. Failing the whole pass
 * because Go is not installed would punish the user for a missing dependency of
 * a component they may never open, so those are reported and not fatal.
 */
export const SYNC_STEPS = [
  { id: 'merge-tracker', args: ['merge-tracker.mjs'], required: true, describe: 'merge pending tracker TSVs' },
  { id: 'pdf-flags', args: ['sync-pdf-flags.mjs'], required: true, describe: 'reconcile PDF flags with output/' },
  { id: 'followup-seed', args: ['followup-seed.mjs', '--backfill'], required: true, describe: 'seed follow-up dates for Applied rows' },
  // Both of these are reports, not writes, and both make ZERO requests — they
  // re-derive from values already on disk. `deadline-sweep` never writes here:
  // retiring a row is `--apply`, which stays a decision the user makes.
  { id: 'deadlines', args: ['deadline-sweep.mjs'], required: false, describe: 'expired / closing-soon by recorded deadline (no fetch)' },
  { id: 'provider-health', args: ['provider-health.mjs'], required: false, describe: 'scrapers returning junk without erroring (no fetch)' },
  { id: 'verify', args: ['verify-pipeline.mjs'], required: false, describe: 'pipeline health check' },
  { id: 'dashboard', args: ['build-dashboard.mjs'], required: false, describe: 'rebuild the dashboard binary' },
];

function cmdSync(flags) {
  const state = loadState();
  const steps = [];
  let failedRequired = false;

  for (const step of SYNC_STEPS) {
    if (flags['skip-dashboard'] && step.id === 'dashboard') {
      steps.push({ ...stepShape(step), status: 'skipped', reason: '--skip-dashboard' });
      continue;
    }
    if (flags['dry-run']) {
      steps.push({ ...stepShape(step), status: 'planned' });
      continue;
    }

    // Child output streams live to stderr, keeping this command's stdout a
    // single JSON object an agent can pipe straight into a parser.
    const res = spawnSync('node', step.args, { cwd: ROOT, stdio: ['ignore', 2, 'inherit'] });
    const ok = !res.error && res.status === 0;
    steps.push({
      ...stepShape(step),
      status: ok ? 'ok' : 'failed',
      exitCode: res.status ?? null,
      ...(res.error ? { error: res.error.message } : {}),
    });
    if (!ok && step.required) {
      failedRequired = true;
      break;   // a later write on top of a failed merge would compound the damage
    }
  }

  const result = {
    synced: !failedRequired,
    dryRun: Boolean(flags['dry-run']),
    steps,
    dashboard: 'Open it with: npm run serve:dashboard',
  };

  if (state && !flags['dry-run']) {
    // Only consume the sync STAGE when sync is actually the stage that is due.
    // Running `sync` early (to refresh the dashboard mid-pass, which is a
    // reasonable thing to do) used to mark the stage complete anyway — and then
    // once pipeline and kits finished, every stage was complete, `next` said
    // "done", and the final reconciliation never ran. That silently skipped the
    // one step that makes the dashboard match the artifacts just built.
    const stageIsDue = currentStage(state) === 'sync';
    if (!failedRequired && stageIsDue && !state.completed.includes('sync')) state.completed.push('sync');
    result.stageConsumed = !failedRequired && stageIsDue;
    state.stats.syncedAt = new Date().toISOString();
    saveState(state);
    log(state, 'sync', `ok=${!failedRequired} steps=${steps.map((s) => `${s.id}:${s.status}`).join(' ')}`);
    result.finished = isFinished(state);
  }

  if (failedRequired) process.exitCode = 1;
  return result;
}

const stepShape = (step) => ({ id: step.id, describe: step.describe, command: `node ${step.args.join(' ')}` });

function cmdStatus() {
  const state = loadState();
  if (!state) return { running: false };
  return {
    running: !isFinished(state),
    ...summarize(state),
    next: decideNextStage(state, gatherFacts(state)),
  };
}

function cmdAbort(flags) {
  const state = requireState();
  state.halted_reason = flags.note || 'aborted by the user';
  saveState(state);
  log(state, 'abort', state.halted_reason);
  return { aborted: true, reason: state.halted_reason };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `run-all.mjs — end-to-end driver for /career-ops run

  start [--skip-scan] [--skip-pipeline] [--skip-kits] [--reset]
        [--target N] [--min-score X] [--kit-threshold X]   begin a pass
  next                                    what to do next (JSON)
  advance [--stage NAME] [--note "..."]   mark the current stage complete
  sync [--dry-run] [--skip-dashboard]     run stage 4 (zero tokens)
  status [--summary]                      current pass state
  abort [--note "..."]                    stop a pass

Stages: ${STAGES.map((s) => `${s} (${STAGE_INFO[s].agent ? 'agent' : 'zero-token'})`).join(' -> ')}
Config comes from config/profile.yml -> loop:. Defaults: ${JSON.stringify(DEFAULT_RUN_CONFIG)}

Produces drafts only. Nothing here submits an application.`;

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
  if (result.running === false && !result.run_id) {
    console.log('No pass in progress. Start one: node run-all.mjs start');
    return;
  }
  console.log(`Run ${result.run_id ?? ''}`.trim());
  for (const s of result.stages ?? []) {
    const mark = { done: '✅', skipped: '⏭️ ', active: '▶ ', pending: '  ' }[s.state] ?? '  ';
    console.log(`  ${mark} ${s.stage}${s.attempts ? ` (${s.attempts} attempt(s))` : ''}`);
  }
  if (result.halted_reason) console.log(`  halted: ${result.halted_reason}`);
  if (result.next) console.log(`  next: ${result.next.action} — ${result.next.reason}`);
}

/**
 * Record that the agent-driven sources (modes/run.md → Stage 1b) were swept
 * this pass — or deliberately skipped, with a reason.
 *
 * This exists because the fact is not observable anywhere else: an Indeed
 * sweep that legitimately found nothing writes exactly what a sweep that never
 * happened writes, i.e. nothing. Without an explicit record the scan stage
 * completed on the loop alone and the omission was silent.
 */
function cmdNoteSources(flags) {
  const state = loadState();
  const note = typeof flags.note === 'string' ? flags.note.trim() : '';
  if (!note) {
    throw new Error('note-sources needs --note "what you swept, or why you skipped it" — the note is the '
      + 'audit trail for a stage that cannot otherwise be verified.');
  }
  state.agent_sources_swept = true;
  state.agent_sources_note = note;
  state.agent_sources_at = new Date().toISOString();
  saveState(state);
  return { recorded: true, note, next: decideNextStage(state, gatherFacts(state)) };
}

const COMMANDS = {
  start: cmdStart, next: cmdNext, advance: cmdAdvance, 'note-sources': cmdNoteSources,
  sync: cmdSync, status: cmdStatus, abort: cmdAbort,
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
    console.error(`run-all: unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }

  const flags = parseFlags(argv.slice(1));
  try {
    const result = handler(flags);
    if (flags.summary) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`run-all: ${err.message}`);
    process.exit(1);
  }
}

main();
