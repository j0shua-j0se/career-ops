// tests/pdf-author.test.mjs — generated PDFs carry the candidate's name as /Author.
//
// Chromium writes /Title (from <title>) and nothing for /Author, so a CV or
// cover letter opened by a recruiter showed a title and nobody's name in the
// file properties. generate-pdf.mjs now stamps candidate.full_name from
// config/profile.yml into the Info dictionary through lib/pdf-info.mjs.
//
// Run:  node --test tests/pdf-author.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePdfTextString, normalizeAuthor, setPdfAuthor } from '../lib/pdf-info.mjs';
import { readCandidateName } from '../theme-style.mjs';
import { scrubPdfBuffer } from '../clean-artifacts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A minimal PDF laid out the way Chromium/Skia writes one: PDF-1.4, Info as
 * object 1 in plain text, one classic xref subsection, a single-line trailer.
 */
function buildChromiumLikePdf({ info = '<</Title (Jane Smith - CV)\n/Creator (Chromium)\n/Producer (Skia/PDF m140)\n/CreationDate (D:20260818123456+00\'00\')\n/ModDate (D:20260818123456+00\'00\')>>' } = {}) {
  const stream = 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET';
  const objects = [
    info,
    '<</Type /Catalog /Pages 3 0 R>>',
    '<</Type /Pages /Kids [4 0 R] /Count 1>>',
    '<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Contents 5 0 R>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n%Óëéá\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Every in-use xref entry must point at `N 0 obj`, and startxref at `xref`. */
function assertXrefValid(buffer) {
  const text = buffer.toString('latin1');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const count = Number(head[1]);
  const tableStart = startxref + head[0].length;
  for (let i = 1; i < count; i++) {
    const entry = text.slice(tableStart + i * 20, tableStart + i * 20 + 20);
    const offset = Number(entry.slice(0, 10));
    assert.match(text.slice(offset, offset + 12), new RegExp(`^${i} 0 obj`), `xref entry ${i} is off`);
  }
}

test('setPdfAuthor adds /Author to a Chromium-shaped PDF and keeps every offset valid', () => {
  const src = buildChromiumLikePdf();
  assertXrefValid(src);
  const { buffer, changed } = setPdfAuthor(src, 'Jane Smith');
  assert.equal(changed, true);
  const text = buffer.toString('latin1');
  assert.match(text, /\/Author \(Jane Smith\)/);
  assert.match(text, /\/Title \(Jane Smith - CV\)/, '/Title is untouched');
  assert.ok(text.includes('BT /F1 12 Tf 72 720 Td (Hello) Tj ET'), 'content stream is untouched');
  assertXrefValid(buffer);
});

test('setPdfAuthor is idempotent and never overrides an existing /Author', () => {
  const once = setPdfAuthor(buildChromiumLikePdf(), 'Jane Smith').buffer;
  const twice = setPdfAuthor(once, 'Someone Else');
  assert.equal(twice.changed, false);
  assert.match(twice.reason, /already has \/Author/);
  assert.ok(twice.buffer.equals(once));
});

test('a blank author, a non-PDF and an unrecognised layout leave the bytes alone', () => {
  const src = buildChromiumLikePdf();
  for (const blank of ['', '   ', undefined, null, 42]) {
    const r = setPdfAuthor(src, blank);
    assert.equal(r.changed, false);
    assert.ok(r.buffer.equals(src));
  }
  const notPdf = Buffer.from('this is not a pdf, not even close to being one, at all');
  assert.equal(setPdfAuthor(notPdf, 'Jane').changed, false);
  // An xref *stream* (PDF 1.5+) has no classic table to rewrite.
  const xrefStream = Buffer.from(src.toString('latin1').replace('xref\n0 6\n', 'xreg\n0 6\n'), 'latin1');
  const r = setPdfAuthor(xrefStream, 'Jane');
  assert.equal(r.changed, false);
  assert.ok(r.buffer.equals(xrefStream));
});

test('names with PDF-special or non-ASCII characters are encoded, not corrupted', () => {
  assert.equal(encodePdfTextString('Jane (JJ) O\\Neil'), '(Jane \\(JJ\\) O\\\\Neil)');
  assert.equal(encodePdfTextString('Zoë'), '<FEFF005A006F00EB>');
  const src = buildChromiumLikePdf();
  const { buffer } = setPdfAuthor(src, 'José Núñez');
  assert.match(buffer.toString('latin1'), /\/Author <FEFF004A006F007300E90020004E00FA00F10065007A>/);
  assertXrefValid(buffer);
});

test('normalizeAuthor collapses whitespace and strips control and separator characters', () => {
  assert.equal(normalizeAuthor('  Jane \n  Smith\t'), 'Jane Smith');
  assert.equal(normalizeAuthor('Jane\u0000Smith'), 'Jane Smith');
  assert.equal(normalizeAuthor(undefined), '');
  assert.equal(normalizeAuthor('x'.repeat(1000)).length, 256);
});

test('the clean-artifacts scrub still blanks /Producer and leaves /Author alone', () => {
  const stamped = setPdfAuthor(buildChromiumLikePdf(), 'Jane Smith').buffer;
  const scrubbed = scrubPdfBuffer(stamped);
  const text = scrubbed.buffer.toString('latin1');
  assert.equal(scrubbed.buffer.length, stamped.length, 'the scrub stays length-preserving');
  assert.match(text, /\/Author \(Jane Smith\)/);
  assert.match(text, /\/Title \(Jane Smith - CV\)/);
  assert.doesNotMatch(text, /Skia|Chromium/);
  assertXrefValid(scrubbed.buffer);
});

test('readCandidateName reads candidate.full_name and degrades to an empty string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-author-profile-'));
  try {
    const good = join(dir, 'profile.yml');
    writeFileSync(good, 'candidate:\n  full_name: "  Jane Smith  "\n  email: jane@example.com\n');
    assert.equal(readCandidateName(good), 'Jane Smith');
    const bom = join(dir, 'bom.yml');
    writeFileSync(bom, '﻿candidate:\n  full_name: Jane Smith\n');
    assert.equal(readCandidateName(bom), 'Jane Smith');
    const none = join(dir, 'none.yml');
    writeFileSync(none, 'candidate:\n  email: jane@example.com\n');
    assert.equal(readCandidateName(none), '');
    const num = join(dir, 'num.yml');
    writeFileSync(num, 'candidate:\n  full_name: 42\n');
    assert.equal(readCandidateName(num), '');
    const bad = join(dir, 'bad.yml');
    writeFileSync(bad, 'candidate: [unclosed\n');
    assert.equal(readCandidateName(bad), '');
    assert.equal(readCandidateName(join(dir, 'missing.yml')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate-pdf.mjs never hard-codes a name: it reads candidate.full_name', () => {
  const src = readFileSync(join(ROOT, 'generate-pdf.mjs'), 'utf-8');
  assert.match(src, /readCandidateName\(resolve\(outputRoot, 'config', 'profile\.yml'\)\)/);
  assert.match(src, /stampPdfAuthor\(/);
});

test('a real Chromium render carries /Title and the candidate as /Author', async (t) => {
  const { renderHtmlToPdf } = await import('../generate-pdf.mjs');
  const outDir = mkdtempSync(join(ROOT, 'output', 'pdf-author-'));
  try {
    mkdirSync(outDir, { recursive: true });
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Test Candidate - CV</title></head>'
      + '<body><h1>Test Candidate</h1></body></html>';
    let stamped;
    try {
      stamped = join(outDir, 'stamped.pdf');
      await renderHtmlToPdf(html, stamped, { author: 'Test Candidate' });
    } catch (err) {
      t.skip(`Chromium unavailable: ${err.message.split('\n')[0]}`);
      return;
    }
    const withAuthor = readFileSync(stamped);
    const text = withAuthor.toString('latin1');
    assert.match(text, /\/Title \(Test Candidate - CV\)/);
    assert.match(text, /\/Author \(Test Candidate\)/);
    assertXrefValid(withAuthor);
    // The scrub that follows in build-application.mjs must still work on it.
    const scrubbed = scrubPdfBuffer(withAuthor);
    assert.match(scrubbed.buffer.toString('latin1'), /\/Author \(Test Candidate\)/);
    assert.doesNotMatch(scrubbed.buffer.toString('latin1'), /Skia/);

    // An empty author means "no name known": the PDF is left as Chromium made it.
    const bare = join(outDir, 'bare.pdf');
    await renderHtmlToPdf(html, bare, { author: '' });
    assert.doesNotMatch(readFileSync(bare).toString('latin1'), /\/Author/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
