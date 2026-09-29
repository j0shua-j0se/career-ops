// tests/pinloop-provider.test.mjs — Pinloop wraps the `pinloop` CLI (a free-tier
// account; credentials live in ~/.pinloop, never touched here), so — same shape
// as providers/stepstone.mjs and providers/local-parser.mjs — it shells out via
// execFile instead of ctx.fetchJson. The child process is injected through
// `ctx.exec` for every test below: nothing here spawns a real process or makes
// a network call.
import { pass, fail, ROOT, rmSync } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nProvider — pinloop');

/** Points getCareerOpsRoot() at a fresh temp dir for the duration of `fn`. */
async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-pinloop-'));
  const prev = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

/** One pull row in Pinloop's --json shape. */
const row = (id, title, overrides = {}) => ({
  id,
  title,
  company: 'Acme Corp',
  locations: ['Erlangen'],
  posted_at: '2026-09-23T00:00:00.000Z',
  url: `https://acme.example/careers/${id}`,
  countries: ['Germany'],
  workplace_type: 'onsite',
  employment_type: ['internship'],
  ...overrides,
});

function execResolving(stdout) {
  return async () => ({ stdout, stderr: '' });
}

function execRejecting(props) {
  return async () => {
    const err = new Error(props.message || 'failed');
    Object.assign(err, props);
    throw err;
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/pinloop.mjs')).href);
  const pinloop = mod.default;
  const {
    parsePinloopConfig, computePostedAfter, todayUtc, buildPullArgs, joinLocations,
    isJobBoardUrl, normalizePinloopJob, passesWordsFilter, mergePinloopLeads,
    loadPinloopState, savePinloopState, resolvePinloopInvocation,
  } = mod;

  // ── identity ───────────────────────────────────────────────────────────
  if (pinloop.id === 'pinloop') pass('pinloop.id is "pinloop"');
  else fail(`pinloop.id is ${JSON.stringify(pinloop.id)}`);

  if (pinloop.detect === undefined) pass('pinloop has no detect() — explicit provider: pinloop only');
  else fail('pinloop should not define detect()');

  // ── parsePinloopConfig ─────────────────────────────────────────────────
  {
    const def = parsePinloopConfig({});
    if (def.titleQuery === '' && def.from === 'career sites' && def.country === 'Germany'
      && def.lookbackDays === 2 && def.dailyPullBudget === 5 && def.words.length === 0
      && def.allowJobBoardUrls === false) {
      pass('parsePinloopConfig applies documented defaults');
    } else {
      fail(`parsePinloopConfig defaults = ${JSON.stringify(def)}`);
    }
  }
  {
    const cfg = parsePinloopConfig({
      pinloop: {
        title_query: ' (a OR b) ', from: 'job boards', country: ' France ', words: ['  Erlangen  ', '', 7],
        lookback_days: 999999, daily_pull_budget: -3, allow_job_board_urls: true,
      },
    });
    if (cfg.titleQuery === '(a OR b)' && cfg.from === 'job boards' && cfg.country === 'France'
      && cfg.words.length === 1 && cfg.words[0] === 'Erlangen'
      && cfg.lookbackDays === 3650 && cfg.dailyPullBudget === 0 && cfg.allowJobBoardUrls === true) {
      pass('parsePinloopConfig trims strings, sanitizes words[], and clamps numeric fields');
    } else {
      fail(`parsePinloopConfig sanitized = ${JSON.stringify(cfg)}`);
    }
  }
  {
    const cfg = parsePinloopConfig({ pinloop: { words: 'Munich' } });
    if (cfg.words.length === 1 && cfg.words[0] === 'Munich') pass('parsePinloopConfig accepts a single words string');
    else fail(`parsePinloopConfig words string = ${JSON.stringify(cfg.words)}`);
  }

  // ── computePostedAfter / todayUtc ──────────────────────────────────────
  {
    const now = Date.UTC(2026, 8, 24, 10, 0, 0); // 2026-09-24T10:00:00Z
    if (computePostedAfter(2, now) === '2026-09-22') pass('computePostedAfter subtracts lookback days in UTC');
    else fail(`computePostedAfter = ${computePostedAfter(2, now)}`);
    if (todayUtc(now) === '2026-09-24') pass('todayUtc reads the UTC calendar day');
    else fail(`todayUtc = ${todayUtc(now)}`);
  }

  // ── buildPullArgs ──────────────────────────────────────────────────────
  {
    const cfg = parsePinloopConfig({
      pinloop: { title_query: '(werkstudent OR praktikum) AND data', from: 'career sites', country: 'Germany', lookback_days: 2 },
    });
    const now = Date.UTC(2026, 8, 24);
    const args = buildPullArgs(cfg, 3, now);
    const expected = [
      'pull', '(werkstudent OR praktikum) AND data',
      '--in', 'title', '--from', 'career sites', '--country', 'Germany',
      '--posted-after', '2026-09-22', '--limit', '3', '--json',
    ];
    if (JSON.stringify(args) === JSON.stringify(expected)) {
      pass('buildPullArgs sends the boolean title_query as ONE argv element (no shell, no splitting)');
    } else {
      fail(`buildPullArgs = ${JSON.stringify(args)}`);
    }
    const capped = buildPullArgs(cfg, 0, now);
    if (capped[capped.indexOf('--limit') + 1] === '1') pass('buildPullArgs floors --limit at 1');
    else fail(`buildPullArgs floor = ${JSON.stringify(capped)}`);
  }

  // ── joinLocations ──────────────────────────────────────────────────────
  if (joinLocations(['Erlangen', 'Nürnberg']) === 'Erlangen, Nürnberg'
    && joinLocations('Berlin') === 'Berlin' && joinLocations(null) === '' && joinLocations([]) === '') {
    pass('joinLocations joins arrays, passes through strings, and handles garbage as ""');
  } else {
    fail('joinLocations did not handle all input shapes');
  }

  // ── isJobBoardUrl ──────────────────────────────────────────────────────
  {
    const cases = [
      ['https://www.linkedin.com/jobs/view/123', true],
      ['https://de.linkedin.com/jobs/view/123', true],
      ['https://www.xing.com/jobs/123', true],
      ['https://acme.example/careers/123', false],
      ['not a url', false],
    ];
    const bad = cases.find(([url, expected]) => isJobBoardUrl(url) !== expected);
    if (!bad) pass('isJobBoardUrl recognizes linkedin.com/xing.com and their subdomains, nothing else');
    else fail(`isJobBoardUrl(${bad[0]}) !== ${bad[1]}`);
  }

  // ── normalizePinloopJob ────────────────────────────────────────────────
  {
    const job = normalizePinloopJob(row('j1', 'Werkstudent Data Science'));
    if (job && job.title === 'Werkstudent Data Science' && job.url === 'https://acme.example/careers/j1'
      && job.company === 'Acme Corp' && job.location === 'Erlangen' && job.source === 'pinloop'
      && job.postedAt === Date.parse('2026-09-23T00:00:00.000Z')) {
      pass('normalizePinloopJob maps a well-formed row to the Job contract, incl. source:"pinloop"');
    } else {
      fail(`normalizePinloopJob happy path = ${JSON.stringify(job)}`);
    }
  }
  if (normalizePinloopJob({ title: '', url: 'https://x.example/1' }) === null
    && normalizePinloopJob({ title: 'X', url: '' }) === null
    && normalizePinloopJob({ title: 'X', url: 'not a url' }) === null
    && normalizePinloopJob({ title: 'X', url: 'ftp://x.example/1' }) === null
    && normalizePinloopJob(null) === null) {
    pass('normalizePinloopJob drops rows missing a title, a URL, or a non-http(s) URL');
  } else {
    fail('normalizePinloopJob should reject malformed rows');
  }
  {
    const job = normalizePinloopJob(row('j2', 'X', { posted_at: 'not a date' }));
    if (job && job.postedAt === undefined) pass('normalizePinloopJob is NaN-safe: an unparseable posted_at is omitted, never NaN');
    else fail(`normalizePinloopJob postedAt = ${JSON.stringify(job)}`);
  }

  // ── passesWordsFilter ──────────────────────────────────────────────────
  {
    const job = { title: 'Werkstudent Data', company: 'Acme', location: 'Erlangen' };
    if (passesWordsFilter(job, []) === true
      && passesWordsFilter(job, ['erlangen']) === true
      && passesWordsFilter(job, ['ERLANGEN', 'Data']) === true
      && passesWordsFilter(job, ['munich']) === false) {
      pass('passesWordsFilter checks case-insensitively across title+company+location, ANDed');
    } else {
      fail('passesWordsFilter behaved unexpectedly');
    }
  }

  // ── mergePinloopLeads ──────────────────────────────────────────────────
  {
    const existing = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
    const merged = mergePinloopLeads(existing, [{ id: 'b', title: 'B2' }, { id: 'c', title: 'C' }]);
    if (merged.length === 3 && merged.find((l) => l.id === 'b').title === 'B2') {
      pass('mergePinloopLeads merges by id, newer wins');
    } else {
      fail(`mergePinloopLeads = ${JSON.stringify(merged)}`);
    }
    const capped = mergePinloopLeads([], [{ id: '1' }, { id: '2' }, { id: '3' }], 2);
    if (capped.length === 2 && capped[0].id === '2' && capped[1].id === '3') {
      pass('mergePinloopLeads caps the list and trims the OLDEST leads first');
    } else {
      fail(`mergePinloopLeads cap = ${JSON.stringify(capped)}`);
    }
    const noKey = mergePinloopLeads([{ id: 'x' }], [{ title: 'no id or url' }]);
    if (noKey.length === 1) pass('mergePinloopLeads drops an incoming lead with neither id nor url');
    else fail(`mergePinloopLeads noKey = ${JSON.stringify(noKey)}`);
  }

  // ── budget state: round-trip + day rollover ────────────────────────────
  await withTempRoot(async () => {
    const s0 = loadPinloopState(Date.UTC(2026, 8, 24));
    if (s0.day === '2026-09-24' && s0.pulls_used === 0 && s0.exhausted === false) {
      pass('loadPinloopState returns a fresh zero-used day when no state file exists');
    } else {
      fail(`loadPinloopState fresh = ${JSON.stringify(s0)}`);
    }

    savePinloopState({
      day: '2026-09-24', pulls_used: 3, exhausted: false, last_error: '',
    });
    const s1 = loadPinloopState(Date.UTC(2026, 8, 24, 23));
    if (s1.pulls_used === 3 && s1.exhausted === false) pass('savePinloopState/loadPinloopState round-trip within the same UTC day');
    else fail(`round-trip = ${JSON.stringify(s1)}`);

    // Next UTC day: budget resets even though the file still says pulls_used: 3.
    const s2 = loadPinloopState(Date.UTC(2026, 8, 25, 1));
    if (s2.day === '2026-09-25' && s2.pulls_used === 0 && s2.exhausted === false) {
      pass('loadPinloopState resets pulls_used/exhausted on UTC day rollover');
    } else {
      fail(`day rollover = ${JSON.stringify(s2)}`);
    }
  });

  await withTempRoot(async (root) => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'pinloop-state.json'), '{not json');
    const s = loadPinloopState(Date.UTC(2026, 8, 24));
    if (s.pulls_used === 0 && s.exhausted === false) pass('a corrupt state file resolves to a fresh day, not a crash');
    else fail(`corrupt state file = ${JSON.stringify(s)}`);
  });

  // ── fetch(): misconfiguration throws ───────────────────────────────────
  await withTempRoot(async () => {
    try {
      await pinloop.fetch({ name: 'No Query' }, { exec: execResolving('{}') });
      fail('fetch() should throw when pinloop.title_query is missing');
    } catch (e) {
      if (/title_query/.test(e.message)) pass('fetch() throws a descriptive error when title_query is missing');
      else fail(`unexpected error: ${e.message}`);
    }

    try {
      await pinloop.fetch({ name: 'Bad From', pinloop: { title_query: 'x', from: 'social media' } }, { exec: execResolving('{}') });
      fail('fetch() should throw on an invalid pinloop.from');
    } catch (e) {
      if (/pinloop\.from/.test(e.message)) pass('fetch() throws a descriptive error on an invalid pinloop.from');
      else fail(`unexpected error: ${e.message}`);
    }
  });

  // ── fetch(): happy path — JSON parsing, linkedin filtering, reach filtering ──
  await withTempRoot(async (root) => {
    let calledWith = null;
    const exec = async (cmd, args) => {
      calledWith = { cmd, args };
      return {
        stdout: JSON.stringify({
          rows: [
            row('erlangen-1', 'Werkstudent Data Science', { locations: ['Erlangen'] }),
            row('linkedin-1', 'Werkstudent AI', { url: 'https://www.linkedin.com/jobs/view/999', locations: ['Berlin'] }),
            row('abroad-1', 'Werkstudent Analytics', { locations: ['Barcelona'] }),
            row('no-title', '', {}),
          ],
          cursor: null,
          postings: {
            pulled: 2, matching: 4, window: { kind: 'since', day: '2026-09-22' },
            already_had: 0, used: 2, left: 3, period: 'day', next_posted_after: '',
          },
        }),
        stderr: '',
      };
    };
    const entry = {
      name: 'Pinloop Test Board',
      pinloop: { title_query: '(werkstudent) AND (data OR ai OR analytics)', lookback_days: 2 },
    };
    const jobs = await pinloop.fetch(entry, { exec });
    if (calledWith && calledWith.cmd) pass('fetch() invokes the injected exec() rather than a real process');
    else fail('fetch() did not call the injected exec()');

    if (jobs.length === 1 && jobs[0].url === 'https://acme.example/careers/erlangen-1') {
      pass('fetch() keeps only the well-formed, non-linkedin, in-reach row');
    } else {
      fail(`fetch() jobs = ${JSON.stringify(jobs)}`);
    }
    if (jobs[0].source === 'pinloop') pass('fetch() stamps source:"pinloop" on every kept job');
    else fail('fetch() job missing source:"pinloop"');

    const state = loadPinloopState(Date.now());
    if (state.pulls_used === 2 && state.exhausted === false) {
      pass('fetch() records budget usage from the server\'s postings.left, not a guess');
    } else {
      fail(`state after happy path = ${JSON.stringify(state)}`);
    }

    const leadsPath = join(root, 'data', 'pinloop-leads.json');
    if (existsSync(leadsPath)) {
      const leads = JSON.parse(readFileSync(leadsPath, 'utf-8'));
      if (leads.length === 1 && leads[0].id === 'erlangen-1' && leads[0].company === 'Acme Corp') {
        pass('fetch() persists kept rows to data/pinloop-leads.json in the harvester shape');
      } else {
        fail(`pinloop-leads.json = ${JSON.stringify(leads)}`);
      }
    } else {
      fail('fetch() did not write data/pinloop-leads.json');
    }
  });

  // ── fetch(): allow_job_board_urls opts a linkedin/xing row back in ─────
  await withTempRoot(async () => {
    const exec = execResolving(JSON.stringify({
      rows: [row('li-1', 'Werkstudent Data', { url: 'https://www.linkedin.com/jobs/view/1' })],
      cursor: null,
    }));
    const entry = {
      name: 'Allow LinkedIn',
      pinloop: { title_query: 'x', allow_job_board_urls: true },
    };
    const jobs = await pinloop.fetch(entry, { exec });
    if (jobs.length === 1) pass('fetch() keeps a linkedin.com row when allow_job_board_urls is true');
    else fail(`fetch() with allow_job_board_urls = ${JSON.stringify(jobs)}`);
  });

  // ── fetch(): quota refusal on the JSON success path (exit 0, `refused` field) ──
  await withTempRoot(async () => {
    const exec = execResolving(JSON.stringify({ rows: [], cursor: null, refused: 'free plan: 5 postings a day used up' }));
    const entry = { name: 'Quota Board', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() returns zero jobs on a `refused` pull (no throw)');
    else fail(`fetch() on refusal = ${JSON.stringify(jobs)}`);

    const state = loadPinloopState(Date.now());
    if (state.exhausted === true && /5 postings a day/.test(state.last_error)) {
      pass('fetch() marks the day exhausted and records the refusal text on a `refused` pull');
    } else {
      fail(`state after refusal = ${JSON.stringify(state)}`);
    }

    // A SECOND fetch() the same day must not call exec() again.
    let secondCalled = false;
    await pinloop.fetch(entry, { exec: async () => { secondCalled = true; return { stdout: '{}', stderr: '' }; } });
    if (!secondCalled) pass('fetch() never retries in a loop — a second call the same day skips the network entirely');
    else fail('fetch() called exec() again after the day was marked exhausted');
  });

  // ── fetch(): quota/limit refusal thrown as a non-zero exit (no --json envelope) ──
  await withTempRoot(async () => {
    const exec = execRejecting({
      message: 'Command failed', code: 1, stderr: 'daily pull limit exceeded — try again tomorrow',
    });
    const entry = { name: 'Quota Exit Board', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() returns zero jobs on a non-zero-exit quota/limit refusal');
    else fail(`fetch() on thrown quota refusal = ${JSON.stringify(jobs)}`);
    const state = loadPinloopState(Date.now());
    if (state.exhausted === true) pass('fetch() marks the day exhausted on a thrown quota/limit refusal too');
    else fail(`state after thrown refusal = ${JSON.stringify(state)}`);
  });

  // ── fetch(): the 502/AlreadySaid shape — non-zero exit, but JSON already on stdout ──
  await withTempRoot(async () => {
    const exec = execRejecting({
      message: 'Command failed', code: 1,
      stdout: JSON.stringify({ rows: [], cursor: null, error: 'pinloop is unreachable right now' }),
      stderr: '',
    });
    const entry = { name: 'Upstream Down', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() recovers the JSON already printed on stdout for a failed --json pull');
    else fail(`fetch() on AlreadySaid shape = ${JSON.stringify(jobs)}`);
  });

  // ── fetch(): missing CLI ────────────────────────────────────────────────
  await withTempRoot(async () => {
    const exec = execRejecting({ message: 'spawn pinloop.cmd ENOENT', code: 'ENOENT' });
    const entry = { name: 'No CLI', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() returns zero jobs (not a crash) when the pinloop CLI is missing');
    else fail(`fetch() on missing CLI = ${JSON.stringify(jobs)}`);
  });

  // ── fetch(): not logged in ─────────────────────────────────────────────
  await withTempRoot(async () => {
    const exec = execRejecting({
      message: 'no saved login at /home/user/.pinloop/pass.json. Run `pinloop login` first.', code: 1,
    });
    const entry = { name: 'Not Logged In', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() returns zero jobs (not a crash) when not logged in');
    else fail(`fetch() when not logged in = ${JSON.stringify(jobs)}`);
  });

  // ── fetch(): an unrecognized failure still throws (not silently swallowed) ──
  await withTempRoot(async () => {
    const exec = execRejecting({ message: 'ECONNRESET', code: 1, stderr: 'socket hang up' });
    const entry = { name: 'Weird Failure', pinloop: { title_query: 'x' } };
    try {
      await pinloop.fetch(entry, { exec });
      fail('fetch() should throw on an unrecognized failure, not swallow it');
    } catch (e) {
      if (/socket hang up|ECONNRESET/.test(e.message)) pass('fetch() throws (loud) on a failure it does not recognize as quota/login/missing-CLI');
      else fail(`unexpected error: ${e.message}`);
    }
  });

  // ── fetch(): budget already exhausted before this run even starts ─────
  await withTempRoot(async () => {
    savePinloopState({
      day: todayUtc(), pulls_used: 5, exhausted: true, last_error: 'pre-exhausted for this test',
    });
    let called = false;
    const exec = async () => { called = true; return { stdout: '{}', stderr: '' }; };
    const entry = { name: 'Already Exhausted', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (!called && Array.isArray(jobs) && jobs.length === 0) {
      pass('fetch() skips the network call entirely when the daily budget is already exhausted');
    } else {
      fail(`fetch() with pre-exhausted budget: called=${called} jobs=${JSON.stringify(jobs)}`);
    }
  });

  // ── fetch(): daily_pull_budget: 0 always skips the network ────────────
  await withTempRoot(async () => {
    let called = false;
    const exec = async () => { called = true; return { stdout: '{}', stderr: '' }; };
    const entry = { name: 'Zero Budget', pinloop: { title_query: 'x', daily_pull_budget: 0 } };
    const jobs = await pinloop.fetch(entry, { exec });
    if (!called && jobs.length === 0) pass('fetch() with daily_pull_budget: 0 never calls the CLI');
    else fail(`fetch() with zero budget: called=${called} jobs=${JSON.stringify(jobs)}`);
  });

  // ── fetch(): budget accounting across TWO calls the same day, no server numbers ──
  await withTempRoot(async () => {
    const makeExec = (ids) => execResolving(JSON.stringify({
      rows: ids.map((id) => row(id, `Werkstudent ${id}`)),
      cursor: null,
      // no `postings` block: an older server, or one that omits it — fetch()
      // must fall back to counting rows itself.
    }));
    const entry = { name: 'No Server Numbers', pinloop: { title_query: 'x', daily_pull_budget: 5 } };

    const first = await pinloop.fetch(entry, { exec: makeExec(['a', 'b', 'c']) });
    if (first.length === 3) pass('fetch() (no postings block) returns all rows from the first call');
    else fail(`first call = ${JSON.stringify(first)}`);
    let state = loadPinloopState(Date.now());
    if (state.pulls_used === 3) pass('fetch() (no postings block) falls back to counting rows for budget accounting');
    else fail(`state after first call = ${JSON.stringify(state)}`);

    let secondArgs = null;
    const second = await pinloop.fetch(entry, {
      exec: async (cmd, args) => { secondArgs = args; return (await makeExec(['d', 'e']))(); },
    });
    if (secondArgs[secondArgs.indexOf('--limit') + 1] === '2') {
      pass('fetch() bounds the second call\'s --limit to the REMAINING budget (5 - 3 = 2)');
    } else {
      fail(`second call --limit = ${JSON.stringify(secondArgs)}`);
    }
    state = loadPinloopState(Date.now());
    if (state.pulls_used === 5 && state.exhausted === true) {
      pass('fetch() marks the day exhausted once accumulated pulls_used reaches the budget');
    } else {
      fail(`state after second call = ${JSON.stringify(state)}`);
    }
  });

  // ── resolvePinloopInvocation: argv/entry resolution ─────────────────────
  // Node 24 refuses to spawn a `.cmd` file under shell:false (`spawn EINVAL`,
  // synchronous — reproduced live on Windows), so on win32 this resolves the
  // CLI's own JS entry and runs it via `node <entry> <args>` instead of
  // spawning `pinloop.cmd` directly. Every input (platform/env/exists/execPath)
  // is injected here so the win32 branch — including its failure — is exercised
  // deterministically regardless of the host OS running this suite.
  {
    const posix = resolvePinloopInvocation({ platform: 'linux', env: {}, execPath: '/usr/bin/node' });
    if (posix.command === 'pinloop' && posix.args.length === 0) {
      pass('resolvePinloopInvocation on non-win32 invokes the bare `pinloop` binary directly (no entry resolution)');
    } else {
      fail(`resolvePinloopInvocation posix = ${JSON.stringify(posix)}`);
    }
  }
  {
    const win = resolvePinloopInvocation({
      platform: 'win32',
      env: { PINLOOP_ENTRY: 'D:\\dev\\pinloop\\dist\\cli\\pinloop.js' },
      exists: () => false, // must not even be consulted when the override is set
      execPath: 'C:\\nodejs\\node.exe',
    });
    if (win.command === 'C:\\nodejs\\node.exe' && win.args.length === 1 && win.args[0] === 'D:\\dev\\pinloop\\dist\\cli\\pinloop.js') {
      pass('resolvePinloopInvocation on win32 honors PINLOOP_ENTRY as an explicit override, runs it via node');
    } else {
      fail(`resolvePinloopInvocation win32 override = ${JSON.stringify(win)}`);
    }
  }
  {
    const expectedAppData = join('C:\\Users\\test\\AppData\\Roaming', 'npm', 'node_modules', 'pinloop', 'dist', 'cli', 'pinloop.js');
    const win = resolvePinloopInvocation({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      exists: (p) => p === expectedAppData,
      execPath: 'C:\\nodejs\\node.exe',
    });
    if (win.command === 'C:\\nodejs\\node.exe' && win.args[0] === expectedAppData) {
      pass('resolvePinloopInvocation on win32 finds the default npm global install under %APPDATA%\\npm\\node_modules');
    } else {
      fail(`resolvePinloopInvocation win32 APPDATA = ${JSON.stringify(win)}`);
    }
  }
  {
    const expectedNodeDir = join('C:\\nodejs', 'node_modules', 'pinloop', 'dist', 'cli', 'pinloop.js');
    const win = resolvePinloopInvocation({
      platform: 'win32',
      env: {}, // no APPDATA at all
      exists: (p) => p === expectedNodeDir,
      execPath: 'C:\\nodejs\\node.exe',
    });
    if (win.command === 'C:\\nodejs\\node.exe' && win.args[0] === expectedNodeDir) {
      pass('resolvePinloopInvocation falls back to a node_modules dir next to node.exe when APPDATA is unset');
    } else {
      fail(`resolvePinloopInvocation win32 node-dir fallback = ${JSON.stringify(win)}`);
    }
  }
  {
    try {
      resolvePinloopInvocation({
        platform: 'win32', env: { APPDATA: 'C:\\Users\\nobody\\AppData\\Roaming' }, exists: () => false, execPath: 'C:\\nodejs\\node.exe',
      });
      fail('resolvePinloopInvocation should throw when no entry can be found on win32');
    } catch (e) {
      if (e.code === 'ENOENT' && /pinloop:/.test(e.message) && /PINLOOP_ENTRY/.test(e.message)) {
        pass('resolvePinloopInvocation throws a descriptive ENOENT-coded error when nothing resolves on win32');
      } else {
        fail(`unexpected error: code=${e.code} message=${e.message}`);
      }
    }
  }
  {
    // A pathologically throwing `exists` (e.g. a permissions error mid-check)
    // must not crash resolution — it is treated the same as "not found" and
    // the search continues to the next candidate / the final throw.
    try {
      const win = resolvePinloopInvocation({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
        exists: () => { throw new Error('EPERM: permission denied'); },
        execPath: 'C:\\nodejs\\node.exe',
      });
      fail(`resolvePinloopInvocation should have thrown ENOENT, not returned ${JSON.stringify(win)}`);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        pass('resolvePinloopInvocation treats a throwing exists() check as "not found" rather than propagating it');
      } else {
        fail(`unexpected error from a throwing exists() check: ${e.message}`);
      }
    }
  }
} catch (e) {
  fail(`pinloop provider tests crashed: ${e.stack || e.message}`);
}

// ── fetch(): the synchronous-throw path (Node 24's real-world failure mode) ──
// Everything above already proved runPinloop's resolution step is correct; this
// section proves the OTHER half of the coordinator's report: a THROW that
// happens synchronously (before any Promise exists) inside runPinloop must
// still come out of fetch() as an ordinary rejected/handled promise, never as
// an uncaught exception that would crash the scan.
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/pinloop.mjs')).href);
  const pinloop = mod.default;

  await withTempRoot(async () => {
    // ctx.resolveInvocation itself throws synchronously — exactly the shape
    // resolvePinloopInvocation() uses when no entry can be found on win32, and
    // exactly where Node's real spawn EINVAL would have escaped from before
    // this provider stopped spawning `.cmd` files directly.
    const entry = { name: 'Sync Throw — resolution', pinloop: { title_query: 'x' } };
    let execCalled = false;
    const jobs = await pinloop.fetch(entry, {
      exec: async () => { execCalled = true; return { stdout: '{}', stderr: '' }; },
      resolveInvocation: () => {
        const err = new Error('pinloop: could not resolve the installed CLI\'s JS entry on Windows (simulated)');
        err.code = 'ENOENT';
        throw err;
      },
    });
    if (Array.isArray(jobs) && jobs.length === 0 && !execCalled) {
      pass('fetch() survives a synchronous throw from invocation resolution: zero jobs, no crash, exec() never reached');
    } else {
      fail(`fetch() on sync resolution throw: jobs=${JSON.stringify(jobs)} execCalled=${execCalled}`);
    }
  });

  await withTempRoot(async () => {
    // exec() itself throws SYNCHRONOUSLY rather than returning a rejected
    // Promise — this is the literal shape of Node 24's `spawn EINVAL` for a
    // `.cmd` under shell:false: the exception fires before execFile ever hands
    // back a Promise. An ENOENT-flavored one must resolve to the same soft
    // "CLI unavailable" path as an async rejection would.
    const entry = { name: 'Sync Throw — exec (ENOENT-like)', pinloop: { title_query: 'x' } };
    const jobs = await pinloop.fetch(entry, {
      exec: () => {
        const err = new Error('spawn pinloop.cmd ENOENT');
        err.code = 'ENOENT';
        throw err; // synchronous — no Promise, no async function
      },
    });
    if (Array.isArray(jobs) && jobs.length === 0) {
      pass('fetch() survives exec() throwing synchronously (not a rejected Promise) with an ENOENT-like error: zero jobs, no crash');
    } else {
      fail(`fetch() on sync exec ENOENT throw = ${JSON.stringify(jobs)}`);
    }
  });

  await withTempRoot(async () => {
    // A synchronous throw with a cause this provider does NOT recognize as
    // quota/login/missing-CLI must still surface as an ordinary awaited
    // rejection from fetch() — proving the sync throw was normalized into the
    // Promise chain rather than escaping as an uncaught exception (which would
    // have crashed the whole node process, not just this one board).
    const entry = { name: 'Sync Throw — unrecognized', pinloop: { title_query: 'x' } };
    try {
      await pinloop.fetch(entry, {
        exec: () => { throw new Error('EACCES: permission denied, spawn'); }, // synchronous, no code set
      });
      fail('fetch() should reject (not resolve) on an unrecognized synchronous exec() throw');
    } catch (e) {
      if (/EACCES/.test(e.message)) {
        pass('fetch() normalizes an unrecognized synchronous exec() throw into a plain awaited rejection (never an uncaught crash)');
      } else {
        fail(`unexpected error from unrecognized sync throw: ${e.message}`);
      }
    }
  });
} catch (e) {
  fail(`pinloop sync-throw tests crashed: ${e.stack || e.message}`);
}
