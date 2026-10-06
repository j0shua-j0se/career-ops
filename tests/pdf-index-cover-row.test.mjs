// tests/pdf-index-cover-row.test.mjs — a report's CV and cover letter each keep
// their own row in data/pdf-index.tsv.
//
// The cover letter renders through generate-pdf.mjs's manifest writer right
// after the CV, with the same report number, and the writer used to drop EVERY
// older row for that report. By 2026-10-06, 68 of 70 reports were indexed by
// their cover letter alone, so find.mjs printed the letter as the CV, the
// dashboard opened it (and offered to regenerate it from the payload JSON), and
// outcome.mjs would have archived it as the submitted CV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCoverIndexRow } from '../tracker-utils.mjs';
import { parsePdfIndex } from '../find.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('isCoverIndexRow reads the source column, then the file name', () => {
  assert.equal(isCoverIndexRow('output/to-apply/x-cover.pdf', 'payloads/x-cover.json'), true);
  assert.equal(isCoverIndexRow('output/to-apply/x-cv.pdf', 'output/to-apply/x-cv.html'), false);
  assert.equal(isCoverIndexRow('output/to-apply/x-cover.pdf', ''), true);
  assert.equal(isCoverIndexRow('output/to-apply/x-cv.pdf', ''), false);
});

test('parsePdfIndex maps a report to its CV, never its cover letter', () => {
  const map = parsePdfIndex([
    '# report\tpdf\thtml\tformat\tdate',
    '267\toutput/to-apply/dlr-cv.pdf\toutput/to-apply/dlr-cv.html\ta4\t2026-10-06',
    '267\toutput/to-apply/dlr-cover.pdf\tpayloads/dlr-cover.json\ta4\t2026-10-06',
    '269\toutput/to-apply/yarres-cover.pdf\tpayloads/yarres-cover.json\ta4\t2026-10-06',
  ].join('\n'));
  assert.equal(map.get('267'), 'output/to-apply/dlr-cv.pdf');
  assert.equal(map.has('269'), false);
});

test('rendering the cover letter keeps the CV row; re-rendering either replaces only its own', async (t) => {
  const { renderHtmlToPdf } = await import('../generate-pdf.mjs');
  const outDir = mkdtempSync(join(ROOT, 'output', 'pdf-index-cover-'));
  const indexDir = mkdtempSync(join(tmpdir(), 'pdf-index-cover-'));
  const indexPath = join(indexDir, 'pdf-index.tsv');
  const previousIndex = process.env.CAREER_OPS_PDF_INDEX;
  process.env.CAREER_OPS_PDF_INDEX = indexPath;
  try {
    mkdirSync(outDir, { recursive: true });
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><p>T</p></body></html>';
    const cvHtml = join(outDir, 'x-cv.html');
    const coverJson = join(outDir, 'x-cover.json');
    writeFileSync(cvHtml, html);
    writeFileSync(coverJson, '{}');
    const render = (pdf, inputPath) => renderHtmlToPdf(html, join(outDir, pdf), { reportNum: '901', inputPath, author: '' });
    try {
      await render('x-cv.pdf', cvHtml);
    } catch (err) {
      t.skip(`Chromium unavailable: ${err.message.split('\n')[0]}`);
      return;
    }
    await render('x-cover.pdf', coverJson);
    const rows = () => readFileSync(indexPath, 'utf-8').split('\n').filter((l) => l.startsWith('901\t')).map((l) => l.split('\t')[1]);
    assert.deepEqual(rows().map((p) => p.split('/').pop()).sort(), ['x-cover.pdf', 'x-cv.pdf']);

    // A regenerated CV under a new name supersedes the old CV row only.
    await render('x-cv-v2.pdf', cvHtml);
    assert.deepEqual(rows().map((p) => p.split('/').pop()).sort(), ['x-cover.pdf', 'x-cv-v2.pdf']);
  } finally {
    if (previousIndex === undefined) delete process.env.CAREER_OPS_PDF_INDEX;
    else process.env.CAREER_OPS_PDF_INDEX = previousIndex;
    rmSync(outDir, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});
