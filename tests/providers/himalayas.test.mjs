// tests/providers/himalayas.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — himalayas');

try {
  const himalayasModule = await import(pathToFileURL(join(ROOT, 'providers/himalayas.mjs')).href);
  const himalayas = himalayasModule.default;
  const { parseHimalayasResponse } = himalayasModule;

  if (himalayas.id === 'himalayas') pass('himalayas.id is "himalayas"');
  else fail(`himalayas.id is ${JSON.stringify(himalayas.id)}`);

  const hit = himalayas.detect({ name: 'Himalayas', provider: 'himalayas' });
  if (hit && hit.url === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.detect() claims explicit provider config');
  } else {
    fail(`himalayas.detect() returned ${JSON.stringify(hit)}`);
  }

  if (himalayas.detect({ name: 'Remote Board', provider: 'remotive' }) === null) {
    pass('himalayas.detect() ignores other provider ids');
  } else {
    fail('himalayas.detect() should only claim provider: himalayas');
  }

  const sample = {
    jobs: [
      {
        title: '  Staff AI Engineer  ',
        companyName: ' Acme Labs ',
        companySlug: 'acme-labs',
        locationRestrictions: ['Worldwide', 'Europe'],
        pubDate: 1782538666,
        applicationLink: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer',
        guid: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer-guid',
      },
      {
        title: 'Product Manager',
        companyName: 'Fallback Co',
        companySlug: 'fallback-co',
        locationRestrictions: [],
        pubDate: '2026-01-02T09:00:00Z',
        applicationLink: '',
        guid: 'https://himalayas.app/companies/fallback-co/jobs/product-manager',
      },
      {
        title: 'Missing Link Role',
        companyName: 'Dropped Co',
        locationRestrictions: ['United States'],
      },
      {
        title: 'Off Host Role',
        companyName: 'Bad Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://example.com/companies/bad/jobs/off-host',
      },
      {
        title: 'HTTP Role',
        companyName: 'Bad Scheme Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'http://himalayas.app/companies/bad/jobs/http-role',
      },
      {
        title: '   ',
        companyName: 'Blank Title Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://himalayas.app/companies/blank/jobs/blank-title',
      },
    ],
  };
  const jobs = parseHimalayasResponse(sample);

  if (jobs.length === 2) pass('parseHimalayasResponse keeps 2 jobs (drops missing/off-host/http/blank-title rows)');
  else fail(`parseHimalayasResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.title === 'Staff AI Engineer' && jobs[0]?.company === 'Acme Labs') {
    pass('parseHimalayasResponse trims title and companyName');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.location === 'Worldwide, Europe') {
    pass('parseHimalayasResponse joins locationRestrictions');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.url === 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer') {
    pass('parseHimalayasResponse maps applicationLink to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.postedAt === 1782538666 * 1000) {
    pass('parseHimalayasResponse converts epoch seconds pubDate -> postedAt ms');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.url === 'https://himalayas.app/companies/fallback-co/jobs/product-manager') {
    pass('parseHimalayasResponse falls back to guid when applicationLink is missing');
  } else {
    fail(`row 1 url = ${JSON.stringify(jobs[1]?.url)}`);
  }

  if (jobs[1]?.postedAt === Date.parse('2026-01-02T09:00:00Z')) {
    pass('parseHimalayasResponse parses string pubDate -> postedAt');
  } else {
    fail(`row 1 postedAt = ${JSON.stringify(jobs[1]?.postedAt)}`);
  }

  if (parseHimalayasResponse({}).length === 0 && parseHimalayasResponse(null).length === 0) {
    pass('parseHimalayasResponse empty / non-object payload -> empty result (no crash)');
  } else {
    fail('parseHimalayasResponse invalid payload should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.fetch() requests the pinned API URL');
  } else {
    fail(`himalayas.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('himalayas.fetch() passes redirect:"error" to fetchJson');
  } else {
    fail(`himalayas.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme Labs' && fetched[0]?.title === 'Staff AI Engineer') {
    pass('provider: himalayas config returns normalized jobs');
  } else {
    fail(`himalayas.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }

  // ── Cursor pagination (#himalayas-pagination) ─────────────────────────────
  // Live probe (2026-09-01) confirmed: `?limit=50` is ignored (the API always
  // serves 20/page); the response carries `nextCursor`, passed back as
  // `?cursor=`; exhaustion is `jobs: []` with no `nextCursor` key at all. See
  // the header comment in providers/himalayas.mjs for the full write-up.

  const CURSOR_1 = 'cursor-page-2';
  const page1 = {
    totalCount: 3,
    nextCursor: CURSOR_1,
    jobs: [
      { title: 'Job A', companyName: 'Co A', applicationLink: 'https://himalayas.app/companies/a/jobs/a', locationRestrictions: ['Remote'] },
      { title: 'Job B', companyName: 'Co B', applicationLink: 'https://himalayas.app/companies/b/jobs/b', locationRestrictions: ['Remote'] },
    ],
  };
  const page2 = {
    totalCount: 3,
    // No nextCursor key at all — this is the exhaustion signal, not "" or null.
    jobs: [
      { title: 'Job C', companyName: 'Co C', applicationLink: 'https://himalayas.app/companies/c/jobs/c', locationRestrictions: ['Remote'] },
    ],
  };
  const fetchJsonSequence = async (url) => {
    const cursor = new URL(url).searchParams.get('cursor');
    if (!cursor) return page1;
    if (cursor === CURSOR_1) return page2;
    throw new Error(`unexpected cursor in test: ${cursor}`);
  };

  const pageCalls = [];
  const jobsAcrossPages = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    { fetchJson: async (url) => { pageCalls.push(url); return fetchJsonSequence(url); }, sleep: async () => {} },
  );

  if (pageCalls.length === 2) pass('himalayas.fetch() follows the cursor across exactly 2 pages to exhaustion');
  else fail(`himalayas.fetch() made ${pageCalls.length} requests (expected 2): ${JSON.stringify(pageCalls)}`);

  if (pageCalls[0] === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.fetch() requests page 1 without a cursor param');
  } else {
    fail(`page 1 url = ${JSON.stringify(pageCalls[0])}`);
  }

  if (pageCalls[1] === `https://himalayas.app/jobs/api?limit=50&cursor=${CURSOR_1}`) {
    pass('himalayas.fetch() passes the prior nextCursor back as ?cursor=');
  } else {
    fail(`page 2 url = ${JSON.stringify(pageCalls[1])}`);
  }

  if (jobsAcrossPages.length === 3 && jobsAcrossPages.map(j => j.title).join(',') === 'Job A,Job B,Job C') {
    pass('himalayas.fetch() concatenates jobs across pages in order');
  } else {
    fail(`fetch() across pages returned ${JSON.stringify(jobsAcrossPages.map(j => j.title))}`);
  }

  // max_pages bound: stop at 1 page even though page 1 carries a nextCursor.
  const cappedCalls = [];
  const cappedJobs = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas', max_pages: 1 },
    { fetchJson: async (url) => { cappedCalls.push(url); return page1; }, sleep: async () => {} },
  );
  if (cappedCalls.length === 1 && cappedJobs.length === 2) {
    pass('himalayas.fetch() honors max_pages and stops even when more pages remain');
  } else {
    fail(`max_pages=1 -> ${cappedCalls.length} calls, ${cappedJobs.length} jobs`);
  }

  // max_jobs bound: page 1 alone already meets the cap, so page 2 is never fetched.
  const maxJobsCalls = [];
  const maxJobsJobs = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas', max_jobs: 1 },
    { fetchJson: async (url) => { maxJobsCalls.push(url); return page1; }, sleep: async () => {} },
  );
  if (maxJobsJobs.length === 1 && maxJobsJobs[0]?.title === 'Job A') {
    pass('himalayas.fetch() honors max_jobs and trims the result');
  } else {
    fail(`max_jobs=1 -> ${JSON.stringify(maxJobsJobs.map(j => j.title))}`);
  }
  if (maxJobsCalls.length === 1) {
    pass('himalayas.fetch() stops fetching further pages once max_jobs is reached');
  } else {
    fail(`max_jobs=1 made ${maxJobsCalls.length} calls (expected 1)`);
  }

  // Truncation logging only fires when the walk is cut short while more data
  // remained (max_pages/max_jobs), never on natural cursor exhaustion.
  const originalConsoleError = console.error;
  let truncatedLogCount = 0;
  console.error = () => { truncatedLogCount++; };
  try {
    await himalayas.fetch(
      { name: 'Himalayas', provider: 'himalayas', max_pages: 1 },
      { fetchJson: async () => page1, sleep: async () => {} },
    );
  } finally {
    console.error = originalConsoleError;
  }
  if (truncatedLogCount === 1) pass('himalayas.fetch() logs a truncation warning when max_pages cuts off more data');
  else fail(`expected 1 truncation warning, got ${truncatedLogCount}`);

  const originalConsoleError2 = console.error;
  let exhaustedLogCount = 0;
  console.error = () => { exhaustedLogCount++; };
  try {
    await himalayas.fetch(
      { name: 'Himalayas', provider: 'himalayas' },
      { fetchJson: fetchJsonSequence, sleep: async () => {} },
    );
  } finally {
    console.error = originalConsoleError2;
  }
  if (exhaustedLogCount === 0) pass('himalayas.fetch() does not warn when the cursor exhausts naturally');
  else fail(`expected 0 truncation warnings on natural exhaustion, got ${exhaustedLogCount}`);

  // A malformed page mid-walk still throws, naming the offending page.
  let threwOnPage2 = false;
  try {
    await himalayas.fetch(
      { name: 'Himalayas', provider: 'himalayas' },
      {
        fetchJson: async (url) => (new URL(url).searchParams.get('cursor') ? { nope: true } : page1),
        sleep: async () => {},
      },
    );
  } catch (e) {
    threwOnPage2 = /page 2/.test(e.message);
  }
  if (threwOnPage2) pass('himalayas.fetch() throws naming the page when a later page is malformed');
  else fail('himalayas.fetch() should throw on a malformed non-first page');

  // ── ctx.sinceMs stops the walk at the window ───────────────────────
  // The feed is pubDate-descending, so once an entire page falls outside the
  // caller's window every later page does too. Without this the walk is bound
  // only by the page cap: at 100 pages it outran a real portal scan's timeout
  // and the board returned nothing at all, which is a worse failure than the
  // 20-posting cap the pagination was added to fix.
  const DAY = 86_400_000;
  const now = Date.now();
  const recent = { jobs: [{ title: 'Recent', applicationLink: 'https://himalayas.app/jobs/a', companyName: 'A', pubDate: Math.floor((now - DAY) / 1000) }], nextCursor: 'c1', totalCount: 2 };
  const old = { jobs: [{ title: 'Old', applicationLink: 'https://himalayas.app/jobs/b', companyName: 'B', pubDate: Math.floor((now - 400 * DAY) / 1000) }], nextCursor: 'c2', totalCount: 2 };

  let windowCalls = 0;
  const windowed = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    {
      sinceMs: now - 30 * DAY,
      sleep: async () => {},
      fetchJson: async () => { windowCalls++; return windowCalls === 1 ? recent : old; },
    },
  );
  if (windowCalls === 2 && windowed.length === 2) {
    pass('himalayas.fetch() stops paging once a whole page falls outside ctx.sinceMs');
  } else {
    fail(`sinceMs early-stop wrong: ${windowCalls} pages, ${windowed.length} jobs`);
  }

  // An undated page proves nothing about where the walk is in the timeline, so
  // it must not be read as "past the window" — that would silently truncate a
  // board whose postings simply carry no date.
  const undated = { jobs: [{ title: 'No date', applicationLink: 'https://himalayas.app/jobs/c', companyName: 'C' }], nextCursor: 'c2', totalCount: 3 };
  let undatedCalls = 0;
  await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas', max_pages: 3 },
    {
      sinceMs: now - 30 * DAY,
      sleep: async () => {},
      fetchJson: async () => { undatedCalls++; return undatedCalls === 1 ? recent : undated; },
    },
  );
  if (undatedCalls === 3) pass('himalayas.fetch() does not treat an undated page as past the window');
  else fail(`undated page stopped the walk early: ${undatedCalls} page(s)`);
} catch (e) {
  fail(`himalayas provider tests crashed: ${e.message}`);
}
