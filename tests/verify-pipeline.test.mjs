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
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'fs';
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

// ── Check 14: employer-name variants, shared req IDs, shared URLs ──────────
// The gap this closes: report 012's company was "ZEISS (Carl Zeiss
// Microscopy GmbH)", report 043's was "ZEISS" — same requisition
// (JR_1047706), two rows that looked unrelated to Check 9's exact-key
// comparison. That cost two CVs and two cover letters for one job, with the
// letters silently overwriting each other because both resolved to the same
// output filename.
console.log('\nverify-pipeline.mjs — Check 14: employer-variant / req-ID / URL duplicates');

const box2 = mkdtempSync(join(tmpdir(), 'cops-verify-pipeline-dupes-'));
const reportsDir2 = join(box2, 'reports');
const tracker2 = join(box2, 'applications.md');
mkdirSync(reportsDir2, { recursive: true });

/** One synthetic report with a structured header (URL/Req ID before the `---` rule) and a body. */
function makeReport({ company, role, url, reqId, extraHeader = '', body = '## Notes\n\nBody text.\n' }) {
  const reqLine = reqId ? `**Req ID:** ${reqId}\n` : '';
  const urlLine = url ? `**URL:** ${url}\n` : '';
  return `# Evaluation: ${company} — ${role}\n\n` +
    `**Date:** 2026-01-01\n${urlLine}${reqLine}${extraHeader}**Legitimacy:** verified\n\n---\n\n` +
    `## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.0\n\`\`\`\n\n${body}`;
}

function resetDupeFixture() {
  for (const f of readdirSync(reportsDir2)) rmSync(join(reportsDir2, f));
}

try {
  // ── 1. ZEISS-style employer-name variant, identical role → flagged ──────
  writeFileSync(join(reportsDir2, '012-zeiss-2026-08-06.md'),
    makeReport({ company: 'ZEISS (Carl Zeiss Microscopy GmbH)', role: 'Internship Machine Learning' }));
  writeFileSync(join(reportsDir2, '043-zeiss-2026-08-12.md'),
    makeReport({ company: 'ZEISS', role: 'Internship Machine Learning' }));
  writeTracker(tracker2, [
    // Both rows LIVE on purpose: this fixture exercises the employer-variant
    // signal, and a Discarded row would suppress the pair via the
    // reconciliation rule tested separately below.
    '| 12 | 2026-08-06 | ZEISS (Carl Zeiss Microscopy GmbH) | Internship Machine Learning | 3.9/5 | Evaluated | ❌ | [12](reports/012-zeiss-2026-08-06.md) | pending |',
    '| 43 | 2026-08-12 | ZEISS | Internship Machine Learning | 4.0/5 | Evaluated | ❌ | [43](reports/043-zeiss-2026-08-12.md) | ok |',
  ]);
  let out = verify(reportsDir2, tracker2);
  check('ZEISS legal-form/parenthetical variant + identical role is flagged',
    /⚠️[^\n]*Likely duplicate reports[^\n]*012-zeiss-2026-08-06\.md, 043-zeiss-2026-08-12\.md/.test(out.stdout), out.stdout);
  check('ZEISS variant finding stays warning-level (exit 0)', out.status === 0, `status=${out.status}`);

  // ── 1b. Once the tracker has reconciled the pair, it stops being flagged ──
  // A report cannot be deleted — Check 10 treats a report with no tracker row
  // as an orphan, and the reports ARE the audit trail. So the only available
  // resolution for two reports of one requisition is to Discard one row and
  // let the other carry the application. If that did not clear the warning,
  // this check would have no reachable clean state and would warn forever,
  // which is how a health check teaches its reader to skim past warnings.
  writeTracker(tracker2, [
    '| 12 | 2026-08-06 | ZEISS (Carl Zeiss Microscopy GmbH) | Internship Machine Learning | 3.9/5 | Discarded | ❌ | [12](reports/012-zeiss-2026-08-06.md) | dup of 43, resolved |',
    '| 43 | 2026-08-12 | ZEISS | Internship Machine Learning | 4.0/5 | Applied | ❌ | [43](reports/043-zeiss-2026-08-12.md) | the surviving row |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('a duplicate pair reconciled by Discarding one row is NOT flagged',
    !/Likely duplicate reports[^\n]*012-zeiss/.test(out.stdout), out.stdout);
  check('the reconciled fixture exits 0', out.status === 0, `status=${out.status}`);

  // ── 2. Legal-form + country-suffix variant, identical role → flagged ────
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '005-primetals-2026-01-01.md'),
    makeReport({ company: 'Primetals Technologies Germany GmbH', role: 'Werkstudent Data Science' }));
  writeFileSync(join(reportsDir2, '006-primetals-2026-01-02.md'),
    makeReport({ company: 'Primetals Technologies', role: 'Werkstudent Data Science' }));
  writeTracker(tracker2, [
    '| 5 | 2026-01-01 | Primetals Technologies Germany GmbH | Werkstudent Data Science | 4.0/5 | Evaluated | ❌ | [5](reports/005-primetals-2026-01-01.md) | ok |',
    '| 6 | 2026-01-02 | Primetals Technologies | Werkstudent Data Science | 4.0/5 | Evaluated | ❌ | [6](reports/006-primetals-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('"Primetals Technologies Germany GmbH" vs "Primetals Technologies" is flagged',
    /⚠️[^\n]*Likely duplicate reports[^\n]*005-primetals-2026-01-01\.md, 006-primetals-2026-01-02\.md/.test(out.stdout), out.stdout);

  // ── 3. CRITICAL false-positive guard: sibling business units must NOT match ──
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '007-siemens-2026-01-01.md'),
    makeReport({ company: 'Siemens Mobility GmbH', role: 'Werkstudent Data Science' }));
  writeFileSync(join(reportsDir2, '008-siemens-2026-01-02.md'),
    makeReport({ company: 'Siemens Energy', role: 'Werkstudent Data Science' }));
  writeTracker(tracker2, [
    '| 7 | 2026-01-01 | Siemens Mobility GmbH | Werkstudent Data Science | 4.0/5 | Evaluated | ❌ | [7](reports/007-siemens-2026-01-01.md) | ok |',
    '| 8 | 2026-01-02 | Siemens Energy | Werkstudent Data Science | 4.0/5 | Evaluated | ❌ | [8](reports/008-siemens-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('"Siemens Mobility GmbH" vs "Siemens Energy" (same role) is NOT flagged — distinct business units',
    !/Likely duplicate reports[^\n]*007-siemens[^\n]*008-siemens/.test(out.stdout) &&
    !/Likely duplicate reports[^\n]*008-siemens[^\n]*007-siemens/.test(out.stdout), out.stdout);

  // ── 4. Siemens Mobility GmbH, two genuinely different roles → NOT flagged ──
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '009-siemens-2026-01-01.md'),
    makeReport({ company: 'Siemens Mobility GmbH', role: 'Werkstudent Data Science' }));
  writeFileSync(join(reportsDir2, '010-siemens-2026-01-02.md'),
    makeReport({ company: 'Siemens Mobility GmbH', role: 'Werkstudent Embedded Systems' }));
  writeTracker(tracker2, [
    '| 9 | 2026-01-01 | Siemens Mobility GmbH | Werkstudent Data Science | 4.0/5 | Evaluated | ❌ | [9](reports/009-siemens-2026-01-01.md) | ok |',
    '| 10 | 2026-01-02 | Siemens Mobility GmbH | Werkstudent Embedded Systems | 4.0/5 | Evaluated | ❌ | [10](reports/010-siemens-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('same employer, two different roles, is NOT flagged',
    !/Likely duplicate reports[^\n]*009-siemens[^\n]*010-siemens/.test(out.stdout) &&
    !/Likely duplicate reports[^\n]*010-siemens[^\n]*009-siemens/.test(out.stdout), out.stdout);

  // ── 5. Same req ID, different company spelling AND different role title → flagged ──
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '020-acme-2026-01-01.md'),
    makeReport({ company: 'Acme GmbH', role: 'Werkstudent AI', reqId: 'JR_99001' }));
  writeFileSync(join(reportsDir2, '021-acme-2026-01-02.md'),
    makeReport({ company: 'Acme Corporation (Acme GmbH)', role: 'Student Assistant Artificial Intelligence', reqId: 'JR_99001' }));
  writeTracker(tracker2, [
    '| 20 | 2026-01-01 | Acme GmbH | Werkstudent AI | 4.0/5 | Evaluated | ❌ | [20](reports/020-acme-2026-01-01.md) | ok |',
    '| 21 | 2026-01-02 | Acme Corporation (Acme GmbH) | Student Assistant Artificial Intelligence | 4.0/5 | Evaluated | ❌ | [21](reports/021-acme-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('same req ID under different company spelling AND different role title is flagged as same-req',
    /⚠️[^\n]*Likely duplicate reports[^\n]*same req ID[^\n]*020-acme-2026-01-01\.md, 021-acme-2026-01-02\.md/.test(out.stdout), out.stdout);

  // ── 6. Same URL → flagged ────────────────────────────────────────────────
  resetDupeFixture();
  const sharedUrl = 'https://jobs.example.com/job/Munich-Data-Engineer-12345/9988776/?utm_source=newsletter&utm_medium=email';
  const sharedUrlNoTracking = 'https://JOBS.example.com/job/Munich-Data-Engineer-12345/9988776/';
  writeFileSync(join(reportsDir2, '030-globex-2026-01-01.md'),
    makeReport({ company: 'Globex', role: 'Data Engineer', url: sharedUrl }));
  writeFileSync(join(reportsDir2, '031-globex-2026-01-02.md'),
    makeReport({ company: 'Globex Direct Posting', role: 'Data Engineer II', url: sharedUrlNoTracking }));
  writeTracker(tracker2, [
    '| 30 | 2026-01-01 | Globex | Data Engineer | 4.0/5 | Evaluated | ❌ | [30](reports/030-globex-2026-01-01.md) | ok |',
    '| 31 | 2026-01-02 | Globex Direct Posting | Data Engineer II | 4.0/5 | Evaluated | ❌ | [31](reports/031-globex-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('same URL (host case + tracking params normalized away) is flagged',
    /⚠️[^\n]*Likely duplicate reports[^\n]*same URL[^\n]*030-globex-2026-01-01\.md, 031-globex-2026-01-02\.md/.test(out.stdout), out.stdout);

  // ── 7. Different req IDs, same company, same role title → NOT flagged ───
  // AGENTS.md's documented case: distinct requisitions can share a title. A
  // confirmed req mismatch is proof-of-difference and must override the
  // company+role heuristic.
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '040-hooli-2026-01-01.md'),
    makeReport({ company: 'Hooli', role: 'Werkstudent Backend', reqId: 'REQ-1001' }));
  writeFileSync(join(reportsDir2, '041-hooli-2026-01-02.md'),
    makeReport({ company: 'Hooli', role: 'Werkstudent Backend', reqId: 'REQ-1002' }));
  writeTracker(tracker2, [
    '| 40 | 2026-01-01 | Hooli | Werkstudent Backend | 4.0/5 | Evaluated | ❌ | [40](reports/040-hooli-2026-01-01.md) | req REQ-1001 |',
    '| 41 | 2026-01-02 | Hooli | Werkstudent Backend | 4.0/5 | Evaluated | ❌ | [41](reports/041-hooli-2026-01-02.md) | req REQ-1002 |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('same company+role but confirmed DIFFERENT req IDs is NOT flagged (distinct requisitions sharing a title)',
    !/Likely duplicate reports[^\n]*040-hooli[^\n]*041-hooli/.test(out.stdout) &&
    !/Likely duplicate reports[^\n]*041-hooli[^\n]*040-hooli/.test(out.stdout), out.stdout);
  check('different-req fixture prints the all-clear line for Check 14',
    out.stdout.includes('No employer-variant/req-ID/URL duplicates found'), out.stdout);

  // ── 8. A report's own req ID phrasing the shared regex can't parse must
  //      not fall back to a DIFFERENT report's cross-referenced req ID ──────
  // Mirrors the real-repo case (report 029/Schaeffler cites report 020's Req
  // 40922 while explaining they are different requisitions): scanning must
  // stay inside the header block, where a report's own IDs live, so a
  // disambiguation mention elsewhere in the body can't be picked up as if it
  // were this report's own req.
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '050-initech-2026-01-01.md'),
    makeReport({ company: 'Initech', role: 'Werkstudent Platform', reqId: 'REQ-5001' }));
  writeFileSync(join(reportsDir2, '051-initech-2026-01-02.md'),
    makeReport({
      company: 'Initech', role: 'Werkstudent Data',
      // No parseable req ID in the header (three-word phrasing the shared
      // regex does not match) — the only match anywhere in the document is
      // a cross-reference to report 050's req in the prose body.
      extraHeader: '',
      body: '## Notes\n\nThis is a different requisition from report 050 (Initech, REQ-5001) — see that report for the sibling posting.\n',
    }));
  writeTracker(tracker2, [
    '| 50 | 2026-01-01 | Initech | Werkstudent Platform | 4.0/5 | Evaluated | ❌ | [50](reports/050-initech-2026-01-01.md) | ok |',
    '| 51 | 2026-01-02 | Initech | Werkstudent Data | 4.0/5 | Evaluated | ❌ | [51](reports/051-initech-2026-01-02.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('a req ID cross-referenced only in body prose is not attributed to the citing report',
    !/same req ID[^\n]*050-initech[^\n]*051-initech/.test(out.stdout) &&
    !/same req ID[^\n]*051-initech[^\n]*050-initech/.test(out.stdout), out.stdout);

  // ── 9. Findings stay warnings — exit code unaffected ─────────────────────
  resetDupeFixture();
  writeFileSync(join(reportsDir2, '060-clean-2026-01-01.md'),
    makeReport({ company: 'CleanCo', role: 'Analyst' }));
  writeTracker(tracker2, [
    '| 60 | 2026-01-01 | CleanCo | Analyst | 4.0/5 | Evaluated | ❌ | [60](reports/060-clean-2026-01-01.md) | ok |',
  ]);
  out = verify(reportsDir2, tracker2);
  check('single clean report: exit 0 and the all-clear line for Check 14',
    out.status === 0 && out.stdout.includes('No employer-variant/req-ID/URL duplicates found'), `status=${out.status}\n${out.stdout}`);

  // ── An unknown employer must not hide a duplicate of a decided row ──────────
  // companyKeysMatch() rejects two empty company keys, correctly: two
  // unidentified employers are not evidence of one employer. But that leaves a
  // blind spot, and it cost a real duplicate. #3 (Mitsubishi Heavy Industries,
  // "Werkstudent Software Development Edge AI") was applied to and REJECTED on
  // 2026-08-18. The same posting then arrived a third time from stellenwerk —
  // whose sitemap publishes no employer — so it read as `?`, matched nothing, and
  // was promoted at 4.3 as a fresh lead for a job already refused.
  //
  // When one side's employer is unknown the role has to carry the whole match, so
  // it must be EXACT rather than the subset test used when a company is known.
  {
    resetDupeFixture();
    writeTracker(tracker2, [
      '| 3 | 2026-08-05 | Mitsubishi Heavy Industries EMEA | Werkstudent Software Development Edge AI (m/w/d) | 4.4/5 | Rejected | ✅ | — | applied then rejected |',
      '| 122 | 2026-08-19 | ? | Werkstudent Software Development Edge Ai (m/w/d) | 4.3/5 | Evaluated | ❌ | — | triage-only |',
    ]);
    let out = verify(reportsDir2, tracker2);
    check('an unknown-employer row is matched against a decided row by exact role',
      /Likely duplicate tracker rows: #122 \(unknown employer\) and #3/.test(out.stdout), out.stdout);
    check('the duplicate finding stays warning-level (exit 0)', out.status === 0, `status=${out.status}`);

    // The guard: a genuinely different role at an unknown employer must not be
    // dragged in by the shared "Werkstudent" vocabulary.
    writeTracker(tracker2, [
      '| 3 | 2026-08-05 | Mitsubishi Heavy Industries EMEA | Werkstudent Software Development Edge AI (m/w/d) | 4.4/5 | Rejected | ✅ | — | applied then rejected |',
      '| 122 | 2026-08-19 | ? | Werkstudent Data Analytics Reporting (m/w/d) | 4.3/5 | Evaluated | ❌ | — | triage-only |',
    ]);
    out = verify(reportsDir2, tracker2);
    check('a different role at an unknown employer is not flagged',
      !/Likely duplicate tracker rows: #122/.test(out.stdout), out.stdout);

    // Once resolved by Discarding the duplicate, the warning stops — same rule as
    // everywhere else here: a finding that outlives its own fix teaches the reader
    // to skim.
    writeTracker(tracker2, [
      '| 3 | 2026-08-05 | Mitsubishi Heavy Industries EMEA | Werkstudent Software Development Edge AI (m/w/d) | 4.4/5 | Rejected | ✅ | — | applied then rejected |',
      '| 122 | 2026-08-19 | ? | Werkstudent Software Development Edge Ai (m/w/d) | 4.3/5 | Discarded | ❌ | — | duplicate of #3 |',
    ]);
    out = verify(reportsDir2, tracker2);
    check('Discarding the duplicate clears the finding',
      !/Likely duplicate tracker rows: #122/.test(out.stdout), out.stdout);
  }

} catch (e) {
  fail(`verify-pipeline Check 14 duplicate-report tests crashed: ${e.message}`);
} finally {
  rmSync(box2, { recursive: true, force: true });
}
