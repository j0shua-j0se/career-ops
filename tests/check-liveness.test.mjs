// tests/check-liveness.test.mjs — CLI contract for check-liveness.mjs (issue #2576).
//
// The script under test lives at the repository root, so its path is resolved
// from ROOT, not from this file's directory: the first version resolved
// ./check-liveness.mjs relative to tests/ and every CI job died with
// ERR_MODULE_NOT_FOUND before a single assertion ran.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\ncheck-liveness — --help/-h contract');

const scriptPath = join(ROOT, 'check-liveness.mjs');
const run = (args) => spawnSync(NODE, [scriptPath, ...args], {
  encoding: 'utf-8',
  timeout: 10000,
});

const help = run(['--help']);
if (help.status === 0) {
  pass('--help exits 0');
} else {
  fail(`--help exits 0 (got status ${help.status})`);
}
if ((help.stdout || '').includes('Usage:')) {
  pass('--help prints usage');
} else {
  fail('--help prints usage');
}
for (const flag of ['--no-fallback', '--throttle', '--file', '--help']) {
  if ((help.stdout || '').includes(flag)) pass(`--help documents ${flag}`);
  else fail(`--help documents ${flag}`);
}
if ((help.stdout || '').includes('node check-liveness.mjs -h')) pass('--help documents -h');
else fail('--help documents -h');

const h = run(['-h']);
if (h.status === 0 && (h.stdout || '').includes('Usage:')) pass('-h prints usage');
else fail('-h prints usage');
// The alias must stay byte-identical to --help or the two contracts can drift.
if (h.stdout === help.stdout) pass('-h output is byte-identical to --help');
else fail('-h output is byte-identical to --help');

const helpWithMissingFile = run(['--help', '--file', join('definitely', 'missing')]);
if (helpWithMissingFile.status === 0 && (helpWithMissingFile.stdout || '').includes('Usage:')) {
  pass('--help exits before file read');
} else {
  fail('--help exits before file read');
}

const noArgs = run([]);
if (noArgs.status === 1) pass('no args exits 1');
else fail(`no args exits 1 (got status ${noArgs.status})`);
if ((noArgs.stderr || '').includes('Usage:')) pass('no args prints usage to stderr');
else fail('no args prints usage to stderr');

// --- circuit breaker (lib/host-circuit.mjs) ---------------------------------
//
// A URL whose host is circuit-broken must be reported `uncertain` WITHOUT
// check-liveness making any request for it — no ATS API call, no robots.txt
// read, no browser. Proven black-box here (rather than only via the unit
// tests on fetchOne/host-circuit) because check-liveness.mjs's main loop is
// not itself exported — CAREER_OPS_HOST_BLOCKS points the real module at a
// throwaway seeded file so the CLI's own gate is what is under test, and the
// fast, network-free completion is itself part of the proof: a real request
// to a host this machine cannot reach would not return this quickly or this
// cleanly under the test's timeout.
console.log('\ncheck-liveness — circuit breaker (lib/host-circuit.mjs)');

const breakerDir = mkdtempSync(join(tmpdir(), 'co-checkliveness-breaker-'));
const breakerFile = join(breakerDir, 'host-blocks.json');
writeFileSync(breakerFile, JSON.stringify({
  'stepstone.de': {
    status: 403,
    reason: 'HTTP 403',
    trippedAt: '2026-09-23T00:00:00.000Z',
    until: '2026-10-07T00:00:00.000Z',
    days: 14,
  },
}), 'utf-8');

try {
  const blocked = spawnSync(NODE, [scriptPath, 'https://www.stepstone.de/stellenangebote--x--1.html'], {
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, CAREER_OPS_HOST_BLOCKS: breakerFile },
  });
  if ((blocked.stdout || '').includes('uncertain')) pass('a circuit-broken StepStone URL is reported uncertain');
  else fail(`a circuit-broken StepStone URL should report uncertain — got: ${blocked.stdout}`);
  if (/host blocked until 2026-10-07/.test(blocked.stdout || '')) pass('the report names the date the block lifts');
  else fail(`expected "host blocked until 2026-10-07" in output — got: ${blocked.stdout}`);
  if (blocked.status === 1) pass('a circuit-broken URL still exits non-zero (uncertain, not active)');
  else fail(`expected exit 1 for an uncertain result (got ${blocked.status})`);
} finally {
  rmSync(breakerDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
