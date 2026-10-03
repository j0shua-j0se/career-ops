// tests/run-rescore.test.mjs — a change to the scoring rules surfaces the rows
// it may have scored too low.
//
// Observed 2026-10-03: the location policy changed, and Infineon "Data
// Analytics & AI" (discarded at 2.8 two days earlier) scored 3.8 when
// re-evaluated. Nothing in the pass pointed at it; a manual sweep did.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { rescoreCandidates } from '../run-core.mjs';

console.log('\nrun-all.mjs — re-score after a scoring-rule change');

{
  const rows = [
    { num: 1, status: 'Evaluated', score: '3.4/5', date: '2026-09-30', report: '[1](reports/001-a.md)', company: 'A', role: 'r' },
    { num: 2, status: 'SKIP', score: '2.9/5', date: '2026-09-30', report: '[2](reports/002-b.md)', company: 'B', role: 'r' },
    { num: 3, status: 'SKIP', score: '2.8/5', date: '2026-09-30', report: '[3](reports/003-c.md)', company: 'C', role: 'r' },
    { num: 4, status: 'Evaluated', score: '3.6/5', date: '2026-09-30', report: '[4](reports/004-d.md)', company: 'D', role: 'r' },
    { num: 5, status: 'Applied', score: '3.2/5', date: '2026-09-30', report: '[5](reports/005-e.md)', company: 'E', role: 'r' },
    { num: 6, status: 'Discarded', score: '3.2/5', date: '2026-09-30', report: '[6](reports/006-f.md)', company: 'F', role: 'r' },
    { num: 7, status: 'Evaluated', score: '3.3/5', date: '2026-07-01', report: '[7](reports/007-g.md)', company: 'G', role: 'r' },
    { num: 8, status: 'Evaluated', score: '3.3/5', date: '2026-09-30', report: '—', company: 'H', role: 'r' },
  ];
  const got = rescoreCandidates(rows, { threshold: 3.5, band: 0.6, since: '2026-08-20' }).map((c) => c.num);
  if (got.join(',') === '1,2') {
    pass('rescoreCandidates keeps open/SKIP rows with a report just below the threshold, newest window only, best first');
  } else {
    fail(`rescoreCandidates returned [${got}], expected [1,2]`);
  }
}

let tmp = '';
try {
  tmp = mkdtempSync(join(tmpdir(), 'run-rescore-'));
  const today = new Date().toISOString().slice(0, 10);
  const tracker = join(tmp, 'applications.md');
  writeFileSync(tracker, `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | ${today} | Acme | Data WS | 3.3/5 | Evaluated | ❌ | [1](reports/001-acme-${today}.md) | location 3.0 |
| 2 | ${today} | Beta | ML WS | 4.1/5 | Evaluated | ❌ | [2](reports/002-beta-${today}.md) | fine |
`, 'utf-8');
  const pipeline = join(tmp, 'pipeline.md');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n\n## Processed\n', 'utf-8');
  const env = {
    ...process.env,
    CAREER_OPS_RUN_STATE: join(tmp, 'run-state.json'),
    CAREER_OPS_RUN_LOG: join(tmp, 'run-log.md'),
    CAREER_OPS_PIPELINE_FILE: pipeline,
    CAREER_OPS_TRACKER: tracker,
  };
  const start = () => JSON.parse(execFileSync(NODE, [join(ROOT, 'run-all.mjs'), 'start', '--reset', '--skip-scan', '--kit-threshold', '3.5'], {
    cwd: ROOT, env, encoding: 'utf-8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  }));

  const first = start();
  const fpPath = join(tmp, 'scoring-inputs.json');
  if (!first.rescore && existsSync(fpPath)) {
    pass('the first pass records a scoring baseline next to the run state, with no re-score notice');
  } else {
    fail(`first start: rescore=${JSON.stringify(first.rescore)} baselineWritten=${existsSync(fpPath)}`);
  }

  const second = start();
  if (!second.rescore) pass('an unchanged rule set produces no re-score notice');
  else fail(`unchanged rules still produced a notice: ${JSON.stringify(second.rescore)}`);

  const baseline = JSON.parse(readFileSync(fpPath, 'utf-8'));
  baseline.files['modes/_brief.md'] = '0'.repeat(40);
  writeFileSync(fpPath, JSON.stringify(baseline), 'utf-8');
  const third = start();
  const nums = (third.rescore?.candidates ?? []).map((c) => c.num);
  const logged = readFileSync(join(tmp, 'run-log.md'), 'utf-8');
  if (third.rescore?.changed?.includes('modes/_brief.md') && nums.join(',') === '1' && /rescore/.test(logged)) {
    pass('a changed scoring file lists the just-below-threshold rows to re-score and logs it');
  } else {
    fail(`changed rules: ${JSON.stringify(third.rescore)}`);
  }

  const fourth = start();
  if (!fourth.rescore) pass('the notice appears once per change (the new fingerprints become the baseline)');
  else fail('the re-score notice repeated after the baseline was updated');
} catch (e) {
  fail(`run-rescore tests crashed: ${e.message}`);
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
