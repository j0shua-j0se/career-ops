// @ts-check

/**
 * eures-core.mjs — pure logic for the EURES scanner.
 *
 * EURES is the European Commission's job-mobility portal: it aggregates
 * vacancies from the member states' public employment services, which for
 * Germany means it re-publishes a large share of the Bundesagentur set plus
 * everything the other 30 countries contribute. There is no overlap guarantee
 * with `providers/arbeitsagentur.mjs`; `scan.mjs` dedups by URL, so a posting
 * carried by both sources is seen once.
 *
 * ── Why this needs a browser (and therefore is not a provider plugin) ──────
 * Verified 2026-08-19, in this order:
 *   1. `POST https://europa.eu/eures/api/jv-search/search` — the XHR the SPA
 *      itself makes — answers "Access Denied" to a non-browser client, with
 *      and without browser-shaped headers.
 *   2. A plain fetch of the search page returns the Angular shell: zero
 *      vacancies in the HTML, because results are rendered client-side.
 *   3. A real browser render returns the full list.
 * So this is a `scan-*.mjs` browser scanner like `scan-interamt.mjs`, not a
 * `providers/*.mjs` plugin — the provider contract is fetch-based.
 *
 * ── robots.txt ────────────────────────────────────────────────────────────
 * Checked 2026-08-19 at https://europa.eu/robots.txt. Nothing under /eures/
 * is disallowed for any agent. But the `User-agent: *` block carries
 * **`Crawl-delay: 10`**, and that binds us: the scanner sleeps 10s between
 * page loads. That single fact drives the paging defaults below — at one
 * request per 10 seconds, asking for 50 results a page instead of the default
 * 10 is the difference between a scan that finishes and one that doesn't.
 *
 * This module is pure: no I/O, no playwright import, so the parsing rules can
 * be unit-tested without a browser.
 */

export const ORIGIN = 'https://europa.eu';
export const SEARCH_PATH = '/eures/portal/jv-se/search';

/** EURES caps a page at 50; asking for more silently returns 50. */
export const MAX_RESULTS_PER_PAGE = 50;
export const DEFAULT_RESULTS_PER_PAGE = 50;

/** robots.txt `Crawl-delay: 10`, in ms. Not a tunable — it is their rule. */
export const CRAWL_DELAY_MS = 10_000;

/**
 * Contract-type vocabulary EURES renders in the card meta row.
 *
 * Used only to tell a contract chip apart from a company name; an unrecognised
 * value falls through to the company slot, which is the safe direction to be
 * wrong in (a mislabelled company is visible in the pipeline, a dropped one is
 * not).
 */
const CONTRACT_TERMS = [
  'part-time',
  'full-time',
  'permanent',
  'temporary',
  'apprenticeship',
  'traineeship',
  'seasonal',
  'contract',
  'self-employed',
  'unspecified',
];

/**
 * Build one search URL.
 *
 * `lang=en` is pinned deliberately and is load-bearing: `classifyMeta()` finds
 * the publication date by its "Publication date:" label, and the portal
 * translates that label into the requested UI language. Requesting German
 * would rename it "Veröffentlichungsdatum" and the date would silently land in
 * the company slot. The *vacancies* are unaffected — `lang` sets chrome, not
 * the corpus, and each posting still carries its own language.
 *
 * @param {string} keyword
 * @param {{page?: number, resultsPerPage?: number, locationCodes?: string[]|string}} [opts]
 * @returns {string}
 */
export function buildSearchUrl(keyword, opts = {}) {
  const {
    page = 1,
    resultsPerPage = DEFAULT_RESULTS_PER_PAGE,
    locationCodes = 'de',
  } = opts;

  const codes = Array.isArray(locationCodes) ? locationCodes.join(',') : String(locationCodes || '');
  const qs = new URLSearchParams({
    page: String(Math.max(1, page)),
    resultsPerPage: String(Math.min(Math.max(1, resultsPerPage), MAX_RESULTS_PER_PAGE)),
    orderBy: 'BEST_MATCH',
    lang: 'en',
  });
  if (keyword) qs.set('keywordsEverywhere', keyword);
  if (codes) qs.set('locationCodes', codes);

  return `${ORIGIN}${SEARCH_PATH}?${qs.toString()}`;
}

/**
 * Turn a card's meta row into named fields.
 *
 * The row is a `<ul>` of 2-4 `<li>`s whose ORDER is stable but whose PRESENCE
 * is not — a posting with no stated contract type simply omits that item. So
 * each item is classified by content rather than by index; index-based parsing
 * shifts every field left the moment one is missing, which is exactly the kind
 * of failure that looks like data rather than a bug.
 *
 * @param {string[]} items - innerText of each meta <li>, in document order.
 * @returns {{company: string, location: string, contract: string, publishedRaw: string}}
 */
export function classifyMeta(items) {
  let company = '';
  let location = '';
  let contract = '';
  let publishedRaw = '';

  for (const raw of items ?? []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const dateMatch = text.match(/^publication date\s*:\s*(.+)$/i);
    if (dateMatch) {
      if (!publishedRaw) publishedRaw = dateMatch[1].trim();
      continue;
    }

    // Location renders as "Germany : Cologne, urban district" — a country and
    // a region joined by a spaced colon. Company names do not contain one.
    if (/\s:\s/.test(text)) {
      if (!location) location = text.replace(/\s*:\s*/, ' : ');
      continue;
    }

    // Contract chips can be comma-joined ("Part-time, Full-time"). Treat the
    // item as a contract only if EVERY part is a known term, so a company
    // called "Contract Systems GmbH" is not swallowed.
    const parts = text.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => CONTRACT_TERMS.includes(p))) {
      if (!contract) contract = text;
      continue;
    }

    if (!company) company = text;
  }

  return { company, location, contract, publishedRaw };
}

/**
 * Parse the portal's DD/MM/YYYY publication date to a UTC Date.
 *
 * Day-first is the EU convention the portal uses; reading it as US month-first
 * would silently mis-sort every posting for the first twelve days of a month
 * and throw on the rest.
 *
 * @param {string} str
 * @returns {Date|null}
 */
export function parseEuresDate(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(Number(y), month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Absolutise a detail href from the results list.
 *
 * Hrefs come back root-relative ("/eures/portal/jv-se/jv-details/..."). The
 * `jvDisplayLanguage` query the list attaches is kept: it is what makes the
 * detail page render in the posting's own language rather than the UI's.
 *
 * @param {string} href
 * @returns {string}
 */
export function detailUrl(href) {
  const raw = String(href ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${ORIGIN}${raw.startsWith('/') ? '' : '/'}${raw}`;
}


/**
 * Assemble one canonical offer from a card's raw extraction.
 *
 * @param {{href: string, title: string, meta: string[]}} card
 * @returns {{url: string, title: string, company: string, location: string, contract: string, source: string, postedAt?: number}|null}
 */
export function toOffer(card) {
  const title = String(card?.title ?? '').replace(/\s+/g, ' ').trim();
  const url = detailUrl(card?.href ?? '');
  if (!title || !url) return null;

  const { company, location, contract, publishedRaw } = classifyMeta(card?.meta ?? []);
  const posted = parseEuresDate(publishedRaw);

  return {
    url,
    title,
    // A vacancy syndicated from a public employment service can arrive without
    // a named employer; label it rather than emitting an empty column.
    company: company || 'EURES (employer not stated)',
    location,
    contract,
    source: 'eures',
    ...(posted ? { postedAt: posted.getTime() } : {}),
  };
}
