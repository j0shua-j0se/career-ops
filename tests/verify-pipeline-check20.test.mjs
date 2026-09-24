// tests/verify-pipeline-check20.test.mjs — Check 20 (StepStone 403, 2026-09-24)
// end to end, through the real verify-pipeline.mjs process.
//
// StepStone started answering HTTP 403 to the user's own browser and to this
// machine on 2026-09-23; portals.yml's StepStone board and search_queries were
// disabled 2026-09-24 so no new request goes out. This is the other half: a
// StepStone URL already sitting in an open ("Evaluated") tracker row is a link
// the user can never open. Asserted through the real process, the same way
// tests/verify-pipeline-check15.test.mjs and
// tests/verify-pipeline-control-bytes.test.mjs do, so the exit code and the
// exact warning text — what a cron wrapper and the user actually see — are
// what gets pinned, not a reimplementation of the check's own logic.
//
// Only the tracker and reports dir point at a fixture, and CAREER_OPS_PORTALS
// points at a non-existent file so Check 15's portal-coverage pass is a no-op
// and cannot add unrelated noise to the output this suite greps.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nverify-pipeline — Check 20 warns on an open tracker row pointing at a blocked job-board host (StepStone)');

const HEADER = '# Applications Tracker\n\n'
  + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n'
  + '|---|------|---------|------|-------|--------|-----|--------|-------|-----|\n';

const row = (num, company, status, url) =>
  `| ${num} | 2026-09-05 | ${company} | Werkstudent Data Science | 4.0/5 | ${status} | ❌ | — | seeded | ${url} |\n`;

const tmp = mkdtempSync(join(tmpdir(), 'co-vp-check20-'));
try {
  const reports = join(tmp, 'reports');
  mkdirSync(reports, { recursive: true });
  const tracker = join(tmp, 'applications.md');

  // verify-pipeline exits 1 only on errors; a warning-only run exits 0. Read
  // stdout off the error object too so a non-zero exit never hides the assertion.
  const runVp = () => {
    const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reports, CAREER_OPS_PORTALS: join(tmp, 'no-portals.yml') };
    try {
      return execFileSync(NODE, [join(ROOT, 'verify-pipeline.mjs')], { cwd: ROOT, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (err) {
      return typeof err.stdout === 'string' ? err.stdout : '';
    }
  };

  // Case 1: active (Evaluated) StepStone row -> warning, naming the row and company.
  writeFileSync(tracker, HEADER + row(1, 'Acme Co', 'Evaluated', 'https://www.stepstone.de/stellenangebote--Werkstudent-1234.html'), 'utf-8');
  let out = runVp();
  if (/#1 Acme Co: URL is a StepStone listing \(blocked for the user\) — repoint to the employer's own posting or close the row/.test(out)) {
    pass('an Evaluated row with a stepstone.de URL is warned about, naming #num and company');
  } else {
    fail(`Evaluated stepstone row not flagged as expected:\n${out.split('\n').filter((l) => /StepStone|blocked job-board/i.test(l)).join('\n')}`);
  }

  // Case 2: Discarded StepStone row -> no warning (row is already resolved).
  writeFileSync(tracker, HEADER + row(2, 'Beta GmbH', 'Discarded', 'https://www.stepstone.de/stellenangebote--Werkstudent-5678.html'), 'utf-8');
  out = runVp();
  if (!/StepStone listing/.test(out) && /No open tracker rows point at a blocked job-board host/.test(out)) {
    pass('a Discarded row with a stepstone.de URL is not flagged — it is already resolved');
  } else {
    fail(`Discarded stepstone row unexpectedly flagged:\n${out.split('\n').filter((l) => /StepStone|blocked job-board/i.test(l)).join('\n')}`);
  }

  // Case 3: active row on an unrelated German job board (karriere.adac.de) -> no warning.
  writeFileSync(tracker, HEADER + row(3, 'ADAC', 'Evaluated', 'https://karriere.adac.de/jobs/werkstudent-data-science-3'), 'utf-8');
  out = runVp();
  if (!/StepStone listing/.test(out) && /No open tracker rows point at a blocked job-board host/.test(out)) {
    pass('an active karriere.adac.de row is not flagged — unrelated host');
  } else {
    fail(`karriere.adac.de row unexpectedly flagged:\n${out.split('\n').filter((l) => /StepStone|blocked job-board/i.test(l)).join('\n')}`);
  }

  // Case 4: host-variant coverage — "www." subdomain and an uppercase host both match.
  writeFileSync(
    tracker,
    HEADER
      + row(4, 'Gamma AG', 'Evaluated', 'https://www.stepstone.de/stellenangebote--Werkstudent-4321.html')
      + row(5, 'Delta SE', 'Evaluated', 'https://STEPSTONE.DE/stellenangebote--Werkstudent-8765.html'),
    'utf-8',
  );
  out = runVp();
  const flaggedFour = /#4 Gamma AG: URL is a StepStone listing/.test(out);
  const flaggedFive = /#5 Delta SE: URL is a StepStone listing/.test(out);
  if (flaggedFour && flaggedFive) {
    pass('both a "www." subdomain and an uppercase stepstone.de host are recognized');
  } else {
    fail(`host-variant coverage gap: www.=${flaggedFour} uppercase=${flaggedFive}\n${out.split('\n').filter((l) => /StepStone|blocked job-board/i.test(l)).join('\n')}`);
  }
} catch (err) {
  fail(`verify-pipeline Check 20 tests could not run: ${err.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
