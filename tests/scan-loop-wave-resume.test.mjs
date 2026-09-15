// tests/scan-loop-wave-resume.test.mjs — regression test for buildWaveArgs'
// `--resume` decision in scan-loop.mjs.
//
// buildWaveArgs used to derive its own partial opts object (just `since` and
// `ats`) and hand it to scan-ats-full.mjs's checkpointCompatible — which also
// checks `limit`, `includeUndated` and `shuffle`. Those were always
// `undefined` in the hand-rolled object, so they could never equal the
// scanner's real defaults (`limit: null`, `includeUndated: false`), and
// checkpointCompatible returned false for EVERY checkpoint, including one
// written by the exact same default rung. The fix makes buildWaveArgs call
// scan-ats-full.mjs's own exported `parseArgs` on the rung's argv, so the
// comparison uses identical defaults on both sides.
//
// This runs the check in a CHILD PROCESS (not via in-process import) for two
// reasons: (1) buildWaveArgs's checkpoint lookup goes through
// scan-ats-full.mjs's module-level CHECKPOINT_PATH, which is fixed at that
// module's first import from CAREER_OPS_ROOT — an in-process import could
// pick up whatever the FIRST importer in this shared test run resolved it to.
// A fresh child process guarantees CAREER_OPS_ROOT is read exactly once, for
// this test, before anything imports scan-ats-full.mjs. (2) it keeps this
// suite far away from data/cache/ats-full-checkpoint.json — the real,
// currently-interrupted sweep checkpoint — which must never be read through
// an unpredictable module-cache path or (worse) written to.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

console.log('\nscan-loop.mjs — buildWaveArgs --resume decision');

function check(desc, condition, details = '') {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` — ${details}` : ''}`);
}

const box = mkdtempSync(join(tmpdir(), 'cops-wave-resume-'));
const cacheDir = join(box, 'data', 'cache');
mkdirSync(cacheDir, { recursive: true });
const checkpointPath = join(cacheDir, 'ats-full-checkpoint.json');

// Small harness run in its own process: imports scan-loop.mjs fresh (so its
// import of scan-ats-full.mjs resolves CAREER_OPS_ROOT from THIS process'
// env only), looks up the real 'ats-recent' rung from loop-core.mjs (so this
// test tracks that rung's actual args instead of a hand-copied duplicate),
// and prints buildWaveArgs' result as JSON.
const harnessPath = join(box, 'harness.mjs');
writeFileSync(harnessPath, [
  "import { pathToFileURL } from 'node:url';",
  "import { join } from 'node:path';",
  'const root = process.env.CO_TEST_REPO_ROOT;',
  "const { buildWaveArgs } = await import(pathToFileURL(join(root, 'scan-loop.mjs')).href);",
  "const { WAVE_STRATEGIES } = await import(pathToFileURL(join(root, 'loop-core.mjs')).href);",
  "const strategy = WAVE_STRATEGIES.find((s) => s.id === 'ats-recent');",
  'const args = buildWaveArgs(strategy, {});',
  'process.stdout.write(JSON.stringify(args));',
].join('\n'), 'utf-8');

function runHarness() {
  const res = spawnSync(NODE, [harnessPath], {
    env: { ...process.env, CAREER_OPS_ROOT: box, CO_TEST_REPO_ROOT: ROOT },
    encoding: 'utf-8',
  });
  let args = null;
  try { args = JSON.parse(res.stdout); } catch { /* leave null, checked below */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, args };
}

// The ats-recent rung is `scan-ats-full.mjs --since 7` — no --ats/--limit/
// --include-undated/--shuffle override — so a checkpoint written by that
// exact default rung (all 5 SOURCES, limit null, includeUndated false, a
// valid `current`) must resume.
{
  const cp = {
    version: 1,
    cutoffMs: Date.now() - 7 * 86_400_000,
    ats: ['greenhouse', 'lever', 'ashby', 'workday', 'icims'],
    limit: null,
    includeUndated: false,
    completedSources: ['greenhouse', 'lever', 'ashby', 'workday'],
    current: { name: 'icims', resumeAt: 3500, datasetLen: 10108 },
    offers: new Array(58).fill({ dummy: true }),
  };
  writeFileSync(checkpointPath, JSON.stringify(cp), 'utf-8');

  const { args, status, stderr } = runHarness();
  check('default-settings checkpoint for the ats-recent rung resumes',
    status === 0 && Array.isArray(args) && args.includes('--resume'),
    `status=${status} args=${JSON.stringify(args)} stderr=${stderr?.trim()}`);
}

// Negative: a checkpoint written with --include-undated (or any other
// mismatched setting) must NOT be resumed by a rung that doesn't ask for it.
{
  const cp = {
    version: 1,
    cutoffMs: Date.now() - 7 * 86_400_000,
    ats: ['greenhouse', 'lever', 'ashby', 'workday', 'icims'],
    limit: null,
    includeUndated: true,   // mismatch: ats-recent's parsed opts have includeUndated: false
    completedSources: ['greenhouse', 'lever', 'ashby', 'workday'],
    current: { name: 'icims', resumeAt: 3500, datasetLen: 10108 },
    offers: [],
  };
  writeFileSync(checkpointPath, JSON.stringify(cp), 'utf-8');

  const { args, status, stderr } = runHarness();
  check('includeUndated mismatch does not resume',
    status === 0 && Array.isArray(args) && !args.includes('--resume'),
    `status=${status} args=${JSON.stringify(args)} stderr=${stderr?.trim()}`);
}

// Negative: a different (narrower) ats list must not resume either — the
// checkpoint's per-source progress is meaningless against a different set.
{
  const cp = {
    version: 1,
    cutoffMs: Date.now() - 7 * 86_400_000,
    ats: ['greenhouse', 'lever'],
    limit: null,
    includeUndated: false,
    completedSources: ['greenhouse'],
    current: { name: 'lever', resumeAt: 10, datasetLen: 4368 },
    offers: [],
  };
  writeFileSync(checkpointPath, JSON.stringify(cp), 'utf-8');

  const { args, status, stderr } = runHarness();
  check('ats-list mismatch does not resume',
    status === 0 && Array.isArray(args) && !args.includes('--resume'),
    `status=${status} args=${JSON.stringify(args)} stderr=${stderr?.trim()}`);
}

rmSync(box, { recursive: true, force: true });
