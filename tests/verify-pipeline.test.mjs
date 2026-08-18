// tests/verify-pipeline.test.mjs — Check 13: every report carries a
// parseable '## Machine Summary' YAML fence with a score: field.
//
// The gap this closes: verify-pipeline.mjs referenced the Machine Summary
// fence only inside extractRole() (Check 9), where a missing/unparseable
// fence silently falls back to the report's title line. Nothing ever
// asserted the block *exists*. That matters because analyze-patterns.mjs,
// upskill.mjs and salary-gap.mjs all read fields out of that block — a
// report without one doesn't error anywhere, it just contributes nothing,
// so the analyses come back quietly smaller. See AGENTS.md's stated failure
// mode: a missing input producing a quieter answer, not a louder one.
//
// Warning-level by design (historical, pre-convention reports; the check
// must not flip a clean pipeline to a non-zero exit code), so every
// assertion here checks stdout content and exit code 0, never exit 1.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const SCRIPT = join(ROOT, 'verify-pipeline.mjs');

console.log('\nverify-pipeline.mjs — Check 13: Machine Summary presence & parseability');

/**
 * Run verify-pipeline.mjs against an isolated tracker+reports fixture.
 * Returns {status, stdout}. Never throws — callers assert on the fields.
 */
function verify(reportsDir, tracker) {
  const res = spawnSync(NODE, [SCRIPT], {
    env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reportsDir },
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function check(desc, condition, details = '') {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` — ${details}` : ''}`);
}

/** Minimal tracker with one header + rows, so other checks stay green. */
function writeTracker(path, rows) {
  writeFileSync(path, [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    ...rows,
    '',
  ].join('\n'), 'utf-8');
}

const box = mkdtempSync(join(tmpdir(), 'cops-verify-pipeline-'));
const reportsDir = join(box, 'reports');
const tracker = join(box, 'applications.md');
mkdirSync(reportsDir, { recursive: true });

try {
  // ── 1. Well-formed Machine Summary passes ────────────────────────────────
  writeFileSync(join(reportsDir, '001-acme-2026-01-04.md'),
    '# Evaluación: Acme — Staff AI Engineer\n\n' +
    '## Risk Summary\n\nSome risk table.\n\n' +
    '## Machine Summary\n\n```yaml\ncompany: "Acme"\nrole: "Staff AI Engineer"\nscore: 4.2\n```\n');
  writeTracker(tracker,
    ['| 1 | 2026-01-04 | Acme | Staff AI Engineer | 4.2/5 | Evaluated | ❌ | [1](reports/001-acme-2026-01-04.md) | ok |']);

  let out = verify(reportsDir, tracker);
  check('well-formed Machine Summary with score: passes (exit 0)', out.status === 0, `status=${out.status}`);
  check('well-formed fixture is not flagged as missing a summary',
    !/No usable Machine Summary[^\n]*001-acme/.test(out.stdout), out.stdout);
  check('well-formed fixture prints the all-clear line',
    out.stdout.includes('Every report has a parseable Machine Summary with a score'));

  // ── 2. No Machine Summary block at all ───────────────────────────────────
  rmSync(join(reportsDir, '001-acme-2026-01-04.md'));
  writeFileSync(join(reportsDir, '002-globex-2026-01-05.md'),
    '# Evaluación: Globex — Platform Engineer\n\n## Risk Summary\n\nEnds here, no Machine Summary.\n');
  writeTracker(tracker,
    ['| 2 | 2026-01-05 | Globex | Platform Engineer | 3.5/5 | Evaluated | ❌ | [2](reports/002-globex-2026-01-05.md) | ok |']);

  out = verify(reportsDir, tracker);
  check('missing Machine Summary block is flagged as a warning',
    /⚠️[^\n]*No usable Machine Summary[^\n]*002-globex-2026-01-05\.md/.test(out.stdout), out.stdout);
  check('missing-block finding names the downstream tools it starves',
    out.stdout.includes('analyze-patterns.mjs') && out.stdout.includes('upskill.mjs') && out.stdout.includes('salary-gap.mjs'));
  check('missing-block finding does not raise the error count (exit 0)', out.status === 0, `status=${out.status}`);

  // ── 3. Heading present, fence empty ──────────────────────────────────────
  rmSync(join(reportsDir, '002-globex-2026-01-05.md'));
  writeFileSync(join(reportsDir, '003-initech-2026-01-06.md'),
    '# Evaluación: Initech — Data Engineer\n\n## Machine Summary\n\n```yaml\n```\n');
  writeTracker(tracker,
    ['| 3 | 2026-01-06 | Initech | Data Engineer | 3.5/5 | Evaluated | ❌ | [3](reports/003-initech-2026-01-06.md) | ok |']);

  out = verify(reportsDir, tracker);
  check('empty fence is flagged',
    /⚠️[^\n]*No usable Machine Summary[^\n]*003-initech-2026-01-06\.md/.test(out.stdout), out.stdout);
  check('empty-fence finding stays warning-level (exit 0)', out.status === 0, `status=${out.status}`);

  // ── 4. Heading present, fence unparseable YAML ───────────────────────────
  rmSync(join(reportsDir, '003-initech-2026-01-06.md'));
  writeFileSync(join(reportsDir, '004-hooli-2026-01-07.md'),
    '# Evaluación: Hooli — ML Engineer\n\n## Machine Summary\n\n```yaml\nscore: [unterminated\n```\n');
  writeTracker(tracker,
    ['| 4 | 2026-01-07 | Hooli | ML Engineer | 3.5/5 | Evaluated | ❌ | [4](reports/004-hooli-2026-01-07.md) | ok |']);

  out = verify(reportsDir, tracker);
  check('unparseable YAML fence is flagged',
    /⚠️[^\n]*No usable Machine Summary[^\n]*004-hooli-2026-01-07\.md/.test(out.stdout), out.stdout);
  check('unparseable-fence finding stays warning-level (exit 0)', out.status === 0, `status=${out.status}`);

  // ── 5. Fence parses but has no score: field ──────────────────────────────
  rmSync(join(reportsDir, '004-hooli-2026-01-07.md'));
  writeFileSync(join(reportsDir, '005-vandelay-2026-01-08.md'),
    '# Evaluación: Vandelay Industries — Import/Export Analyst\n\n' +
    '## Machine Summary\n\n```yaml\ncompany: "Vandelay Industries"\nrole: "Import/Export Analyst"\n```\n');
  writeTracker(tracker,
    ['| 5 | 2026-01-08 | Vandelay Industries | Import/Export Analyst | 3.5/5 | Evaluated | ❌ | [5](reports/005-vandelay-2026-01-08.md) | ok |']);

  out = verify(reportsDir, tracker);
  check('fence lacking score: is flagged',
    /⚠️[^\n]*No usable Machine Summary[^\n]*005-vandelay-2026-01-08\.md/.test(out.stdout), out.stdout);
  check('missing-score finding stays warning-level (exit 0)', out.status === 0, `status=${out.status}`);

  // ── 6. RESERVED sentinel is skipped, not flagged ─────────────────────────
  rmSync(join(reportsDir, '005-vandelay-2026-01-08.md'));
  writeFileSync(join(reportsDir, '006-RESERVED.md'), '');
  writeFileSync(join(reportsDir, '007-massive-dynamic-2026-01-09.md'),
    '# Evaluación: Massive Dynamic — Research Scientist\n\n' +
    '## Machine Summary\n\n```yaml\ncompany: "Massive Dynamic"\nrole: "Research Scientist"\nscore: 4.5\n```\n');
  writeTracker(tracker,
    ['| 7 | 2026-01-09 | Massive Dynamic | Research Scientist | 4.5/5 | Evaluated | ❌ | [7](reports/007-massive-dynamic-2026-01-09.md) | ok |']);

  out = verify(reportsDir, tracker);
  check('a *-RESERVED.md sentinel is not flagged as missing a Machine Summary',
    !/No usable Machine Summary[^\n]*006-RESERVED/.test(out.stdout), out.stdout);
  check('the real report alongside the sentinel still passes cleanly',
    out.stdout.includes('Every report has a parseable Machine Summary with a score'), out.stdout);
  check('sentinel fixture stays exit 0', out.status === 0, `status=${out.status}`);
} catch (e) {
  fail(`verify-pipeline Machine Summary tests crashed: ${e.message}`);
} finally {
  rmSync(box, { recursive: true, force: true });
}
