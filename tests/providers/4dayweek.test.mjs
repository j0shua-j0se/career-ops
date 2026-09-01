// tests/providers/4dayweek.test.mjs — renamed from fourdayweek.test.mjs to match
// the provider id, so `--only providers/4dayweek` discovers it (#1657).
//
// Rewritten for the v2 API move (robots.txt disallows /api/jobs and
// /api/v1/jobs 404s live — only /api/v2/jobs is both allowed and working,
// verified 2026-09-01). v2 returns { data, page, limit, total, has_more }
// with RFC3339 `posted_at` and a ready-made absolute `url` per job.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — 4dayweek');

try {
  const fdwModule = await import(pathToFileURL(join(ROOT, 'providers/4dayweek.mjs')).href);
  const { resolveProvider } = await import(pathToFileURL(join(ROOT, 'providers/_registry.mjs')).href);
  const fourdayweek = fdwModule.default;
  const { normalize4dwJob, resolvePostedAfterDays } = fdwModule;

  if (fourdayweek.id === '4dayweek') pass('4dayweek.id is "4dayweek"');
  else fail(`4dayweek.id is ${JSON.stringify(fourdayweek.id)}`);

  const explicitHit = fourdayweek.detect({ name: '4 Day Week', provider: '4dayweek' });
  if (explicitHit?.url === 'https://4dayweek.io/api/v2/jobs') {
    pass('4dayweek.detect() claims explicit provider config, pointed at the v2 endpoint');
  } else {
    fail(`4dayweek.detect() explicit provider = ${JSON.stringify(explicitHit)}`);
  }

  const careersHit = fourdayweek.detect({ name: '4 Day Week', careers_url: 'https://4dayweek.io/jobs' });
  const apiHit = fourdayweek.detect({ name: '4 Day Week', api: 'https://4dayweek.io/api/jobs' });
  if (careersHit?.url === 'https://4dayweek.io/api/v2/jobs' && apiHit?.url === 'https://4dayweek.io/api/v2/jobs') {
    pass('4dayweek.detect() maps trusted 4dayweek.io URLs to the v2 jobs endpoint');
  } else {
    fail(`4dayweek.detect() trusted URLs = ${JSON.stringify({ careersHit, apiHit })}`);
  }

  const detectMisses = [
    fourdayweek.detect({ name: 'X' }),
    fourdayweek.detect({ name: 'Other', provider: 'echojobs', careers_url: 'https://4dayweek.io/jobs' }),
    fourdayweek.detect({ name: 'Path spoof', careers_url: 'https://evil.example/4dayweek.io/jobs' }),
    fourdayweek.detect({ name: 'Suffix spoof', careers_url: 'https://4dayweek.io.evil.example/jobs' }),
    fourdayweek.detect({ name: 'HTTP', careers_url: 'http://4dayweek.io/jobs' }),
    fourdayweek.detect({ name: 'Non-string', careers_url: 42 }),
  ];
  if (detectMisses.every(hit => hit === null)) {
    pass('4dayweek.detect() rejects missing, other-provider, spoofed, http, and non-string URLs');
  } else {
    fail(`4dayweek.detect() misses = ${JSON.stringify(detectMisses)}`);
  }

  const resolved = resolveProvider(
    { name: '4 Day Week', careers_url: 'https://4dayweek.io/jobs' },
    new Map([['4dayweek', fourdayweek]]),
  );
  if (resolved && 'provider' in resolved && resolved.provider === fourdayweek) {
    pass('provider registry dispatches 4dayweek.detect() for trusted 4dayweek.io URLs');
  } else {
    fail(`provider registry did not dispatch 4dayweek.detect(): ${JSON.stringify(resolved)}`);
  }

  // normalize4dwJob — full mapping, using the API's own absolute `url`.
  const full = normalize4dwJob(
    {
      title: '  Financial Controller  ',
      slug: 'financial-controller-at-panzerglass-45369c18',
      url: 'https://4dayweek.io/job/financial-controller-at-panzerglass-45369c18',
      company: { name: '  PanzerGlass  ' },
      locations: [{ city: 'Hinnerup', country: 'Denmark', is_primary: true }],
      work_arrangement: 'onsite',
      posted_at: '2026-06-29T08:19:35Z',
    },
    'Fallback',
  );
  if (full && full.title === 'Financial Controller'
      && full.url === 'https://4dayweek.io/job/financial-controller-at-panzerglass-45369c18'
      && full.company === 'PanzerGlass' && full.location === 'Hinnerup, Denmark'
      && full.postedAt === Date.parse('2026-06-29T08:19:35Z')) {
    pass('normalize4dwJob maps title, uses the API url, company.name, location, posted_at (RFC3339)→ms');
  } else {
    fail(`normalize4dwJob full row = ${JSON.stringify(full)}`);
  }

  // url fallback: built from slug when the API `url` field is missing.
  const builtUrl = normalize4dwJob({ title: 'No URL field', slug: 'no-url-field-1' });
  if (builtUrl?.url === 'https://4dayweek.io/job/no-url-field-1') {
    pass('normalize4dwJob builds /job/<slug> when the API omits url');
  } else {
    fail(`normalize4dwJob built url = ${JSON.stringify(builtUrl?.url)}`);
  }

  // url off-host (tampered/foreign) is rejected even with a valid slug fallback available.
  const offHost = normalize4dwJob({ title: 'Off host', slug: 'off-host-1', url: 'https://evil.example/job/off-host-1' });
  if (offHost === null) pass('normalize4dwJob drops a job url on a foreign host');
  else fail(`normalize4dwJob off-host row = ${JSON.stringify(offHost)}`);

  // work_arrangement: remote → "Remote" appended (top-level and per-location).
  const remoteJob = normalize4dwJob({ title: 'R', slug: 'r-1', locations: [{ city: 'Berlin', country: 'Germany' }], work_arrangement: 'remote' });
  if (remoteJob?.location === 'Berlin, Germany, Remote') pass('normalize4dwJob appends "Remote" when work_arrangement is "remote"');
  else fail(`normalize4dwJob remote location = ${JSON.stringify(remoteJob?.location)}`);

  const remoteLoc = normalize4dwJob({ title: 'R', slug: 'r-2', locations: [{ city: 'Lisbon', country: 'Portugal', work_arrangement: 'remote' }] });
  if (remoteLoc?.location === 'Lisbon, Portugal, Remote') pass('normalize4dwJob also reads work_arrangement off the primary location');
  else fail(`normalize4dwJob per-location remote = ${JSON.stringify(remoteLoc?.location)}`);

  // is_primary picks the right entry out of multiple locations.
  const multiLoc = normalize4dwJob({
    title: 'Multi', slug: 'multi-1',
    locations: [{ city: 'London', country: 'UK' }, { city: 'Paris', country: 'France', is_primary: true }],
  });
  if (multiLoc?.location === 'Paris, France') pass('normalize4dwJob prefers the is_primary location over the first entry');
  else fail(`normalize4dwJob is_primary pick = ${JSON.stringify(multiLoc?.location)}`);

  // company fallbacks: company.name → entry name → "4 Day Week" (whitespace-only ignored).
  const coNested = normalize4dwJob({ title: 'T', slug: 's-1', company: { name: 'Nested Co' } });
  const coEntry = normalize4dwJob({ title: 'T', slug: 's-2' }, 'Entry Name');
  const coDefault = normalize4dwJob({ title: 'T', slug: 's-3' });
  const coBlank = normalize4dwJob({ title: 'T', slug: 's-4' }, '   ');
  if (coNested?.company === 'Nested Co' && coEntry?.company === 'Entry Name'
      && coDefault?.company === '4 Day Week' && coBlank?.company === '4 Day Week') {
    pass('normalize4dwJob falls back company.name → entry name → "4 Day Week" (whitespace-only ignored)');
  } else {
    fail(`normalize4dwJob company fallbacks = ${JSON.stringify({ n: coNested?.company, e: coEntry?.company, d: coDefault?.company, b: coBlank?.company })}`);
  }

  // postedAt omitted when posted_at is absent / unparseable.
  const noDate = normalize4dwJob({ title: 'T', slug: 's-5' });
  const badDate = normalize4dwJob({ title: 'T', slug: 's-6', posted_at: 'not-a-date' });
  if (noDate && !('postedAt' in noDate) && badDate && !('postedAt' in badDate)) {
    pass('normalize4dwJob omits postedAt when posted_at is absent or unparseable');
  } else {
    fail(`normalize4dwJob date handling = ${JSON.stringify({ none: noDate, bad: badDate })}`);
  }

  // drops: empty title, missing/unsafe slug with no url, non-object.
  const drops = [
    normalize4dwJob({ title: '', slug: 'x-2' }),
    normalize4dwJob({ title: 'No slug, no url' }),
    normalize4dwJob({ title: 'Unsafe slug, no url', slug: 'a/b' }),
    normalize4dwJob({ title: 'Spacey slug, no url', slug: 'a b' }),
    normalize4dwJob(null),
  ];
  if (drops.every(r => r === null)) {
    pass('normalize4dwJob drops empty-title / no-slug-no-url / unsafe-slug-no-url / non-object');
  } else {
    fail(`normalize4dwJob drops = ${JSON.stringify(drops)}`);
  }

  // resolvePostedAfterDays — the server-side date-filter push-down.
  const now = Date.UTC(2026, 8, 1); // 2026-09-01
  const oneDayAgo = resolvePostedAfterDays(now - 86_400_000, now);
  const zeroDay = resolvePostedAfterDays(now, now);
  const tooWide = resolvePostedAfterDays(now - 400 * 86_400_000, now); // > 365-day API cap
  const absent = resolvePostedAfterDays(undefined, now);
  if (oneDayAgo === 1 && zeroDay === 0 && tooWide === null && absent === null) {
    pass('resolvePostedAfterDays converts ms→days, caps at 365 by omitting (not clamping), and passes through absent sinceMs');
  } else {
    fail(`resolvePostedAfterDays = ${JSON.stringify({ oneDayAgo, zeroDay, tooWide, absent })}`);
  }

  // fetch(): pagination by ?page=N&limit=100, stop on has_more:false.
  const mk = (i) => ({ id: `id-${i}`, title: `Role ${i}`, slug: `role-${i}`, url: `https://4dayweek.io/job/role-${i}`, company: { name: `Co ${i}` }, locations: [{ city: 'Lisbon', country: 'Portugal' }], posted_at: '2026-06-29T00:00:00Z' });
  const page1 = { data: Array.from({ length: 100 }, (_, i) => mk(i)), total: 150, page: 1, limit: 100, has_more: true };
  const page2 = { data: [mk(100), mk(101), { title: '' }], total: 150, page: 2, limit: 100, has_more: false }; // has_more:false → stop; 1 drop
  const requested = [];
  const pagedFetch = async (url, opts) => {
    requested.push({ url, redirect: opts?.redirect });
    return Number(new URL(url).searchParams.get('page')) === 1 ? page1 : page2;
  };
  const paged = await fourdayweek.fetch({ name: '4 Day Week' }, { fetchJson: pagedFetch, sleep: async () => {} });

  if (requested.length === 2
      && requested[0].url === 'https://4dayweek.io/api/v2/jobs?page=1&limit=100&sort=date'
      && requested[1].url === 'https://4dayweek.io/api/v2/jobs?page=2&limit=100&sort=date') {
    pass('4dayweek.fetch() builds ?page=N&limit=100&sort=date URLs and stops when has_more is false');
  } else {
    fail(`4dayweek.fetch() requested = ${JSON.stringify(requested.map(r => r.url))}`);
  }

  if (requested.every(r => r.redirect === 'error')) pass('4dayweek.fetch() passes redirect:"error" on every page (SSRF guard)');
  else fail(`4dayweek.fetch() redirect opts = ${JSON.stringify(requested.map(r => r.redirect))}`);

  if (paged.length === 102) pass('4dayweek.fetch() aggregates valid jobs across pages (100 + 2, dropping the empty-title row)');
  else fail(`4dayweek.fetch() returned ${paged.length} jobs (expected 102)`);

  // ctx.sinceMs → posted_after is pushed into the query string.
  const sinceReq = [];
  await fourdayweek.fetch(
    { name: '4 Day Week' },
    { fetchJson: async (url) => { sinceReq.push(url); return { data: [], total: 0, has_more: false }; }, sleep: async () => {}, sinceMs: Date.now() - 5 * 86_400_000 },
  );
  const sinceUrl = new URL(sinceReq[0]);
  const postedAfterParam = sinceUrl.searchParams.get('posted_after');
  if (postedAfterParam === '5' || postedAfterParam === '6') {
    pass('4dayweek.fetch() pushes ctx.sinceMs down as posted_after=<days>');
  } else {
    fail(`4dayweek.fetch() posted_after param = ${JSON.stringify(postedAfterParam)} (url: ${sinceReq[0]})`);
  }

  // max_pages cap: only the first page is requested even though has_more is true.
  const capReq = [];
  await fourdayweek.fetch(
    { name: '4 Day Week', max_pages: 1 },
    { fetchJson: async (url) => { capReq.push(url); return { data: Array.from({ length: 100 }, (_, i) => mk(i)), total: 999, has_more: true }; }, sleep: async () => {} },
  );
  if (capReq.length === 1 && capReq[0] === 'https://4dayweek.io/api/v2/jobs?page=1&limit=100&sort=date') {
    pass('4dayweek.fetch() honors max_pages (stops at the cap even when has_more is true)');
  } else {
    fail(`4dayweek.fetch() max_pages:1 requested ${JSON.stringify(capReq)}`);
  }

  // unexpected API response → throws.
  let badThrew = false;
  try {
    await fourdayweek.fetch({ name: 'X' }, { fetchJson: async () => ([]), sleep: async () => {} });
  } catch (e) {
    badThrew = /unexpected API response/.test(e.message);
  }
  if (badThrew) pass('4dayweek.fetch() throws on unexpected API response shape (no data array)');
  else fail('4dayweek.fetch() should throw when the data array is absent');

} catch (e) {
  fail(`4dayweek provider tests crashed: ${e.message}`);
}
