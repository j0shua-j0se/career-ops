#!/usr/bin/env node

/**
 * verify-pdf-ats.mjs — does the PDF a recruiter receives survive an ATS parser?
 *
 * An applicant tracking system reads the PDF's embedded TEXT LAYER, not the
 * rendered page. Those two can disagree: a glyph can be visible and unextractable
 * (`(cid:12)`, `□`, `�`), a contact detail can exist only inside an icon or a
 * hyperlink, and a CSS regression can push a two-page CV to three without
 * changing a single character of the source. None of that is visible in the
 * HTML, and none of it is caught by the fact gate, which reads the HTML.
 *
 * This repo already owned the check — `test/cv-visual/cv-visual.spec.mjs` asserts
 * page count and text extraction — but only against sanitized FIXTURES, and only
 * under `npm run test:cv-visual`, which is not part of `test-all.mjs`. The CV
 * actually sent to an employer was never checked at all. Same technique, pointed
 * at the real artifact.
 *
 * Adopted from the ai-job-search framework's `tools/verify_pdf.py`
 * (github.com/MadsLorentzen/ai-job-search, MIT), which verifies page count and
 * text-layer extraction for the same reason.
 *
 * Usage:
 *   node verify-pdf-ats.mjs <pdf> [--pages N] [--max-pages N] [--min-chars N]
 *                                 [--contains "text"]... [--dump-text <path>]
 *                                 [--payload <cv.json>] [--json]
 *
 * `--payload` derives the required strings from the CV payload itself — the
 * candidate's name and email — so the common case needs no `--contains` at all.
 *
 * Exit 0 when every check passes, 1 otherwise. Missing `pdftotext` is a
 * WARNING, not a failure: it is an optional Poppler dependency, and a hard
 * failure here would block the build chain on a machine that simply lacks it.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { isMainModule } from './lib/is-main-module.mjs';

/**
 * Count concrete page objects in a PDF buffer.
 *
 * Byte-level on purpose: it needs no external tool, so page count is still
 * checked on a machine with no Poppler installed — the case where the text-layer
 * half of this gate degrades to a warning.
 */
export function countPdfPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

/**
 * Characters that mean the text layer is broken rather than merely different.
 *
 * `(cid:N)` is a font whose glyphs never got mapped back to characters — the
 * classic LaTeX/embedded-subset failure, where the page looks perfect and the
 * parser reads nothing. U+FFFD and the tofu box are the same story from the
 * other direction.
 */
const BROKEN_GLYPH_PATTERNS = [
  { re: /\(cid:\d+\)/, label: 'unmapped font glyphs — (cid:N) markers' },
  { re: /�/, label: 'replacement characters (U+FFFD)' },
  { re: /□/, label: 'tofu boxes (U+25A1)' },
];

export function normalizeText(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/** Find broken-glyph evidence in an extracted text layer. */
export function findBrokenGlyphs(text) {
  return BROKEN_GLYPH_PATTERNS.filter((p) => p.re.test(String(text ?? ''))).map((p) => p.label);
}

/**
 * Strings a CV must expose as literal text, derived from its own payload.
 *
 * Email is the one that actually bites: a template that renders it only as a
 * `mailto:` link or an icon looks complete to a human and leaves an ATS with no
 * way to contact the candidate. Phone is deliberately NOT required — this
 * candidate's CVs carry email only on purpose.
 */
export function requiredStringsFromPayload(payload) {
  const out = [];
  const c = payload?.candidate ?? {};
  if (typeof c.name === 'string' && c.name.trim()) out.push(c.name.trim());
  if (typeof c.email === 'string' && c.email.trim()) out.push(c.email.trim());
  return out;
}

export function extractTextLayer(pdfPath) {
  try {
    return {
      text: execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
      available: true,
    };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return { text: '', available: false, missing, message: error?.message ?? String(error) };
  }
}

/**
 * The pure gate. Returns { ok, failures[], warnings[], pages, extracted }.
 * No I/O beyond what the caller already read, so it is unit-testable offline.
 */
export function evaluateAts({ buffer, text, textAvailable, pages: pagesIn,
  expectPages = null, maxPages = null, minChars = 0, contains = [] } = {}) {
  const failures = [];
  const warnings = [];
  const pages = pagesIn ?? (buffer ? countPdfPages(buffer) : 0);

  if (pages === 0) failures.push('no page objects found — the file may not be a PDF');
  if (expectPages != null && pages !== expectPages) {
    failures.push(`expected exactly ${expectPages} page(s), found ${pages}`);
  }
  if (maxPages != null && pages > maxPages) {
    failures.push(`PDF is ${pages} pages; the limit is ${maxPages}`);
  }

  if (!textAvailable) {
    // Degrade, never block: pdftotext is optional and a build chain must not
    // stop because a machine lacks Poppler. The page-count half still ran.
    warnings.push('pdftotext unavailable — text-layer checks skipped (install poppler-utils to enable)');
    return { ok: failures.length === 0, failures, warnings, pages, extracted: '' };
  }

  const normalized = normalizeText(text);
  if (normalized.length < minChars) {
    failures.push(`text layer has ${normalized.length} character(s); expected at least ${minChars}`);
  }
  for (const label of findBrokenGlyphs(text)) {
    failures.push(`text layer contains ${label}`);
  }
  for (const needle of contains) {
    if (!normalizeText(needle)) continue;
    if (!normalized.includes(normalizeText(needle))) {
      failures.push(`text layer is missing required text: ${JSON.stringify(needle)}`);
    }
  }
  return { ok: failures.length === 0, failures, warnings, pages, extracted: text };
}

function usage() {
  return `Usage: node verify-pdf-ats.mjs <pdf> [options]

  --pages N          require exactly N pages
  --max-pages N      fail above N pages (default 2 for a CV; pass 0 to disable)
  --min-chars N      minimum non-whitespace characters in the text layer (default 400)
  --contains "text"  text that must appear literally; repeatable
  --payload <json>   derive --contains from a CV payload (candidate name + email)
  --dump-text <path> write the extracted text layer here
  --json             machine-readable result on stdout`;
}

async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        pages: { type: 'string' },
        'max-pages': { type: 'string' },
        'min-chars': { type: 'string', default: '400' },
        contains: { type: 'string', multiple: true, default: [] },
        payload: { type: 'string' },
        'dump-text': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    console.error(`verify-pdf-ats: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const pdfPath = positionals[0];
  if (values.help || !pdfPath) {
    console.log(usage());
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const target = resolve(pdfPath);
  if (!existsSync(target)) {
    console.error(`verify-pdf-ats: PDF not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const contains = [...values.contains];
  if (values.payload) {
    const p = resolve(values.payload);
    if (!existsSync(p)) {
      console.error(`verify-pdf-ats: payload not found: ${p}`);
      process.exitCode = 1;
      return;
    }
    try {
      contains.push(...requiredStringsFromPayload(JSON.parse(readFileSync(p, 'utf-8'))));
    } catch (error) {
      console.error(`verify-pdf-ats: could not read payload ${p}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const buffer = readFileSync(target);
  const { text, available } = extractTextLayer(target);

  if (values['dump-text']) {
    const dump = resolve(values['dump-text']);
    mkdirSync(dirname(dump), { recursive: true });
    writeFileSync(dump, text.endsWith('\n') ? text : `${text}\n`, 'utf-8');
  }

  const maxPagesRaw = values['max-pages'] ?? '2';
  const maxPages = Number(maxPagesRaw) === 0 ? null : Number(maxPagesRaw);
  const result = evaluateAts({
    buffer,
    text,
    textAvailable: available,
    expectPages: values.pages ? Number(values.pages) : null,
    maxPages,
    minChars: Number(values['min-chars']),
    contains,
  });

  if (values.json) {
    console.log(JSON.stringify({ pdf: target, ...result, extracted: undefined }, null, 2));
  } else {
    for (const w of result.warnings) console.log(`⚠️  ${w}`);
    if (result.ok) {
      console.log(`✅ ATS gate passed — ${result.pages} page(s), `
        + `${available ? `${normalizeText(text).length} extractable characters` : 'text layer not checked'}`);
      if (contains.length && available) {
        console.log(`   verified present as literal text: ${contains.join(', ')}`);
      }
    } else {
      console.error(`❌ ATS gate failed for ${target}`);
      for (const f of result.failures) console.error(`   - ${f}`);
      console.error('\n   An ATS reads the text layer, not the rendered page. Fix before sending.');
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`verify-pdf-ats: ${error.message}`);
    process.exitCode = 1;
  });
}
