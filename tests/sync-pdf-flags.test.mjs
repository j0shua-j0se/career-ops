// tests/sync-pdf-flags.test.mjs — regression coverage for syncing tracker PDF flags.

import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nsync-pdf-flags.mjs — PDF flag reconciliation');

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-01-01 | Acme | ML Eng | 4.5/5 | Evaluated | ❌ | [1](reports/1-acme.md) | |',
  '| 2 | 2026-01-02 | Globex | Data Eng | 4.0/5 | Evaluated | — | [2](reports/2-globex.md) | |',
  '| 3 | 2026-01-03 | Initech | SE | 3.5/5 | Evaluated | ✅ | [3](reports/3-initech.md) | |',
  '| 4 | 2026-01-04 | Massive Dynamic | SE | 4.0/5 | Evaluated | ❌ | [4](reports/4-massive.md) | |',
  '',
].join('\n');

const PDF_MANIFEST = [
  '# report\tpdf\thtml\tformat\tdate',
  '1\toutput/1-acme-cv.pdf\toutput/1-acme.html\ta4\t2026-01-01',
  '002\toutput/2-globex-cv.pdf\toutput/2-globex.html\ta4\t2026-01-02',
  '3\toutput/3-initech-cv.pdf\toutput/3-initech.html\ta4\t2026-01-03',
  '',
].join('\n');

function runSync() {
  const work = mkdtempSync(join(tmpdir(), 'cops-sync-'));
  try {
    const tracker = join(work, 'applications.md');
    const pdfIndex = join(work, 'pdf-index.tsv');
    // Empty reports dir: the header audit must not read the real reports/
    // here, or this test's output depends on the user's own pipeline state.
    const reports = join(work, 'reports');
    writeFileSync(tracker, TRACKER_HEADER);
    writeFileSync(pdfIndex, PDF_MANIFEST);
    mkdirSync(reports);

    execFileSync(NODE, [join(ROOT, 'sync-pdf-flags.mjs')], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_PDF_INDEX: pdfIndex, CAREER_OPS_REPORTS_DIR: reports },
    });

    return readFileSync(tracker, 'utf-8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  const synced = runSync();
  const rows = synced.split('\n');
  
  const acme = rows.find(l => /\bAcme\b/.test(l)) || '';
  if (/\|\s*✅\s*\|\s*\[1\]/.test(acme)) {
    pass('sync-pdf-flags flips ❌ to ✅ when present in manifest');
  } else {
    fail(`sync-pdf-flags failed to flip Acme (report 1): ${acme.trim()}`);
  }

  const globex = rows.find(l => /\bGlobex\b/.test(l)) || '';
  if (/\|\s*✅\s*\|\s*\[2\]/.test(globex)) {
    pass('sync-pdf-flags handles zero-padded report numbers in manifest (002 matches [2])');
  } else {
    fail(`sync-pdf-flags failed to flip Globex (report 2): ${globex.trim()}`);
  }

  const initech = rows.find(l => /\bInitech\b/.test(l)) || '';
  if (/\|\s*✅\s*\|\s*\[3\]/.test(initech)) {
    pass('sync-pdf-flags leaves existing ✅ alone');
  } else {
    fail(`sync-pdf-flags broke Initech: ${initech.trim()}`);
  }

  const massive = rows.find(l => /\bMassive\b/.test(l)) || '';
  if (/\|\s*❌\s*\|\s*\[4\]/.test(massive)) {
    pass('sync-pdf-flags ignores rows missing from manifest');
  } else {
    fail(`sync-pdf-flags wrongly flipped Massive: ${massive.trim()}`);
  }
} catch (e) {
  fail(`sync-pdf-flags.mjs tests crashed: ${e.message}`);
}

// --- Report header audit ---------------------------------------------------
// A report header asserting a PDF that was never built (or was deleted with the
// rest of gitignored output/) kept asserting it forever, because nothing
// re-checked the claim after the report was written.
console.log('\nsync-pdf-flags.mjs — report **PDF:** header audit');

try {
  const work = mkdtempSync(join(tmpdir(), 'cops-sync-audit-'));
  try {
    const tracker = join(work, 'applications.md');
    const pdfIndex = join(work, 'pdf-index.tsv');
    const reports = join(work, 'reports');
    const realPdf = join(work, 'real-cv.pdf');
    writeFileSync(tracker, TRACKER_HEADER);
    writeFileSync(pdfIndex, PDF_MANIFEST);
    writeFileSync(realPdf, '%PDF-1.4 stub');
    mkdirSync(reports);

    const report = (num, slug, pdfLine) => writeFileSync(
      join(reports, `${String(num).padStart(3, '0')}-${slug}.md`),
      `# Evaluation: ${slug}\n\n**Date:** 2026-01-0${num}\n**Score:** 4.0/5\n**URL:** https://example.com/${slug}\n${pdfLine}\n`,
    );
    report(1, 'acme', `**PDF:** ${realPdf}`);
    report(2, 'globex', '**PDF:** output/never-generated-2026-01-02.pdf');
    report(3, 'initech', '**Legitimacy:** verified');

    const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_PDF_INDEX: pdfIndex, CAREER_OPS_REPORTS_DIR: reports };
    const out = execFileSync(NODE, [join(ROOT, 'sync-pdf-flags.mjs'), '--json'], { encoding: 'utf-8', timeout: 30000, env });
    const parsed = JSON.parse(out);
    const byNum = Object.fromEntries((parsed.reports ?? []).map(r => [r.report, r.status]));

    if (byNum[1] === 'ok') pass('audit: a header whose PDF is on disk is ok');
    else fail(`audit: existing PDF should be ok, got ${byNum[1]}`);

    if (byNum[2] === 'file-missing') pass('audit: a header naming a PDF that was never built is flagged');
    else fail(`audit: missing PDF should be file-missing, got ${byNum[2]}`);

    // Report 3 has no **PDF:** line but IS in the manifest — the header
    // understates what exists, which is drift in the other direction.
    if (byNum[3] === 'header-missing') pass('audit: a manifest PDF with no header line is flagged');
    else fail(`audit: report 3 should be header-missing, got ${byNum[3]}`);

    // Exit 0 by default: merge-tracker.mjs shells out with execFileSync, which
    // throws on non-zero, and it neither caused nor can fix report drift.
    let defaultCode = 0;
    try {
      execFileSync(NODE, [join(ROOT, 'sync-pdf-flags.mjs')], { encoding: 'utf-8', timeout: 30000, env, stdio: 'pipe' });
    } catch (e) {
      defaultCode = e.status ?? 1;
    }
    if (defaultCode === 0) pass('audit: drift alone does not change the default exit code');
    else fail(`audit: default run should exit 0 on drift, got ${defaultCode}`);

    let strictCode = 0;
    try {
      execFileSync(NODE, [join(ROOT, 'sync-pdf-flags.mjs'), '--strict'], { encoding: 'utf-8', timeout: 30000, env, stdio: 'pipe' });
    } catch (e) {
      strictCode = e.status ?? 1;
    }
    if (strictCode === 3) pass('audit: --strict exits 3 when a header disagrees with the filesystem');
    else fail(`audit: --strict should exit 3, got ${strictCode}`);

    // The audit must never touch user-layer reports.
    const before = readFileSync(join(reports, '002-globex.md'), 'utf-8');
    execFileSync(NODE, [join(ROOT, 'sync-pdf-flags.mjs')], { encoding: 'utf-8', timeout: 30000, env });
    if (readFileSync(join(reports, '002-globex.md'), 'utf-8') === before) {
      pass('audit: reports/ is left byte-identical (user layer is never rewritten)');
    } else {
      fail('audit: a report file was modified');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} catch (e) {
  fail(`sync-pdf-flags.mjs report audit tests crashed: ${e.message}`);
}
