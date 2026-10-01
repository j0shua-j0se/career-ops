// tests/merge-tracker-result.test.mjs — merge-tracker.mjs reports what it did to
// each TSV in a machine-readable file (CAREER_OPS_MERGE_RESULT) and leaves a TSV
// it REFUSED in the additions dir instead of archiving it into merged/.
//
// Why: `scan-loop.mjs finish` told the user "trackerRows: 1, merged: true" for a
// TSV merge-tracker had skipped (aggregator URL for a company whose own board is
// tracked) and then filed it under merged/ — a tracker row that never existed,
// and no copy left where a re-merge could find it. A caller can only be honest
// about a merge if the merge says what happened, per file.
//
// Drives the REAL merge-tracker.mjs CLI against a temp tracker (same technique as
// tests/merge-tracker-aggregator-guard.test.mjs). No network.
import { pass, fail } from './helpers.mjs';
import assert from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
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
  const base = mkdtempSync(join(tmpdir(), 'merge-result-'));
  const dataDir = join(base, 'data');
  const addDir = join(base, 'additions');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(addDir, { recursive: true });
  return {
    base, addDir, tracker: join(dataDir, 'applications.md'), portals: join(base, 'portals.yml'),
    result: join(base, 'merge-result.json'),
  };
}
const writeTracker = (env, rows = []) => writeFileSync(env.tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));
const addTsv = (env, name, cols) => writeFileSync(join(env.addDir, name), cols.join('\t'));
function runMerge(env, { withResult = true } = {}) {
  const r = spawnSync('node', [MERGE], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: env.tracker, CAREER_OPS_ADDITIONS: env.addDir, CAREER_OPS_PORTALS: env.portals,
      ...(withResult ? { CAREER_OPS_MERGE_RESULT: env.result } : { CAREER_OPS_MERGE_RESULT: '' }),
    },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const readResult = (env) => JSON.parse(readFileSync(env.result, 'utf-8'));
const pending = (env) => readdirSync(env.addDir).filter((f) => f.endsWith('.tsv'));
const archived = (env) => (existsSync(join(env.addDir, 'merged')) ? readdirSync(join(env.addDir, 'merged')) : []);
const cleanup = (env) => rmSync(env.base, { recursive: true, force: true });
const SIEMENS_URL = 'https://to.indeed.com/aamflg7vhdvk';
const tsv = (num, company, role, score, url) => [
  String(num), '2026-10-01', company, role, 'Evaluated', score, '❌', `[${num}](reports/${num}-x-2026-10-01.md)`, 'n', ...(url ? [url] : []),
];

console.log('\nmerge-tracker — machine-readable merge result');

ok('an aggregator-URL skip is reported with its reason and the TSV is LEFT in the additions dir', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writeFileSync(env.portals, 'tracked_companies:\n  - name: "Siemens"\n    provider: greenhouse\n    careers_url: https://boards.greenhouse.io/siemens\n');
    addTsv(env, '202-siemens.tsv', tsv(202, 'Siemens', 'Working Student', '4.1/5', SIEMENS_URL));
    const { status } = runMerge(env);
    assert.equal(status, 0, 'a skip is not a failed run — exit code unchanged');
    const res = readResult(env);
    assert.equal(res.added, 0);
    assert.equal(res.updated, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.results[0].file, '202-siemens.tsv');
    assert.equal(res.results[0].outcome, 'skipped');
    assert.equal(res.results[0].kept, true);
    assert.match(res.results[0].reason, /to\.indeed\.com aggregator listing for "Siemens"/);
    assert.match(res.results[0].reason, /resolve-aggregator-leads\.mjs --write/);
    assert.deepEqual(pending(env), ['202-siemens.tsv'], 'the skipped TSV must stay where a re-merge will find it');
    assert.deepEqual(archived(env), [], 'a skipped TSV must never be filed under merged/');
    assert.ok(!/\| 202 \|/.test(readFileSync(env.tracker, 'utf-8')), 'no tracker row was written');
  } finally { cleanup(env); }
});

ok('after the URL is resolved, the same TSV merges on a re-run (nothing was lost)', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writeFileSync(env.portals, 'tracked_companies:\n  - name: "Siemens"\n    provider: greenhouse\n    careers_url: https://boards.greenhouse.io/siemens\n');
    addTsv(env, '202-siemens.tsv', tsv(202, 'Siemens', 'Working Student', '4.1/5', SIEMENS_URL));
    runMerge(env);
    addTsv(env, '202-siemens.tsv', tsv(202, 'Siemens', 'Working Student', '4.1/5', 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/524303'));
    const { status } = runMerge(env);
    assert.equal(status, 0);
    const res = readResult(env);
    assert.equal(res.added, 1);
    assert.equal(res.results[0].outcome, 'added');
    assert.equal(res.results[0].num, 202);
    assert.deepEqual(pending(env), []);
    assert.deepEqual(archived(env), ['202-siemens.tsv']);
    assert.match(readFileSync(env.tracker, 'utf-8'), /\| 202 \|/);
  } finally { cleanup(env); }
});

ok('a TSV the parser rejects is reported as skipped with the parser reason and left in place', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writeFileSync(env.portals, 'tracked_companies: []\n');
    writeFileSync(join(env.addDir, '5-broken.tsv'), 'not\tenough\tfields');
    addTsv(env, '6-fine.tsv', tsv(6, 'Fine Co', 'Analyst', '3.9/5'));
    const { status } = runMerge(env);
    assert.equal(status, 0);
    const res = readResult(env);
    const broken = res.results.find((r) => r.file === '5-broken.tsv');
    assert.equal(broken.outcome, 'skipped');
    assert.equal(broken.kept, true);
    assert.match(broken.reason, /malformed|fields/i);
    assert.ok(!/^⚠️/u.test(broken.reason), 'the reason carries no warning prefix');
    assert.equal(res.results.find((r) => r.file === '6-fine.tsv').outcome, 'added');
    assert.deepEqual(pending(env), ['5-broken.tsv']);
    assert.deepEqual(archived(env), ['6-fine.tsv']);
  } finally { cleanup(env); }
});

ok('adds and updates are counted per file, with the tracker number each landed on', () => {
  const env = makeEnv();
  try {
    writeTracker(env, [
      '| 10 | 2026-09-01 | Acme GmbH | Werkstudent Data Science | 3.5/5 | Evaluated | ❌ | [10](../reports/10-acme-2026-09-01.md) | old | https://jobs.example.com/acme/1 |',
    ]);
    writeFileSync(env.portals, 'tracked_companies: []\n');
    // Same URL as row 10, higher score -> update; a different company -> add.
    addTsv(env, '11-acme.tsv', tsv(11, 'Acme GmbH', 'Werkstudent Data Science', '4.2/5', 'https://jobs.example.com/acme/1'));
    addTsv(env, '12-beta.tsv', tsv(12, 'Beta AG', 'ML Engineer', '3.9/5', 'https://jobs.example.com/beta/2'));
    const { status } = runMerge(env);
    assert.equal(status, 0);
    const res = readResult(env);
    assert.equal(res.added, 1);
    assert.equal(res.updated, 1);
    assert.equal(res.skipped, 0);
    assert.deepEqual(res.results.map((r) => [r.file, r.outcome, r.num]), [['11-acme.tsv', 'updated', 10], ['12-beta.tsv', 'added', 12]]);
  } finally { cleanup(env); }
});

ok('with nothing pending the result file still says so (zero adds), rather than being absent', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writeFileSync(env.portals, 'tracked_companies: []\n');
    const { status } = runMerge(env);
    assert.equal(status, 0);
    const res = readResult(env);
    assert.deepEqual([res.added, res.updated, res.skipped, res.failed, res.results.length], [0, 0, 0, 0, 0]);
  } finally { cleanup(env); }
});

ok('CONTROL: without CAREER_OPS_MERGE_RESULT no file is written and the human output is unchanged', () => {
  const env = makeEnv();
  try {
    writeTracker(env);
    writeFileSync(env.portals, 'tracked_companies: []\n');
    addTsv(env, '6-fine.tsv', tsv(6, 'Fine Co', 'Analyst', '3.9/5'));
    const { status, out } = runMerge(env, { withResult: false });
    assert.equal(status, 0);
    assert.ok(!existsSync(env.result));
    assert.match(out, /Summary: \+1 added/);
  } finally { cleanup(env); }
});
