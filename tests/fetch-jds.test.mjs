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

import { compactJdText, gateUrl, fetchOne, fetchPlainJd, germanHardStop, splitGatedResults, pickContainerText, htmlToText, MIN_OK_CHARS } from '../fetch-jds.mjs';
import { setHostResolver } from '../liveness-browser.mjs';

// Every fetchOne test below a URL is not itself exercising the API rung passes
// this stub so the (real, network-hitting) default `checkLivenessViaApi` is
// never reached — several of the fixture URLs (linkedin.com) ARE real ATS
// postings per liveness-api.mjs, so without this stub these tests would fire
// a live network request. `null` = inconclusive, matching "not an ATS URL" for
// every fixture that isn't specifically testing the API rung.
const apiInconclusive = async () => null;

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
    const result = await fetchOne(entry, { newPage, checkRobotsFn: stubCheckRobots, checkLivenessViaApiFn: apiInconclusive });
    assert.equal(result.status, 'robots-blocked');
    assert.equal(result.key, url);
    assert.equal(result.chars, 0);
    assert.equal(result.text, '');
  });
}

test('fetchOne: never calls newPage for an unsafe (private-host) URL', async () => {
  const newPage = () => { throw new Error('fetchOne must not create a page for an unsafe URL'); };
  const entry = { key: 'k1', url: 'http://169.254.169.254/latest/meta-data/', company: 'X', title: 'Y', location: 'Z' };
  const result = await fetchOne(entry, { newPage, checkLivenessViaApiFn: apiInconclusive });
  assert.equal(result.status, 'unsafe-url');
  assert.equal(result.chars, 0);
});

test('fetchOne: preserves key/company/title/location on every branch', async () => {
  const entry = { key: 'abc-key', url: 'https://www.linkedin.com/jobs/view/1', company: 'Acme', title: 'Working Student', location: 'Munich' };
  const stubCheckRobots = async () => ({ retry: false, code: 'disallowed', reason: 'no' });
  const result = await fetchOne(entry, { newPage: () => { throw new Error('nope'); }, checkRobotsFn: stubCheckRobots, checkLivenessViaApiFn: apiInconclusive });
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

test('fetchOne: a live page whose text is a stub (< MIN_OK_CHARS) is error/empty-text, not ok — the worker falls back', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const finalUrl = 'https://careers.example.com/stellenangebote--werkstudent-inline.html';
    const shortBody = 'Ich bin interessiert. Schnelle Bewerbung. Werkstudent Generative AI.'; // well under 300 chars
    const page = fakeActivePage({ bodyText: shortBody, applyControls: ['Ich bin interessiert'], finalUrl });
    const entry = { key: 'k1', url: finalUrl, company: 'Atruvia AG', title: 'Werkstudent', location: 'Karlsruhe' };

    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
    });

    // Live, but 70 chars of text is not a JD a triage worker can score from;
    // `ok` here made jobs.schaeffler.com stubs (25-27 chars) look triageable.
    assert.equal(result.status, 'error', `expected error, got ${JSON.stringify(result)}`);
    assert.equal(result.liveness, 'empty-text');
    assert.equal(result.chars, 0);
    assert.equal(result.text, '');
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
      checkLivenessViaApiFn: apiInconclusive,
    });

    assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(abortCount, 1, 'the dead subresource must still be aborted by the egress guard');
  } finally {
    restoreDns();
  }
});

// ─── htmlToText ─────────────────────────────────────────────────────────────
// This is what turns an ATS API's HTML description field (Greenhouse `content`,
// Workday `jobPostingInfo.jobDescription`, ...) into the plain text fetchOne
// runs through compactJdText.

test('htmlToText: empty/non-string input returns empty string', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

test('htmlToText: strips tags and decodes entities', () => {
  const html = '<p>We need someone who knows R&amp;D &mdash; C++ &amp; Go.</p>';
  const out = htmlToText(html);
  assert.ok(!/<[^>]+>/.test(out), `tags should be stripped: ${out}`);
  assert.ok(out.includes('R&D'), `named entity &amp; should decode: ${out}`);
  assert.ok(out.includes('—'), `&mdash; should decode to an em dash: ${out}`);
});

test('htmlToText: decodes numeric and hex entities', () => {
  assert.ok(htmlToText('Caf&#233;').includes('Café'));
  assert.ok(htmlToText('Caf&#xe9;').includes('Café'));
});

test('htmlToText: keeps line breaks at block-level elements', () => {
  const html = '<p>First paragraph.</p><p>Second paragraph.</p><ul><li>One</li><li>Two</li></ul>';
  const out = htmlToText(html);
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.includes('First paragraph.'), `lines: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('Second paragraph.'), `lines: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.includes('One')), `list item should survive on its own line: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.includes('Two')), `list item should survive on its own line: ${JSON.stringify(lines)}`);
});

test('htmlToText: <br> becomes a line break', () => {
  const out = htmlToText('Line one<br>Line two<br/>Line three');
  assert.equal(out.split('\n').map((l) => l.trim()).filter(Boolean).join('|'), 'Line one|Line two|Line three');
});

// ─── EXPIRED_CODE_STATUS: only a strong signal is reported `expired` ───────
// Regression coverage for the Workday false-negative in the bug report: a
// classifyLiveness `expired` result whose code is `insufficient_content` (body
// too short to judge — an ATS SPA that never rendered under headless
// Playwright) must NOT become `status: 'expired'` here, because
// modes/triage.md returns SKIP without ever fetching for `expired` — silently
// dropping a posting that may well still be live. Only a strong signal
// (HTTP 404/410, an explicit expired-text match, a listing-page redirect)
// earns `expired`; everything else falls back to `error` so triage retries.

function fakePage({ status = 200, bodyText = '', applyControls = [], finalUrl = 'https://careers.example.com/jobs/1' } = {}) {
  return {
    async goto() { return { status: () => status }; },
    async waitForTimeout() {},
    url() { return finalUrl; },
    async evaluate(fn) {
      const src = fn.toString();
      if (src.includes('querySelectorAll')) return applyControls;
      if (src.includes('preferredText')) return { preferredText: '', bodyText };
      return bodyText;
    },
  };
}

test('fetchOne: HTTP 404 (http_gone) maps to status expired — strong signal', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const page = fakePage({ status: 404, bodyText: 'Not Found' });
    const entry = { key: 'k', url: 'https://careers.example.com/jobs/1', company: 'Acme', title: 'Role', location: 'Remote' };
    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
    });
    assert.equal(result.status, 'expired');
    assert.equal(result.liveness, 'http_gone');
  } finally {
    restoreDns();
  }
});

test('fetchOne: thin/unrendered body (insufficient_content) maps to status error, NOT expired', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    // Short body, no apply control — exactly what an ATS SPA looks like when its
    // client-side app never mounts under a plain headless hit (the Workday case).
    const page = fakePage({ status: 200, bodyText: 'Loading', applyControls: [] });
    const entry = { key: 'k', url: 'https://careers.example.com/jobs/1', company: 'Acme', title: 'Role', location: 'Remote' };
    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
    });
    assert.equal(result.status, 'error', `insufficient_content must map to error, not expired — got ${JSON.stringify(result)}`);
    assert.equal(result.liveness, 'insufficient_content');
  } finally {
    restoreDns();
  }
});

// ─── robots-unconfirmed: 'permission unconfirmed' is not a refusal ────────

test('gateUrl: a "not_robots" (soft-200) robots.txt verdict maps to robots-unconfirmed, not robots-blocked', async () => {
  const result = await gateUrl('https://job-boards.greenhouse.io/acme/jobs/123', {
    checkRobotsFn: async () => ({ retry: false, code: 'not_robots', reason: 'robots.txt body is not a policy file (soft-200) — permission unconfirmed' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'robots-unconfirmed');
});

test('gateUrl: an "unreadable" robots.txt verdict also maps to robots-unconfirmed', async () => {
  const result = await gateUrl('https://example.com/jobs/1', {
    checkRobotsFn: async () => ({ retry: false, code: 'unreadable', reason: 'robots.txt returned HTTP 500 — permission unconfirmed' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'robots-unconfirmed');
});

test('gateUrl: "disallowed" still maps to robots-blocked (unchanged)', async () => {
  const result = await gateUrl('https://example.com/jobs/1', {
    checkRobotsFn: async () => ({ retry: false, code: 'disallowed', reason: 'robots.txt disallows this path' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'robots-blocked');
});

test('fetchOne: never calls newPage for a robots-unconfirmed URL either', async () => {
  const newPage = () => { throw new Error('fetchOne must not create a page for a robots-unconfirmed URL'); };
  const entry = { key: 'k', url: 'https://job-boards.greenhouse.io/acme/jobs/123', company: 'Acme', title: 'Role', location: 'Remote' };
  const result = await fetchOne(entry, {
    newPage,
    checkRobotsFn: async () => ({ retry: false, code: 'not_robots', reason: 'soft-200 — permission unconfirmed' }),
    checkLivenessViaApiFn: apiInconclusive,
  });
  assert.equal(result.status, 'robots-unconfirmed');
  assert.equal(result.chars, 0);
});

// ─── API-first rung: a confirmed ATS API verdict is used before any gate/browser ─

test('fetchOne: API confirms the posting live with description text → status ok, no browser opened', async () => {
  const fakeApi = async () => ({
    result: 'active',
    code: 'workday_api_ok',
    reason: 'ATS API returns the posting (live)',
    description: '<p>Senior Engineer role.</p><ul><li>Own the platform</li></ul><p>' + 'You will design, build and operate the data platform that every product team relies on. '.repeat(3) + '</p>',
  });
  const entry = { key: 'k', url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Role_R1', company: 'Acme', title: 'Senior Engineer', location: 'Toronto' };
  const result = await fetchOne(entry, {
    newPage: () => { throw new Error('fetchOne must not open a browser when the API already confirmed live text'); },
    checkRobotsFn: async () => { throw new Error('the API route is not subject to the job-page robots gate'); },
    checkLivenessViaApiFn: fakeApi,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.liveness, 'workday_api_ok');
  assert.ok(result.text.includes('Senior Engineer role.'), `text: ${result.text}`);
  assert.ok(result.text.includes('Own the platform'), `text: ${result.text}`);
  assert.ok(result.chars > 0);
});

test('fetchOne: an API description under MIN_OK_CHARS is not ok — it falls through to the browser rung, which can still rescue it', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const stubApi = async () => ({ result: 'active', code: 'workday_api_ok', reason: 'live', description: '<p>Senior Engineer role.</p>' });
    const page = fakePage({ status: 200, bodyText: 'Ich bin interessiert. '.repeat(20), applyControls: ['Ich bin interessiert'] });
    const entry = { key: 'k', url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Role_R1', company: 'Acme', title: 'Senior Engineer', location: 'Toronto' };
    const result = await fetchOne(entry, {
      newPage: async () => page,
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: stubApi,
    });
    assert.equal(result.status, 'ok');
    assert.notEqual(result.liveness, 'workday_api_ok', 'the 27-char API stub must not be the JD');
    assert.ok(result.chars >= MIN_OK_CHARS);
  } finally {
    restoreDns();
  }
});

test('fetchOne: the MIN_OK_CHARS boundary — 25 chars is error/empty-text, exactly MIN_OK_CHARS is ok', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const finalUrl = 'https://jobs.schaeffler.com/job/Herzogenaurach-Werkstudent/1';
    const run = async (bodyText) => fetchOne(
      { key: 'k', url: finalUrl, company: 'Schaeffler', title: 'Werkstudent', location: 'Herzogenaurach' },
      {
        newPage: async () => fakeActivePage({ bodyText, applyControls: ['Jetzt bewerben'], finalUrl }),
        checkRobotsFn: async () => ({ retry: true }),
        checkLivenessViaApiFn: apiInconclusive,
      },
    );
    assert.equal(MIN_OK_CHARS, 200);
    const stub = await run('Wir suchen Dich als Werkst');           // 26 chars, the Schaeffler shape
    assert.equal(stub.status, 'error');
    assert.equal(stub.liveness, 'empty-text');
    assert.equal(stub.text, '');
    const exact = await run('a'.repeat(MIN_OK_CHARS));
    assert.equal(exact.status, 'ok');
    assert.equal(exact.chars, MIN_OK_CHARS);
    const justUnder = await run('a'.repeat(MIN_OK_CHARS - 1));
    assert.equal(justUnder.status, 'error');
    assert.equal(justUnder.liveness, 'empty-text');
  } finally {
    restoreDns();
  }
});

test('fetchOne: API confirms the posting expired → status expired, no browser opened', async () => {
  const fakeApi = async () => ({ result: 'expired', code: 'workday_api_gone', reason: 'ATS API 404 — posting removed' });
  const entry = { key: 'k', url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Role_R1', company: 'Acme', title: 'Senior Engineer', location: 'Toronto' };
  const result = await fetchOne(entry, {
    newPage: () => { throw new Error('fetchOne must not open a browser when the API already confirmed expired'); },
    checkRobotsFn: async () => { throw new Error('the API route is not subject to the job-page robots gate'); },
    checkLivenessViaApiFn: fakeApi,
  });
  assert.equal(result.status, 'expired');
  assert.equal(result.liveness, 'workday_api_gone');
  assert.equal(result.chars, 0);
});

test('fetchOne: API result null (not an ATS URL / inconclusive) falls through to the gate + browser path', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const page = fakePage({ status: 200, bodyText: 'Ich bin interessiert. '.repeat(20), applyControls: ['Ich bin interessiert'] });
    let newPageCalled = false;
    const entry = { key: 'k', url: 'https://careers.example.com/jobs/1', company: 'Acme', title: 'Role', location: 'Remote' };
    const result = await fetchOne(entry, {
      newPage: async () => { newPageCalled = true; return page; },
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
    });
    assert.ok(newPageCalled, 'an inconclusive API result must fall through to the browser path');
    assert.equal(result.status, 'ok');
  } finally {
    restoreDns();
  }
});

test('fetchOne: API "active" with no description falls through to the gate + browser path', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    // finalUrl matches the requested URL's host so classifyLiveness's
    // redirected_off_posting check (job id missing from the final URL) never
    // fires here — this test is only about the description-less API branch.
    const finalUrl = 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Role_R1';
    const page = fakePage({ status: 200, bodyText: 'Ich bin interessiert. '.repeat(20), applyControls: ['Ich bin interessiert'], finalUrl });
    let newPageCalled = false;
    const entry = { key: 'k', url: finalUrl, company: 'Acme', title: 'Role', location: 'Remote' };
    const result = await fetchOne(entry, {
      newPage: async () => { newPageCalled = true; return page; },
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: async () => ({ result: 'active', code: 'workday_api_ok', reason: 'live' }), // no description
    });
    assert.ok(newPageCalled, 'active-with-no-description must fall through to the browser path');
    assert.equal(result.status, 'ok');
  } finally {
    restoreDns();
  }
});

test('fetchOne: API "uncertain" falls through to the gate + browser path', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const page = fakePage({ status: 200, bodyText: 'Ich bin interessiert. '.repeat(20), applyControls: ['Ich bin interessiert'] });
    let newPageCalled = false;
    const entry = { key: 'k', url: 'https://careers.example.com/jobs/1', company: 'Acme', title: 'Role', location: 'Remote' };
    const result = await fetchOne(entry, {
      newPage: async () => { newPageCalled = true; return page; },
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: async () => ({ result: 'uncertain', code: 'linkedin_signals_disagree', reason: 'unreadable' }),
    });
    assert.ok(newPageCalled, 'an uncertain API result must fall through to the browser path');
    assert.equal(result.status, 'ok');
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

// ─── plain-HTTP rung (StepStone) ───────────────────────────────────────────
//
// On 2026-09-22/23 every StepStone navigation but one ended in
// `navigation_error`, pushing a WebFetch retry into each triage worker, while a
// plain GET returned the full JD. The rung may only ever turn a would-be
// browser attempt into an early success — never an `expired` or `error` —
// so every non-success must fall through to the browser unchanged.

const STEPSTONE = 'https://www.stepstone.de/stellenangebote--Werkstudent-Analytics-wmd-Muenchen-ADAC--1-inline.html';
const JD_HTML = `<html><head><style>.x{color:red}</style><script>window.__STATE__={"a":1};function f(){}</script></head>
<body><h1>Werkstudent Analytics Engineer (w/m/d)</h1>
<h2>Deine Aufgaben</h2><ul>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<li>Aufgabe ${n}: Du baust Datenpipeline Nummer ${n} in Python und SQL und stimmst sie mit dem Analytics-Team ab.</li>`).join('')}</ul>
<h2>Dein Profil</h2><ul>${[1, 2, 3, 4, 5, 6].map((n) => `<li>Anforderung ${n}: Studium der Informatik oder Data Science, Erfahrung mit Werkzeug ${n}, sehr gute Englischkenntnisse.</li>`).join('')}</ul>
<h2>Wir bieten</h2><p>Flexible Arbeitszeiten und mobiles Arbeiten.</p></body></html>`;

test('fetchPlainJd: a host outside PLAIN_HTTP_HOSTS is never requested', async () => {
  let called = false;
  const r = await fetchPlainJd('https://careers.example.com/job/1', { fetchTextFn: async () => { called = true; return JD_HTML; } });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('fetchPlainJd: a StepStone JD page comes back ok, with script and style bodies stripped', async () => {
  const r = await fetchPlainJd(STEPSTONE, { fetchTextFn: async () => JD_HTML });
  assert.equal(r?.status, 'ok');
  assert.equal(r.liveness, 'plain_http');
  assert.match(r.text, /Deine Aufgaben/);
  assert.doesNotMatch(r.text, /__STATE__|function f|color:red/);
});

test('fetchPlainJd: any request failure is not interpreted — a 403 falls through as null', async () => {
  const r = await fetchPlainJd(STEPSTONE, { fetchTextFn: async () => { const e = new Error('HTTP 403 Forbidden'); e.status = 403; throw e; } });
  assert.equal(r, null);
});

test('fetchPlainJd: a 200 with no JD section words (a consent wall) falls through as null', async () => {
  const wall = `<html><body>${'<p>Wir verwenden Cookies, um Ihnen das beste Erlebnis zu bieten. Bitte stimmen Sie zu.</p>'.repeat(20)}</body></html>`;
  assert.equal(await fetchPlainJd(STEPSTONE, { fetchTextFn: async () => wall }), null);
});

test('fetchPlainJd: a short fragment is left to the browser path', async () => {
  const fragment = '<html><body><h1>Werkstudent</h1><p>Deine Aufgaben: kurz.</p></body></html>';
  assert.equal(await fetchPlainJd(STEPSTONE, { fetchTextFn: async () => fragment }), null);
});

test('fetchOne: a readable StepStone page is served over plain HTTP without opening the browser', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    const result = await fetchOne({ key: 's1', url: STEPSTONE, company: 'ADAC', title: 'Werkstudent' }, {
      newPage: async () => { throw new Error('the browser must not open when plain HTTP already has the JD'); },
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
      fetchTextFn: async () => JD_HTML,
      isHostBlockedFn: () => null,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.liveness, 'plain_http');
    assert.equal(result.key, 's1');
  } finally {
    restoreDns();
  }
});

test('fetchOne: robots.txt still decides first — a disallowed StepStone URL is never requested', async () => {
  let requested = false;
  const result = await fetchOne({ key: 's2', url: STEPSTONE }, {
    newPage: () => { throw new Error('nope'); },
    checkRobotsFn: async () => ({ retry: false, code: 'disallowed', reason: 'no' }),
    checkLivenessViaApiFn: apiInconclusive,
    fetchTextFn: async () => { requested = true; return JD_HTML; },
  });
  assert.equal(requested, false);
  assert.notEqual(result.status, 'ok');
});

test('fetchOne: when the plain rung finds nothing, the browser path runs exactly as before', async () => {
  const restoreDns = setHostResolver(async () => ['93.184.216.34']);
  try {
    let opened = false;
    await fetchOne({ key: 's3', url: STEPSTONE }, {
      newPage: async () => { opened = true; throw new Error('stop here — reaching newPage is the assertion'); },
      checkRobotsFn: async () => ({ retry: true }),
      checkLivenessViaApiFn: apiInconclusive,
      fetchTextFn: async () => { const e = new Error('HTTP 403'); e.status = 403; throw e; },
      isHostBlockedFn: () => null,
    });
    assert.equal(opened, true);
  } finally {
    restoreDns();
  }
});

// ─── circuit breaker (lib/host-circuit.mjs) ────────────────────────────────
//
// A host the breaker has tripped (StepStone/Indeed after a 403, see
// lib/host-circuit.mjs) must receive NO request at all — not the robots.txt
// read gateUrl would otherwise make, not the plain-HTTP rung, not the
// browser. isHostBlockedFn is injected so this is provable with no real
// data/host-blocks.json state.

test('fetchOne: a circuit-broken host is never requested — no robots.txt read, no plain HTTP, no browser', async () => {
  let robotsCalled = false;
  let plainCalled = false;
  const blocked = { host: 'stepstone.de', until: '2026-10-07T00:00:00.000Z', reason: 'HTTP 403' };
  const result = await fetchOne({ key: 's4', url: STEPSTONE, company: 'ADAC', title: 'Werkstudent' }, {
    newPage: () => { throw new Error('a circuit-broken host must never open the browser'); },
    checkRobotsFn: async () => { robotsCalled = true; return { retry: true }; },
    checkLivenessViaApiFn: apiInconclusive,
    fetchTextFn: async () => { plainCalled = true; return JD_HTML; },
    isHostBlockedFn: (host) => (host === 'www.stepstone.de' ? blocked : null),
  });
  assert.equal(robotsCalled, false, 'robots.txt must not be read for a circuit-broken host');
  assert.equal(plainCalled, false, 'the plain-HTTP rung must not run for a circuit-broken host');
  assert.equal(result.status, 'host-blocked');
  assert.equal(result.chars, 0);
  assert.equal(result.text, '');
  assert.match(result.liveness, /circuit_breaker/);
  assert.match(result.liveness, /2026-10-07/);
  assert.equal(result.key, 's4');
});

test('fetchOne: a host with no recorded block proceeds normally', async () => {
  const result = await fetchOne({ key: 's5', url: STEPSTONE }, {
    newPage: () => { throw new Error('nope'); },
    checkRobotsFn: async () => ({ retry: true }),
    checkLivenessViaApiFn: apiInconclusive,
    fetchTextFn: async () => JD_HTML,
    isHostBlockedFn: () => null,
  });
  assert.equal(result.status, 'ok');
});

test('splitGatedResults: host-blocked gates to a SKIP line, same as robots-blocked/unsafe-url', () => {
  const { gatedLines, rest, counts } = splitGatedResults([
    { key: 'k1', company: 'ADAC', title: 'Werkstudent', status: 'host-blocked' },
  ]);
  assert.equal(rest.length, 0);
  assert.equal(counts.notFetchable, 1);
  assert.match(gatedLines[0], /^k1\tTRIAGE: SKIP \| ADAC \| Werkstudent \| 0\/5 \| Not fetchable/);
});

// ─── zero-token German gate + deterministic verdicts ───────────────────────
//
// On 2026-09-23 triage passed a Siemens role at 4.3 that the full evaluation
// then SKIPped on "Sehr gute Deutsch- und Englischkenntnisse" — ~196k tokens to
// find a phrase in the pre-fetched text. The gate is validated against 137
// labelled postings (fires on 20; catches 12/13 German-language FAILs; the only
// PASSes it fires on are the two genuine hard stops triage let through).

test('germanHardStop: the hard-stop phrasings fire, verbatim', () => {
  for (const line of [
    'Sehr gute Deutsch- und Englischkenntnisse runden Dein Profil ab.',
    'Du verfügst über sehr gute Deutschkenntnisse in Wort und Schrift (C1)',
    'Verhandlungssichere Deutschkenntnisse',
    'Fließende Deutsch- und Englischkenntnisse',
    'Deutschkenntnisse auf dem Niveau C1 oder besser',
    'Languages: You speak English and German fluently',
    'Fluent German is required',
  ]) {
    assert.equal(germanHardStop(`Werkstudent Data\n${line}\nWir bieten Obstkorb.`), line, line);
  }
});

test('germanHardStop: preferences, alternatives and the country name never fire', () => {
  for (const line of [
    'Gute Deutschkenntnisse',                                   // not a hard stop under the profile
    'Sehr gute Deutsch- oder Englischkenntnisse',               // English alone qualifies
    'Sehr gute Englischkenntnisse, Deutschkenntnisse von Vorteil',
    'Fluent German is a plus',
    'German or English at C1 level',
    'Englisch C1, Deutsch wünschenswert',
    'Standort: Deutschland, Remote C1-Gebäude',                 // "Deutschland" is not the language
    'Sehr gute Kenntnisse in Python und SQL',
  ]) {
    assert.equal(germanHardStop(line), null, line);
  }
});

// Found on the 2026-09-29 pass: real fluent-tier lines the first version let
// through. Root causes — (1) the hedge veto looked at the whole line, so a
// "wünschenswert" attached to ENGLISH cancelled a hard German requirement;
// (2) the sentence splitter cut "mind. C1" in half and the C1 gap refused the
// dot; (3) JS w is ASCII-only, so "Kommunikationsfähigkeiten" broke every
// word-run pattern; (4) no pattern for adjective+skills+"auf Deutsch", the
// "fehlerfrei"/"Muttersprache" family, or "excellent English and German".
test('germanHardStop: 2026-09-29 misses now fire, verbatim', () => {
  for (const line of [
    'Verhandlungssichere Deutschkenntnisse in Wort und Schrift, gute Englischkenntnisse wünschenswert',
    'Strukturierte Arbeitsweise und ausgeprägte Kommunikationsfähigkeit auf Deutsch (mind. C1)',
    'Sehr gute Kommunikationsfähigkeiten in Wort und Schrift auf Deutsch',
    'Du sprichst und schreibst die deutsche Sprache fehlerfrei, um gekonnt mit unterschiedlichen Zielgruppen zu kommunizieren',
    'Languages: You have excellent English and German skills for effective communication in our international team',
    '- Sprachkenntnisse: Exzellente Kommunikationsfähigkeiten in Deutsch (fließend/Muttersprache) sowie gute Englischkenntnisse in Wort und Schrift.',
    'Professional proficiency in German is required, alongside English',
  ]) {
    assert.equal(germanHardStop(`Werkstudent Data
${line}
Wir bieten Obstkorb.`), line, line);
  }
});

test('germanHardStop: sibling phrasings (CEFR, native, perfect, excellent) fire', () => {
  for (const line of [
    'Deutsch auf C1-Niveau',
    'Deutsch (C1)',
    'German (C1)',
    'German at C1 level',
    'German language skills at C1 level',
    'Excellent German',
    'Perfect German',
    'Native German',
    'Native German speaker',
    'Deutsch auf Muttersprachniveau',
    'Deutsch als Muttersprache',
    'Einwandfreie Deutschkenntnisse in Wort und Schrift',
    'Perfekte Deutschkenntnisse',
    'Sehr gutes Deutsch',
    'Exzellente Deutschkenntnisse',
    'Ausgezeichnete Kenntnisse in Deutsch und Englisch',
    'Deutschkenntnisse (mind. C1)',
    'Sehr gute mündliche und schriftliche Kommunikationsfähigkeiten in Deutsch und Englisch',
    'Excellent written and spoken German',
    'Business-level German and English',
    'Muttersprache Deutsch oder vergleichbar',
  ]) {
    assert.equal(germanHardStop(line), line, line);
  }
});

test('germanHardStop: a hedge on ANOTHER language does not veto the German requirement, one on the German still does', () => {
  // hedge belongs to Englisch → German stays a hard stop
  assert.ok(germanHardStop('Verhandlungssichere Deutschkenntnisse, Englischkenntnisse wünschenswert'));
  assert.ok(germanHardStop('Fließend Deutsch (C1); Französisch von Vorteil'));
  assert.ok(germanHardStop('Verhandlungssicheres Deutsch, Erfahrung mit SAP wünschenswert'));
  // hedge belongs to Deutsch → preference
  assert.equal(germanHardStop('Sehr gute Englischkenntnisse, Deutschkenntnisse von Vorteil'), null);
  assert.equal(germanHardStop('Englisch C1, Deutsch wünschenswert'), null);
  assert.equal(germanHardStop('Verhandlungssichere Deutsch- und Englischkenntnisse von Vorteil'), null);
  assert.equal(germanHardStop('Von Vorteil: Deutsch (C1)'), null);
  assert.equal(germanHardStop('Deutsch C1, ein Plus'), null);
  assert.equal(germanHardStop('Excellent English and preferably German'), null);
});

test('germanHardStop: 2026-09-29 sibling negatives never fire', () => {
  for (const line of [
    'Gute Deutschkenntnisse',
    'Gute Deutschkenntnisse in Wort und Schrift',
    'Deutschkenntnisse von Vorteil',
    'Deutschkenntnisse wünschenswert',
    'Deutschkenntnisse sind ein Plus',
    'German is a plus',
    'German is a nice to have',
    'English or German',
    'Deutsch oder Englisch',
    'Deutsch oder Englisch auf C1-Niveau',
    'Sehr gute Deutsch- ODER Englischkenntnisse',
    'Fluent English; German is nice to have',
    'Fluent English, German is a plus',
    'Arbeitsort: Deutschland',
    'Location: Germany, hybrid',
    'Standort Nürnberg, Deutschland',
    'Deutsche Bahn AG',
    'Wir sind Teil der Deutschen Bahn und suchen Talente mit fließend Englisch',
    'Deutsche Telekom, Englisch C1',
    'Deutsche Bank: ausgezeichnete Kenntnisse in Python',
    'Deutsch B2, Englisch C1',
    'German B2, English C1',
    'Sehr gute Kenntnisse in Python und SQL',
    'Sehr gute Kommunikationsfähigkeiten und Teamgeist',
    'Ausgezeichnete Kenntnisse in Python und SQL',
    'Excellent English and German-speaking customers',
    'Excellent communication skills and a full German-language onboarding',
    'Confirmed live via browser (full German JD + Apply Now control)',
    'Perfect fit for a German student visa holder',
    'Studiengang: Informatik (mind. 3. Semester). Deutsch ist die Teamsprache.',
  ]) {
    assert.equal(germanHardStop(line), null, line);
  }
});

test('splitGatedResults: deterministic verdicts are gated, everything else goes to the worker', () => {
  const results = [
    { key: 'a', company: 'Siemens', title: 'Werkstudent KI', status: 'ok', text: 'Aufgaben\nSehr gute Deutsch- und Englischkenntnisse runden Dein Profil ab.' },
    { key: 'b', company: 'Acme', title: 'Werkstudent', status: 'expired', text: '' },
    { key: 'c', company: 'Indeed row', title: 'Data', status: 'robots-blocked', text: '' },
    { key: 'd', company: 'X', title: 'Y', status: 'unsafe-url', text: '' },
    { key: 'e', company: 'Datev', title: 'Werkstudent BI', status: 'ok', text: 'Deutschkenntnisse von Vorteil, Englisch fließend.' },
    { key: 'f', company: 'Z', title: 'W', status: 'robots-unconfirmed', text: '' },   // worker may still WebFetch
    { key: 'g', company: 'Z', title: 'W', status: 'blocked', text: '' },              // worker may still WebFetch
    { key: 'h', company: 'Z', title: 'W', status: 'error', text: '' },
  ];
  const { gatedLines, rest, counts } = splitGatedResults(results);
  assert.deepEqual(counts, { german: 1, expired: 1, notFetchable: 2 });
  assert.deepEqual(rest.map((r) => r.key), ['e', 'f', 'g', 'h']);
  assert.match(gatedLines[0], /^a\tTRIAGE: FAIL \| Siemens \| Werkstudent KI \| 2\.0\/5 \| Hard DQ \(zero-token gate\): German requirement "Sehr gute Deutsch-/);
});

test('splitGatedResults: every gated line parses with the real loop parser, even with pipes in a cell', async () => {
  const { parseTriageLine } = await import('../loop-core.mjs');
  const { gatedLines } = splitGatedResults([
    { key: 'k1', company: 'Acme | Holding', title: 'Data | AI\tWerkstudent', status: 'ok', text: 'Fließende Deutschkenntnisse erforderlich.' },
    { key: 'k2', company: '', title: '', status: 'expired', text: '' },
    { key: 'k3', company: 'B', title: 'C', status: 'robots-blocked', text: '' },
  ]);
  const want = [['FAIL', 2], ['SKIP', 0], ['SKIP', 0]];
  gatedLines.forEach((line, i) => {
    const [key, rest] = line.split('\t');
    assert.equal(key, `k${i + 1}`);
    const parsed = parseTriageLine(rest);
    assert.ok(parsed, `the loop parser dropped: ${line}`);
    assert.equal(parsed.verdict, want[i][0]);
    assert.equal(parsed.score, want[i][1]);
  });
  assert.equal(parseTriageLine(gatedLines[0].split('\t')[1]).company, 'Acme Holding');
});
