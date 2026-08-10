// tests/run-all.test.mjs — driver tests for run-all.mjs (`/career-ops run`).
//
// run-core.test.mjs covers the decision logic in isolation. This suite covers
// the half that only exists on disk: that a pass is durable across processes,
// that it resumes where it left off, and that the state file is written
// atomically enough that a crashed run is resumable rather than corrupt.
//
// Every run here is redirected through the CAREER_OPS_* env vars into a temp
// sandbox, so the suite exercises the real write paths without touching the
// user's own run state, inbox or tracker. The one command that would spawn real
// work — `sync`, which merges the tracker and rebuilds the dashboard — is only
// ever invoked with --dry-run.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\nUtility - run-all (end-to-end run driver)');

const SCRIPT = join(ROOT, 'run-all.mjs');

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-08-01 | Acme | AI Eng | 4.4/5 | Evaluated | ❌ | [1](reports/001-acme-2026-08-01.md) | strong fit |
| 2 | 2026-08-01 | Beta | ML Eng | 3.0/5 | Evaluated | ❌ | [2](reports/002-beta-2026-08-01.md) | below bar |
| 3 | 2026-08-01 | Gamma | PM | 4.9/5 | Applied | ✅ | [3](reports/003-gamma-2026-08-01.md) | sent |
`;

const inbox = (pending) => `# Pipeline\n\n## Pending\n\n${pending.map((u) => `- [ ] ${u}`).join('\n')}\n\n## Processed\n`;

let tmp = '';
try {
  tmp = mkdtempSync(join(tmpdir(), 'run-all-'));
  const statePath = join(tmp, 'run-state.json');
  const pipelinePath = join(tmp, 'pipeline.md');
  const trackerPath = join(tmp, 'applications.md');
  const logPath = join(tmp, 'run-log.md');

  writeFileSync(trackerPath, TRACKER, 'utf-8');
  writeFileSync(pipelinePath, inbox(['https://a.example/1 | Acme | AI Eng', 'https://b.example/2 | Beta | ML Eng']), 'utf-8');

  const env = {
    ...process.env,
    CAREER_OPS_RUN_STATE: statePath,
    CAREER_OPS_RUN_LOG: logPath,
    CAREER_OPS_PIPELINE_FILE: pipelinePath,
    CAREER_OPS_TRACKER: trackerPath,
  };

  /** Run the CLI in the sandbox and parse its single stdout JSON object. */
  function cli(args) {
    try {
      const stdout = execFileSync(NODE, [SCRIPT, ...args], {
        cwd: ROOT, env, encoding: 'utf-8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, json: safeJson(stdout) };
    } catch (e) {
      const stdout = e?.stdout == null ? '' : String(e.stdout);
      return { code: e?.status ?? null, stdout, stderr: e?.stderr == null ? '' : String(e.stderr), json: safeJson(stdout) };
    }
  }
  const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // ── help / unknown command ─────────────────────────────────────────────────
  const help = cli(['--help']);
  if (help.code === 0 && /run-all\.mjs — end-to-end driver/.test(help.stdout)) {
    pass('--help prints usage and exits 0');
  } else {
    fail(`--help exited ${help.code}`);
  }

  // The command must state its own limits: this is the entry point a user is
  // most likely to treat as "do the whole job search for me".
  if (/never submits|submits an application/i.test(help.stdout)) {
    pass('the help text states that nothing is submitted');
  } else {
    fail('the help text does not state that nothing is submitted');
  }

  const unknown = cli(['frobnicate']);
  if (unknown.code === 1 && /unknown command/.test(unknown.stderr ?? '')) {
    pass('an unknown command is a hard error, not a silent no-op');
  } else {
    fail(`unknown command exited ${unknown.code}`);
  }

  // ── status before anything exists ──────────────────────────────────────────
  const cold = cli(['status']);
  if (cold.code === 0 && cold.json?.running === false) {
    pass('status with no state file reports no pass in progress');
  } else {
    fail(`cold status returned ${cold.stdout.slice(0, 200)}`);
  }

  // `next` with no run must refuse rather than silently starting one — an
  // implicit start would pick default budgets the user never chose.
  const nextCold = cli(['next']);
  if (nextCold.code === 1 && /no run in progress/.test(nextCold.stderr ?? '')) {
    pass('next with no run refuses instead of implicitly starting one');
  } else {
    fail(`next with no run exited ${nextCold.code}`);
  }

  // ── start ──────────────────────────────────────────────────────────────────
  const started = cli(['start', '--skip-scan']);
  if (started.code === 0 && started.json?.started === true) pass('start begins a pass');
  else fail(`start exited ${started.code}: ${started.stderr ?? ''}`);

  if (existsSync(statePath)) pass('start writes the state file to the redirected path');
  else fail('start did not write a state file');

  if (started.json?.next?.stage === 'pipeline') {
    pass('--skip-scan starts the pass at the pipeline stage');
  } else {
    fail(`--skip-scan started at ${started.json?.next?.stage}`);
  }

  // A second start must not silently discard a pass in flight.
  const restart = cli(['start']);
  if (restart.code === 1 && /already in progress/.test(restart.stderr ?? '')) {
    pass('starting over an in-flight pass refuses without --reset');
  } else {
    fail(`a second start exited ${restart.code}`);
  }

  const reset = cli(['start', '--skip-scan', '--reset']);
  if (reset.code === 0 && reset.json?.started === true) pass('--reset discards the in-flight pass and starts fresh');
  else fail(`start --reset exited ${reset.code}`);

  // ── next: the pipeline stage ───────────────────────────────────────────────
  const evaluate = cli(['next']);
  if (evaluate.json?.stage === 'pipeline' && evaluate.json?.action === 'evaluate') {
    pass('next reports the pipeline stage while the inbox has pending URLs');
  } else {
    fail(`next returned ${JSON.stringify(evaluate.json)?.slice(0, 200)}`);
  }
  if (evaluate.json?.pending === 2) pass('next counts the pending URLs in the redirected inbox');
  else fail(`next counted ${evaluate.json?.pending} pending URLs, expected 2`);

  // Durability: the attempt counter must survive the process exiting, or the
  // circuit breaker never trips across the separate invocations that are the
  // only way this driver is ever used.
  const secondCall = cli(['next']);
  if (secondCall.json?.attempts === 1) {
    pass('the attempt counter persists across separate processes');
  } else {
    fail(`attempts was ${secondCall.json?.attempts} on the second call, expected 1`);
  }

  // ── next: auto-advance when a stage is already satisfied ───────────────────
  // Draining the inbox out-of-band is exactly what happens when another session
  // ran /career-ops pipeline. Resuming must roll past that stage, not re-ask.
  writeFileSync(pipelinePath, inbox([]), 'utf-8');
  const afterDrain = cli(['next']);
  if (afterDrain.json?.stage === 'kits') {
    pass('an inbox drained by another session auto-completes the pipeline stage');
  } else {
    fail(`after draining the inbox, next returned stage ${afterDrain.json?.stage}`);
  }

  const candidates = afterDrain.json?.candidates ?? [];
  if (candidates.length === 1 && candidates[0].num === 1) {
    pass('the kits stage offers only the qualifying tracker row (4.4, no PDF)');
  } else {
    fail(`kit candidates were ${JSON.stringify(candidates.map((c) => c.num))}, expected [1]`);
  }

  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  if (state.completed.includes('pipeline')) {
    pass('the auto-completed stage is recorded in the state file, not just reported');
  } else {
    fail(`state.completed was ${JSON.stringify(state.completed)}`);
  }

  // ── the run log ────────────────────────────────────────────────────────────
  if (existsSync(logPath)) {
    const logText = readFileSync(logPath, 'utf-8');
    if (/· start ·/.test(logText) && /· stage-complete ·/.test(logText)) {
      pass('the run log records both the start and the auto-completed stage');
    } else {
      fail(`run log missing entries:\n${logText.slice(0, 300)}`);
    }
  } else {
    fail('no run log was written');
  }

  // ── advance ────────────────────────────────────────────────────────────────
  const advanced = cli(['advance', '--note', 'built by hand']);
  if (advanced.json?.advanced === true && advanced.json?.stage === 'kits') {
    pass('advance marks the current stage complete');
  } else {
    fail(`advance returned ${JSON.stringify(advanced.json)?.slice(0, 200)}`);
  }
  if (advanced.json?.next?.stage === 'sync') pass('advancing past kits lands on the sync stage');
  else fail(`after advance, next stage was ${advanced.json?.next?.stage}`);

  const badStage = cli(['advance', '--stage', 'nonsense']);
  if (badStage.code === 1 && /unknown stage/.test(badStage.stderr ?? '')) {
    pass('advance rejects an unknown stage name');
  } else {
    fail(`advance --stage nonsense exited ${badStage.code}`);
  }

  // ── sync --dry-run ─────────────────────────────────────────────────────────
  const dry = cli(['sync', '--dry-run']);
  if (dry.code === 0 && dry.json?.dryRun === true) pass('sync --dry-run exits 0 without running anything');
  else fail(`sync --dry-run exited ${dry.code}`);

  const planned = (dry.json?.steps ?? []).map((s) => s.id);
  if (JSON.stringify(planned) === JSON.stringify(['merge-tracker', 'pdf-flags', 'followup-seed', 'verify', 'dashboard'])) {
    pass('sync plans merge -> pdf-flags -> followup-seed -> verify -> dashboard, in that order');
  } else {
    fail(`sync planned ${JSON.stringify(planned)}`);
  }
  if ((dry.json?.steps ?? []).every((s) => s.status === 'planned')) {
    pass('every sync step is reported as planned, none as run');
  } else {
    fail('a sync step reported a status other than planned during a dry run');
  }

  // merge-tracker is the only sanctioned writer of applications.md; a sync that
  // reached the tracker any other way would bypass its collision handling.
  const mergeStep = (dry.json?.steps ?? []).find((s) => s.id === 'merge-tracker');
  if (mergeStep && /merge-tracker\.mjs/.test(mergeStep.command)) {
    pass('the tracker is reconciled through merge-tracker.mjs');
  } else {
    fail('the sync stage does not route the tracker through merge-tracker.mjs');
  }

  const noDash = cli(['sync', '--dry-run', '--skip-dashboard']);
  const dashStep = (noDash.json?.steps ?? []).find((s) => s.id === 'dashboard');
  if (dashStep?.status === 'skipped') pass('--skip-dashboard skips the Go build step');
  else fail(`--skip-dashboard left the dashboard step at ${dashStep?.status}`);

  // A dry run must not claim progress it did not make.
  const afterDry = JSON.parse(readFileSync(statePath, 'utf-8'));
  if (!afterDry.completed.includes('sync')) {
    pass('sync --dry-run does not mark the sync stage complete');
  } else {
    fail('sync --dry-run marked the stage complete without doing the work');
  }

  // ── abort ──────────────────────────────────────────────────────────────────
  const aborted = cli(['abort', '--note', 'stopping here']);
  if (aborted.json?.aborted === true && aborted.json?.reason === 'stopping here') {
    pass('abort records the reason it was given');
  } else {
    fail(`abort returned ${JSON.stringify(aborted.json)}`);
  }

  const haltedNext = cli(['next']);
  if (haltedNext.json?.action === 'halt' && haltedNext.json?.reason === 'stopping here') {
    pass('next after an abort reports the halt rather than resuming work');
  } else {
    fail(`next after abort returned ${JSON.stringify(haltedNext.json)?.slice(0, 200)}`);
  }

  // advance is the sanctioned way to unstick a halted pass; the halt has to
  // clear with it or `next` would keep reporting a stage that is no longer open.
  const unstick = cli(['advance']);
  if (unstick.json?.advanced === true && unstick.json?.next?.action !== 'halt') {
    pass('advance clears a recorded halt so the pass can continue');
  } else {
    fail(`advance after abort returned ${JSON.stringify(unstick.json)?.slice(0, 200)}`);
  }

  // ── corrupt state ──────────────────────────────────────────────────────────
  // A truncated write (power loss mid-run) must produce an actionable message
  // naming the recovery command, not a raw JSON.parse stack trace.
  writeFileSync(statePath, '{ this is not json', 'utf-8');
  const corrupt = cli(['status']);
  if (corrupt.code === 1 && /unreadable/.test(corrupt.stderr ?? '') && /--reset/.test(corrupt.stderr ?? '')) {
    pass('a corrupt state file yields an actionable error naming `start --reset`');
  } else {
    fail(`corrupt state exited ${corrupt.code} with ${(corrupt.stderr ?? '').slice(0, 200)}`);
  }
} catch (e) {
  fail(`run-all driver tests crashed: ${e.message}`);
} finally {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
