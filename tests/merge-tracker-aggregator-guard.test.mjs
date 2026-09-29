// tests/merge-tracker-aggregator-guard.test.mjs — merge-tracker.mjs must
// refuse to write a StepStone/Indeed aggregator URL into the tracker's URL
// column when the employer's own board is already known (portals.yml
// tracked_companies) — the merge-time choke point for "resolve the aggregator
// lead first" (see resolve-aggregator-leads.mjs).
//
// Drives the REAL merge-tracker.mjs CLI end-to-end against a temp tracker +
// temp portals.yml via the CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS /
// CAREER_OPS_PORTALS env hooks — same technique as
// tests/merge-tracker-url-dedup.test.mjs.
import { pass, fail } from './helpers.mjs';
import assert from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE = join(HERE, '..', 'merge-tracker.mjs');
const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|';

function makeEnv() {
  const base = mkdtempSync(join(tmpdir(), 'merge-agg-guard-'));
  const dataDir = join(base, 'data');
  const addDir = join(base, 'additions');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(addDir, { recursive: true });
  const tracker = join(dataDir, 'applications.md');
  const portals = join(base, 'portals.yml');
  return {
    base, dataDir, addDir, tracker, portals,
  };
}
function writeTracker(env, rows = []) {
  writeFileSync(env.tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));
}
function addTsv(env, name, cols) {
  writeFileSync(join(env.addDir, name), cols.join('\t'));
}
function writePortals(env, trackedCompanies) {
  const body = trackedCompanies.map((c) => `  - name: "${c.name}"\n    provider: ${c.provider}\n    careers_url: ${c.careers_url}\n`).join('');
  writeFileSync(env.portals, `tracked_companies:\n${body}`);
}
/** Runs merge-tracker.mjs and returns combined stdout+stderr (the skip warning is console.warn, i.e. stderr). */
function runMerge(env, args = []) {
  const r = spawnSync('node', [MERGE, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env, CAREER_OPS_TRACKER: env.tracker, CAREER_OPS_ADDITIONS: env.addDir, CAREER_OPS_PORTALS: env.portals,
    },
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}
function trackerRows(env) {
  return readFileSync(env.tracker, 'utf-8').split('\n').filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|\s*$/.test(l) && !/^\|\s*#\s*\|/.test(l));
}
const cleanup = (env) => rmSync(env.base, { recursive: true, force: true });

console.log('\nmerge-tracker — aggregator-URL guard');

ok('a StepStone URL for a company whose board is already tracked is REFUSED, not merged', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writePortals(env, [{ name: 'Acme GmbH', provider: 'ashby', careers_url: 'https://jobs.ashbyhq.com/acme' }]);
    addTsv(env, '1-acme.tsv', [
      '1', '2026-09-24', 'Acme GmbH', 'Werkstudent Data Science', 'Evaluated', '3.8/5', '❌', '[1](reports/1-acme-2026-09-24.md)', 'n',
      'https://www.stepstone.de/stellenangebote--Werkstudent-Data-Science-Acme--123456.html',
    ]);
    const out = runMerge(env);
    assert.match(out, /Skipping 1-acme\.tsv/, `expected a skip warning — got: ${out}`);
    assert.match(out, /stepstone\.de/i);
    assert.match(out, /resolve-aggregator-leads\.mjs --write/);
    const rows = trackerRows(env);
    assert.equal(rows.length, 0, 'the aggregator-URL row must not be merged into the tracker');
  } finally { cleanup(env); }
});

ok('CONTROL: the same StepStone URL merges fine when the company has no tracked board', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writePortals(env, []); // no tracked_companies entry for "Unknown Co"
    addTsv(env, '1-unknown.tsv', [
      '1', '2026-09-24', 'Unknown Co', 'Werkstudent Data Science', 'Evaluated', '3.8/5', '❌', '[1](reports/1-unknown-2026-09-24.md)', 'n',
      'https://www.stepstone.de/stellenangebote--Werkstudent-Data-Science-Unknown--123456.html',
    ]);
    runMerge(env);
    const rows = trackerRows(env);
    assert.equal(rows.length, 1, 'with no known employer board, the aggregator URL is the best we have — must still merge');
  } finally { cleanup(env); }
});

ok('CONTROL: an employer-board URL for a tracked company merges fine (the guard is aggregator-specific)', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writePortals(env, [{ name: 'Acme GmbH', provider: 'ashby', careers_url: 'https://jobs.ashbyhq.com/acme' }]);
    addTsv(env, '1-acme.tsv', [
      '1', '2026-09-24', 'Acme GmbH', 'Werkstudent Data Science', 'Evaluated', '3.8/5', '❌', '[1](reports/1-acme-2026-09-24.md)', 'n',
      'https://jobs.ashbyhq.com/acme/data-science',
    ]);
    runMerge(env);
    const rows = trackerRows(env);
    assert.equal(rows.length, 1, 'an ordinary employer-board URL must never be caught by the aggregator guard');
  } finally { cleanup(env); }
});

ok('CONTROL: an Indeed URL for a tracked company is refused the same way as StepStone', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writePortals(env, [{ name: 'Acme GmbH', provider: 'ashby', careers_url: 'https://jobs.ashbyhq.com/acme' }]);
    addTsv(env, '1-acme.tsv', [
      '1', '2026-09-24', 'Acme GmbH', 'Werkstudent Data Science', 'Evaluated', '3.8/5', '❌', '[1](reports/1-acme-2026-09-24.md)', 'n',
      'https://de.indeed.com/viewjob?jk=abc123',
    ]);
    const out = runMerge(env);
    assert.match(out, /Skipping 1-acme\.tsv/);
    assert.match(out, /indeed\.com/i);
    assert.equal(trackerRows(env).length, 0);
  } finally { cleanup(env); }
});

ok('a missing/unreadable portals.yml degrades to "no board known" rather than blocking the merge', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    // Deliberately do not write env.portals at all.
    addTsv(env, '1-acme.tsv', [
      '1', '2026-09-24', 'Acme GmbH', 'Werkstudent Data Science', 'Evaluated', '3.8/5', '❌', '[1](reports/1-acme-2026-09-24.md)', 'n',
      'https://www.stepstone.de/stellenangebote--Werkstudent-Data-Science-Acme--123456.html',
    ]);
    runMerge(env);
    assert.equal(trackerRows(env).length, 1, 'no portals.yml on disk must not turn into a blocked merge');
  } finally { cleanup(env); }
});
