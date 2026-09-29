// tests/eval-references.test.mjs — oferta.md's Block G reference file stays
// wired to every consumer that cannot read on demand.
//
// modes/oferta.md keeps Block G signals 1-5 inline and moves the conditional
// signals 6-15 to modes/reference/posting-legitimacy-signals.md behind a trigger
// index. An interactive agent reads the file when a trigger matches; a one-shot
// prompt (Gemini, OpenAI, Ollama, OpenRouter, the batch runner) has to carry it
// itself, or the index points at text the model never sees.
//
// Run:  node --test tests/eval-references.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFERTA_REFERENCE_FILES, evalModeNeedsReferences, loadEvalReferences, withEvalReferences,
} from '../lib/eval-references.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const SIGNAL_HEADING = /^\*\*(\d+)\.\s+(.+?)\*\*/gm;

test('only the default modes/oferta.md needs the reference files', () => {
  assert.equal(evalModeNeedsReferences(), true);
  assert.equal(evalModeNeedsReferences('modes', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes/', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes\\', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes/de', 'angebot.md'), false);
  assert.equal(evalModeNeedsReferences('modes/es', 'oferta.md'), false);
});

test('loadEvalReferences inlines every signal 6-15 for the default mode', () => {
  const text = loadEvalReferences(ROOT);
  assert.ok(text.includes('REFERENCE FILE (modes/reference/posting-legitimacy-signals.md)'));
  for (let n = 6; n <= 15; n++) {
    assert.ok(new RegExp(`^\\*\\*${n}\\. `, 'm').test(text), `signal ${n} missing from the inlined reference`);
  }
});

test('a localized evaluation mode gets nothing appended', () => {
  assert.equal(loadEvalReferences(ROOT, { modesDir: 'modes/de', evalFilename: 'angebot.md' }), '');
  assert.equal(withEvalReferences('BASE', ROOT, { modesDir: 'modes/de', evalFilename: 'angebot.md' }), 'BASE');
});

test('withEvalReferences appends after the mode content', () => {
  const out = withEvalReferences('BASE', ROOT);
  assert.ok(out.startsWith('BASE\n\n'));
  assert.ok(out.length > 'BASE'.length + 10000);
});

test('a missing reference file warns instead of throwing', () => {
  const warnings = [];
  const out = loadEvalReferences(join(ROOT, 'no-such-root'), { warn: (m) => warnings.push(m) });
  assert.equal(out, '');
  assert.equal(warnings.length, OFERTA_REFERENCE_FILES.length);
  assert.match(warnings[0], /Block G signals 6-15 will be missing/);
});

test('oferta.md indexes every moved signal by number and exact name', () => {
  const oferta = read('modes/oferta.md');
  const reference = read(OFERTA_REFERENCE_FILES[0]);
  const indexed = [...oferta.matchAll(SIGNAL_HEADING)].filter((m) => Number(m[1]) >= 6);
  const moved = [...reference.matchAll(SIGNAL_HEADING)];
  assert.deepEqual(
    indexed.map((m) => `${m[1]}. ${m[2]}`),
    moved.map((m) => `${m[1]}. ${m[2]}`),
    'the trigger index and the reference file must list the same signals under the same names',
  );
  assert.equal(moved.length, 10);
  assert.ok(oferta.includes('modes/reference/posting-legitimacy-signals.md'));
});

test('signals 1-5 and the tail of Block G stay inline in oferta.md', () => {
  const oferta = read('modes/oferta.md');
  for (const heading of [
    '**1. Posting Freshness**', '**2. Description Quality**', '**3. Company Hiring Signals**',
    '**4. Reposting Detection**', '**5. Role Market Context**',
    '### Output format:', '### Prior-contact FYI (non-scoring)', '### Edge case handling:',
    '**Ethical framing:**',
  ]) {
    assert.ok(oferta.includes(heading), `${heading} must stay in oferta.md`);
  }
});

test('the moved hard rules live in the reference file, not in oferta.md', () => {
  const oferta = read('modes/oferta.md');
  const reference = read(OFERTA_REFERENCE_FILES[0]);
  for (const rule of [
    'never asserts an agency is unlicensed',
    'Phrasing discipline (mandatory)',
    'never naive keyword matching',
  ]) {
    assert.ok(reference.includes(rule), `reference file lost: ${rule}`);
    assert.ok(!oferta.includes(rule), `oferta.md still carries the moved rule: ${rule}`);
  }
});

test('every script that inlines oferta.md into a prompt also inlines the reference', () => {
  for (const script of [
    'gemini-eval.mjs', 'batch-evaluate-gemini.mjs', 'ollama-eval.mjs', 'openai-eval.mjs',
    'openrouter-runner.mjs', 'lib/golden-budget-analysis.mjs',
  ]) {
    assert.match(read(script), /eval-references\.mjs/, `${script} reads oferta.md but never loads its reference files`);
  }
});
