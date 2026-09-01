// tests/providers/zalando.test.mjs — jobs.zalando.com sitemap + detail-page walk.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — zalando (jobs.zalando.com sitemap + location lookup)');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/zalando.mjs')).href);
  const provider = mod.default;
  const { parseSitemapLocs, parseJobUrl, extractLocationFromDetailHtml, resolveSitemapUrl } = mod;

  if (provider.id === 'zalando') pass('zalando.id is "zalando"');
  else fail(`zalando.id is ${JSON.stringify(provider.id)}`);

  // ── detect() / SSRF host guard ──────────────────────────────────────────
  for (const url of ['https://jobs.zalando.com/en/jobs', 'https://jobs.zalando.com/sitemap.xml']) {
    if (provider.detect({ careers_url: url })) pass(`zalando.detect() claims ${url}`);
    else fail(`zalando.detect() should claim ${url}`);
  }
  for (const url of [
    'https://jobs.zalando.com.evil.com/en/jobs', // lookalike: real host as a prefix
    'https://evil.com/jobs.zalando.com/en/jobs', // lookalike: real host in the path
    'https://zalando.com/jobs', // the marketing domain, not the jobs subdomain
    'http://jobs.zalando.com/en/jobs', // plain HTTP, not HTTPS
    'not-a-url',
    '',
  ]) {
    if (provider.detect({ careers_url: url }) === null) pass(`zalando.detect() rejects ${JSON.stringify(url)}`);
    else fail(`zalando.detect() should reject ${JSON.stringify(url)}`);
  }
  if (provider.detect({}) === null) pass('zalando.detect() rejects an entry with neither api: nor careers_url:');
  else fail('zalando.detect() should reject an entry with no URL at all');

  // ── resolveSitemapUrl ─────────────────────────────────────────────────────
  if (resolveSitemapUrl({ api: 'https://jobs.zalando.com/sitemap.xml' }) === 'https://jobs.zalando.com/sitemap.xml') {
    pass('zalando.resolveSitemapUrl() honors an explicit sitemap.xml URL verbatim');
  } else {
    fail(`zalando.resolveSitemapUrl() explicit wrong: ${resolveSitemapUrl({ api: 'https://jobs.zalando.com/sitemap.xml' })}`);
  }
  if (resolveSitemapUrl({ careers_url: 'https://jobs.zalando.com/en/jobs' }) === 'https://jobs.zalando.com/sitemap.xml') {
    pass('zalando.resolveSitemapUrl() falls back to the well-known sitemap for a bare careers_url');
  } else {
    fail(`zalando.resolveSitemapUrl() fallback wrong: ${resolveSitemapUrl({ careers_url: 'https://jobs.zalando.com/en/jobs' })}`);
  }
  if (resolveSitemapUrl({ careers_url: 'https://evil.com/en/jobs' }) === null) {
    pass('zalando.resolveSitemapUrl() rejects a non-zalando host');
  } else {
    fail('zalando.resolveSitemapUrl() should reject a non-zalando host');
  }
  if (resolveSitemapUrl({}) === 'https://jobs.zalando.com/sitemap.xml') {
    pass('zalando.resolveSitemapUrl() defaults to the well-known sitemap when no URL is configured');
  } else {
    fail(`zalando.resolveSitemapUrl() no-URL default wrong: ${resolveSitemapUrl({})}`);
  }

  // ── parseSitemapLocs ──────────────────────────────────────────────────────
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jobs.zalando.com</loc><lastmod>2026-09-01T18:22:23.523Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en</loc><lastmod>2026-09-01T18:22:23.523Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en/jobs</loc><lastmod>2026-09-01T18:22:23.555Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en/blog/outlet-store-manager</loc><lastmod>2026-09-01T18:22:23.653Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en/what-we-do/software-engineering</loc></url>
  <url><loc>https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)</loc><lastmod>2026-09-01T18:22:23.653Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en/jobs/2724757-Cost-Centre-Coordinator-%2F-Specialist-(all-genders)</loc><lastmod>2026-09-01T18:22:23.653Z</lastmod></url>
  <url><loc>https://jobs.zalando.com/en/jobs/2724601-Senior-Data-Engineer-(all-genders)---Tradebyte</loc><lastmod>2026-09-01T18:22:23.653Z</lastmod></url>
</urlset>`;
  const locs = parseSitemapLocs(SITEMAP);
  if (locs.length === 8) pass('zalando.parseSitemapLocs() extracts every <loc> in the document');
  else fail(`zalando.parseSitemapLocs() expected 8 locs, got ${locs.length}`);
  if (parseSitemapLocs(null).length === 0 && parseSitemapLocs(undefined).length === 0) pass('zalando.parseSitemapLocs() tolerates non-string input');
  else fail('zalando.parseSitemapLocs() should return [] for non-string input');

  // ── parseJobUrl — filters non-job URLs, recovers title from the slug ────
  for (const [url, why] of [
    ['https://jobs.zalando.com', 'the bare homepage'],
    ['https://jobs.zalando.com/en', 'the bare /en landing page'],
    ['https://jobs.zalando.com/en/jobs', 'the listing page itself (no id)'],
    ['https://jobs.zalando.com/en/blog/outlet-store-manager', 'a blog post'],
    ['https://jobs.zalando.com/en/what-we-do/software-engineering', 'a marketing page'],
    ['not-a-url', 'a malformed URL'],
  ]) {
    if (parseJobUrl(url) === null) pass(`zalando.parseJobUrl() rejects ${why}`);
    else fail(`zalando.parseJobUrl() should reject ${why}: ${url}`);
  }

  const media = parseJobUrl('https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)');
  if (media && media.id === '2725415' && media.title === 'Media Activation Manager (all genders)') {
    pass('zalando.parseJobUrl() recovers id and title from a plain slug');
  } else {
    fail(`zalando.parseJobUrl() media wrong: ${JSON.stringify(media)}`);
  }

  const slash = parseJobUrl('https://jobs.zalando.com/en/jobs/2724757-Cost-Centre-Coordinator-%2F-Specialist-(all-genders)');
  if (slash && slash.title === 'Cost Centre Coordinator / Specialist (all genders)') {
    pass('zalando.parseJobUrl() percent-decodes a slug segment (%2F -> /)');
  } else {
    fail(`zalando.parseJobUrl() percent-decode wrong: ${JSON.stringify(slash)}`);
  }

  const tradebyte = parseJobUrl('https://jobs.zalando.com/en/jobs/2724601-Senior-Data-Engineer-(all-genders)---Tradebyte');
  if (tradebyte && tradebyte.title === 'Senior Data Engineer (all genders) Tradebyte') {
    pass('zalando.parseJobUrl() collapses a triple-hyphen separator into a single space (no title/location split attempted)');
  } else {
    fail(`zalando.parseJobUrl() tradebyte wrong: ${JSON.stringify(tradebyte)}`);
  }

  // ── extractLocationFromDetailHtml — the RSC-escaped "offices" field ─────
  // Real shape (verified live 2026-09-01): the job's Workday-sourced data is
  // embedded twice as a JS string literal argument to self.__next_f.push(),
  // so the JSON quotes are backslash-escaped.
  const detailPage = (offices) =>
    `<html><body><script>self.__next_f.push([1,"6:[\\"$\\",\\"section\\",null,{\\"job\\":{\\"id\\":\\"2725415\\",\\"offices\\":[${offices
      .map((o) => `\\"${o}\\"`)
      .join(',')}],\\"name\\":\\"Someone\\"}}]"])</script></body></html>`;

  const single = extractLocationFromDetailHtml(detailPage(['Germany - Berlin']));
  if (single === 'Germany - Berlin') pass('zalando.extractLocationFromDetailHtml() reads a single office');
  else fail(`zalando.extractLocationFromDetailHtml() single wrong: ${JSON.stringify(single)}`);

  const multi = extractLocationFromDetailHtml(detailPage(['Germany - Berlin', 'Germany - Dortmund']));
  if (multi === 'Germany - Berlin / Germany - Dortmund') pass('zalando.extractLocationFromDetailHtml() joins multiple offices with " / "');
  else fail(`zalando.extractLocationFromDetailHtml() multi wrong: ${JSON.stringify(multi)}`);

  if (extractLocationFromDetailHtml('<html><body>no job data here</body></html>') === '') {
    pass('zalando.extractLocationFromDetailHtml() returns empty string when the field is absent');
  } else {
    fail('zalando.extractLocationFromDetailHtml() should return empty string when the offices field is missing');
  }
  if (extractLocationFromDetailHtml(null) === '' && extractLocationFromDetailHtml(undefined) === '') {
    pass('zalando.extractLocationFromDetailHtml() tolerates non-string input');
  } else {
    fail('zalando.extractLocationFromDetailHtml() should return "" for non-string input');
  }

  // ── fetch() — sitemap walk + per-job detail lookup ──────────────────────
  {
    const jobUrls = [
      'https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)',
      'https://jobs.zalando.com/en/jobs/2724757-Cost-Centre-Coordinator-%2F-Specialist-(all-genders)',
    ];
    const officesByUrl = {
      [jobUrls[0]]: ['Germany - Berlin'],
      [jobUrls[1]]: ['Romania - Bucharest'],
    };
    const requested = [];
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url === 'https://jobs.zalando.com/sitemap.xml') return SITEMAP;
        if (officesByUrl[url]) return detailPage(officesByUrl[url]);
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (jobs.length === 3) pass('zalando.fetch() returns only the /en/jobs/{id}-… postings, across a mixed sitemap');
    else fail(`zalando.fetch() should return 3 jobs, got ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);

    const byId = Object.fromEntries(jobs.map((j) => [j.url, j]));
    if (byId[jobUrls[0]]?.location === 'Germany - Berlin') pass('zalando.fetch() attaches the detail-page location for job 1');
    else fail(`zalando.fetch() location wrong for job 1: ${JSON.stringify(byId[jobUrls[0]])}`);
    if (byId[jobUrls[1]]?.location === 'Romania - Bucharest') pass('zalando.fetch() attaches the detail-page location for job 2');
    else fail(`zalando.fetch() location wrong for job 2: ${JSON.stringify(byId[jobUrls[1]])}`);

    if (jobs.every((j) => j.company === 'Zalando')) pass('zalando.fetch() stamps company from entry.name');
    else fail(`zalando.fetch() company wrong: ${JSON.stringify(jobs.map((j) => j.company))}`);
    if (jobs.every((j) => j.postedAt === undefined)) pass('zalando.fetch() never emits postedAt (lastmod is not a publication date)');
    else fail(`zalando.fetch() should omit postedAt entirely, got ${JSON.stringify(jobs.map((j) => j.postedAt))}`);
    if (requested.filter((u) => u === 'https://jobs.zalando.com/sitemap.xml').length === 1) {
      pass('zalando.fetch() reads the sitemap exactly once');
    } else {
      fail(`zalando.fetch() sitemap requested ${requested.filter((u) => u === 'https://jobs.zalando.com/sitemap.xml').length} times`);
    }
  }

  // ── location gracefully degrades to '' when one detail page fails ──────
  {
    const jobUrls = [
      'https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)',
      'https://jobs.zalando.com/en/jobs/2724757-Cost-Centre-Coordinator-%2F-Specialist-(all-genders)',
    ];
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        if (url === 'https://jobs.zalando.com/sitemap.xml') return SITEMAP;
        if (url === jobUrls[0]) throw Object.assign(new Error('HTTP 500'), { status: 500 });
        if (url === jobUrls[1]) return detailPage(['Romania - Bucharest']);
        throw new Error(`unexpected URL in test: ${url}`);
      },
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    const byId = Object.fromEntries(jobs.map((j) => [j.url, j]));
    if (jobs.length === 3 && byId[jobUrls[0]]?.location === '' && byId[jobUrls[1]]?.location === 'Romania - Bucharest') {
      pass('zalando.fetch() degrades one failed detail-page fetch to an empty location without losing the posting or the whole board');
    } else {
      fail(`zalando.fetch() resilience wrong: ${JSON.stringify(jobs)}`);
    }
  }

  // ── SSRF: an off-host job URL named inside the sitemap is never fetched ──
  {
    const poisonedSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)</loc></url>
  <url><loc>https://attacker.example.com/steal?x=1</loc></url>
</urlset>`;
    const requested = [];
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url.includes('attacker.example.com')) throw new Error('test should never fetch this host');
        if (url === 'https://jobs.zalando.com/sitemap.xml') return poisonedSitemap;
        return detailPage(['Germany - Berlin']);
      },
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (!requested.some((u) => u.includes('attacker.example.com'))) {
      pass('zalando.fetch() never requests an off-allowlist host named inside the sitemap');
    } else {
      fail(`zalando.fetch() leaked a request to an off-allowlist host: ${JSON.stringify(requested)}`);
    }
    if (jobs.length === 1 && jobs[0].location === 'Germany - Berlin') {
      pass('zalando.fetch() still returns the legitimate job from an otherwise-poisoned sitemap');
    } else {
      fail(`zalando.fetch() should still return the legitimate job, got ${JSON.stringify(jobs)}`);
    }
  }

  // fetch() must refuse to run at all when the entry's own URL is off-host —
  // the SSRF guard applies before a single request goes out.
  {
    let threw = false;
    try {
      await provider.fetch(
        { name: 'Spoofed', careers_url: 'https://jobs.zalando.com.evil.com/en/jobs' },
        { fetchText: async () => { throw new Error('should never be called'); } },
      );
    } catch {
      threw = true;
    }
    if (threw) pass('zalando.fetch() throws for a spoofed careers_url instead of fetching it');
    else fail('zalando.fetch() should refuse to fetch a spoofed careers_url');
  }

  // ── ctx.maxPages bounds detail-page fan-out (health probe) ──────────────
  {
    const jobUrls = [
      'https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)',
      'https://jobs.zalando.com/en/jobs/2724757-Cost-Centre-Coordinator-%2F-Specialist-(all-genders)',
      'https://jobs.zalando.com/en/jobs/2724601-Senior-Data-Engineer-(all-genders)---Tradebyte',
    ];
    const requested = [];
    const ctx = {
      maxPages: 1,
      sleep: async () => {},
      fetchText: async (url) => {
        requested.push(url);
        if (url === 'https://jobs.zalando.com/sitemap.xml') return SITEMAP;
        if (jobUrls.includes(url)) return detailPage(['Germany - Berlin']);
        throw new Error(`unexpected URL in test: should not fetch beyond ctx.maxPages (${url})`);
      },
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (requested.length === 2) pass('zalando.fetch() honors ctx.maxPages by fetching the sitemap plus only one detail page');
    else fail(`zalando.fetch() should make 2 requests under ctx.maxPages:1, made ${requested.length}: ${JSON.stringify(requested)}`);
    if (jobs.length === 3) pass('zalando.fetch() still returns every job found in the sitemap under ctx.maxPages');
    else fail(`zalando.fetch() jobs wrong under ctx.maxPages: ${jobs.length}`);
    if (jobs.filter((j) => j.location !== '').length === 1) pass('zalando.fetch() only the budgeted job gets a resolved location under ctx.maxPages');
    else fail(`zalando.fetch() location budget wrong under ctx.maxPages: ${JSON.stringify(jobs.map((j) => j.location))}`);
  }

  // ── dedup by job id ───────────────────────────────────────────────────────
  {
    const dupeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)</loc></url>
  <url><loc>https://jobs.zalando.com/en/jobs/2725415-Media-Activation-Manager-(all-genders)</loc></url>
</urlset>`;
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => (url === 'https://jobs.zalando.com/sitemap.xml' ? dupeSitemap : detailPage(['Germany - Berlin'])),
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (jobs.length === 1) pass('zalando.fetch() dedups repeated job ids within the same sitemap');
    else fail(`zalando.fetch() should dedup to 1 job, got ${jobs.length}`);
  }

  // ── MAX_JOBS bounds a runaway board ──────────────────────────────────────
  {
    const bigCount = 405;
    const urls = [];
    for (let i = 0; i < bigCount; i++) {
      urls.push(`  <url><loc>https://jobs.zalando.com/en/jobs/${3000000 + i}-Bulk-Test-Role-${i}</loc></url>`);
    }
    const bigSitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => (url === 'https://jobs.zalando.com/sitemap.xml' ? bigSitemap : detailPage(['Germany - Berlin'])),
    };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (jobs.length === 400) pass('zalando.fetch() caps total jobs at MAX_JOBS (400) even when the board has more');
    else fail(`zalando.fetch() should cap at 400 jobs, got ${jobs.length}`);
  }

  // ── an empty/malformed sitemap degrades to [] rather than throwing ───────
  {
    const ctx = { sleep: async () => {}, fetchText: async () => '<urlset></urlset>' };
    const jobs = await provider.fetch({ name: 'Zalando', careers_url: 'https://jobs.zalando.com/en/jobs' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0) pass('zalando.fetch() returns [] for a sitemap with no job URLs');
    else fail(`zalando.fetch() should return [] for a job-less sitemap, got ${JSON.stringify(jobs)}`);
  }
} catch (e) {
  fail(`zalando provider tests crashed: ${e.message}`);
}
