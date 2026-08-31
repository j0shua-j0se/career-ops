// tests/scan-run-health.test.mjs
//
// A /career-ops run pass on 2026-08-31 concluded "0 applications worth making"
// from a scan that recorded found=2307/errors=19 against a ~7,800/0 baseline.
// Re-running the identical command 100 minutes later returned 7785/0 — the
// machine had rate-limited itself with ~115 liveness requests minutes before.
//
// Nothing was broken. The bug is that NOTHING NOTICED: a degraded run and an
// empty market are indistinguishable downstream, and only one of them is a
// fact about jobs.
import { pass, fail } from './helpers.mjs';
import { assessRun, parseRuns, median, ERROR_LIMIT, FOUND_FLOOR_RATIO } from '../scan-run-health.mjs';
import { barrenWaveStreak } from '../loop-core.mjs';

console.log('\nscan-run-health — a starved scan must not read as an empty market');

const run = (found, errors = 0, status = 'completed') => ({ timestamp: '2026-08-01T00:00:00Z', status, found, errors, newAdded: 0 });
const healthyHistory = [run(7161), run(6916), run(6926), run(6988), run(7792)];

// ── The real incident ───────────────────────────────────────────────────────
{
  const r = assessRun([...healthyHistory, run(2307, 19)]);
  r.verdict === 'degraded'
    ? pass('the 2026-08-31 run (2307 found, 19 errors vs ~7,800) is caught')
    : fail(`the real incident classified ${JSON.stringify(r)}`);
  r.reasons.length === 2
    ? pass('and BOTH signals are reported — the error count and the collapsed yield')
    : fail(`expected two reasons, got ${JSON.stringify(r.reasons)}`);
}

// ── The re-run that proved nothing was broken ───────────────────────────────
{
  const r = assessRun([...healthyHistory, run(7785, 0)]);
  r.verdict === 'healthy'
    ? pass('the healthy re-run (7785 found, 0 errors) passes cleanly')
    : fail(`healthy re-run classified ${JSON.stringify(r)}`);
}

// ── Each signal fires on its own ────────────────────────────────────────────
assessRun([...healthyHistory, run(7500, ERROR_LIMIT)]).verdict === 'degraded'
  ? pass('errors alone are enough, even at full yield') : fail('error signal did not fire alone');
assessRun([...healthyHistory, run(7500, ERROR_LIMIT - 1)]).verdict === 'healthy'
  ? pass('a handful of errors below the limit is still healthy') : fail('error limit too tight');
assessRun([...healthyHistory, run(100, 0)]).verdict === 'degraded'
  ? pass('collapsed yield alone is enough, even with zero errors') : fail('yield signal did not fire alone');

// ── The baseline must be a median, not a mean ───────────────────────────────
{
  // Two starved runs among six: a MEAN would sink the baseline to ~4,800 and
  // wave the next starved run straight through. The median holds at ~7,080.
  const contaminated = [run(7161), run(7000), run(7200), run(6900), run(200), run(200)];
  const r = assessRun([...contaminated, run(2307, 0)]);
  r.verdict === 'degraded'
    ? pass('a minority of past starved runs cannot drag the baseline down enough to hide a new one')
    : fail(`baseline contaminated: ${JSON.stringify(r)}`);
  median([1, 2, 3, 100]) === 2.5 ? pass('median is computed correctly') : fail('median wrong');
}

// ── The guard must not erode itself ─────────────────────────────────────────
{
  // Each heavily-errored run would otherwise join the history and lower the bar
  // for the next one. They are excluded from the baseline outright.
  const eroding = [run(7161), run(7000), run(7200), run(300, 19), run(300, 22), run(300, 25)];
  const r = assessRun([...eroding, run(2307, 0)]);
  r.verdict === 'degraded' && r.baseline > 6000
    ? pass('heavily-errored runs are excluded from the baseline, so the guard cannot erode itself')
    : fail(`guard eroded: verdict=${r.verdict} baseline=${r.baseline}`);
}

// ── "Cannot tell" is not "fine" ─────────────────────────────────────────────
{
  const r = assessRun([run(5000), run(4000)]);
  r.verdict === 'unknown'
    ? pass('too little history reports unknown, never healthy')
    : fail(`thin history classified ${r.verdict}`);
}
assessRun([]).verdict === 'unknown' ? pass('no runs at all is unknown') : fail('empty history mishandled');
{
  // Errors still win over a missing baseline — that signal needs no history.
  const r = assessRun([run(5000), run(1, 40)]);
  r.verdict === 'degraded' ? pass('errors are caught even with no usable baseline') : fail('errors ignored without history');
}

// ── An incomplete run must not become the baseline ──────────────────────────
{
  const r = assessRun([...healthyHistory, run(50, 0, 'aborted'), run(7500, 0)]);
  r.verdict === 'healthy'
    ? pass('a non-completed run is excluded from the baseline')
    : fail(`aborted run polluted the baseline: ${JSON.stringify(r)}`);
}

// ── Parsing ─────────────────────────────────────────────────────────────────
{
  const tsv = 'timestamp\tstatus\tfound\tnew_added\terrors\n2026-08-01\tcompleted\t7161\t528\t0\n';
  const rows = parseRuns(tsv);
  rows.length === 1 && rows[0].found === 7161 && rows[0].errors === 0
    ? pass('scan-runs rows are read by column name') : fail(`parseRuns gave ${JSON.stringify(rows)}`);
}
parseRuns('').length === 0 ? pass('an empty runs file yields nothing') : fail('empty runs file mishandled');

// ── The consequence: a degraded wave cannot end the run ─────────────────────
console.log('\nloop-core — a degraded wave is not a barren wave');
{
  const state = {
    waves: [{ n: 1, degraded: true }, { n: 2 }],
    candidates: {
      a: { wave: 1, verdict: 'rejected' },
      b: { wave: 2, verdict: 'rejected' },
    },
  };
  barrenWaveStreak(state) === 1
    ? pass('a degraded wave is skipped, so two waves count as one barren')
    : fail(`streak was ${barrenWaveStreak(state)}, expected 1`);
}
{
  const state = {
    waves: [{ n: 1 }, { n: 2 }],
    candidates: { a: { wave: 1, verdict: 'rejected' }, b: { wave: 2, verdict: 'rejected' } },
  };
  barrenWaveStreak(state) === 2
    ? pass('two genuinely barren waves still count as two — the breaker still works')
    : fail(`streak was ${barrenWaveStreak(state)}, expected 2`);
}
{
  const state = {
    waves: [{ n: 1 }, { n: 2, degraded: true }],
    candidates: { a: { wave: 1, verdict: 'rejected' }, b: { wave: 2, verdict: 'qualified' } },
  };
  barrenWaveStreak(state) === 0
    ? pass('a qualifying wave still stops the streak outright')
    : fail(`streak was ${barrenWaveStreak(state)}, expected 0`);
}
