// tests/eures-core.test.mjs
//
// Pins the parsing law behind scan-eures.mjs. The scanner itself needs a real
// browser (the portal renders client-side and its API refuses non-browser
// clients), so the rules live in a pure module precisely so they can be tested
// without one. Fixture strings are the real 2026-08-19 card meta rows.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nEURES core');

try {
  const {
    buildSearchUrl,
    classifyMeta,
    parseEuresDate,
    detailUrl,
    toOffer,
    CRAWL_DELAY_MS,
    MAX_RESULTS_PER_PAGE,
  } = await import(pathToFileURL(join(ROOT, 'eures-core.mjs')).href);

  // ── buildSearchUrl ──────────────────────────────────────────────────────
  const u = new URL(buildSearchUrl('Werkstudent Data', { page: 2 }));
  if (u.origin === 'https://europa.eu' && u.pathname === '/eures/portal/jv-se/search') {
    pass('buildSearchUrl targets the jv-se search path');
  } else {
    fail(`buildSearchUrl target = ${u.origin}${u.pathname}`);
  }
  if (u.searchParams.get('keywordsEverywhere') === 'Werkstudent Data' && u.searchParams.get('page') === '2') {
    pass('buildSearchUrl carries the keyword and page');
  } else {
    fail(`buildSearchUrl params = ${u.search}`);
  }
  // lang=en is load-bearing, not cosmetic: classifyMeta finds the date by its
  // "Publication date:" label, and the portal translates that label. A German
  // UI would rename it and the date would land in the company slot.
  if (u.searchParams.get('lang') === 'en') {
    pass('buildSearchUrl pins lang=en, which the date label depends on');
  } else {
    fail(`buildSearchUrl lang = ${u.searchParams.get('lang')}`);
  }
  if (u.searchParams.get('locationCodes') === 'de') pass('buildSearchUrl defaults to Germany');
  else fail(`buildSearchUrl locationCodes = ${u.searchParams.get('locationCodes')}`);

  const multi = new URL(buildSearchUrl('x', { locationCodes: ['de', 'at'] }));
  if (multi.searchParams.get('locationCodes') === 'de,at') pass('buildSearchUrl joins multiple country codes');
  else fail(`buildSearchUrl multi-country = ${multi.searchParams.get('locationCodes')}`);

  const all = new URL(buildSearchUrl('x', { locationCodes: [] }));
  if (!all.searchParams.has('locationCodes')) pass('an empty country list searches all of EURES');
  else fail(`empty locationCodes produced ${all.searchParams.get('locationCodes')}`);

  const capped = new URL(buildSearchUrl('x', { resultsPerPage: 500 }));
  if (capped.searchParams.get('resultsPerPage') === String(MAX_RESULTS_PER_PAGE)) {
    pass('buildSearchUrl clamps resultsPerPage to the portal maximum');
  } else {
    fail(`resultsPerPage = ${capped.searchParams.get('resultsPerPage')}`);
  }
  const floored = new URL(buildSearchUrl('x', { page: 0 }));
  if (floored.searchParams.get('page') === '1') pass('buildSearchUrl floors page at 1');
  else fail(`page 0 became ${floored.searchParams.get('page')}`);

  // The crawl delay is robots.txt policy, not a tunable.
  if (CRAWL_DELAY_MS === 10_000) pass('CRAWL_DELAY_MS honours robots.txt Crawl-delay: 10');
  else fail(`CRAWL_DELAY_MS = ${CRAWL_DELAY_MS}`);

  // ── classifyMeta ────────────────────────────────────────────────────────
  const full = classifyMeta([
    'CERANO Hotel & Restaurant Betriebs GmbH',
    'Germany : Cologne, urban district',
    'Part-time',
    'Publication date: 18/07/2026',
  ]);
  if (full.company === 'CERANO Hotel & Restaurant Betriebs GmbH' && full.location === 'Germany : Cologne, urban district'
    && full.contract === 'Part-time' && full.publishedRaw === '18/07/2026') {
    pass('classifyMeta reads a complete meta row');
  } else {
    fail(`classifyMeta full = ${JSON.stringify(full)}`);
  }

  const joined = classifyMeta(['OneXip GmbH', 'Germany : Dresden, urban district', 'Part-time, Full-time', 'Publication date: 18/07/2026']);
  if (joined.contract === 'Part-time, Full-time' && joined.company === 'OneXip GmbH') {
    pass('classifyMeta keeps a comma-joined contract out of the company slot');
  } else {
    fail(`classifyMeta joined = ${JSON.stringify(joined)}`);
  }

  // The reason classification is by CONTENT and not by index: a posting with no
  // stated contract omits that <li> entirely, and an index-based parser would
  // shift the date into the contract slot and produce a plausible-looking row.
  const noContract = classifyMeta(['Acme GmbH', 'Germany : Berlin', 'Publication date: 01/02/2026']);
  if (noContract.company === 'Acme GmbH' && noContract.location === 'Germany : Berlin'
    && noContract.contract === '' && noContract.publishedRaw === '01/02/2026') {
    pass('classifyMeta survives a missing contract item without shifting fields');
  } else {
    fail(`classifyMeta no-contract = ${JSON.stringify(noContract)}`);
  }

  // A company whose name merely contains a contract word must stay a company.
  const tricky = classifyMeta(['Contract Systems GmbH', 'Germany : Berlin', 'Full-time']);
  if (tricky.company === 'Contract Systems GmbH' && tricky.contract === 'Full-time') {
    pass('classifyMeta does not mistake "Contract Systems GmbH" for a contract chip');
  } else {
    fail(`classifyMeta tricky = ${JSON.stringify(tricky)}`);
  }

  const empty = classifyMeta([]);
  if (empty.company === '' && empty.location === '' && empty.publishedRaw === '') {
    pass('classifyMeta tolerates an empty meta row');
  } else {
    fail(`classifyMeta empty = ${JSON.stringify(empty)}`);
  }

  // ── parseEuresDate ──────────────────────────────────────────────────────
  // Day-first. Read as month-first, 07/08 would silently become 8 July and the
  // incremental date filter would skip real postings.
  const d = parseEuresDate('18/07/2026');
  if (d && d.toISOString() === '2026-07-18T00:00:00.000Z') pass('parseEuresDate reads DD/MM/YYYY day-first');
  else fail(`parseEuresDate = ${d && d.toISOString()}`);

  const ambiguous = parseEuresDate('07/08/2026');
  if (ambiguous && ambiguous.getUTCMonth() === 7 && ambiguous.getUTCDate() === 7) {
    pass('parseEuresDate treats 07/08 as 7 August, not 8 July');
  } else {
    fail(`parseEuresDate ambiguous = ${ambiguous && ambiguous.toISOString()}`);
  }
  if (parseEuresDate('') === null && parseEuresDate('not a date') === null && parseEuresDate('32/01/2026') === null) {
    pass('parseEuresDate rejects empty, malformed, and out-of-range input');
  } else {
    fail('parseEuresDate accepted invalid input');
  }
  if (parseEuresDate('18/13/2026') === null) pass('parseEuresDate rejects month 13');
  else fail('parseEuresDate accepted month 13');

  // ── detailUrl ───────────────────────────────────────────────────────────
  if (detailUrl('/eures/portal/jv-se/jv-details/ABC?jvDisplayLanguage=de')
    === 'https://europa.eu/eures/portal/jv-se/jv-details/ABC?jvDisplayLanguage=de') {
    pass('detailUrl absolutises a root-relative href and keeps jvDisplayLanguage');
  } else {
    fail(`detailUrl = ${detailUrl('/eures/portal/jv-se/jv-details/ABC?jvDisplayLanguage=de')}`);
  }
  if (detailUrl('https://europa.eu/x') === 'https://europa.eu/x') pass('detailUrl leaves an absolute URL alone');
  else fail('detailUrl mangled an absolute URL');
  if (detailUrl('') === '') pass('detailUrl returns empty for empty input');
  else fail('detailUrl invented a URL');

  // ── toOffer ─────────────────────────────────────────────────────────────
  const offer = toOffer({
    href: '/eures/portal/jv-se/jv-details/XYZ',
    title: '  Data   Engineer (m/w/d)  ',
    meta: ['BORA GmbH', 'Germany : Rosenheim, rural district', 'Full-time', 'Publication date: 18/07/2026'],
  });
  if (offer && offer.title === 'Data Engineer (m/w/d)') pass('toOffer collapses whitespace in the title');
  else fail(`toOffer title = ${JSON.stringify(offer && offer.title)}`);
  if (offer && offer.source === 'eures') pass('toOffer tags the source as eures');
  else fail(`toOffer source = ${offer && offer.source}`);
  if (offer && offer.postedAt === Date.UTC(2026, 6, 18)) pass('toOffer exposes postedAt as epoch ms');
  else fail(`toOffer postedAt = ${offer && offer.postedAt}`);

  // A PES-syndicated vacancy can arrive with no employer; an empty company
  // column reads as a parse failure, so it is labelled instead.
  const anon = toOffer({ href: '/x', title: 'Role', meta: ['Germany : Berlin', 'Full-time'] });
  if (anon && anon.company === 'EURES (employer not stated)') pass('toOffer labels a missing employer');
  else fail(`toOffer anonymous company = ${JSON.stringify(anon && anon.company)}`);

  const undated = toOffer({ href: '/x', title: 'Role', meta: ['Acme'] });
  if (undated && !('postedAt' in undated)) pass('toOffer omits postedAt when there is no date');
  else fail(`toOffer undated = ${JSON.stringify(undated)}`);

  if (toOffer({ href: '', title: 'Role', meta: [] }) === null) pass('toOffer rejects a card with no href');
  else fail('toOffer accepted a card with no href');
  if (toOffer({ href: '/x', title: '   ', meta: [] }) === null) pass('toOffer rejects a card with no title');
  else fail('toOffer accepted a card with no title');
} catch (err) {
  fail(`eures-core threw: ${err.message}`);
}
