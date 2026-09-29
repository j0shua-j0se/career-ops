/**
 * pdf-info.mjs — set `/Author` in the /Info dictionary of a Chromium-printed PDF.
 *
 * Chromium stamps a `/Title` (from the document `<title>`), a `/Creator` and a
 * `/Producer`, and no `/Author`. A CV or cover letter that a recruiter opens
 * therefore shows a title and nobody's name in the file properties. The name is
 * the candidate's own (`config/profile.yml` -> `candidate.full_name`); this
 * module only knows how to write it into the bytes.
 *
 * Editing a PDF in place is safe only when every byte offset stays right, so
 * this does the one thing Chromium's output allows: it inserts the entry into
 * the plain-text Info object, then shifts each cross-reference offset that
 * points past the insertion and rewrites `startxref`. Anything it does not
 * recognise -- an xref stream, an Info object inside an object stream, several
 * xref subsections, an Info dictionary that already names an author -- leaves
 * the buffer byte-for-byte untouched and says why. The result is re-validated
 * (every in-use xref entry must land on `N G obj`) before it is returned, and a
 * failed validation returns the original buffer.
 *
 * Ordering with `clean-artifacts.mjs`: that scrub blanks `/Creator` and
 * `/Producer` in a length-preserving way and never touches `/Title` or
 * `/Author`, so the two compose in either order as long as this runs while the
 * Info object is still a single plain-text dictionary -- which is exactly what
 * generate-pdf.mjs hands it.
 *
 * Pure: bytes in, bytes out, no I/O and no dependencies.
 */

/** Longest author the writer will embed; a name is never near this. */
const MAX_AUTHOR_CHARS = 256;

/** One 20-byte cross-reference entry: offset, generation, in-use flag, EOL. */
const ENTRY_RE = /^\d{10} \d{5} [nf](?: \n| \r|\r\n)$/;

/**
 * Encode text as a PDF text string: a literal `( ... )` for printable ASCII,
 * otherwise UTF-16BE with a BOM as a hex string (the PDF spec's Unicode form).
 * @param {string} text
 * @returns {string} an ASCII-only PDF string token
 */
export function encodePdfTextString(text) {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  }
  const hex = ['FEFF'];
  for (let i = 0; i < text.length; i++) {
    hex.push(text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'));
  }
  return `<${hex.join('')}>`;
}

/**
 * Clean a candidate-supplied author string: collapse whitespace, drop control
 * and line-separator characters, and cap the length. Returns '' for anything
 * that is not text.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAuthor(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AUTHOR_CHARS);
}

/** Whether every in-use xref entry points at `N G obj` (used to vet the result). */
function xrefIsConsistent(text, xrefPos, count) {
  const head = /^xref\n0 \d+\n/.exec(text.slice(xrefPos, xrefPos + 40));
  if (!head) return false;
  const tableStart = xrefPos + head[0].length;
  for (let i = 0; i < count; i++) {
    const entry = text.slice(tableStart + i * 20, tableStart + i * 20 + 20);
    if (!ENTRY_RE.test(entry)) return false;
    if (entry[17] !== 'n') continue;
    const offset = Number(entry.slice(0, 10));
    const generation = Number(entry.slice(11, 16));
    if (!new RegExp(`^${i} ${generation} obj\\b`).test(text.slice(offset, offset + 24))) return false;
  }
  return true;
}

/**
 * @typedef {{buffer: Buffer, changed: boolean, reason?: string}} SetAuthorResult
 */

/**
 * Return the PDF with `/Author` set in its Info dictionary.
 *
 * @param {Buffer} buffer  the PDF bytes
 * @param {string} author  the candidate's name (blank -> unchanged)
 * @returns {SetAuthorResult}
 */
export function setPdfAuthor(buffer, author) {
  const unchanged = (reason) => ({ buffer, changed: false, reason });
  const name = normalizeAuthor(author);
  if (!name) return unchanged('no author supplied');
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.toString('latin1', 0, 5) !== '%PDF-') {
    return unchanged('not a PDF');
  }

  const text = buffer.toString('latin1');

  const startxrefIdx = text.lastIndexOf('startxref');
  if (startxrefIdx < 0) return unchanged('no startxref');
  const sx = /^startxref\s+(\d+)\s*%%EOF\s*$/.exec(text.slice(startxrefIdx));
  if (!sx) return unchanged('unrecognised startxref tail');
  const xrefPos = Number(sx[1]);
  const xrefHead = /^xref\n0 (\d+)\n/.exec(text.slice(xrefPos, xrefPos + 40));
  if (!xrefHead) return unchanged('cross-reference table is not a single classic subsection');
  const objCount = Number(xrefHead[1]);

  const trailerIdx = text.indexOf('trailer', xrefPos);
  if (trailerIdx < 0) return unchanged('no trailer');
  const infoRef = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(text.slice(trailerIdx, startxrefIdx));
  if (!infoRef) return unchanged('trailer has no /Info reference');
  const [, objNum, gen] = infoRef;

  const objHeader = new RegExp(`(?:^|[^0-9])(${objNum}\\s+${gen}\\s+obj)\\b`).exec(text);
  if (!objHeader) return unchanged('Info object is not plain text');
  const headerEnd = objHeader.index + objHeader[0].length;
  const dictStart = text.indexOf('<<', headerEnd);
  const endobj = text.indexOf('endobj', headerEnd);
  if (dictStart < 0 || endobj < 0 || dictStart > endobj) return unchanged('Info dictionary not found');
  const dictEnd = text.lastIndexOf('>>', endobj);
  if (dictEnd < dictStart) return unchanged('Info dictionary not closed');
  if (xrefPos < dictEnd) return unchanged('cross-reference table precedes the Info object');

  const body = text.slice(dictStart + 2, dictEnd);
  if (/\/Author(?![A-Za-z0-9])/.test(body)) return unchanged('Info already has /Author');

  const insertion = `\n/Author ${encodePdfTextString(name)}`;
  const delta = insertion.length; // ASCII only, so chars == bytes in latin1
  const shifted = text.slice(0, dictEnd) + insertion + text.slice(dictEnd);

  // Rebuild the xref table: entries that pointed past the insertion move by delta.
  const newXrefPos = xrefPos + delta; // the table sits after the Info object
  const tableStart = newXrefPos + xrefHead[0].length;
  let table = '';
  for (let i = 0; i < objCount; i++) {
    const entry = shifted.slice(tableStart + i * 20, tableStart + i * 20 + 20);
    if (!ENTRY_RE.test(entry)) return unchanged('unexpected cross-reference entry layout');
    const offset = Number(entry.slice(0, 10));
    if (entry[17] === 'n' && offset > dictEnd) {
      table += String(offset + delta).padStart(10, '0') + entry.slice(10);
    } else {
      table += entry;
    }
  }
  const rebuilt = shifted.slice(0, tableStart) + table + shifted.slice(tableStart + objCount * 20);

  const tail = rebuilt.lastIndexOf('startxref');
  const out = rebuilt.slice(0, tail) + `startxref\n${newXrefPos}\n%%EOF\n`;

  if (!xrefIsConsistent(out, newXrefPos, objCount)) {
    return unchanged('validation of the rewritten cross-reference table failed');
  }
  return { buffer: Buffer.from(out, 'latin1'), changed: true };
}
