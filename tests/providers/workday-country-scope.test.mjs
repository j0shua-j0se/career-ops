// tests/providers/workday-country-scope.test.mjs — a location-scoped Workday
// crawl queries only the in-scope COUNTRY slice when the board publishes one.
//
// Measured 2026-10-03: the 7-day Workday/Ashby sweep took 24 of the pass's 52
// minutes and produced 0 qualifiers, much of it paging through boards whose
// postings were almost all outside Germany.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — workday country-scoped crawl');

const workdayModule = await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href);
const workday = workdayModule.default;
const { countryScopeSlice } = workdayModule;

const ENTRY = { name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/acme' };
const HINTS = { countries: ['Germany', 'Deutschland'], always_allow: ['Germany', 'Deutschland', 'Erlangen'], allow: [], block: ['United States'] };
const CITY_HINTS = { always_allow: ['Erlangen', 'Germany'], allow: ['Remote'], block: [] };
const mkCtx = (fetchJson, extra = {}) => ({
  transport: 'http',
  fetchText: async () => { throw new Error('fetchText should not be called'); },
  fetchJson,
  sleep: async () => {},
  ...extra,
});
const sliceKey = (appliedFacets) => Object.entries(appliedFacets || {})
  .map(([param, ids]) => `${param}=${[].concat(ids).join(',')}`)
  .sort()
  .join('&');
const postings = (tag, offset, n = 20) => Array.from({ length: n }, (_, i) => ({
  title: `${tag} job ${offset + i}`,
  externalPath: `/job/city/${tag}-${offset + i}`,
  postedOn: 'Posted Today',
}));
const countryFacet = (values) => ({ facetParameter: 'locationCountry', descriptor: 'Country', values });

try {
  // ── countryScopeSlice ─────────────────────────────────────────────
  const mixed = [countryFacet([
    { id: 'us', descriptor: 'United States of America', count: 900 },
    { id: 'de', descriptor: 'Germany', count: 60 },
    { id: 'in', descriptor: 'India', count: 40 },
  ])];
  const slice = countryScopeSlice(mixed, HINTS, 1000);
  if (slice?.facetParameter === 'locationCountry' && slice.values.map((v) => v.id).join() === 'de' && slice.inScopeCount === 60) {
    pass('countryScopeSlice() picks only the in-scope country values of a country facet');
  } else {
    fail(`countryScopeSlice(mixed) = ${JSON.stringify(slice)}`);
  }

  const cityOnly = [{ facetParameter: 'locations', values: [
    { id: 'a', descriptor: 'Schnelldorf', count: 10 }, { id: 'b', descriptor: 'Dallas', count: 990 },
  ] }];
  const undercovered = countryScopeSlice(mixed, HINTS, 1500);
  if (countryScopeSlice(cityOnly, HINTS, 1000) === null && undercovered === null
      && countryScopeSlice(mixed, null, 1000) === null) {
    pass('countryScopeSlice() ignores city facets, under-covering facets and unscoped callers');
  } else {
    fail(`countryScopeSlice() should be null: city=${JSON.stringify(countryScopeSlice(cityOnly, HINTS, 1000))} under=${JSON.stringify(undercovered)}`);
  }

  // Shape and counts from a live NVIDIA page-0 response (2026-10-04): the
  // country level is nested inside locationMainGroup as locationHierarchy1
  // ("Locations"), next to a site level ("Germany, Munich"). total is the
  // clamped 2000. Querying locationHierarchy1=Germany returned 61, the same as
  // the union of every German site.
  const nested = [{
    facetParameter: 'locationMainGroup',
    values: [
      { facetParameter: 'locationHierarchy2', descriptor: 'Location Type', values: [
        { id: 'office', descriptor: 'Office', count: 2526 }, { id: 'remote', descriptor: 'Remote', count: 594 },
      ] },
      { facetParameter: 'locationHierarchy1', descriptor: 'Locations', values: [
        { id: 'us', descriptor: 'United States', count: 2400 }, { id: 'de', descriptor: 'Germany', count: 61 },
        { id: 'in', descriptor: 'India', count: 364 },
      ] },
      { facetParameter: 'locations', descriptor: 'Sites', values: [
        { id: 'de-muc', descriptor: 'Germany, Munich', count: 34 }, { id: 'de-rem', descriptor: 'Germany, Remote', count: 45 },
        { id: 'us-sc', descriptor: 'US, CA, Santa Clara', count: 1900 },
      ] },
    ],
  }];
  const nestedSlice = countryScopeSlice(nested, HINTS, 2000);
  if (nestedSlice?.facetParameter === 'locationHierarchy1' && nestedSlice.values.map((v) => v.id).join() === 'de') {
    pass('countryScopeSlice() finds a country level nested in locationMainGroup, not the site level');
  } else {
    fail(`countryScopeSlice(nested) = ${JSON.stringify(nestedSlice)}`);
  }
  const sitesOnly = [{ facetParameter: 'locationMainGroup', values: [nested[0].values[2]] }];
  if (countryScopeSlice(sitesOnly, HINTS, 2000) === null) {
    pass('countryScopeSlice() never treats a "Germany, Munich" site facet as the country level');
  } else {
    fail('a site-level facet was mistaken for the country level');
  }

  // ── fetch(): only the Germany slice is paginated ─────────────────
  const calls = [];
  const scoped = await captureConsoleErrors(() => workday.fetch(ENTRY, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const key = sliceKey(body.appliedFacets);
    calls.push(`${key}@${body.offset}`);
    if (key === '') return { total: 1000, facets: mixed, jobPostings: postings('all', body.offset) };
    if (key === 'locationCountry=de') {
      return { total: 60, facets: [], jobPostings: body.offset < 60 ? postings('de', body.offset) : [] };
    }
    throw new Error(`unexpected slice ${key}`);
  }, { includeUndated: true, locationHints: HINTS }))).then((r) => r.result);

  const unfacetedPages = calls.filter((c) => c.startsWith('@')).length;
  const dePages = calls.filter((c) => c.startsWith('locationCountry=de@')).length;
  if (unfacetedPages === 1 && dePages === 3 && scoped.workdayCountryScoped === true && !scoped.workdayTruncated) {
    pass('workday.fetch() pages the Germany slice (3 pages) instead of the whole 50-page board');
  } else {
    fail(`calls: unfaceted=${unfacetedPages} de=${dePages} tags=${JSON.stringify({ s: scoped.workdayCountryScoped, t: scoped.workdayTruncated })}`);
  }
  if (scoped.filter((j) => j.title.startsWith('de ')).length === 60 && scoped.length === 80) {
    pass('workday.fetch() returns page 0 plus every in-scope posting, deduped');
  } else {
    fail(`scoped crawl returned ${scoped.length} jobs`);
  }

  // ── multi-site postings in a country slice get the country in their label ──
  const multi = await captureConsoleErrors(() => workday.fetch(ENTRY, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const key = sliceKey(body.appliedFacets);
    const withText = (list, text) => list.map((p) => ({ ...p, locationsText: text }));
    if (key === '') return { total: 1000, facets: mixed, jobPostings: withText(postings('de', body.offset), '3 Locations') };
    return { total: 20, facets: [], jobPostings: body.offset === 0 ? withText(postings('de', 0), '3 Locations') : [] };
  }, { includeUndated: true, locationHints: HINTS }))).then((r) => r.result);
  if (multi.length === 20 && multi.every((j) => j.location === 'Germany (3 Locations)')) {
    pass('workday.fetch() labels a country slice\'s "3 Locations" postings "Germany (3 Locations)", even when page 0 had them first');
  } else {
    fail(`multi-site labels: ${JSON.stringify([...new Set(multi.map((j) => j.location))])} (${multi.length} jobs)`);
  }

  // ── a board whose country facet holds no in-scope country stops at page 0 ──
  const outCalls = [];
  const out = await captureConsoleErrors(() => workday.fetch(ENTRY, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    outCalls.push(`${sliceKey(body.appliedFacets)}@${body.offset}`);
    return {
      total: 1000,
      facets: [countryFacet([
        { id: 'us', descriptor: 'United States of America', count: 950 },
        { id: 'mx', descriptor: 'Mexico', count: 50 },
      ])],
      jobPostings: postings('us', body.offset),
    };
  }, { includeUndated: true, locationHints: HINTS }))).then((r) => r.result);
  if (outCalls.length === 1 && out.workdayOutOfScope === true && !out.workdayTruncated && out.length === 20) {
    pass('workday.fetch() stops at page 0 when the country facet lists no in-scope country');
  } else {
    fail(`out-of-scope board: ${outCalls.length} calls, tags ${JSON.stringify({ o: out.workdayOutOfScope, t: out.workdayTruncated })}`);
  }

  // ── no `countries` opt-in: never inferred from allow/always_allow ──
  // A filter that also allows "Remote" may want remote postings filed under
  // another country; a city-only filter names no country value at all.
  if (countryScopeSlice(mixed, CITY_HINTS, 1000) === null) {
    pass('countryScopeSlice() is opt-in: allow/always_allow alone never scope the crawl');
  } else {
    fail('countryScopeSlice() inferred a country scope without location_filter.countries');
  }
  const cityCalls = [];
  await captureConsoleErrors(() => workday.fetch(ENTRY, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    cityCalls.push(sliceKey(body.appliedFacets));
    return { total: 100, facets: mixed, jobPostings: postings('all', body.offset) };
  }, { includeUndated: true, locationHints: CITY_HINTS })));
  if (cityCalls.length === 5 && cityCalls.every((k) => k === '')) {
    pass('workday.fetch() with hints but no countries list paginates the whole board as before');
  } else {
    fail(`city-hint crawl made ${cityCalls.length} calls: ${JSON.stringify([...new Set(cityCalls)])}`);
  }

  // ── unscoped callers crawl exactly as before ──────────────────────
  const plainCalls = [];
  await captureConsoleErrors(() => workday.fetch(ENTRY, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    plainCalls.push(sliceKey(body.appliedFacets));
    return { total: 100, facets: mixed, jobPostings: postings('all', body.offset) };
  }, { includeUndated: true })));
  if (plainCalls.length === 5 && plainCalls.every((k) => k === '')) {
    pass('workday.fetch() without location hints still paginates the whole board');
  } else {
    fail(`unscoped crawl made ${plainCalls.length} calls: ${JSON.stringify([...new Set(plainCalls)])}`);
  }
} catch (e) {
  fail(`workday country-scope tests crashed: ${e.stack || e.message}`);
}
