// tests/fetch-jds.test.mjs — fetch-jds.mjs (zero-token JD pre-fetcher).
//
// HERMETIC: no network. Playwright is never launched here — compactJdText is
// pure, and the gate/fetchOne tests inject stub robots/page dependencies so
// the "never navigated" guarantee is provable without a real browser or a
// real robots.txt fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync as _rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { compactJdText, gateUrl, fetchOne, pickContainerText } from '../fetch-jds.mjs';
import { setHostResolver } from '../liveness-browser.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rmSync = (target, opts = {}) => _rmSync(target, { maxRetries: 10, retryDelay: 100, ...opts });

function runScript(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'fetch-jds.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  assert.equal(r.error, undefined, `fetch-jds.mjs failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `fetch-jds.mjs was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ─── compactJdText ──────────────────────────────────────────────────────────

test('compactJdText: empty input returns empty string', () => {
  assert.equal(compactJdText(''), '');
  assert.equal(compactJdText('   \n\n  '), '');
  assert.equal(compactJdText(null), '');
  assert.equal(compactJdText(undefined), '');
});

test('compactJdText: normalizes whitespace (tabs/multi-space collapse, lines trimmed)', () => {
  const raw = 'Senior   Engineer\t\t(m/w/d)\n   We are looking for talented engineers to join our AI team.   \n';
  const out = compactJdText(raw);
  assert.ok(out.includes('Senior Engineer (m/w/d)'), `whitespace not collapsed: ${out}`);
  assert.ok(out.includes('We are looking for talented engineers to join our AI team.'));
  assert.ok(!out.includes('  '), 'double spaces should be collapsed');
});

test('compactJdText: drops empty and 1-2 char lines', () => {
  const raw = [
    'A real requirements line goes here for the role we are hiring.',
    '',
    'a',
    'ok',
    'Another substantial requirements sentence about the team and mission.',
  ].join('\n');
  const out = compactJdText(raw);
  assert.ok(!/^a$/m.test(out), 'single-char line "a" should be dropped');
  assert.ok(!/^ok$/m.test(out), 'two-char line "ok" should be dropped');
  assert.ok(out.includes('A real requirements line'));
  assert.ok(out.includes('Another substantial requirements sentence'));
});

test('compactJdText: drops exact duplicate lines', () => {
  const raw = [
    'We are hiring a Working Student for our Generative AI team in Munich.',
    'We are hiring a Working Student for our Generative AI team in Munich.',
    'Responsibilities include building agentic AI prototypes end to end.',
  ].join('\n');
  const out = compactJdText(raw);
  const occurrences = out.split('We are hiring a Working Student').length - 1;
  assert.equal(occurrences, 1, `duplicate line should appear once, got ${occurrences}`);
});

test('compactJdText: drops boilerplate nav/consent/legal lines', () => {
  const raw = [
    'Login',
    'Menü',
    'Share',
    'Teilen',
    'Impressum',
    'Datenschutz',
    'LinkedIn',
    'This website uses cookies to improve your experience.',
    'A genuine job description sentence about backend engineering work.',
  ].join('\n');
  const out = compactJdText(raw);
  for (const boilerplate of ['Login', 'Menü', 'Share', 'Teilen', 'Impressum', 'Datenschutz', 'LinkedIn']) {
    assert.ok(!new RegExp(`^${boilerplate}$`, 'm').test(out), `"${boilerplate}" should have been dropped, got: ${out}`);
  }
  assert.ok(!/uses cookies/i.test(out), 'cookie banner line should have been dropped');
  assert.ok(out.includes('A genuine job description sentence'), 'real content line should survive');
});

test('compactJdText: keeps the head up to maxChars', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`Requirement number ${i}: strong communication and engineering skills.`);
  const raw = lines.join('\n');
  const out = compactJdText(raw, { maxChars: 200 });
  const headOnly = out.split('--- signals beyond cut ---')[0];
  assert.ok(headOnly.length <= 210, `head should respect maxChars=200 (line-granular), got ${headOnly.length}`);
  assert.ok(headOnly.includes('Requirement number 0'), 'head should start from the beginning');
});

test('compactJdText: appends signals beyond the cut, under the marker, capped at ~800 chars', () => {
  const filler = [];
  for (let i = 0; i < 50; i++) filler.push(`Filler sentence ${i} about the team culture and mission statement.`);
  const signals = [
    'This role requires German at C1 level and fluent English.',
    'This is a full-time position, 40 Stunden/Woche, unbefristet.',
    'Salary: 55.000 EUR Gehalt per TVöD E13 pay band.',
    'You have 5 Jahre of experience and a Master degree, currently eingeschrieben.',
    'This role is Remote with occasional Homeoffice and hybrid on-site days.',
  ];
  const raw = [...filler, ...signals].join('\n');

  const out = compactJdText(raw, { maxChars: 300 });
  assert.ok(out.includes('--- signals beyond cut ---'), 'marker line should be present when signals exist beyond the cut');
  const [, afterMarker] = out.split('--- signals beyond cut ---');
  assert.ok(afterMarker, 'there should be content after the marker');
  for (const s of signals) {
    assert.ok(afterMarker.includes(s), `signal line missing from beyond-cut section: ${s}`);
  }
  assert.ok(afterMarker.length <= 820, `signals-beyond-cut section should be capped near 800 chars, got ${afterMarker.length}`);
});

test('compactJdText: no marker when everything fits inside maxChars', () => {
  const raw = 'Short JD that easily fits within the character budget for this role.';
  const out = compactJdText(raw, { maxChars: 3500 });
  assert.ok(!out.includes('--- signals beyond cut ---'), 'no marker expected when nothing was cut');
});

// ─── pickContainerText: main/article vs whole-body fallback ────────────────
//
// Regression coverage for the StepStone `-inline.html` false negative: `main`
// there is a 298-char title/company/location snippet while `document.body`
// carries the ~11,800-char posting (tasks section included) — confirmed by a
// direct headless Playwright probe against the real page, no iframe/shadow
// root/lazy-load involved. A fixed "> 200 chars is substantial" rule picks
// the small container and never recovers the JD body.

test('pickContainerText: falls back to body when preferred is short in both absolute and relative terms (StepStone case)', () => {
  const preferred = 'Werkstudent Generative AI / Agentic AI (m/w/d)\nAtruvia AG\nKarlsruhe, Aschheim\nStudentenjob';
  const body = 'x'.repeat(11800); // stand-in for the full posting text
  assert.equal(pickContainerText(preferred, body), body);
});

test('pickContainerText: uses preferred when it is long and a substantial share of body', () => {
  const body = 'y'.repeat(5000);
  const preferred = 'z'.repeat(4000); // >= 1500 chars and >= 40% of body
  assert.equal(pickContainerText(preferred, body), preferred);
});

test('pickContainerText: falls back to body when preferred clears the fraction but not the absolute floor', () => {
  const body = 'b'.repeat(1000);
  const preferred = 'p'.repeat(800); // 80% of body, but under CONTAINER_MIN_CHARS (1500)
  assert.equal(pickContainerText(preferred, body), body);
});

test('pickContainerText: falls back to body when preferred clears the absolute floor but not the fraction', () => {
  const body = 'b'.repeat(10000);
  const preferred = 'p'.repeat(1600); // >= 1500 chars, but only 16% of body
  assert.equal(pickContainerText(preferred, body), body);
});

test('pickContainerText: empty preferred returns body', () => {
  assert.equal(pickContainerText('', 'some body text'), 'some body text');
  assert.equal(pickContainerText('   ', 'some body text'), 'some body text');
});

test('pickContainerText: empty body returns preferred (never returns empty when preferred has text)', () => {
  assert.equal(pickContainerText('preferred text', ''), 'preferred text');
});

test('pickContainerText: both empty returns empty string', () => {
  assert.equal(pickContainerText('', ''), '');
});

// ─── gateUrl / fetchOne: never navigate a disallowed or unsafe URL ─────────

test('gateUrl: refuses a private/loopback URL as unsafe-url without any robots check', async () => {
  let robotsCalled = false;
  const result = await gateUrl('http://127.0.0.1:9999/job/1', {
    checkRobotsFn: async () => { robotsCalled = true; return { retry: true }; },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'unsafe-url');
  assert.equal(robotsCalled, false, 'robots.txt should never be consulted for an already-unsafe URL');
});

// Real-world robots.txt for these four hosts disallows the paths below (LinkedIn
// job pages, Xing job pages, BMW Group's ATS, hiring.cafe /viewjob/). Stubbed
// here rather than fetched live so the test is hermetic and deterministic.
const DISALLOWED_HOSTS = [
  ['https://www.linkedin.com/jobs/view/123456789', 'linkedin.com'],
  ['https://www.xing.com/jobs/some-job-123', 'xing.com'],
  ['https://bmwgroup.jobs/de/de/job/12345.html', 'bmwgroup.jobs'],
  ['https://hiring.cafe/viewjob/abc123', 'hiring.cafe'],
];

for (const [url, host] of DISALLOWED_HOSTS) {
  test(`gateUrl: refuses ${host} per robots.txt (stubbed) as robots-blocked`, async () => {
    const stubCheckRobots = async () => ({ retry: false, code: 'disallowed', reason: `robots.txt disallows this path for ${host}` });
    const result = await gateUrl(url, { checkRobotsFn: stubCheckRobots });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 'robots-blocked');
  });

  test(`fetchOne: never calls newPage/navigates for ${host} when robots-blocked`, async () => {
    const stubCheckRobots = async () => ({ retry: false, code: 'disallowed', reason: `robots.txt disallows this path for ${host}` });
    const newPage = () => { throw new Error(`fetchOne must not create a page for a robots-blocked URL (${host})`); };
    const entry = { key: url, url, company: 'Test', title: 'Test Role', location: 'Remote' };
    const result = await fetchOne(entry, { newPage, checkRobotsFn: stubCheckRobots });
    assert.equal(result.status, 'robots-blocked');
    assert.equal(result.key, url);
    assert.equal(result.chars, 0);
    assert.equal(result.text, '');
  });
}

test('fetchOne: never calls newPage for an unsafe (private-host) URL', async () => {
  const newPage = () => { throw new Error('fetchOne must not create a page for an unsafe URL'); };
  const entry = { key: 'k1', url: 'http://169.254.169.254/latest/meta-data/', company: 'X', title: 'Y', location: 'Z' };
  const result = await fetchOne(entry, { newPage });
  assert.equal(result.status, 'unsafe-url');
  assert.equal(result.chars, 0);
});

test('fetchOne: preserves key/company/title/location on every branch', async () => {
  const entry = { key: 'abc-key', url: 'https://www.linkedin.com/jobs/view/1', company: 'Acme', title: 'Working Student', location: 'Munich' };
  const stubCheckRobots = async () => ({ retry: false, code: 'disallowed', reason: 'no' });
  const result = await fetchOne(entry, { newPage: () => { throw new Error('nope'); }, checkRobotsFn: stubCheckRobots });
  assert.equal(result.key, 'abc-key');
  assert.equal(result.company, 'Acme');
  assert.equal(result.title, 'Working Student');
  assert.equal(result.location, 'Munich');
});

// ─── regression: a blocked third-party request / thin body must not turn an
// ok page into `error` ──────────────────────────────────────────────────────
//
// Bug (found via a live smoke test): fetch-jds independently re-gated on raw
// body length (>= 300 chars) AFTER checkUrlLiveness already returned `active`.
// That is stricter than classifyLiveness's own rule (an apply control alone
// is enough — checked BEFORE its length check), so a genuinely live but
// thin-bodied page — StepStone's own `-inline.html` fragment renders only
// title/company/apply, no JD prose — was downgraded from `ok` to `error`
// (`no_content`), even though `check-liveness.mjs` correctly calls it active.
// `checkUrlLiveness` itself already has its own coverage (test-all.mjs) that
// a dead THIRD-PARTY subresource must not decide the verdict; this test
// guards the seam fetch-jds adds on top: once checkUrlLiveness says `active`,
// fetch-jds must not re-derive `error` from a stricter length rule of its own.
//
// A fake page (no frames/route, matching the "frameless" shape checkUrlLiveness
// already supports) stands in for Playwright: `evaluate` discriminates the
// three calls fetchOne triggers by the callback's own source text.
function fakeActivePage({ bodyText, applyControls, finalUrl }) {
  return {
    async goto() { return { status: () => 200 }; },
    async waitForTimeout() {},
    url() { return finalUrl; },
    async evaluate(fn) {
      const src = fn.toString();
      // checkUrlLiveness's own apply-control extractor uses querySelectorAll.
      if (src.includes('querySelectorAll')) return applyControls;
      // fetch-jds's extractPageText reads {preferredText, bodyText} in one
      // call; simulate no main/article/[role=main] element found, so
      // pickContainerText falls back to bodyText — same as a real page with
      // no such container.
      if (src.includes('preferredText')) return { preferredText: '', bodyText };
      // checkUrlLiveness's own plain bodyText read.
      return bodyText;
    },
  };
}

test('fetchOne: a live page with a short body is reported ok (not re-gated to error)', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const finalUrl = 'https://careers.example.com/stellenangebote--werkstudent-inline.html';
    const shortBody = 'Ich bin interessiert. Schnelle Bewerbung. Werkstudent Generative AI.'; // well under 300 chars
    const page = fakeActivePage({ bodyText: shortBody, applyControls: ['Ich bin interessiert'], finalUrl });
    const entry = { key: 'k1', url: finalUrl, company: 'Atruvia AG', title: 'Werkstudent', location: 'Karlsruhe' };

    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
    });

    assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(result.liveness, 'apply_control_visible');
    assert.ok(result.chars > 0);
    assert.ok(result.text.includes('Ich bin interessiert'));
  } finally {
    restoreDns();
  }
});

test('fetchOne: a dead third-party subresource does not turn an active page into error', async () => {
  const restoreDns = setHostResolver(async (hostname) => {
    if (hostname === 'dead-analytics-vendor.invalid') return [];
    return ['93.184.216.34'];
  });
  try {
    const finalUrl = 'https://careers.example.com/jobs/1';
    const main = {};
    let routeCb = null;
    let abortCount = 0;
    let evalCall = 0;
    const page = {
      mainFrame: () => main,
      async route(_pattern, callback) { routeCb = callback; },
      async goto() {
        await routeCb({
          request: () => ({
            url: () => 'https://dead-analytics-vendor.invalid/widget.js',
            isNavigationRequest: () => false,
            frame: () => ({}),
          }),
          abort: async () => { abortCount += 1; },
          continue: async () => {},
        });
        return { status: () => 200 };
      },
      async waitForTimeout() {},
      url: () => finalUrl,
      async evaluate(fn) {
        evalCall += 1;
        const src = fn.toString();
        if (src.includes('querySelectorAll')) return ['Apply for this job'];
        const longBody = 'Senior Analyst. '.repeat(30); // long, real JD content
        if (src.includes('preferredText')) return { preferredText: '', bodyText: longBody };
        return longBody;
      },
    };
    const entry = { key: 'k2', url: finalUrl, company: 'Acme', title: 'Senior Analyst', location: 'Remote' };

    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
    });

    assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(abortCount, 1, 'the dead subresource must still be aborted by the egress guard');
  } finally {
    restoreDns();
  }
});

// ─── CLI argument validation ────────────────────────────────────────────────

test('fetch-jds.mjs: missing --file and --out exits non-zero with a message', () => {
  const r = runScript();
  assert.notEqual(r.status, 0, 'should exit non-zero when both --file and --out are missing');
  assert.match(r.all, /--file and --out are both required/i);
});

test('fetch-jds.mjs: missing --out exits non-zero with a message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-fetchjds-'));
  try {
    const batchPath = join(dir, 'batch.json');
    writeFileSync(batchPath, JSON.stringify([{ key: 'k', url: 'https://example.com/job/1' }]));
    const r = runScript('--file', batchPath);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /--file and --out are both required/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-jds.mjs: missing --file exits non-zero with a message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-fetchjds-'));
  try {
    const outPath = join(dir, 'out.json');
    const r = runScript('--out', outPath);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /--file and --out are both required/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-jds.mjs: --help exits 0 and prints usage', () => {
  const r = runScript('--help');
  assert.equal(r.status, 0);
  assert.match(r.all, /Usage:/i);
});

test('fetch-jds.mjs: rejects an unrecognized flag instead of falling back to defaults', () => {
  const r = runScript('--fyle', 'x', '--out', 'y');
  assert.equal(r.status, 1);
  assert.match(r.all, /unrecognized flag/i);
});

test('fetch-jds.mjs: --file requires a value', () => {
  const r = runScript('--file', '--out', 'y');
  assert.equal(r.status, 1);
  assert.match(r.all, /--file requires a value/i);
});

test('fetch-jds.mjs: unreadable --file exits non-zero with a message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-fetchjds-'));
  try {
    const outPath = join(dir, 'out.json');
    const missingPath = join(dir, 'does-not-exist.json');
    const r = runScript('--file', missingPath, '--out', outPath);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /could not read\/parse/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-jds.mjs: --file must contain a JSON array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-fetchjds-'));
  try {
    const batchPath = join(dir, 'batch.json');
    const outPath = join(dir, 'out.json');
    writeFileSync(batchPath, JSON.stringify({ not: 'an array' }));
    const r = runScript('--file', batchPath, '--out', outPath);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /must contain a JSON array/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
