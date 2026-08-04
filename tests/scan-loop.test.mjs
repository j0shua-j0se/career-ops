// tests/scan-loop.test.mjs — behavioural tests for scan-loop.mjs, the disk and
// state layer of the scan loop.
//
// loop-core.mjs (the pure control law) already has a large unit suite; until now
// scan-loop.mjs itself was covered only by existence checks and source greps in
// test-all.mjs. Those cannot see the things that actually break a loop run:
// state that does not survive a process boundary, a second `start` silently
// discarding a run in progress, `record` accepting a file whose keys match
// nothing, or `finish` promoting candidates without writing the review gate.
//
// Everything here is offline. `wave` is exercised only through its refusal path
// — running a rung would spawn scan.mjs/scan-ats-full.mjs against live ATS
// endpoints, which is not something a test suite should do to anybody.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const SCRIPT = join(ROOT, 'scan-loop.mjs');

console.log('\nscan-loop.mjs — loop driver state & disk layer');

function check(desc, condition, details = '') {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` — ${details}` : ''}`);
}

const box = mkdtempSync(join(tmpdir(), 'cops-scan-loop-'));
const paths = {
  state: join(box, 'data', 'loop-state.json'),
  shortlist: join(box, 'data', 'loop-shortlist.md'),
  runLog: join(box, 'data', 'loop-run-log.md'),
  pipeline: join(box, 'data', 'pipeline.md'),
  profile: join(box, 'config', 'profile.yml'),
  tracker: join(box, 'data', 'applications.md'),
  additions: join(box, 'batch', 'tracker-additions'),
  batchState: join(box, 'batch', 'batch-state.tsv'),
  reports: join(box, 'reports'),
};

mkdirSync(join(box, 'data'), { recursive: true });
mkdirSync(join(box, 'config'), { recursive: true });
mkdirSync(paths.additions, { recursive: true });
mkdirSync(paths.reports, { recursive: true });

// target: 2 keeps the run short enough to drive to `finish` in one pass without
// making the qualifier threshold itself trivial.
writeFileSync(paths.profile, 'loop:\n  target: 2\n  min_score: 3.8\n  score_batch: 12\n', 'utf-8');
writeFileSync(paths.tracker, [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n'), 'utf-8');

/**
 * Redirect every artifact the driver (and the two scripts it spawns) writes.
 * The child processes inherit this env, which is what keeps `finish` from
 * reserving report numbers out of the real repo and merging into the real
 * tracker.
 */
const env = {
  ...process.env,
  CAREER_OPS_LOOP_STATE: paths.state,
  CAREER_OPS_LOOP_SHORTLIST: paths.shortlist,
  CAREER_OPS_LOOP_RUN_LOG: paths.runLog,
  CAREER_OPS_PIPELINE_FILE: paths.pipeline,
  CAREER_OPS_PROFILE: paths.profile,
  CAREER_OPS_TRACKER: paths.tracker,
  CAREER_OPS_ADDITIONS: paths.additions,
  CAREER_OPS_BATCH_STATE: paths.batchState,
  CAREER_OPS_REPORTS_DIR: paths.reports,
};

function loop(...args) {
  const res = spawnSync(NODE, [SCRIPT, ...args], { env, encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Parse the JSON a successful command prints; returns null when it did not. */
function loopJson(...args) {
  const res = loop(...args);
  try {
    return { ...res, json: JSON.parse(res.stdout) };
  } catch {
    return { ...res, json: null };
  }
}

const readState = () => JSON.parse(readFileSync(paths.state, 'utf-8'));
const writeJson = (name, value) => {
  const p = join(box, name);
  writeFileSync(p, JSON.stringify(value), 'utf-8');
  return p;
};

// The driver used to pin its run log, shortlist and tracker TSVs to the repo it
// lives in. Snapshot the real files so an env-plumbing regression shows up as a
// failed assertion here rather than as junk in the user's own loop history.
const realArtifacts = ['data/loop-state.json', 'data/loop-run-log.md', 'data/loop-shortlist.md']
  .map((rel) => ({ rel, before: existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf-8') : null }));

try {
  // ── start ──────────────────────────────────────────────────────────────────
  const started = loopJson('start');
  check('start exits 0 and reports the new run', started.status === 0 && started.json?.started === true,
    started.stderr.trim());
  check('start writes the state file', existsSync(paths.state));
  check('start honours loop.target from profile.yml', started.json?.config?.target === 2,
    `got ${started.json?.config?.target}`);
  check('start opens on a scan action', started.json?.next?.action === 'scan',
    `got ${started.json?.next?.action}`);

  const fresh = existsSync(paths.state) ? readState() : {};
  check('fresh state is scanning with no waves and no candidates',
    fresh.phase === 'scanning' && Array.isArray(fresh.waves) && fresh.waves.length === 0
    && fresh.candidates && Object.keys(fresh.candidates).length === 0);

  check('start creates the append-only run log with its header',
    existsSync(paths.runLog) && readFileSync(paths.runLog, 'utf-8').includes('# Loop run log'));

  // A second `start` must not quietly throw away a run that is mid-flight —
  // the candidates already scored in it are the expensive part.
  const restart = loop('start');
  check('a second start refuses while a run is in progress',
    restart.status === 1 && /already in progress/.test(restart.stderr), restart.stderr.trim());

  const reset = loopJson('start', '--reset');
  check('start --reset discards the run and begins a new one',
    reset.status === 0 && reset.json?.started === true && reset.json?.next?.action === 'scan');
  check('start --reset issues a different run_id', readState().run_id !== fresh.run_id);

  // ── ingest ─────────────────────────────────────────────────────────────────
  const offersFile = writeJson('offers.json', [
    { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Staff AI Engineer', location: 'Berlin' },
    { url: 'https://jobs.lever.co/beta/2', company: 'Beta', title: 'ML Platform Lead', location: 'Remote' },
    { url: 'https://jobs.ashbyhq.com/gamma/3', company: 'Gamma', title: 'Backend Engineer', location: 'Munich' },
    { url: 'https://boards.greenhouse.io/delta/jobs/4', company: 'Delta', title: 'Data Engineer', location: 'Hamburg' },
  ]);

  const ingested = loopJson('ingest', '--file', offersFile);
  check('ingest adds every new offer as a candidate',
    ingested.status === 0 && ingested.json?.added === 4 && ingested.json?.duplicate === 0,
    `${ingested.json?.added} added / ${ingested.json?.duplicate} dup ${ingested.stderr.trim()}`);
  check('ingest persists candidates across the process boundary',
    Object.keys(readState().candidates).length === 4);
  check('ingest records the wave it belongs to', readState().waves.length === 1);

  const reIngested = loopJson('ingest', '--file', offersFile);
  check('re-ingesting the same offers adds nothing and counts them as duplicates',
    reIngested.json?.added === 0 && reIngested.json?.duplicate === 4,
    `${reIngested.json?.added} added / ${reIngested.json?.duplicate} dup`);
  check('duplicate ingest does not grow the candidate set',
    Object.keys(readState().candidates).length === 4);

  const badShape = loop('ingest', '--file', writeJson('not-an-array.json', { url: 'https://example.com/1' }));
  check('ingest rejects a file that is not a JSON array',
    badShape.status === 1 && /must contain a JSON array/.test(badShape.stderr), badShape.stderr.trim());

  const noFile = loop('ingest');
  check('ingest without --file explains what it needs',
    noFile.status === 1 && /--file/.test(noFile.stderr), noFile.stderr.trim());

  // ── next ───────────────────────────────────────────────────────────────────
  const toScore = loopJson('next');
  check('next asks for scores once there are unscored candidates',
    toScore.json?.action === 'score', `got ${toScore.json?.action}`);

  // ── record ─────────────────────────────────────────────────────────────────
  // Use the keys the state itself holds: candidateKey() normalizes the URL, so a
  // test that re-derives them by hand would be testing its own copy of the rule.
  const keys = Object.keys(readState().candidates);

  const scoresFile = writeJson('scores.json', [
    { key: keys[0], score: 4.4, verdict: 'PASS', reason: 'archetype match' },
    { key: keys[1], score: 4.1, verdict: 'PASS', reason: 'strong platform fit' },
    { key: keys[2], score: 2.6, verdict: 'FAIL', reason: 'wrong seniority' },
  ]);
  const recorded = loopJson('record', '--file', scoresFile);
  check('record scores candidates and counts the qualifiers',
    recorded.status === 0 && recorded.json?.scored === 3 && recorded.json?.qualified === 2,
    `${recorded.json?.scored} scored / ${recorded.json?.qualified} qualified ${recorded.stderr.trim()}`);
  check('record persists verdicts, not just counts',
    readState().candidates[keys[0]].verdict === 'qualified'
    && readState().candidates[keys[2]].verdict === 'rejected');

  // The TSV form exists because a subagent asked for strict JSON often returns
  // prose-wrapped JSON; a tab and a TRIAGE line survive that.
  const triageFile = join(box, 'scores.txt');
  writeFileSync(triageFile, `${keys[3]}\tTRIAGE: MARGINAL | Delta | Data Engineer | 3.1/5 | thin AI surface\n`, 'utf-8');
  const recordedTsv = loopJson('record', '--file', triageFile);
  check('record accepts key<TAB>TRIAGE lines as well as JSON',
    recordedTsv.status === 0 && recordedTsv.json?.scored === 1 && recordedTsv.json?.qualified === 0,
    `${recordedTsv.json?.scored} scored ${recordedTsv.stderr.trim()}`);
  check('the TRIAGE line lands as a rejection with its score',
    readState().candidates[keys[3]].verdict === 'rejected' && readState().candidates[keys[3]].score === 3.1);

  // Recording nothing would read downstream as a barren wave and trip the
  // circuit breaker for a reason that has nothing to do with the postings.
  const unmatched = loop('record', '--file', writeJson('stale-scores.json', [{ key: 'https://example.com/gone', score: 4.9 }]));
  check('record refuses a file whose keys match no candidate',
    unmatched.status === 1 && /matched a candidate/.test(unmatched.stderr), unmatched.stderr.trim());

  // ── status / wave guard ────────────────────────────────────────────────────
  const summary = loop('status', '--summary');
  check('status --summary prints the qualified/target line',
    summary.status === 0 && /qualified\s+2\/2/.test(summary.stdout), summary.stdout.trim());

  const waveRefused = loop('wave');
  check('wave refuses to run a rung when the next action is not scan',
    waveRefused.status === 1 && /not "scan"/.test(waveRefused.stderr), waveRefused.stderr.trim());

  check('no temp state file is left behind by the write-then-rename',
    !existsSync(`${paths.state}.tmp`));

  // ── finish ─────────────────────────────────────────────────────────────────
  const finished = loopJson('finish');
  check('finish exits 0 and promotes only the qualified candidates',
    finished.status === 0 && finished.json?.promoted === 2,
    `promoted ${finished.json?.promoted} ${finished.stderr.trim()}`);
  check('finish writes the human review gate',
    existsSync(paths.shortlist) && /Acme/.test(readFileSync(paths.shortlist, 'utf-8')));
  check('finish names the review gate in its result, not an auto-apply next step',
    /loop-shortlist\.md/.test(finished.json?.shortlist ?? '') && /Review/.test(finished.json?.reviewGate ?? ''));

  // merge-tracker.mjs moves a merged TSV into an adjacent merged/ dir, so the
  // row can legitimately be in either place by the time this runs.
  const tsvNames = [
    ...readdirSync(paths.additions).filter((f) => f.endsWith('.tsv')),
    ...(existsSync(join(paths.additions, 'merged')) ? readdirSync(join(paths.additions, 'merged')).filter((f) => f.endsWith('.tsv')) : []),
  ];
  check('finish hands the tracker two TSV rows rather than editing applications.md',
    finished.json?.trackerRows === 2 && tsvNames.length === 2, `saw ${tsvNames.join(', ')}`);
  check('the promoted rows reach the tracker through merge-tracker',
    finished.json?.merged === true && /Acme/.test(readFileSync(paths.tracker, 'utf-8')));
  check('finish stamps a report number on every promoted candidate',
    Object.values(readState().candidates).filter((c) => c.verdict === 'qualified')
      .every((c) => Number.isInteger(c.reportNum)));

  // The tracker rows hold the numbers once the merge lands, so leaving the
  // sentinels behind just blocks those numbers until the 4h GC.
  check('finish releases its report-number reservations',
    readdirSync(paths.reports).filter((f) => f.endsWith('-RESERVED.md')).length === 0,
    readdirSync(paths.reports).join(', '));

  check('finish closes the run', readState().phase === 'done');

  // ── finish guard on an unscored run ────────────────────────────────────────
  loop('start', '--reset');
  loop('ingest', '--file', offersFile);
  const premature = loop('finish');
  check('finish refuses while candidates are still unscored',
    premature.status === 1 && /unscored/.test(premature.stderr), premature.stderr.trim());
  const forced = loopJson('finish', '--force');
  check('finish --force promotes what has been scored so far',
    forced.status === 0 && forced.json?.promoted === 0, forced.stderr.trim());

  // ── abort ──────────────────────────────────────────────────────────────────
  loop('start', '--reset');
  const aborted = loopJson('abort', '--note', 'stuck on a captcha wall');
  check('abort ends the run with the reason it was given',
    aborted.status === 0 && aborted.json?.reason === 'stuck on a captcha wall'
    && readState().phase === 'done' && readState().halted_reason === 'stuck on a captcha wall',
    aborted.stderr.trim());

  const runLog = readFileSync(paths.runLog, 'utf-8');
  check('the run log accumulates every event append-only',
    ['start', 'ingest', 'score', 'finish', 'abort'].every((e) => runLog.includes(e)),
    'missing at least one event');

  // ── failure modes ──────────────────────────────────────────────────────────
  writeFileSync(paths.state, '{ this is not json', 'utf-8');
  const corrupt = loop('status');
  check('an unreadable state file explains how to recover',
    corrupt.status === 1 && /start --reset/.test(corrupt.stderr), corrupt.stderr.trim());

  const unknown = loop('frobnicate');
  check('an unknown command exits 1 and prints the usage block',
    unknown.status === 1 && /unknown command/.test(unknown.stderr) && /scan-loop\.mjs/.test(unknown.stderr));

  const help = loop('--help');
  check('--help exits 0 and lists the commands', help.status === 0 && /start \[--target N\]/.test(help.stdout));

  // ── isolation ──────────────────────────────────────────────────────────────
  const leaked = realArtifacts.filter(({ rel, before }) => {
    const p = join(ROOT, rel);
    const after = existsSync(p) ? readFileSync(p, 'utf-8') : null;
    return after !== before;
  });
  check('the driver wrote nothing into the real repo while under test',
    leaked.length === 0, leaked.map((a) => a.rel).join(', '));
} catch (err) {
  fail(`scan-loop.mjs suite crashed: ${err.message}`);
}
