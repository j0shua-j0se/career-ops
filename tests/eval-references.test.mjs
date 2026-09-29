// tests/eval-references.test.mjs — oferta.md's per-signal Block G files stay
// wired to every consumer that cannot read on demand.
//
// modes/oferta.md keeps Block G signals 1-5 and 7 inline (7 fires on nearly every
// AI role) and moves the conditional, jurisdiction-specific signals (6, 8-15) to
// one file each under modes/reference/legitimacy/, behind a trigger index. An
// interactive agent opens only the files whose trigger matches; a one-shot prompt
// (Gemini, OpenAI, Ollama, OpenRouter, the batch runner) has to carry them itself,
// or the index points at text the model never sees.
//
// Run:  node --test tests/eval-references.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFERTA_REFERENCE_FILES, evalModeNeedsReferences, loadEvalReferences, withEvalReferences,
} from '../lib/eval-references.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const SIGNAL_HEADING = /^\*\*(\d+)\.\s+(.+?)\*\*/gm;
const MOVED = [6, 8, 9, 10, 11, 12, 13, 14, 15];

test('only the default modes/oferta.md needs the reference files', () => {
  assert.equal(evalModeNeedsReferences(), true);
  assert.equal(evalModeNeedsReferences('modes', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes/', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes\\', 'oferta.md'), true);
  assert.equal(evalModeNeedsReferences('modes/de', 'angebot.md'), false);
  assert.equal(evalModeNeedsReferences('modes/es', 'oferta.md'), false);
});

test('the reference list is exactly the files on disk, one per moved signal, in order', () => {
  const onDisk = readdirSync(join(ROOT, 'modes', 'reference', 'legitimacy')).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(OFERTA_REFERENCE_FILES.map((p) => p.split('/').pop()), onDisk);
  assert.deepEqual(
    OFERTA_REFERENCE_FILES.map((p) => Number(/\/(\d+)-/.exec(p)[1])),
    MOVED,
  );
  for (const rel of OFERTA_REFERENCE_FILES) assert.ok(existsSync(join(ROOT, rel)), rel);
  assert.ok(!existsSync(join(ROOT, 'modes/reference/posting-legitimacy-signals.md')), 'the old combined file is gone');
});

test('each per-signal file holds exactly its own signal under its own number', () => {
  for (const rel of OFERTA_REFERENCE_FILES) {
    const n = Number(/\/(\d+)-/.exec(rel)[1]);
    const headings = [...read(rel).matchAll(SIGNAL_HEADING)];
    assert.equal(headings.length, 1, `${rel} must contain exactly one signal`);
    assert.equal(Number(headings[0][1]), n, `${rel} carries the wrong signal number`);
  }
});

test('loadEvalReferences inlines every moved signal, in order, for the default mode', () => {
  const text = loadEvalReferences(ROOT);
  let last = -1;
  for (const n of MOVED) {
    const at = text.search(new RegExp(`^\\*\\*${n}\\. `, 'm'));
    assert.ok(at > last, `signal ${n} missing or out of order in the inlined references`);
    last = at;
  }
  assert.ok(text.includes('REFERENCE FILE (modes/reference/legitimacy/06-employment-classification.md)'));
});

test('a localized evaluation mode gets nothing appended', () => {
  assert.equal(loadEvalReferences(ROOT, { modesDir: 'modes/de', evalFilename: 'angebot.md' }), '');
  assert.equal(withEvalReferences('BASE', ROOT, { modesDir: 'modes/de', evalFilename: 'angebot.md' }), 'BASE');
});

test('withEvalReferences appends after the mode content', () => {
  const out = withEvalReferences('BASE', ROOT);
  assert.ok(out.startsWith('BASE\n\n'));
  assert.ok(out.length > 'BASE'.length + 25000);
});

test('a missing reference file warns instead of throwing', () => {
  const warnings = [];
  const out = loadEvalReferences(join(ROOT, 'no-such-root'), { warn: (m) => warnings.push(m) });
  assert.equal(out, '');
  assert.equal(warnings.length, OFERTA_REFERENCE_FILES.length);
  assert.match(warnings[0], /Block G signal will be missing/);
});

test('oferta.md lists every signal 6-15 once, and only the moved ones point at a file', () => {
  const oferta = read('modes/oferta.md');
  const headings = [...oferta.matchAll(SIGNAL_HEADING)].filter((m) => Number(m[1]) >= 6);
  assert.deepEqual(headings.map((m) => Number(m[1])), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const names = new Map();
  for (const rel of OFERTA_REFERENCE_FILES) {
    const m = [...read(rel).matchAll(SIGNAL_HEADING)][0];
    names.set(Number(m[1]), m[2]);
  }
  for (const m of headings) {
    const n = Number(m[1]);
    if (n === 7) continue;
    assert.equal(m[2], names.get(n), `signal ${n}: index name differs from its file`);
    const line = oferta.split('\n').find((l) => l.startsWith(`**${n}. `));
    const rel = OFERTA_REFERENCE_FILES.find((p) => p.includes(`/${String(n).padStart(2, '0')}-`));
    assert.ok(line.includes(rel), `signal ${n}'s index line must point at ${rel}`);
  }
});

test('signal 7 stays fully inline in oferta.md (it applies to nearly every AI role)', () => {
  const oferta = read('modes/oferta.md');
  for (const text of [
    '**7. AI-Buzzword vs. Infrastructure Mismatch**',
    'Only flag when 2+ of the three signal classes are present.',
    'Buzzword/infrastructure mismatch signal:',
    'orthogonal to ghost-job detection',
  ]) {
    assert.ok(oferta.includes(text), `oferta.md lost signal 7 text: ${text}`);
  }
});

test('signal 15 is gated by an inexpensive check, never by hard-coded dates', () => {
  const oferta = read('modes/oferta.md');
  const line = oferta.split('\n').find((l) => l.startsWith('**15. '));
  assert.match(line, /AI \/ automated screening/);
  assert.match(line, /already in effect today/);
  assert.match(line, /grep -nE/);
  assert.match(line, /no match/);
  assert.doesNotMatch(line, /20\d\d-\d\d-\d\d/, 'effective dates live in the template, never in oferta.md');
});

test('the jurisdiction derivation signals 10, 11, 12 and 15 lean on is inline in the index', () => {
  const oferta = read('modes/oferta.md');
  assert.match(oferta, /\*\*Jurisdiction \(signals 10, 11, 12, 15\):\*\*[^\n]*config\/profile\.yml/);
  for (const n of [10, 11, 12, 15]) {
    const rel = OFERTA_REFERENCE_FILES.find((p) => p.includes(`/${n}-`));
    assert.match(read(rel), /Jurisdiction \(the "same derivation as signal 6"/, `${rel} must carry the derivation itself`);
  }
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

test('the moved hard rules live in the per-signal files, not in oferta.md', () => {
  const oferta = read('modes/oferta.md');
  const reference = OFERTA_REFERENCE_FILES.map(read).join('\n');
  for (const rule of [
    'never asserts an agency is unlicensed',
    'Phrasing discipline (mandatory)',
    'never naive keyword matching',
  ]) {
    assert.ok(reference.includes(rule), `reference files lost: ${rule}`);
    assert.ok(!oferta.includes(rule), `oferta.md still carries the moved rule: ${rule}`);
  }
});

test('every script that inlines oferta.md into a prompt also inlines the references', () => {
  for (const script of [
    'gemini-eval.mjs', 'batch-evaluate-gemini.mjs', 'ollama-eval.mjs', 'openai-eval.mjs',
    'openrouter-runner.mjs', 'lib/golden-budget-analysis.mjs',
  ]) {
    assert.match(read(script), /eval-references\.mjs/, `${script} reads oferta.md but never loads its reference files`);
  }
});
