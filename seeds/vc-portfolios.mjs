// @ts-check
/**
 * seeds/vc-portfolios.mjs — VC portfolio seed fetchers for career-ops.
 *
 * Pulls public VC portfolio company lists (Y Combinator, Andreessen Horowitz,
 * Index Ventures) and emits company entries compatible with the existing ATS
 * scan/discovery path (same shape as tracked_companies entries in portals.yml).
 *
 * Design constraints:
 *  - Zero auth — public sources only, no login, no API keys.
 *  - Zero LLM tokens — pure HTTP + JSON / HTML.
 *  - Same SLUG_RE guard used by scan-ats-full.mjs for every slug that reaches
 *    URL interpolation — a tampered or malformed payload can never inject
 *    unexpected characters into a URL.
 *  - `parseSeedEntries()` is a pure, synchronous function (no network) so it
 *    can be unit-tested with inline fixtures without any mocking.
 *
 * Typical usage (via scan-ats-full.mjs --seeds flag):
 *   node scan-ats-full.mjs --seeds yc
 *   node scan-ats-full.mjs --seeds yc,a16z,index,sequoia --since 7 --dry-run
 *
 * Direct usage:
 *   import { fetchYCCompanies, fetchA16zCompanies } from './seeds/vc-portfolios.mjs';
 *   const companies = await fetchYCCompanies();
 */

import { DEFAULT_USER_AGENT } from '../user-agent.mjs';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Safe charset for slug values that will be interpolated into ATS URLs.
 * Consistent with the SLUG_RE guard in scan-ats-full.mjs.
 */
export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_TIMEOUT_MS = 20_000;

// Runaway guard for the YC pagination walk, NOT the stop condition: the walk
// normally ends at the API's own `totalPages` (246 as of Aug 2026, 25 per page).
// It exists only for the case where the API stops reporting pagination metadata
// at all. Sized well clear of the real total on purpose - a ceiling that sits
// close to today's page count stops being a guard and becomes a silent truncation
// the day the catalogue grows past it, which is the exact failure this file was
// fixed for. Exported so the walk is clamped to it as a hard ceiling and tests
// can assert the contract.
export const YC_MAX_PAGES = 500;

/**
 * YC public company API.
 * Returns paginated JSON with company objects including name, slug, website.
 * Documentation: https://www.ycombinator.com/companies (public, no auth needed).
 */
const YC_API_URL = 'https://api.ycombinator.com/v0.1/companies?page=1&per_page=1000';

/**
 * a16z public portfolio page.
 * The portfolio is a publicly accessible HTML page listing all portfolio companies.
 */
const A16Z_PORTFOLIO_URL = 'https://a16z.com/portfolio/';

/**
 * Index Ventures public portfolio page.
 *
 * YC and a16z are both US-weighted; this rung is the European complement
 * (Personio, DeepL, Raisin, auxmoney, cargo.one, Pitch, Productboard, Wise,
 * Revolut...), which is what a DACH or wider-EU search actually needs.
 *
 * It earned its place by being the only candidate that server-renders the whole
 * list: a survey of the obvious alternatives found Point Nine, Northzone,
 * Creandum and Earlybird 404 on their documented portfolio paths, and
 * Speedinvest, Accel, HV Capital and Atomico render theirs client-side, leaving
 * nothing for a zero-token fetcher to read. Index emits ~300 plain
 * `<a href="/companies/{slug}/">Name</a>` anchors with no JS required.
 */
const INDEX_PORTFOLIO_URL = 'https://www.indexventures.com/companies/';

/**
 * Sequoia's public job board, which is a Consider-hosted board.
 *
 * Unlike the other three rungs this page is NOT server-rendered: a GET returns a
 * 20 KB shell with a spinner and two anchors, so an HTML parser would silently
 * return zero companies. The board's own client calls a public, unauthenticated
 * JSON endpoint, and that is what this rung uses.
 *
 * It earns its place for a reason none of the others can match: each company
 * carries a `jobSources` array naming the ATS vendor outright (Greenhouse,
 * Ashby, Lever, ...). YC's dataset has a partial hint; a16z and Index have
 * none, so `toPortalEntry` falls back to guessing Greenhouse for every company
 * and quietly misses everyone on Ashby or Lever. Here the vendor is known, so
 * the guess is right first time.
 *
 * `board.id` is the board slug from the page's own bootstrap JSON. `isParent`
 * is required by the API; omitting the whole board object 422s.
 */
const SEQUOIA_BOARD_URL = 'https://jobs.sequoiacap.com/api-boards/search-companies';
const SEQUOIA_BOARD_ID = 'sequoia-capital';
/** Same board API; returns postings, whose URLs carry the real ATS board token. */
const SEQUOIA_JOBS_URL = 'https://jobs.sequoiacap.com/api-boards/search-jobs';
/** Server caps the page size; 25 is what the board's own client requests. */
const SEQUOIA_PAGE_SIZE = 25;
/** Safety rail on the cursor walk (~254 companies today, so 40 pages is ample). */
const SEQUOIA_MAX_PAGES = 40;

/**
 * Consider `jobSources[].value` -> the ATS vendor names toPortalEntry understands.
 *
 * Deliberately partial. Vendors career-ops has no provider for (comeet, gem,
 * rippling, workday, ...) are left unmapped so the entry falls through to the
 * slug guess rather than being handed a board URL nothing can read.
 */
const SEQUOIA_ATS_VENDORS = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashbyhq: 'ashby',
  ashby: 'ashby',
};

// ── HTTP helper (local — avoids importing providers/_http.mjs to keep seeds/ self-contained) ──

/**
 * Minimal fetch wrapper with timeout + user-agent header.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, method, headers, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      // The three GET rungs pass none of these and keep their exact previous
      // request shape; the Sequoia rung needs a POST with a JSON body. Caller
      // headers are merged over the default UA rather than replacing it, so a
      // POST still identifies itself the same way a GET does.
      ...(method ? { method } : {}),
      ...(body === undefined ? {} : { body }),
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...(headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = await res.text().catch(() => '').then(t => t.slice(0, 200));
      throw new Error(`HTTP ${res.status}${snippet ? ': ' + snippet.replace(/\s+/g, ' ').trim() : ''}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Shared types (JSDoc only — no runtime cost) ──────────────────────

/**
 * A single VC-portfolio company entry — the output unit of both seed fetchers.
 *
 * @typedef {object} SeedCompany
 * @property {string}   name            Display name, e.g. "Stripe".
 * @property {string}   slug            URL-safe slug, validated against SLUG_RE.
 * @property {string}   url             Company website URL.
 * @property {string}   [ats]           ATS platform if detectable: 'greenhouse' | 'lever' | 'ashby'.
 * @property {string}   [ats_id]        ATS board/org slug for URL construction.
 * @property {string}   [source]        Which VC list this came from: 'yc' | 'a16z' | 'index'.
 * @property {string}   [batch]         YC batch label, e.g. "W21" (YC only).
 */

/**
 * A PortalEntry-compatible object ready to be passed to ATS provider.detect().
 * Shape matches the PortalEntry typedef in providers/_types.js.
 *
 * @typedef {object} SeedPortalEntry
 * @property {string} name
 * @property {string} careers_url   Best-effort ATS or website URL.
 * @property {string} [source]      Seed origin ('yc' | 'a16z' | 'index').
 */

// ── Pure parser: YC ──────────────────────────────────────────────────

/**
 * Parse a raw YC API response payload into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects.
 * The YC API returns a paginated JSON object:
 *   { companies: [{ id, name, slug, website, batch, ... }], ... }
 *
 * @param {unknown} payload   Parsed JSON from the YC API (or a fixture in tests).
 * @returns {SeedCompany[]}
 */
export function parseYCPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = /** @type {any} */ (payload);
  const list = Array.isArray(raw.companies) ? raw.companies : (Array.isArray(raw) ? raw : []);
  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;

    // Prefer explicit slug; derive from name as fallback.
    const rawSlug = typeof item.slug === 'string' ? item.slug.trim()
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!rawSlug || !SLUG_RE.test(rawSlug)) continue;

    // Deduplicate by slug.
    if (seen.has(rawSlug)) continue;

    const url = typeof item.website === 'string' && item.website.startsWith('http')
      ? item.website.trim()
      : (typeof item.url === 'string' && item.url.startsWith('http') ? item.url.trim() : '');

    /** @type {SeedCompany} */
    const entry = {
      name,
      slug: rawSlug,
      url,
      source: 'yc',
    };

    if (typeof item.batch === 'string' && item.batch.trim()) {
      entry.batch = item.batch.trim();
    }

    seen.set(rawSlug, entry);
  }

  return [...seen.values()];
}

// ── Pure parser: a16z ────────────────────────────────────────────────

/**
 * Parse raw a16z portfolio HTML into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects.
 * The a16z portfolio page lists companies in anchor tags with data attributes.
 * We extract company names and URLs from the HTML without a full DOM parser —
 * matching patterns like:
 *   <a ... href="https://company.com" ... data-company-name="Stripe" ...>
 *   or <h3 class="...">Stripe</h3> adjacent to a link
 *
 * Strategy: look for JSON-LD structured data first (most reliable), then
 * fall back to pattern-matching anchor/heading text.
 *
 * @param {string} html    Raw HTML from the a16z portfolio page (or a fixture in tests).
 * @returns {SeedCompany[]}
 */
export function parseA16zPayload(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();

  // Strategy 1: JSON-LD embedded in the page (structured data block).
  // a16z sometimes embeds schema.org/Organization blocks — extract if present.
  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'Organization' || item?.['@type'] === 'Corporation') {
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          const url = typeof item.url === 'string' ? item.url.trim() : '';
          if (!name) continue;
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
          seen.set(slug, { name, slug, url, source: 'a16z' });
        }
      }
    } catch {
      // Malformed JSON-LD — skip silently.
    }
  }

  // Strategy 2: data-company-name attributes (a16z uses React-rendered data attrs).
  // Pattern: data-company-name="Stripe" (optionally with data-company-url)
  const dataAttrRe = /data-company-name=["']([^"']+)["'](?:[^>]*data-company-url=["']([^"']+)["'])?/gi;
  for (const match of html.matchAll(dataAttrRe)) {
    const name = match[1]?.trim();
    const url = match[2]?.trim() || '';
    if (!name) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.set(slug, { name, slug, url, source: 'a16z' });
  }

  // Strategy 3: Portfolio card anchors / heading text fallback.
  // Matches patterns like: <a href="https://stripe.com" class="...portfolio...">Stripe</a>
  // or company names in h3/h4 elements within portfolio sections.
  const portfolioAnchorRe = /<a\s+[^>]*href=["'](https?:\/\/[^"'?\s]+)["'][^>]*class=["'][^"']*(?:portfolio|company|card)[^"']*["'][^>]*>\s*([A-Z][^<]{1,60}?)\s*<\/a>/gi;
  for (const match of html.matchAll(portfolioAnchorRe)) {
    const url = match[1]?.trim();
    const name = match[2]?.trim().replace(/\s+/g, ' ');
    if (!name || !url) continue;
    // Filter out nav/generic link text.
    if (/^(read more|learn more|visit|see all|view|more|news|blog|press|contact)/i.test(name)) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.set(slug, { name, slug, url, source: 'a16z' });
  }

  return [...seen.values()];
}

// ── Pure parser: Index Ventures ──────────────────────────────────────

/**
 * Decode the handful of HTML entities that show up in portfolio company names.
 *
 * Not a general-purpose decoder: names are short plain text, and the only
 * entities observed in the wild are the ampersand ones ("Bloom &amp; Wild",
 * "Ben &#38; Jerry"-style) plus quotes. Anything else is left verbatim rather
 * than guessed at — a name is user-visible output, so a wrong expansion is
 * worse than an untouched entity.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeNameEntities(text) {
  return text
    .replace(/&(?:#0*38|#x0*26|amp);/gi, '&')
    .replace(/&(?:#0*39|#x0*27|apos|rsquo);/gi, "'")
    .replace(/&(?:#0*34|#x0*22|quot);/gi, '"')
    .replace(/&(?:#0*60|#x0*3c|lt);/gi, '<')
    .replace(/&(?:#0*62|#x0*3e|gt);/gi, '>')
    .replace(/&(?:#0*160|#x0*a0|nbsp);/gi, ' ');
}

/**
 * Strip a trailing legal-entity suffix from a company name.
 *
 * "CodeSignal, Inc." and "ApplyBoard Inc." are the same board as "codesignal"
 * and "applyboard" as far as any ATS is concerned; leaving the suffix in place
 * would derive `codesignal-inc` and miss the board entirely.
 *
 * @param {string} name
 * @returns {string}
 */
function stripLegalSuffix(name) {
  return name
    .replace(/[,\s]+(?:Inc|Incorporated|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|GmbH|AG|BV|B\.V|NV|N\.V|SA|S\.A|SAS|S\.A\.S|SL|S\.L|AB|AS|A\/S|Oy|PLC|P\.L\.C|Pty|PBC)\.?$/i, '')
    .trim();
}

/**
 * Parse raw Index Ventures portfolio HTML into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects.
 *
 * The page server-renders the full list as plain detail-page anchors:
 *   <a href="/companies/personio/">Personio</a>
 *
 * Two deliberate choices:
 *
 *  - **The slug comes from the NAME, not from Index's own path segment.** Index
 *    routes Wiz at `/companies/wizio/` and Abacus.ai at `/companies/abacusai/`;
 *    those are Index's internal identifiers and have no relationship to the
 *    company's ATS board slug. Deriving from the display name is what YC and
 *    a16z already do and is the guess most likely to hit a real board.
 *  - **No website URL is recorded.** The only href on offer points back at
 *    indexventures.com, and putting that in `url` would make toPortalEntry's
 *    last-resort fallback hand the scanner a VC marketing page instead of a
 *    careers page. An empty url makes it fall through to the slug-based ATS
 *    guess, which is the correct behaviour here.
 *
 * @param {string} html    Raw HTML from the Index portfolio page (or a fixture in tests).
 * @returns {SeedCompany[]}
 */
export function parseIndexPayload(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();

  // Accept both the root-relative form the live page emits and an absolute one,
  // so a mirrored or proxied copy of the page parses identically. The trailing
  // `[\s\S]{1,160}?` tolerates the wrapper markup Index puts inside the anchor.
  const anchorRe = /<a\b[^>]*href=["'](?:https?:\/\/[^"'/]*indexventures\.com)?\/companies\/([A-Za-z0-9._-]+)\/?["'][^>]*>([\s\S]{1,160}?)<\/a>/gi;

  for (const match of html.matchAll(anchorRe)) {
    const rawText = match[2] ?? '';
    // Anchor text may wrap the name in spans/headings; strip tags, collapse space.
    const name = stripLegalSuffix(
      decodeNameEntities(rawText.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    if (!name || name.length > 60) continue;

    // Nav and CTA links live under the same path prefix on some page revisions.
    if (/^(all|read more|learn more|view all|see all|more|companies|portfolio|next|previous)$/i.test(name)) continue;

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;

    seen.set(slug, { name, slug, url: '', source: 'index' });
  }

  return [...seen.values()];
}

/**
 * Parse a Consider `search-companies` response into SeedCompany entries.
 *
 * This is the testable unit — pure, no network, no side effects. Accepts either
 * the parsed object or the raw JSON string, so a fixture can be stored as text.
 *
 * Three choices worth stating, because they differ from the sibling parsers:
 *
 *  - **The ATS vendor is recorded when it is known.** `jobSources[]` names the
 *    vendor outright. Only vendors career-ops can actually read are mapped
 *    (see SEQUOIA_ATS_VENDORS); everything else is left unset so the entry
 *    falls through to the slug guess instead of getting an unreadable board URL.
 *  - **The slug is derived from the NAME, not from Consider's `slug`.** Same
 *    reasoning as the Index rung: Consider's slug is its own routing
 *    identifier. It usually agrees with the name-derived one, and where it does
 *    not, the name is the better guess at an ATS board token.
 *  - **The real company website IS recorded.** Index deliberately stores an
 *    empty url because the only href on offer points back at the VC. Consider
 *    carries `website.url` / `domain`, so toPortalEntry's last-resort fallback
 *    lands on the company's own site rather than a VC marketing page.
 *
 * @param {unknown} payload  Parsed Consider response, or the raw JSON string.
 * @returns {SeedCompany[]}
 */
export function parseSequoiaPayload(payload) {
  let data = payload;
  if (typeof data === 'string') {
    if (!data.trim()) return [];
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const companies = data && typeof data === 'object' ? data.companies : null;
  if (!Array.isArray(companies)) return [];

  /** @type {Map<string, SeedCompany>} */
  const seen = new Map();

  for (const raw of companies) {
    if (!raw || typeof raw !== 'object') continue;

    const name = stripLegalSuffix(
      decodeNameEntities(String(raw.name ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    if (!name || name.length > 60) continue;

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;

    // `website` is an object ({url, label}); `domain` is a bare hostname. Prefer
    // the explicit url, fall back to the domain, and never emit a bare hostname
    // as if it were a URL.
    let url = '';
    const site = raw.website;
    if (site && typeof site === 'object' && typeof site.url === 'string') url = site.url.trim();
    else if (typeof site === 'string') url = site.trim();
    else if (typeof raw.domain === 'string' && raw.domain.trim()) url = `https://${raw.domain.trim()}`;
    if (url && !/^https?:\/\//i.test(url)) url = '';

    /** @type {SeedCompany} */
    const entry = { name, slug, url, source: 'sequoia' };
    // Consider's own company id (its display-name key, e.g. "Gong"). Not part of
    // the portal entry — it is the filter value the jobs endpoint accepts, and
    // resolveSequoiaAtsTokens() needs it to look up a real posting URL.
    if (typeof raw.id === 'string' && raw.id.trim()) entry.considerId = raw.id.trim();
    // Consider's own slug, kept separately from the name-derived `slug`. The two
    // disagree often (Consider routes "Mach Industries" as one thing, the name
    // rule derives another), and the jobs endpoint echoes ITS slug back — so the
    // identity guard in resolveSequoiaAtsTokens has to compare against this one.
    if (typeof raw.slug === 'string' && raw.slug.trim()) entry.considerSlug = raw.slug.trim();

    // Vendor hint. Consider lists the busiest source first; take the first one
    // career-ops actually has a provider for rather than blindly the first.
    const sources = Array.isArray(raw.jobSources) ? raw.jobSources : [];
    for (const js of sources) {
      const value = typeof js === 'string' ? js : js && typeof js === 'object' ? js.value ?? js.id : null;
      const vendor = value ? SEQUOIA_ATS_VENDORS[String(value).toLowerCase()] : null;
      if (vendor) {
        entry.ats = vendor;
        entry.ats_id = slug;
        break;
      }
    }

    seen.set(slug, entry);
  }

  return [...seen.values()];
}

/**
 * Recover the real ATS board token from a posting URL.
 *
 * This is what fixes the seed's biggest weakness. Deriving a board token from a
 * company's display name is a guess, and it is wrong often enough to matter:
 * Gong's Greenhouse board is `gongio`, Mach Industries' Ashby board is `mach`.
 * A posting URL is not a guess — it is where the board actually lives.
 *
 * Only the three vendors career-ops has providers for are recognised. A
 * Workday, Rippling or custom-domain URL returns null so the caller keeps
 * whatever it already had rather than storing a token nothing can read.
 *
 * Custom-domain Greenhouse links (`hex.tech/careers/123?gh_jid=456`) are
 * deliberately NOT resolved: the gh_jid proves the vendor but the host is the
 * company's own, so the board token is not present in the URL at all.
 *
 * @param {string} url  A posting URL from the Consider jobs endpoint.
 * @returns {{ats: string, ats_id: string}|null}
 */
export function extractAtsFromJobUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // Split on '/' and drop empties so a leading or doubled slash cannot shift
  // which segment is read as the token.
  const seg = parsed.pathname.split('/').filter(Boolean);
  const token = seg[0] ? decodeURIComponent(seg[0]) : '';
  if (!token || !SLUG_RE.test(token)) return null;

  if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') {
    return { ats: 'greenhouse', ats_id: token };
  }
  // Greenhouse's EU boards live on a separate host with the same path shape.
  if (host === 'job-boards.eu.greenhouse.io' || host === 'boards.eu.greenhouse.io') {
    return { ats: 'greenhouse', ats_id: token };
  }
  if (host === 'jobs.ashbyhq.com') {
    return { ats: 'ashby', ats_id: token };
  }
  if (host === 'jobs.lever.co') {
    return { ats: 'lever', ats_id: token };
  }

  // Workday and Rippling differ in kind from the three above: their board root
  // cannot be rebuilt from a slug, so there is nothing for toPortalEntry to
  // construct. Both carry the root inside the posting URL, so it is returned
  // verbatim as `careersUrl` and toPortalEntry uses it as-is.
  //
  // Workday: https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>/job/...
  // The optional locale segment is part of the board root — dropping it gives
  // providers/workday.mjs a URL its own tenant pattern will not match.
  const workday = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/((?:[a-z]{2}-[A-Z]{2}\/)?[^/?#]+)/);
  if (workday) {
    const [, tenant, instance, sitePath] = workday;
    return {
      ats: 'workday',
      ats_id: tenant,
      careersUrl: `https://${tenant}.${instance}.myworkdayjobs.com/${sitePath}`,
    };
  }

  // Rippling: https://ats.rippling.com/<slug>/jobs/<id>  ->  board is /<slug>.
  if (host === 'ats.rippling.com') {
    return { ats: 'rippling', ats_id: token, careersUrl: `https://ats.rippling.com/${token}` };
  }

  return null;
}

// ── Generic pure parser (entry point for test-all.mjs) ───────────────

/**
 * Parse a raw seed payload (either YC JSON or a16z HTML) into validated
 * SeedCompany entries. This is the universal testable unit cited in the
 * issue acceptance criteria.
 *
 * @param {unknown} payload             JSON object (YC) or HTML string (a16z, Index).
 * @param {'yc'|'a16z'|'index'} source  Which VC portfolio this payload came from.
 * @returns {SeedCompany[]}
 */
export function parseSeedEntries(payload, source) {
  // HTML-payload sources are routed explicitly: each one has its own markup and
  // its own parser, and passing HTML to the YC default would silently return [].
  if (source === 'a16z') {
    return parseA16zPayload(typeof payload === 'string' ? payload : '');
  }
  if (source === 'index') {
    return parseIndexPayload(typeof payload === 'string' ? payload : '');
  }
  // Sequoia is JSON, not HTML: pass the payload through untouched so an already
  // parsed object and a raw JSON string both work.
  if (source === 'sequoia') {
    return parseSequoiaPayload(payload);
  }
  // Default: YC (also used for unknown sources — parse defensively).
  return parseYCPayload(payload);
}

// ── toPortalEntry converter ──────────────────────────────────────────

/**
 * Convert a SeedCompany into a PortalEntry-shaped object that ATS provider
 * detect() can consume directly.
 *
 * Resolution order for careers_url:
 *  1. If `company.ats === 'greenhouse'` and `company.ats_id` is set → Greenhouse board URL.
 *  2. If `company.ats === 'lever'` and `company.ats_id` is set → Lever URL.
 *  3. If `company.ats === 'ashby'` and `company.ats_id` is set → Ashby URL.
 *  4. Derive from slug: try Greenhouse, Lever, Ashby URLs (provider.detect() will
 *     validate at scan time; if none match, the entry is skipped with a warning).
 *  5. Fallback: company website URL (the ATS may be on a custom subdomain).
 *
 * @param {SeedCompany} company
 * @returns {SeedPortalEntry}
 */
export function toPortalEntry(company) {
  let careers_url = '';

  // An explicit board URL recovered from a live posting beats anything derived.
  // Workday and Rippling boards cannot be rebuilt from a slug at all, so without
  // this they fall through to a Greenhouse guess that is wrong by construction.
  if (typeof company.careersUrl === 'string' && /^https:\/\//i.test(company.careersUrl)) {
    return { name: company.name, careers_url: company.careersUrl, source: company.source };
  }

  // Explicit ATS hint from the YC dataset.
  const atsId = company.ats_id && SLUG_RE.test(company.ats_id) ? company.ats_id : null;
  if (atsId) {
    if (company.ats === 'greenhouse') {
      careers_url = `https://job-boards.greenhouse.io/${atsId}`;
    } else if (company.ats === 'lever') {
      careers_url = `https://jobs.lever.co/${atsId}`;
    } else if (company.ats === 'ashby') {
      careers_url = `https://jobs.ashbyhq.com/${atsId}`;
    }
  }

  // No explicit ATS: try Greenhouse by slug (most common for YC companies), then
  // Lever, then Ashby — provider.detect() will confirm or skip at scan time.
  if (!careers_url && company.slug && SLUG_RE.test(company.slug)) {
    // Use a format that greenhouse.mjs detect() can match.
    careers_url = `https://job-boards.greenhouse.io/${company.slug}`;
  }

  // Last resort: company website (ATS may auto-detect from the domain).
  if (!careers_url) {
    careers_url = company.url || '';
  }

  return {
    name: company.name,
    careers_url,
    source: company.source,
  };
}

// ── Network fetchers ─────────────────────────────────────────────────

/**
 * Fetch the Y Combinator public company list and return parsed SeedCompany entries.
 *
 * Uses the public YC API (no auth, no API key). The response is a JSON object
 * with a `companies` array plus `page`/`totalPages` pagination fields. The API
 * caps page size server-side (~30/page; `per_page` is ignored), so the whole
 * portfolio is walked page by page, newest batches first.
 *
 * @param {{ timeoutMs?: number, maxPages?: number }} [opts] - `maxPages` is
 *   clamped to YC_MAX_PAGES, which is a hard ceiling; pagination normally stops
 *   at the API-reported last page.
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchYCCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = YC_MAX_PAGES } = {}) {
  /** @type {SeedCompany[]} */
  const all = [];
  const seen = new Set();

  // YC_MAX_PAGES is a hard ceiling: clamp here so an explicit maxPages (or a
  // stray Infinity) can never spin the walk past the runaway guard.
  const limit = Math.min(maxPages, YC_MAX_PAGES);

  let page = 1;
  for (let fetched = 0; fetched < limit; fetched++) {
    const url = `https://api.ycombinator.com/v0.1/companies?page=${page}&per_page=1000`;
    let payload;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs });
      payload = await res.json();
    } catch (err) {
      if (page === 1) throw new Error(`vc-portfolios: YC API fetch failed — ${err.message}`);
      break; // Partial data is fine after page 1.
    }

    const entries = parseYCPayload(payload);
    if (entries.length === 0) break; // No more companies.

    for (const e of entries) {
      if (!seen.has(e.slug)) {
        seen.add(e.slug);
        all.push(e);
      }
    }

    // The API caps page size server-side (~30/page; per_page is ignored) and
    // reports totalPages — follow its signal instead of guessing from batch size.
    const raw = /** @type {any} */ (payload);
    if (Number.isInteger(raw?.totalPages) && raw.totalPages > 0) {
      if (page >= raw.totalPages) break;
      page += 1;
      continue;
    }
    // When totalPages is absent, follow the nextPage target the API hands back
    // rather than stopping — tolerating a bare number, a page=N fragment, or a
    // full URL, and requiring forward progress so it can't spin. This is the
    // case that bites the day YC changes the response shape again.
    const next = parseYCNextPage(raw?.nextPage);
    if (next == null || next <= page) break;
    page = next;
  }

  return all;
}

/**
 * Extract the next page number from the YC API's `nextPage` field, which may be
 * a bare page number, a `page=N` query fragment, or a full URL carrying a
 * `page=N` query param. Returns null when no forward page number can be read.
 *
 * @param {unknown} nextPage
 * @returns {number | null}
 */
export function parseYCNextPage(nextPage) {
  if (nextPage == null || nextPage === false) return null;
  if (typeof nextPage === 'number') {
    return Number.isInteger(nextPage) && nextPage > 0 ? nextPage : null;
  }
  if (typeof nextPage === 'string') {
    const m = nextPage.match(/(?:^|[?&/])page[=/](\d+)/) || nextPage.match(/^\s*(\d+)\s*$/);
    if (m) {
      const n = Number(m[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Fetch the a16z public portfolio page and return parsed SeedCompany entries.
 *
 * a16z does not expose a public JSON API, so we fetch the HTML portfolio page
 * and parse it with `parseA16zPayload()`.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchA16zCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let html;
  try {
    const res = await fetchWithTimeout(A16Z_PORTFOLIO_URL, { timeoutMs });
    html = await res.text();
  } catch (err) {
    throw new Error(`vc-portfolios: a16z portfolio fetch failed — ${err.message}`);
  }
  return parseA16zPayload(html);
}

/**
 * Fetch the Index Ventures public portfolio page and return parsed SeedCompany entries.
 *
 * Index exposes no JSON API, but the companies page is fully server-rendered,
 * so a single zero-auth GET is enough — no per-company follow-up requests.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchIndexCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let html;
  try {
    const res = await fetchWithTimeout(INDEX_PORTFOLIO_URL, { timeoutMs });
    html = await res.text();
  } catch (err) {
    throw new Error(`vc-portfolios: Index Ventures portfolio fetch failed — ${err.message}`);
  }
  return parseIndexPayload(html);
}

/**
 * Fetch Sequoia's Consider-hosted board and return parsed SeedCompany entries.
 *
 * The board renders client-side, so this posts to the same public JSON endpoint
 * its own client uses. Paging is a base64 cursor echoed back as `meta.sequence`;
 * the walk stops when a page returns no companies, repeats a cursor, or hits
 * `maxPages`. Cursor loops are the failure mode that turns a seed fetch into an
 * infinite one, so a repeated cursor is treated as end-of-list, not as an error.
 *
 * Partial results are kept: a mid-walk failure returns what was already
 * collected rather than throwing away several successful pages, which matches
 * how fetchYCCompanies treats its own pagination.
 *
 * @param {{ timeoutMs?: number, maxPages?: number }} [opts]
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchSequoiaCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = SEQUOIA_MAX_PAGES, resolveAts = true } = {}) {
  /** @type {Map<string, SeedCompany>} */
  const collected = new Map();
  const seenCursors = new Set();
  let sequence = null;

  for (let page = 0; page < maxPages; page++) {
    const meta = sequence ? { size: SEQUOIA_PAGE_SIZE, sequence } : { size: SEQUOIA_PAGE_SIZE };
    let body;
    try {
      const res = await fetchWithTimeout(SEQUOIA_BOARD_URL, {
        timeoutMs,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          query: { promoteFeatured: true },
          meta,
          board: { id: SEQUOIA_BOARD_ID, isParent: true },
        }),
      });
      body = await res.json();
    } catch (err) {
      // First page failing means the rung produced nothing — that is a real
      // error. A later page failing still leaves usable companies behind.
      if (page === 0) throw new Error(`vc-portfolios: Sequoia board fetch failed — ${err.message}`);
      break;
    }

    const batch = parseSequoiaPayload(body);
    for (const company of batch) {
      if (!collected.has(company.slug)) collected.set(company.slug, company);
    }
    if (batch.length === 0) break;

    const next = body && body.meta ? body.meta.sequence : null;
    if (!next || typeof next !== 'string' || seenCursors.has(next)) break;
    seenCursors.add(next);
    sequence = next;
  }

  const companies = [...collected.values()];

  // Board tokens guessed from a display name are wrong often enough that the
  // majority of this seed's entries were unreachable without this step. It is
  // on by default because a seed that mostly resolves to dead boards is not
  // worth having; `resolveAts: false` keeps the fetch to a single cursor walk
  // for callers that only want the company list.
  if (resolveAts && companies.length) {
    try {
      await resolveSequoiaAtsTokens(companies, { timeoutMs });
    } catch {
      // Enrichment is strictly additive — never let it lose the company list.
    }
  }

  return companies;
}

/** Jobs per page when harvesting board tokens. The API accepts 500. */
const SEQUOIA_JOBS_PAGE_SIZE = 500;
/** Page budget for the harvest — ~9.7k jobs today, so 24 pages covers the board. */
const SEQUOIA_JOBS_MAX_PAGES = 24;

/**
 * Replace guessed ATS board tokens with the real ones, read from live postings.
 *
 * The seed's weak point is that a board token is guessed from the company's
 * display name. Measured against the live board that guess left 168 of 254
 * companies unreachable: Gong's Greenhouse board is `gongio`, Fireworks AI's is
 * `fireworksai`, Ironclad's Ashby board is `ironcladhq`. The token is simply not
 * derivable from the name, so no better slug rule fixes this — the board has to
 * be asked.
 *
 * It is asked in BULK. The obvious implementation queries the jobs endpoint once
 * per company; that is 254 requests, and it got rate-limited hard enough to
 * truncate the company walk itself (254 companies became 200) while taking 100s.
 * Paging the unfiltered jobs list at 500/page covers the same ground in ~20
 * requests, because one posting is enough to locate a company's board and every
 * page carries hundreds of companies' worth of postings.
 *
 * The walk stops early once every company has been located, so a board where the
 * first pages happen to cover everything costs only those pages.
 *
 * Failures are non-fatal: anything unresolved keeps the name-derived guess, so
 * this can only improve the result.
 *
 * @param {SeedCompany[]} companies  Entries from parseSequoiaPayload().
 * @param {{ timeoutMs?: number, maxPages?: number }} [opts]
 * @returns {Promise<{resolved: number, corrected: number, pages: number}>} Mutates `companies` in place.
 */
export async function resolveSequoiaAtsTokens(companies, { timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = SEQUOIA_JOBS_MAX_PAGES } = {}) {
  // Index by Consider's own slug: that is what the jobs records echo back. The
  // name-derived slug disagrees for a fair number of companies, and matching on
  // it silently drops those.
  const byConsiderSlug = new Map();
  for (const company of companies) {
    const key = company?.considerSlug || company?.slug;
    if (key && !byConsiderSlug.has(key)) byConsiderSlug.set(key, company);
  }

  const located = new Set();
  let resolved = 0;
  let corrected = 0;
  let pages = 0;
  let sequence = null;
  const seenCursors = new Set();

  for (let page = 0; page < maxPages; page++) {
    // Everything already located — stop paying for pages that cannot teach us
    // anything new.
    if (located.size >= byConsiderSlug.size) break;

    const meta = sequence ? { size: SEQUOIA_JOBS_PAGE_SIZE, sequence } : { size: SEQUOIA_JOBS_PAGE_SIZE };
    let body;
    try {
      const res = await fetchWithTimeout(SEQUOIA_JOBS_URL, {
        timeoutMs,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          meta,
          query: {},
          board: { id: SEQUOIA_BOARD_ID, isParent: true },
          grouped: false,
        }),
      });
      body = await res.json();
    } catch {
      // Keep whatever has been resolved so far rather than discarding it.
      break;
    }
    pages++;

    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const key = job?.companySlug;
      if (!key || located.has(key)) continue;
      const company = byConsiderSlug.get(key);
      if (!company) continue;

      const hit = extractAtsFromJobUrl(job.url || job.applyUrl || '');
      // A Workday/custom-domain posting cannot locate a board. Leave the company
      // unlocated so a later page carrying a first-party URL can still fix it.
      if (!hit) continue;

      const changed = company.ats !== hit.ats || company.ats_id !== hit.ats_id;
      company.ats = hit.ats;
      company.ats_id = hit.ats_id;
      // Vendors whose board root is not reconstructible from a slug hand back an
      // explicit URL; toPortalEntry prefers it over anything it could build.
      if (hit.careersUrl) company.careersUrl = hit.careersUrl;
      located.add(key);
      resolved++;
      if (changed) corrected++;
    }

    const next = body?.meta?.sequence;
    if (!next || typeof next !== 'string' || seenCursors.has(next)) break;
    seenCursors.add(next);
    sequence = next;
  }

  return { resolved, corrected, pages };
}

// ── SEED_SOURCES registry ────────────────────────────────────────────

/**
 * Registry mapping seed source names to their fetch functions.
 * Consumed by scan-ats-full.mjs --seeds flag and CLI tooling.
 *
 * To add a new VC portfolio:
 *  1. Add a fetchXyzCompanies() function above.
 *  2. Add an entry here: { fetch: fetchXyzCompanies, label: 'XYZ Portfolio' }
 *
 * @type {Record<string, { fetch: (opts?: object) => Promise<SeedCompany[]>, label: string }>}
 */
export const SEED_SOURCES = {
  yc: {
    fetch: fetchYCCompanies,
    label: 'Y Combinator Portfolio',
  },
  a16z: {
    fetch: fetchA16zCompanies,
    label: 'Andreessen Horowitz (a16z) Portfolio',
  },
  index: {
    fetch: fetchIndexCompanies,
    label: 'Index Ventures Portfolio',
  },
  sequoia: {
    fetch: fetchSequoiaCompanies,
    label: 'Sequoia Capital Portfolio',
  },
};
