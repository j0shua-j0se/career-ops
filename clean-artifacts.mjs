#!/usr/bin/env node

/**
 * clean-artifacts.mjs — deterministic invisible-Unicode + PDF-metadata scrubber.
 *
 * Attribution: the text-hygiene rules below ("Layer A") port the deterministic
 * invisible-Unicode / space-homoglyph detection from the MIT-licensed
 * watermarks-remover project — https://github.com/guillaumemeyer/watermarks-remover
 * (service/scripts/text_unicode.py) — into native Node, so career-ops keeps its
 * zero-dependency build chain. This is a from-scratch JavaScript reimplementation
 * (no Python source was copied); the codepoint classes and the "load-bearing
 * invisibles are preserved" design are deliberately mirrored from that project.
 * watermarks-remover is MIT licensed — see its LICENSE for the original terms.
 *
 * The PDF /Info metadata scrub is this project's own addition (built for the
 * Chromium/Skia PDFs generate-pdf.mjs produces) — not part of the upstream port.
 *
 * Usage:
 *   node clean-artifacts.mjs <path...> [--inspect] [--in-place] [--keep-dates] [--json] [--quiet]
 *
 * Default action cleans each file in place (text hygiene for .html/.htm/.md/
 * .txt/.json/.tex, /Info metadata scrub for .pdf). --inspect reports findings
 * without changing anything. --in-place is accepted for explicitness — cleaning
 * is already the default, so it changes nothing that --inspect's absence
 * doesn't already imply. Any other extension is skipped with a clear message.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { extname, basename, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

// ─────────────────────────────────────────────────────────────────────────
// Layer A: text hygiene — invisible Unicode / format controls / space homoglyphs
// ─────────────────────────────────────────────────────────────────────────

// Zero-width / format controls stripped unconditionally unless a preserve
// rule below says otherwise.
const STRIP_EXPLICIT = new Set([
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
  0xfeff, // BOM / zero width no-break space
  0x00ad, // soft hyphen
  0x180e, // Mongolian vowel separator
  0x061c, // Arabic letter mark
]);

// Bidi directional controls — conditionally preserved, matching upstream's
// intent that RTL directional marks and paired embeddings are load-bearing:
//   - LRM/RLM (200E/200F) are preserved only when the surrounding text
//     actually contains an RTL-script character somewhere (see isRtlChar
//     below) — otherwise they're a carrier with nothing to direct.
//   - Embeddings (202A/202B ... 202C) and isolates (2066/2067/2068 ... 2069)
//     are preserved only as *correctly paired* runs, found via a stack scan
//     (computeBidiPairPreserveIndices) — an orphan opener or closer isn't
//     doing directional work.
//   - Overrides (202D/202E) are always stripped, paired or not. See
//     BIDI_EMBEDDING_OPENERS for why.
const BIDI_EXPLICIT = new Set([
  0x200e, 0x200f, // LRM, RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
  0x2066, 0x2067, 0x2068, 0x2069, // LRI, RLI, FSI, PDI
]);

// Openers for the two pairing families tracked by computeBidiPairPreserveIndices.
//
// LRO/RLO (202D/202E) are deliberately absent. They are *overrides*, not
// embeddings: they force every following character to a direction regardless of
// its own, which is the mechanism behind right-to-left filename and text
// spoofing. Legitimate bidirectional text reaches for RLM, RLE or RLI instead —
// an override in a CV is not typography, it is a way to make displayed text
// differ from the underlying characters. Upstream watermarks-remover strips
// them unconditionally for the same reason, and pairing does not make them
// benign, so a correctly closed override is stripped here too.
const BIDI_EMBEDDING_OPENERS = new Set([0x202a, 0x202b]); // LRE, RLE -> closed by PDF (202C)
const BIDI_OVERRIDE_OPENERS = new Set([0x202d, 0x202e]); // LRO, RLO -> tracked for nesting, never preserved
const BIDI_ISOLATE_OPENERS = new Set([0x2066, 0x2067, 0x2068]); // LRI, RLI, FSI -> closed by PDI (2069)

// RTL-script ranges used to decide whether a lone LRM/RLM has anything to
// direct: Hebrew/Arabic supplement blocks, Hebrew/Arabic presentation forms,
// and the RTL supplementary-plane scripts (e.g. Adlam sits just outside this
// but the task-specified ranges below are what this project targets).
function isRtlChar(cp) {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff) ||
    (cp >= 0x10800 && cp <= 0x10fff)
  );
}

/** True if any code point in `codepoints` falls in an RTL script range. */
function textHasRtl(codepoints) {
  for (const ch of codepoints) {
    if (isRtlChar(ch.codePointAt(0))) return true;
  }
  return false;
}

/**
 * Stack scan over `codepoints` finding correctly paired bidi embedding/
 * override runs (202A/202B/202D/202E ... 202C) and isolate runs
 * (2066/2067/2068 ... 2069). Returns a Set of indices — both the opener and
 * the closer of every validly matched pair — to preserve during cleaning.
 * Embeddings and isolates may nest inside each other (their closers differ:
 * PDF only closes an embedding, PDI only closes an isolate), so a closer that
 * doesn't match the family on top of the stack is treated as unpaired and left
 * off the preserve set without disturbing the stack. Anything left on the stack
 * when the scan ends (an opener with no matching closer before the string runs
 * out) is never preserved.
 *
 * Overrides (202D/202E) ARE pushed, so that nesting is tracked with real
 * Unicode semantics — an override consumes one PDF — but they are tagged
 * `override` and neither they nor the PDF that closes them is ever preserved:
 * the terminator of a spoofing control has nothing legitimate to terminate.
 * Not pushing them would be worse than it looks, because the override's own
 * PDF would then close the *enclosing* embedding, preserving a shorter run
 * than the text actually declared.
 */
function computeBidiPairPreserveIndices(codepoints) {
  const preserve = new Set();
  const stack = [];
  for (let i = 0; i < codepoints.length; i++) {
    const cp = codepoints[i].codePointAt(0);
    if (BIDI_EMBEDDING_OPENERS.has(cp)) {
      stack.push({ family: 'embedding', index: i });
    } else if (BIDI_OVERRIDE_OPENERS.has(cp)) {
      // Pushed so that nesting is tracked with real Unicode semantics — an
      // override consumes one PDF — but tagged so neither it nor that PDF is
      // ever preserved. Skipping the push instead would let the override's own
      // terminator close the enclosing embedding, silently repairing a
      // different (shorter) run than the text actually declared.
      stack.push({ family: 'override', index: i });
    } else if (BIDI_ISOLATE_OPENERS.has(cp)) {
      stack.push({ family: 'isolate', index: i });
    } else if (cp === 0x202c) { // PDF
      const top = stack[stack.length - 1];
      if (top && top.family === 'embedding') {
        stack.pop();
        preserve.add(top.index);
        preserve.add(i);
      } else if (top && top.family === 'override') {
        stack.pop(); // consumed, but neither end survives
      }
    } else if (cp === 0x2069) { // PDI
      const top = stack[stack.length - 1];
      if (top && top.family === 'isolate') {
        stack.pop();
        preserve.add(top.index);
        preserve.add(i);
      }
    }
  }
  return preserve;
}

// Space homoglyphs replaced with a plain ASCII space.
const SPACE_HOMOGLYPHS = new Map(
  [0x00a0, 0x202f, 0x205f, 0x3000, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i)]
    .map((cp) => [cp, ' '])
);

function isTagChar(cp) {
  return cp >= 0xe0000 && cp <= 0xe007f;
}
function isPrivateUse(cp) {
  return cp >= 0xe000 && cp <= 0xf8ff;
}
function isVariationSelector(cp) {
  return cp >= 0xfe00 && cp <= 0xfe0f;
}

// Broad "pictographic" test used for two preserve rules: ZWJ between two
// pictographic code points (emoji ZWJ sequences), and VS16 (FE0F, emoji
// presentation selector) directly after a pictographic code point. This is a
// deliberately simplified approximation of Unicode's Extended_Pictographic
// property — it covers the emoji blocks plus the legacy symbol ranges that
// commonly carry FE0F/ZWJ (dingbats, misc symbols, keycap bases) — not a
// full property table.
function isPictographic(cp) {
  if (cp == null) return false;
  if (cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39)) return true; // keycap bases: # * 0-9
  if ([0x00a9, 0x00ae, 0x2122, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp)) return true;
  if (cp >= 0x2190 && cp <= 0x21ff) return true; // arrows
  if (cp >= 0x2300 && cp <= 0x23ff) return true; // misc technical
  if (cp >= 0x25a0 && cp <= 0x27bf) return true; // geometric shapes, misc symbols, dingbats
  if (cp >= 0x2b00 && cp <= 0x2bff) return true; // misc symbols and arrows
  if (cp >= 0x1f000 && cp <= 0x1faff) return true; // the main emoji planes
  return false;
}

// CJK Unified Ideograph ranges (main block + Extension A + compatibility +
// the supplementary-plane extensions, treated as one contiguous band for
// simplicity — precise extension-block boundaries don't matter here).
function isCjkIdeograph(cp) {
  if (cp == null) return false;
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

// Per the task spec: ZWNJ/ZWJ next to Arabic/Hebrew (0590-08FF) or
// Devanagari/other Indic scripts (0900-0DFF) are orthographic, not carriers.
// Kept simple and documented rather than a full script-joining-type table.
function isJoiningScript(cp) {
  if (cp == null) return false;
  return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0x0900 && cp <= 0x0dff);
}

/** Indices (into a code-point array) that fall inside a *complete* subdivision
 * flag tag sequence: U+1F3F4 WAVING BLACK FLAG, one or more tag chars in
 * U+E0020-E007E, then the U+E007F cancel tag. Only complete sequences are
 * marked — a truncated one is contraband, not a flag. */
function computeFlagTagPreserveIndices(codepoints) {
  const preserve = new Set();
  for (let i = 0; i < codepoints.length; i++) {
    if (codepoints[i].codePointAt(0) !== 0x1f3f4) continue;
    let j = i + 1;
    while (j < codepoints.length) {
      const cp = codepoints[j].codePointAt(0);
      if (cp >= 0xe0020 && cp <= 0xe007e) { j++; continue; }
      break;
    }
    if (j > i + 1 && j < codepoints.length && codepoints[j].codePointAt(0) === 0xe007f) {
      for (let k = i + 1; k <= j; k++) preserve.add(k);
    }
  }
  return preserve;
}

/**
 * Classify one code point at index `i`. Returns null for an ordinary
 * character (nothing to report), or a decision object describing the
 * strip/replace/keep action, the inspect `kind`, and whether a load-bearing
 * preserve rule applied.
 */
function classify(i, codepoints, flagTagPreserve, bidiPairPreserve, hasRtl) {
  const ch = codepoints[i];
  const cp = ch.codePointAt(0);
  const prevCp = i > 0 ? codepoints[i - 1].codePointAt(0) : null;
  const nextCp = i + 1 < codepoints.length ? codepoints[i + 1].codePointAt(0) : null;

  let bucket = null;
  let kind = null;
  if (STRIP_EXPLICIT.has(cp)) { bucket = 'strip'; kind = 'strip'; }
  else if (isTagChar(cp)) { bucket = 'strip'; kind = 'tag_chars'; }
  else if (isPrivateUse(cp)) { bucket = 'strip'; kind = 'private_use'; }
  else if (isVariationSelector(cp)) { bucket = 'strip'; kind = 'variation_selector'; }
  else if (BIDI_EXPLICIT.has(cp)) { bucket = 'bidi'; kind = 'bidi'; }
  else if (SPACE_HOMOGLYPHS.has(cp)) { bucket = 'space'; kind = 'space'; }
  else return null;

  let preserved = false;
  if (bucket === 'strip') {
    if (cp === 0x200d && isPictographic(prevCp) && isPictographic(nextCp)) {
      preserved = true; // emoji ZWJ sequence, e.g. 👨‍👩‍👧
    } else if (cp === 0xfe0f && isPictographic(prevCp)) {
      preserved = true; // VS16 emoji presentation selector
    } else if (cp >= 0xfe00 && cp <= 0xfe0f && isCjkIdeograph(prevCp)) {
      preserved = true; // Ideographic Variation Sequence
    } else if ((cp === 0x200c || cp === 0x200d) && (isJoiningScript(prevCp) || isJoiningScript(nextCp))) {
      preserved = true; // orthographic ZWNJ/ZWJ in Arabic/Hebrew/Indic scripts
    } else if (cp >= 0xe0020 && cp <= 0xe007f && flagTagPreserve.has(i)) {
      preserved = true; // part of a complete flag tag sequence
    }
  } else if (bucket === 'bidi') {
    if (cp === 0x200e || cp === 0x200f) {
      if (hasRtl) preserved = true; // LRM/RLM: load-bearing only where the text has RTL script to direct
    } else if (bidiPairPreserve.has(i)) {
      preserved = true; // one end of a correctly paired embedding/override/isolate run
    }
  }

  const action = preserved ? 'keep' : bucket === 'space' ? 'replace' : 'strip';
  const outChar = preserved ? ch : bucket === 'space' ? SPACE_HOMOGLYPHS.get(cp) : '';
  return { index: i, codePoint: cp, char: ch, kind, preserved, action, outChar };
}

/**
 * Report every suspicious/preserved code point in `str`. Ordinary characters
 * are omitted; preserved (load-bearing) characters ARE included, tagged
 * `preserved: true`, so cleaning is conservative but inspection hides nothing.
 *
 * `index` is a code-point offset (via Array.from(str)), not a UTF-16 offset —
 * consistent between inspectText and cleanText, but not directly usable as a
 * JS string index when supplementary-plane characters precede it.
 */
export function inspectText(str) {
  const codepoints = Array.from(str);
  const flagTagPreserve = computeFlagTagPreserveIndices(codepoints);
  const bidiPairPreserve = computeBidiPairPreserveIndices(codepoints);
  const hasRtl = textHasRtl(codepoints);
  const findings = [];
  for (let i = 0; i < codepoints.length; i++) {
    const c = classify(i, codepoints, flagTagPreserve, bidiPairPreserve, hasRtl);
    if (c) findings.push({ index: c.index, codePoint: c.codePoint, char: c.char, kind: c.kind, preserved: c.preserved });
  }
  return findings;
}

/**
 * Clean `str`: strip invisible/format carriers, replace space homoglyphs with
 * ASCII space, and leave load-bearing invisibles untouched. Returns the
 * cleaned text plus `removed`/`replaced` (the findings that were actually
 * mutated) and `findings` (every suspicious code point, preserved or not —
 * same shape as inspectText's output).
 */
export function cleanText(str) {
  const codepoints = Array.from(str);
  const flagTagPreserve = computeFlagTagPreserveIndices(codepoints);
  const bidiPairPreserve = computeBidiPairPreserveIndices(codepoints);
  const hasRtl = textHasRtl(codepoints);
  const out = [];
  const findings = [];
  const removed = [];
  const replaced = [];
  for (let i = 0; i < codepoints.length; i++) {
    const c = classify(i, codepoints, flagTagPreserve, bidiPairPreserve, hasRtl);
    if (!c) { out.push(codepoints[i]); continue; }
    findings.push({ index: c.index, codePoint: c.codePoint, char: c.char, kind: c.kind, preserved: c.preserved });
    if (c.action === 'keep') {
      out.push(c.char);
    } else if (c.action === 'replace') {
      out.push(c.outChar);
      replaced.push({ index: c.index, codePoint: c.codePoint, char: c.char, kind: c.kind });
    } else {
      removed.push({ index: c.index, codePoint: c.codePoint, char: c.char, kind: c.kind });
    }
  }
  return { text: out.join(''), removed, replaced, findings };
}

// ─────────────────────────────────────────────────────────────────────────
// PDF /Info metadata scrub
// ─────────────────────────────────────────────────────────────────────────

const NEVER_TOUCH_FIELDS = ['Title', 'Author'];
const DEFAULT_BLANK_FIELDS = ['Creator', 'Producer'];
const DATE_FIELDS = ['CreationDate', 'ModDate'];

/** Parse a PDF literal string `(...)` starting at `openIdx` (text[openIdx] ===
 * '('), honoring `\)` escapes and balanced unescaped parens. Returns the
 * exclusive end index (just past the closing paren), or null if unterminated. */
function parseLiteralString(text, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return i;
}

/** Find the trailer's `/Info N G R` reference. Returns { objNum, gen } or null. */
function findInfoRef(text) {
  let idx = text.lastIndexOf('\ntrailer');
  if (idx === -1) idx = text.indexOf('trailer');
  if (idx === -1) return null;
  const dictStart = text.indexOf('<<', idx);
  if (dictStart === -1) return null;
  const dictEnd = text.indexOf('>>', dictStart);
  if (dictEnd === -1) return null;
  const dict = text.slice(dictStart, dictEnd);
  const m = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(dict);
  return m ? { objNum: m[1], gen: m[2] } : null;
}

/** Locate `N G obj << ... >> endobj` for the Info object. Returns
 * { bodyStart, bodyEnd } (the span strictly between << and >>) or null if the
 * object isn't found as plain text (absent, or compressed in an object stream —
 * this parser deliberately does not chase compressed object streams). */
function findInfoObject(text, objNum, gen) {
  const headerRe = new RegExp(`(?:^|[^0-9])${objNum}\\s+${gen}\\s+obj\\b`);
  const m = headerRe.exec(text);
  if (!m) return null;
  const headerEnd = m.index + m[0].length;
  const dictStart = text.indexOf('<<', headerEnd);
  const endobjIdx = text.indexOf('endobj', headerEnd);
  if (dictStart === -1 || endobjIdx === -1 || dictStart > endobjIdx) return null;
  const dictEnd = text.lastIndexOf('>>', endobjIdx);
  if (dictEnd === -1 || dictEnd < dictStart) return null;
  return { bodyStart: dictStart + 2, bodyEnd: dictEnd };
}

/** Find `/Name`'s value within [bodyStart, bodyEnd). Returns 'absent', 'hex',
 * 'unsupported', or { start, end } spanning the literal string including its
 * parens. */
function findFieldLiteralString(text, bodyStart, bodyEnd, name) {
  const nameRe = new RegExp(`/${name}(?![A-Za-z0-9])`);
  const body = text.slice(bodyStart, bodyEnd);
  const m = nameRe.exec(body);
  if (!m) return 'absent';
  let i = bodyStart + m.index + m[0].length;
  while (i < bodyEnd && /\s/.test(text[i])) i++;
  if (i >= bodyEnd) return 'absent';
  if (text[i] === '(') {
    const end = parseLiteralString(text, i);
    if (end === null || end > bodyEnd) return 'unsupported';
    return { start: i, end };
  }
  if (text[i] === '<') return 'hex';
  return 'unsupported';
}

/**
 * Scrub toolchain-fingerprint /Info fields from a PDF buffer without
 * shifting a single byte — every replacement is padded/rewritten to the
 * exact original byte length, and the function throws rather than return a
 * buffer whose length doesn't match (a shifted xref table corrupts the PDF).
 *
 * - /Title and /Author are never touched, regardless of options.
 * - /Creator and /Producer (default `fields`) are blanked to `()` + padding.
 * - /CreationDate and /ModDate are normalized to midnight of the same date
 *   (`keepDates: true` skips this) — only when the existing value already
 *   parses as `D:YYYYMMDDHHMMSS...`; anything else is left untouched.
 * - Hex-string values, an absent field, an absent/compressed Info dict, or a
 *   trailer with no /Info reference are all reported in `fields` as
 *   `{ name, action: 'skipped', reason }` — never guessed at or mangled.
 */
export function scrubPdfBuffer(buffer, options = {}) {
  const keepDates = options.keepDates ?? false;
  const blankFields = options.fields ?? DEFAULT_BLANK_FIELDS;
  const text = buffer.toString('latin1');

  const trailerInfo = findInfoRef(text);
  if (!trailerInfo) {
    return {
      buffer: Buffer.from(text, 'latin1'),
      changed: false,
      fields: [{ name: 'Info', action: 'skipped', reason: 'trailer /Info reference not found' }],
    };
  }
  const objLoc = findInfoObject(text, trailerInfo.objNum, trailerInfo.gen);
  if (!objLoc) {
    return {
      buffer: Buffer.from(text, 'latin1'),
      changed: false,
      fields: [{
        name: 'Info',
        action: 'skipped',
        reason: `Info object ${trailerInfo.objNum} ${trailerInfo.gen} obj not found (absent or compressed)`,
      }],
    };
  }

  const fields = [];
  const spans = [];

  for (const name of NEVER_TOUCH_FIELDS) {
    fields.push({ name, action: 'skipped', reason: 'left alone by default' });
  }

  for (const name of blankFields) {
    if (NEVER_TOUCH_FIELDS.includes(name)) continue; // Title/Author can never be overridden into a blank target
    const loc = findFieldLiteralString(text, objLoc.bodyStart, objLoc.bodyEnd, name);
    if (loc === 'absent') { fields.push({ name, action: 'skipped', reason: 'field not present' }); continue; }
    if (loc === 'hex') { fields.push({ name, action: 'skipped', reason: 'hex string value not supported' }); continue; }
    if (loc === 'unsupported') { fields.push({ name, action: 'skipped', reason: 'unsupported value type' }); continue; }
    const originalLen = loc.end - loc.start;
    const newLiteral = '(' + ' '.repeat(originalLen - 2) + ')';
    if (newLiteral.length !== originalLen) {
      throw new Error(`clean-artifacts: length mismatch blanking /${name} (this should never happen)`);
    }
    if (newLiteral === text.slice(loc.start, loc.end)) {
      fields.push({ name, action: 'unchanged', reason: 'already blank' });
      continue;
    }
    spans.push({ start: loc.start, end: loc.end, replacement: newLiteral });
    fields.push({ name, action: 'blanked' });
  }

  for (const name of DATE_FIELDS) {
    if (keepDates) { fields.push({ name, action: 'skipped', reason: 'keepDates option' }); continue; }
    const loc = findFieldLiteralString(text, objLoc.bodyStart, objLoc.bodyEnd, name);
    if (loc === 'absent') { fields.push({ name, action: 'skipped', reason: 'field not present' }); continue; }
    if (loc === 'hex') { fields.push({ name, action: 'skipped', reason: 'hex string value not supported' }); continue; }
    if (loc === 'unsupported') { fields.push({ name, action: 'skipped', reason: 'unsupported value type' }); continue; }
    const content = text.slice(loc.start + 1, loc.end - 1);
    const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([\s\S]*)$/.exec(content);
    if (!m) { fields.push({ name, action: 'skipped', reason: 'value is not a recognizable PDF date' }); continue; }
    const newContent = `D:${m[1]}${m[2]}${m[3]}000000${m[7]}`;
    if (newContent.length !== content.length) {
      throw new Error(`clean-artifacts: length mismatch normalizing /${name} (this should never happen)`);
    }
    if (newContent === content) {
      fields.push({ name, action: 'unchanged', reason: 'already normalized' });
      continue;
    }
    const newLiteral = '(' + newContent + ')';
    spans.push({ start: loc.start, end: loc.end, replacement: newLiteral });
    fields.push({ name, action: 'normalized' });
  }

  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  out += text.slice(cursor);

  if (out.length !== text.length) {
    throw new Error('clean-artifacts: PDF byte length changed during scrub — aborting to protect the xref table');
  }
  const newBuffer = Buffer.from(out, 'latin1');
  if (newBuffer.length !== buffer.length) {
    throw new Error('clean-artifacts: PDF buffer length changed during scrub — aborting to protect the xref table');
  }
  return { buffer: newBuffer, changed: spans.length > 0, fields };
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.md', '.txt', '.json', '.tex']);

function usage() {
  return `Usage: node clean-artifacts.mjs <path...> [options]

  --inspect      Report findings only; change nothing
  --in-place     Explicit alias for the default clean-in-place action
  --keep-dates   Do not normalize /CreationDate and /ModDate in PDFs
  --json         Print one JSON object with per-file results
  --quiet        Suppress per-file lines; print only the summary
  --help         Show this message

Dispatch by extension: .pdf -> PDF /Info metadata scrub; .html .htm .md .txt
.json .tex -> text hygiene (invisible Unicode / space homoglyphs); anything
else is skipped.`;
}

function processTextFile(path, opts) {
  const text = readFileSync(path, 'utf-8');
  if (opts.inspect) {
    const findings = inspectText(text);
    return { path, kind: 'text', findings, findingsCount: findings.length, changed: false };
  }
  const { text: cleaned, removed, replaced, findings } = cleanText(text);
  const changed = cleaned !== text;
  if (changed) writeFileSync(path, cleaned, 'utf-8');
  return {
    path, kind: 'text', changed,
    removedCount: removed.length, replacedCount: replaced.length,
    findingsCount: findings.length,
  };
}

function processPdfFile(path, opts) {
  const buffer = readFileSync(path);
  const { buffer: cleaned, changed, fields } = scrubPdfBuffer(buffer, { keepDates: opts['keep-dates'] });
  if (opts.inspect) {
    return { path, kind: 'pdf', fields, changed: false, wouldChange: changed };
  }
  if (changed) writeFileSync(path, cleaned);
  return { path, kind: 'pdf', fields, changed };
}

function processFile(rawPath, opts) {
  const path = resolve(rawPath);
  if (!existsSync(path)) return { path, kind: 'error', error: 'file not found' };
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.pdf') return processPdfFile(path, opts);
    if (TEXT_EXTENSIONS.has(ext)) return processTextFile(path, opts);
    return { path, kind: 'skipped', message: `unsupported extension "${ext || '(none)'}"` };
  } catch (err) {
    return { path, kind: 'error', error: err.message };
  }
}

function formatLine(result, opts) {
  const label = relative(process.cwd(), result.path) || basename(result.path);
  if (result.kind === 'error') return `❌ ${label}  error: ${result.error}`;
  if (result.kind === 'skipped') return `-  ${label}  skipped (${result.message})`;
  if (result.kind === 'text') {
    if (opts.inspect) {
      const icon = result.findingsCount > 0 ? '⚠️ ' : '✅';
      return `${icon} ${label}  text  ${result.findingsCount} finding(s)`;
    }
    const icon = result.changed ? '🔧' : '✅';
    const detail = result.changed
      ? `cleaned (${result.removedCount} removed, ${result.replacedCount} replaced)`
      : 'clean';
    return `${icon} ${label}  text  ${detail}`;
  }
  if (result.kind === 'pdf') {
    const touched = result.fields.filter((f) => f.action === 'blanked' || f.action === 'normalized').length;
    if (opts.inspect) {
      const icon = result.wouldChange ? '⚠️ ' : '✅';
      return `${icon} ${label}  pdf   ${touched} field(s) would change`;
    }
    const icon = result.changed ? '🔧' : '✅';
    return `${icon} ${label}  pdf   ${result.changed ? `scrubbed (${touched} field(s))` : 'clean'}`;
  }
  return `? ${label}  unknown result`;
}

async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        inspect: { type: 'boolean', default: false },
        'in-place': { type: 'boolean', default: false },
        'keep-dates': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    console.error(`clean-artifacts: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (values.help || positionals.length === 0) {
    console.log(usage());
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const results = positionals.map((p) => processFile(p, values));
  const hadError = results.some((r) => r.kind === 'error');

  if (values.json) {
    console.log(JSON.stringify({ inspect: values.inspect, files: results }, null, 2));
  } else {
    if (!values.quiet) {
      for (const r of results) console.log(formatLine(r, values));
    }
    if (values.inspect) {
      const totalFindings = results.reduce((sum, r) => sum + (r.findingsCount ?? (r.fields?.filter((f) => f.action === 'blanked' || f.action === 'normalized').length ?? 0)), 0);
      console.log(`\nFindings: ${totalFindings} across ${results.length} file(s).`);
    } else {
      const cleaned = results.filter((r) => r.changed).length;
      const skipped = results.filter((r) => r.kind === 'skipped').length;
      const errors = results.filter((r) => r.kind === 'error').length;
      console.log(`\nCleaned: ${cleaned}  Unchanged: ${results.length - cleaned - skipped - errors}  Skipped: ${skipped}  Errors: ${errors}`);
    }
  }

  process.exitCode = hadError ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`clean-artifacts: ${error.message}`);
    process.exitCode = 1;
  });
}
