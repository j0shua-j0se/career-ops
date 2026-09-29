/**
 * eval-references.mjs — the reference files `modes/oferta.md` points at, for
 * every script that inlines `oferta.md` into a one-shot prompt.
 *
 * `modes/oferta.md` keeps Block G signals 1-5 and 7 inline and moves the
 * conditional, jurisdiction-specific signals (6, 8-15) to one file each under
 * `modes/reference/legitimacy/`, behind a trigger index. An interactive agent
 * reads only the files whose trigger matches; a
 * one-shot prompt (Gemini, OpenAI, Ollama, OpenRouter, the batch runner) cannot,
 * so it must carry the file itself — otherwise the index would point at text the
 * model never sees and those signals would silently stop firing.
 *
 * Only the default `modes/oferta.md` has this shape. A localized evaluation mode
 * (`modes/de/angebot.md`, ...) carries its own content and needs nothing appended.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Repo-relative reference files `modes/oferta.md` defers to, in signal order. */
export const OFERTA_REFERENCE_FILES = [
  'modes/reference/legitimacy/06-employment-classification.md',
  'modes/reference/legitimacy/08-benefits-terminology-mismatch.md',
  'modes/reference/legitimacy/09-location-tag-mismatch.md',
  'modes/reference/legitimacy/10-agency-licensing.md',
  'modes/reference/legitimacy/11-immigration-status.md',
  'modes/reference/legitimacy/12-jurisdiction-prohibited-content.md',
  'modes/reference/legitimacy/13-pay-transparency-range-width.md',
  'modes/reference/legitimacy/14-minimum-wage-lawyer-question.md',
  'modes/reference/legitimacy/15-ai-screening-disclosure.md',
];

/**
 * Whether the resolved evaluation mode is the default `modes/oferta.md`.
 * @param {string} [modesDir]      e.g. 'modes' or 'modes/de'
 * @param {string} [evalFilename]  e.g. 'oferta.md' or 'angebot.md'
 */
export function evalModeNeedsReferences(modesDir = 'modes', evalFilename = 'oferta.md') {
  const dir = String(modesDir).replace(/\\/g, '/').replace(/\/+$/, '');
  return dir === 'modes' && evalFilename === 'oferta.md';
}

/**
 * The reference text to append after `oferta.md`, or '' when the evaluation
 * mode is not the default one. A missing file warns (it never throws — same
 * degrade-with-a-warning stance as the scripts' own readFile helpers).
 *
 * @param {string} codeRoot  checkout root that ships `modes/`
 * @param {{modesDir?: string, evalFilename?: string, warn?: (msg: string) => void}} [opts]
 * @returns {string}
 */
export function loadEvalReferences(codeRoot, opts = {}) {
  const { modesDir = 'modes', evalFilename = 'oferta.md', warn = console.warn } = opts;
  if (!evalModeNeedsReferences(modesDir, evalFilename)) return '';
  const parts = [];
  for (const rel of OFERTA_REFERENCE_FILES) {
    const full = join(codeRoot, rel);
    if (!existsSync(full)) {
      warn(`⚠️   ${rel} not found at: ${full} — that Block G signal will be missing from the prompt`);
      continue;
    }
    parts.push(
      `REFERENCE FILE (${rel}) — inlined because this prompt cannot read files on demand; ` +
      'apply it exactly as oferta.md\'s trigger index says:\n\n' +
      readFileSync(full, 'utf-8').trim(),
    );
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/**
 * `evalContent` with the reference files appended (unchanged for localized modes).
 * @param {string} evalContent
 * @param {string} codeRoot
 * @param {{modesDir?: string, evalFilename?: string, warn?: (msg: string) => void}} [opts]
 */
export function withEvalReferences(evalContent, codeRoot, opts = {}) {
  return evalContent + loadEvalReferences(codeRoot, opts);
}
