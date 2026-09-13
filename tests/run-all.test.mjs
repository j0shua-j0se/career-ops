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
import { pathToFileURL } from 'url';
import { SYNC_STEPS } from '../run-all.mjs';

console.log('\nUtility - run-all (end-to-end run driver)');

const SCRIPT = join(ROOT, 'run-all.mjs');

// ── direct-invocation guard (#run-all-entry-guard) ──────────────────────────
// This suite (and test-all.mjs's discovered-suite runner) statically imports
// SYNC_STEPS from run-all.mjs, and test-all.mjs runs discovered suites
// IN-PROCESS. Before the entry-point guard existed, importing run-all.mjs
// made its unconditional `main()` call read the HOST process's own argv — so
// `node test-all.mjs --quick` made run-all's main() see "--quick", print
// `run-all: unknown command "--quick".`, and process.exit(1), killing
// test-all mid-run before the global summary could print. Reproduced live
// pre-fix: `node test-all.mjs --quick` exited 1 with exactly that message.
//
// Exercised via a child process (not an in-process import) because the old,
// buggy behavior calls process.exit() — which would kill this very test
// process if run in-process here.
{
  const foreignArgv = [
    `process.argv[1] = ${JSON.stringify(join(ROOT, 'test-all.mjs'))};`,
    `process.argv.push('--quick');`,
    `import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`,
    `  .then(() => { console.log('IMPORT_OK'); })`,
    `  .catch((e) => { console.error('IMPORT_FAILED: ' + e.message); process.exitCode = 1; });`,
  ].join('\n');

  let guardResult;
  try {
    const stdout = execFileSync(NODE, ['-e', foreignArgv], {
      cwd: ROOT, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    guardResult = { code: 0, stdout, stderr: '' };
  } catch (e) {
    guardResult = {
      code: e?.status ?? null,
      stdout: e?.stdout == null ? '' : String(e.stdout),
      stderr: e?.stderr == null ? '' : String(e.stderr),
    };
  }

  if (guardResult.code === 0) {
    pass('importing run-all.mjs with a foreign --quick flag on process.argv does not exit the host process');
  } else {
    fail(`importing run-all.mjs with a foreign argv exited ${guardResult.code} — the entry-point guard regressed`);
  }
  if (/IMPORT_OK/.test(guardResult.stdout)) {
    pass('the import resolves normally (main() did not run and did not throw)');
  } else {
    fail(`import did not report IMPORT_OK — stdout: ${guardResult.stdout.slice(0, 200)} stderr: ${guardResult.stderr.slice(0, 200)}`);
  }
  if (!/unknown command/.test(guardResult.stdout + guardResult.stderr)) {
    pass('no "unknown command" output leaks from an import-time argv collision');
  } else {
    fail(`unexpected "unknown command" output: ${(guardResult.stdout + guardResult.stderr).slice(0, 300)}`);
  }
}

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
  const WRITES = ['merge-tracker', 'pdf-flags', 'followup-seed'];
  const REPORTS = ['deadlines', 'provider-health', 'verify', 'dashboard'];
  if (JSON.stringify(planned) === JSON.stringify([...WRITES, ...REPORTS])) {
    pass('sync plans the three writes first, then the four reports, in that order');
  } else {
    fail(`sync planned ${JSON.stringify(planned)}`);
  }
  // The ordering is a data dependency, not taste: every report reads what the
  // writes just reconciled. A report that ran first would describe the tracker
  // as it was before the merge.
  if (WRITES.every((id) => planned.indexOf(id) < Math.min(...REPORTS.map((r) => planned.indexOf(r))))) {
    pass('every write is planned before every report that reads it');
  } else {
    fail(`writes and reports are interleaved: ${JSON.stringify(planned)}`);
  }
  // Both sweeps re-derive from disk and must never fail a pass: they are
  // reports, and a report the user has not read yet is not a broken pipeline.
  // Asserted against SYNC_STEPS itself — the dry-run JSON does not carry
  // `required`, so reading it there would have asserted nothing at all.
  const sweepDefs = SYNC_STEPS.filter((s) => ['deadlines', 'provider-health'].includes(s.id));
  if (sweepDefs.length === 2 && sweepDefs.every((s) => s.required === false)) {
    pass('the zero-fetch sweeps are advisory — neither can fail the pass');
  } else {
    fail(`sweep steps wrong: ${JSON.stringify(sweepDefs)}`);
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

  // ── sync must not consume its stage out of order ───────────────────────────
  // Running `sync` mid-pass to refresh the dashboard is reasonable. Letting it
  // mark the sync STAGE complete is not: once pipeline and kits then finished,
  // every stage was complete, `next` said "done", and the final reconciliation
  // — the step that makes the dashboard match the artifacts just built — was
  // silently skipped.
  {
    const fresh = cli(['start', '--skip-scan', '--reset']);
    if (fresh.code !== 0) fail(`could not reset for the out-of-order sync check (exit ${fresh.code})`);

    // pipeline is due here, not sync.
    const early = cli(['sync', '--skip-dashboard']);
    const st = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (early.code === 0 && !st.completed.includes('sync')) {
      pass('running sync while an earlier stage is due does NOT consume the sync stage');
    } else {
      fail(`early sync left completed=${JSON.stringify(st.completed)}`);
    }
    if (early.json?.stageConsumed === false) {
      pass('sync reports stageConsumed:false when it ran out of order');
    } else {
      fail(`stageConsumed was ${early.json?.stageConsumed}`);
    }

    // Now walk to the sync stage properly and confirm it IS consumed there.
    cli(['advance', '--stage', 'pipeline']);
    cli(['advance', '--stage', 'kits']);
    const due = cli(['sync', '--skip-dashboard']);
    const st2 = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (due.code === 0 && st2.completed.includes('sync') && due.json?.stageConsumed === true) {
      pass('running sync when it is the due stage consumes it and finishes the pass');
    } else {
      fail(`in-order sync left completed=${JSON.stringify(st2.completed)}, stageConsumed=${due.json?.stageConsumed}`);
    }
    if (due.json?.finished === true) pass('the pass reports finished once sync completes in order');
    else fail(`finished was ${due.json?.finished}`);

    // This block walked the pass to completion; the abort checks below need a
    // live pass, so hand them one.
    cli(['start', '--skip-scan', '--reset']);
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
