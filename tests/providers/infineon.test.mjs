// tests/providers/infineon.test.mjs — jobs.infineon.com sitemap parser.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — infineon (jobs.infineon.com sitemap walk)');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/infineon.mjs')).href);
  const provider = mod.default;
  const { parseLocs, parseJobUrl, resolveSitemapIndexUrl } = mod;

  if (provider.id === 'infineon') pass('infineon.id is "infineon"');
  else fail(`infineon.id is ${JSON.stringify(provider.id)}`);

  // ── detect() / SSRF host guard ──────────────────────────────────────────
  for (const url of [
    'https://jobs.infineon.com/careers',
    'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com',
  ]) {
    if (provider.detect({ careers_url: url })) pass(`infineon.detect() claims ${url}`);
    else fail(`infineon.detect() should claim ${url}`);
  }

  for (const url of [
    'https://jobs.infineon.com.evil.com/careers', // lookalike: real host as a prefix
    'https://evil.com/jobs.infineon.com/careers', // lookalike: real host in the path
    'https://infineon.eightfold.ai/careers', // the gated multi-tenant host, not the sitemap host
    'http://jobs.infineon.com/careers', // plain HTTP, not HTTPS
    'not-a-url',
    '',
  ]) {
    if (provider.detect({ careers_url: url }) === null) pass(`infineon.detect() rejects ${JSON.stringify(url)}`);
    else fail(`infineon.detect() should reject ${JSON.stringify(url)}`);
  }
  if (provider.detect({}) === null) pass('infineon.detect() rejects an entry with neither api: nor careers_url:');
  else fail('infineon.detect() should reject an entry with no URL at all');

  // ── resolveSitemapIndexUrl ───────────────────────────────────────────────
  const explicitIndex = resolveSitemapIndexUrl({ api: 'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com' });
  if (explicitIndex === 'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com') {
    pass('infineon.resolveSitemapIndexUrl() honors an explicit sitemap_index.xml URL verbatim');
  } else {
    fail(`infineon.resolveSitemapIndexUrl() explicit wrong: ${explicitIndex}`);
  }
  const fallbackIndex = resolveSitemapIndexUrl({ careers_url: 'https://jobs.infineon.com/careers' });
  if (fallbackIndex === 'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com') {
    pass('infineon.resolveSitemapIndexUrl() falls back to the well-known index for a bare careers_url');
  } else {
    fail(`infineon.resolveSitemapIndexUrl() fallback wrong: ${fallbackIndex}`);
  }
  if (resolveSitemapIndexUrl({ careers_url: 'https://evil.com/careers' }) === null) {
    pass('infineon.resolveSitemapIndexUrl() rejects a non-infineon host');
  } else {
    fail('infineon.resolveSitemapIndexUrl() should reject a non-infineon host');
  }
  // No api:/careers_url at all -> the well-known index (single-company
  // provider convention: portals.yml can set `provider: infineon` with only
  // `enabled: true`, no URL, and still resolve correctly).
  if (resolveSitemapIndexUrl({}) === 'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com') {
    pass('infineon.resolveSitemapIndexUrl() defaults to the well-known index when no URL is configured');
  } else {
    fail(`infineon.resolveSitemapIndexUrl() no-URL default wrong: ${resolveSitemapIndexUrl({})}`);
  }

  // ── parseLocs — sitemap-index and child-sitemap <loc> extraction ────────
  const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
    <loc>https://jobs.infineon.com/careers/sitemap.xml?domain=infineon.com</loc>
</sitemap>
<sitemap>
    <loc>https://jobs.infineon.com/careers/sitemap_cat.xml?domain=infineon.com</loc>
</sitemap>
</sitemapindex>`;
  const indexLocs = parseLocs(SITEMAP_INDEX);
  if (indexLocs.length === 2 && indexLocs[0].endsWith('sitemap.xml?domain=infineon.com') && indexLocs[1].endsWith('sitemap_cat.xml?domain=infineon.com')) {
    pass('infineon.parseLocs() extracts both child sitemap URLs from the index');
  } else {
    fail(`infineon.parseLocs() index wrong: ${JSON.stringify(indexLocs)}`);
  }
  if (parseLocs(null).length === 0 && parseLocs(undefined).length === 0) pass('infineon.parseLocs() tolerates non-string input');
  else fail('infineon.parseLocs() should return [] for non-string input');

  // Real shape of sitemap.xml — carries the bare /careers landing page,
  // ordinary job postings, one with a trailing-dash slug and one whose
  // location segment is unicode (percent-encoded 西安 / Xi'an).
  const SITEMAP_JOBS = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://jobs.infineon.com/careers?domain=infineon.com</loc>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://jobs.infineon.com/careers/job/563808969260056-staff-specialist-marketing-bangalore-india-?domain=infineon.com</loc>
    <priority>1.0</priority>
    <lastmod>2026-02-04T05:05:21Z</lastmod>
  </url>
  <url>
    <loc>https://jobs.infineon.com/careers/job/563808971037103-senior-staff-engineer-soc-implementation-munich?domain=infineon.com</loc>
    <priority>1.0</priority>
    <lastmod>2026-05-20T02:15:27Z</lastmod>
  </url>
  <url>
    <loc>https://jobs.infineon.com/careers/job/563808971774445-staff-engineer-field-application-engineering-xi-an-%E8%A5%BF%E5%AE%89?domain=infineon.com</loc>
    <lastmod>2026-07-31T08:50:28Z</lastmod>
  </url>
</urlset>`;

  const SITEMAP_CAT = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jobs.infineon.com/careers/hr?domain=infineon.com</loc></url>
  <url><loc>https://jobs.infineon.com/careers/it?domain=infineon.com</loc></url>
</urlset>`;

  // ── parseJobUrl — the slug-ambiguity crux ────────────────────────────────
  const bangalore = parseJobUrl('https://jobs.infineon.com/careers/job/563808969260056-staff-specialist-marketing-bangalore-india-?domain=infineon.com');
  if (bangalore && bangalore.title === 'staff specialist marketing bangalore india') {
    pass('infineon.parseJobUrl() de-slugs a trailing-dash URL into one title (no title/location split attempted)');
  } else {
    fail(`infineon.parseJobUrl() bangalore wrong: ${JSON.stringify(bangalore)}`);
  }

  const munich = parseJobUrl('https://jobs.infineon.com/careers/job/563808971037103-senior-staff-engineer-soc-implementation-munich?domain=infineon.com');
  if (munich && munich.title === 'senior staff engineer soc implementation munich') {
    pass('infineon.parseJobUrl() de-slugs a URL with no trailing dash the same way');
  } else {
    fail(`infineon.parseJobUrl() munich wrong: ${JSON.stringify(munich)}`);
  }

  const xian = parseJobUrl('https://jobs.infineon.com/careers/job/563808971774445-staff-engineer-field-application-engineering-xi-an-%E8%A5%BF%E5%AE%89?domain=infineon.com');
  if (xian && xian.title.endsWith('西安')) {
    pass('infineon.parseJobUrl() percent-decodes a unicode slug segment');
  } else {
    fail(`infineon.parseJobUrl() xi'an wrong: ${JSON.stringify(xian)}`);
  }

  // This slug carries a double hyphen in TWO places: immediately after the id,
  // and as the real title/location delimiter. Only the second one is data — the
  // first is slugification noise and must not be mistaken for a split point,
  // which would leave an empty title and drop the posting.
  const doubleDash = parseJobUrl('https://jobs.infineon.com/careers/job/563808960697866--duales-studium-2026-embedded-systems-m-w-div-dhbw--munich-germany-?domain=infineon.com');
  if (doubleDash
      && doubleDash.title === 'duales studium 2026 embedded systems m w div dhbw'
      && doubleDash.location === 'munich germany') {
    pass('infineon.parseJobUrl() splits on the delimiting double-dash, not the one right after the id');
  } else {
    fail(`infineon.parseJobUrl() double-dash wrong: ${JSON.stringify(doubleDash)}`);
  }

  for (const [url, why] of [
    ['https://jobs.infineon.com/careers?domain=infineon.com', 'the bare /careers landing page'],
    ['https://jobs.infineon.com/careers/hr?domain=infineon.com', 'a category landing page (no /job/ segment)'],
    ['https://jobs.infineon.com/careers/job/?domain=infineon.com', 'a /job/ path with no id-slug tail'],
    ['not-a-url', 'a malformed URL'],
  ]) {
    if (parseJobUrl(url) === null) pass(`infineon.parseJobUrl() rejects ${why}`);
    else fail(`infineon.parseJobUrl() should reject ${why}: ${url}`);
  }

  // ── fetch() — walks index -> children, filters to /careers/job/ URLs ────
  {
    const requested = [];
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url.includes('sitemap_index.xml')) return SITEMAP_INDEX;
        if (url.includes('sitemap_cat.xml')) return SITEMAP_CAT;
        if (url.includes('/careers/sitemap.xml')) return SITEMAP_JOBS;
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (jobs.length === 3) pass('infineon.fetch() returns only the /careers/job/ URLs, across both child sitemaps');
    else fail(`infineon.fetch() should return 3 jobs, got ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);
    if (jobs.every((j) => j.location === '')) pass('infineon.fetch() leaves location empty rather than guessing it from the slug');
    else fail(`infineon.fetch() should never invent a location, got ${JSON.stringify(jobs.map((j) => j.location))}`);
    if (jobs.every((j) => j.company === 'Infineon')) pass('infineon.fetch() stamps company from entry.name');
    else fail(`infineon.fetch() company wrong: ${JSON.stringify(jobs.map((j) => j.company))}`);
    if (jobs.every((j) => j.postedAt === undefined)) pass('infineon.fetch() never emits postedAt (lastmod is not a publication date)');
    else fail(`infineon.fetch() should omit postedAt entirely, got ${JSON.stringify(jobs.map((j) => j.postedAt))}`);
    if (requested.filter((u) => u.includes('sitemap_index.xml')).length === 1) pass('infineon.fetch() reads the sitemap index exactly once');
    else fail(`infineon.fetch() index requested ${requested.filter((u) => u.includes('sitemap_index.xml')).length} times`);
    if (requested.some((u) => u.includes('/careers/sitemap.xml')) && requested.some((u) => u.includes('sitemap_cat.xml'))) {
      pass('infineon.fetch() fetches both child sitemaps named in the index');
    } else {
      fail(`infineon.fetch() did not fetch both children: ${JSON.stringify(requested)}`);
    }
  }

  // ── SSRF: an off-host entry named inside the index is never fetched ──────
  {
    const requested = [];
    const poisonedIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://jobs.infineon.com/careers/sitemap.xml?domain=infineon.com</loc></sitemap>
<sitemap><loc>https://attacker.example.com/steal?x=1</loc></sitemap>
</sitemapindex>`;
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url.includes('attacker.example.com')) throw new Error('test should never fetch this host');
        if (url.includes('sitemap_index.xml')) return poisonedIndex;
        if (url.includes('/careers/sitemap.xml')) return SITEMAP_JOBS;
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (!requested.some((u) => u.includes('attacker.example.com'))) pass('infineon.fetch() never requests an off-allowlist host named inside the sitemap index');
    else fail(`infineon.fetch() leaked a request to an off-allowlist host: ${JSON.stringify(requested)}`);
    if (jobs.length === 3) pass('infineon.fetch() still returns the jobs from the legitimate child sitemap');
    else fail(`infineon.fetch() should still return 3 jobs from the good child, got ${jobs.length}`);
  }

  // ── resilience: one bad child sitemap must not take the whole board down ─
  {
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        if (url.includes('sitemap_index.xml')) return SITEMAP_INDEX;
        if (url.includes('sitemap_cat.xml')) throw Object.assign(new Error('HTTP 404 Not Found'), { status: 404 });
        if (url.includes('/careers/sitemap.xml')) return SITEMAP_JOBS;
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (jobs.length === 3) pass('infineon.fetch() keeps the jobs from a good child sitemap when a sibling child fails');
    else fail(`infineon.fetch() should tolerate one failed child sitemap, got ${jobs.length} jobs`);
  }

  // ── ctx.maxPages bounds the child-sitemap fan-out (health probe) ────────
  {
    const requested = [];
    const ctx = {
      maxPages: 1,
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url.includes('sitemap_index.xml')) return SITEMAP_INDEX;
        if (url.includes('/careers/sitemap.xml')) return SITEMAP_JOBS;
        throw new Error(`unexpected URL in test: should not fetch beyond ctx.maxPages (${url})`);
      },
    };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (requested.length === 2) pass('infineon.fetch() honors ctx.maxPages by fetching only the index plus one child sitemap');
    else fail(`infineon.fetch() should make 2 requests under ctx.maxPages:1, made ${requested.length}: ${JSON.stringify(requested)}`);
    if (jobs.length === 3) pass('infineon.fetch() still returns the jobs found in the single fetched child under ctx.maxPages');
    else fail(`infineon.fetch() jobs wrong under ctx.maxPages: ${jobs.length}`);
  }

  // ── MAX_JOBS bounds a runaway board ──────────────────────────────────────
  {
    const bigCount = 2005;
    const urls = [];
    for (let i = 0; i < bigCount; i++) {
      urls.push(`  <url><loc>https://jobs.infineon.com/careers/job/${900000000000000 + i}-bulk-test-role-${i}-munich-germany-?domain=infineon.com</loc></url>`);
    }
    const bigSitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        if (url.includes('sitemap_index.xml')) return SITEMAP_INDEX;
        if (url.includes('sitemap_cat.xml')) return SITEMAP_CAT;
        if (url.includes('/careers/sitemap.xml')) return bigSitemap;
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (jobs.length === 2000) pass('infineon.fetch() caps total jobs at MAX_JOBS (2000) even when the board has more');
    else fail(`infineon.fetch() should cap at 2000 jobs, got ${jobs.length}`);
  }

  // ── an empty/malformed index degrades to [] rather than throwing ─────────
  {
    const ctx = { sleep: async () => {}, fetchText: async () => '<sitemapindex></sitemapindex>' };
    const jobs = await provider.fetch({ name: 'Infineon', careers_url: 'https://jobs.infineon.com/careers' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0) pass('infineon.fetch() returns [] for an index with no child sitemaps');
    else fail(`infineon.fetch() should return [] for a childless index, got ${JSON.stringify(jobs)}`);
  }

  // fetch() must refuse to run at all when the entry's own URL is off-host —
  // the SSRF guard applies before a single request goes out, not just to
  // URLs discovered later inside a sitemap.
  {
    let threw = false;
    try {
      await provider.fetch({ name: 'Spoofed', careers_url: 'https://jobs.infineon.com.evil.com/careers' }, { fetchText: async () => { throw new Error('should never be called'); } });
    } catch {
      threw = true;
    }
    if (threw) pass('infineon.fetch() throws for a spoofed careers_url instead of fetching it');
    else fail('infineon.fetch() should refuse to fetch a spoofed careers_url');
  }
} catch (e) {
  fail(`infineon provider tests crashed: ${e.message}`);
}

// ── The double hyphen is the only delimiter this board offers ────────
//
// The general slug is {id}-{title-and-location} with nothing between the two,
// which is why location is normally left empty rather than guessed. But 11% of
// the live board (measured 2026-09-01: 154 of 1,347 slugs) carries a `--`, and
// what follows it was a location in every one — warstein-germany 33, munich 17,
// singapore 13, munich-germany 12, then dresden, villach-austria, regensburg,
// kulim-malaysia, shanghai.
//
// That 11% is not a random sample: the delimiter exists because the title ended
// in "(f/m/div)", a German-market convention, so roughly half of them are DACH
// postings — precisely the ones this search cares about. Splitting there is
// free. Splitting on a SINGLE hyphen would be guessing, and a wrongly
// attributed location silently mis-filters a posting.
{
  // Re-imported: the block above closes its own scope, and destructuring here
  // keeps this section self-contained rather than depending on where it sits.
  const { parseJobUrl } = await import(pathToFileURL(join(ROOT, 'providers/infineon.mjs')).href);

  const withSep = parseJobUrl('https://jobs.infineon.com/careers/job/563808971733507-internship-diversity-and-inclusion-f-m-div--munich-germany-');
  if (withSep && withSep.title === 'internship diversity and inclusion f m div' && withSep.location === 'munich germany') {
    pass('parseJobUrl splits title from location on the double hyphen');
  } else {
    fail(`double-hyphen split wrong: ${JSON.stringify(withSep)}`);
  }

  // No delimiter — the conservative path. The location is genuinely
  // unrecoverable here ("...-marketing-bangalore-india-" could split before
  // "bangalore" or before "india"), so it stays empty and the whole readable
  // string stays in the title where location_filter can still read it.
  const noSep = parseJobUrl('https://jobs.infineon.com/careers/job/563808969260056-staff-specialist-marketing-bangalore-india-');
  if (noSep && noSep.location === '' && noSep.title === 'staff specialist marketing bangalore india') {
    pass('parseJobUrl leaves location empty when the slug has no delimiter');
  } else {
    fail(`no-delimiter case wrong: ${JSON.stringify(noSep)}`);
  }

  // A city with no country still counts — 17 postings end at "--munich".
  const cityOnly = parseJobUrl('https://jobs.infineon.com/careers/job/563808971794185-working-student-database-development-f-m-div--munich');
  if (cityOnly && cityOnly.location === 'munich' && !/munich/.test(cityOnly.title)) {
    pass('parseJobUrl handles a bare city after the delimiter and removes it from the title');
  } else {
    fail(`city-only case wrong: ${JSON.stringify(cityOnly)}`);
  }

  // Percent-encoded non-Latin locations must survive the split, not corrupt it.
  const unicode = parseJobUrl('https://jobs.infineon.com/careers/job/563808971774445-staff-engineer-test--shanghai-%E4%B8%8A%E6%B5%B7');
  if (unicode && unicode.location === 'shanghai 上海' && unicode.title === 'staff engineer test') {
    pass('parseJobUrl decodes a percent-encoded location after the delimiter');
  } else {
    fail(`unicode location wrong: ${JSON.stringify(unicode)}`);
  }

  // `{id}--munich` — a double hyphen with nothing before it. This asserts the
  // CONSISTENT reading, not a preferred one, and the distinction matters.
  //
  // A `--` immediately after the id is slugification noise, proved by the
  // duales-studium posting above which carries one there AND a real delimiter
  // later. The regex consumes the id and one hyphen, so what reaches the split
  // is `-munich`: a single leading hyphen, no delimiter, and therefore the
  // ordinary no-delimiter path — title "munich", location empty.
  //
  // An earlier version of this test asserted null instead, on the reasoning
  // that an empty title should drop the posting. That was a preference about a
  // URL shape the live board does not produce, and it contradicted the
  // leading-noise rule the real board does exercise. Keeping the posting with
  // whatever readable text exists is the conservative behaviour: it can be
  // filtered, whereas a dropped posting cannot be recovered.
  const noTitle = parseJobUrl('https://jobs.infineon.com/careers/job/123--munich');
  if (noTitle && noTitle.title === 'munich' && noTitle.location === '') {
    pass('parseJobUrl treats a double-dash right after the id as noise, not a delimiter');
  } else {
    fail(`leading-double-dash case wrong: ${JSON.stringify(noTitle)}`);
  }
}
