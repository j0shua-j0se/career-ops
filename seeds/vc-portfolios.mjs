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
 *   node scan-ats-full.mjs --seeds yc,a16z,index --since 7 --dry-run
 *
 * Direct usage:
 *   import { fetchYCCompanies, fetchA16zCompanies } from './seeds/vc-portfolios.mjs';
 *   const companies = await fetchYCCompanies();
 */

// ── Constants ────────────────────────────────────────────────────────

/**
 * Safe charset for slug values that will be interpolated into ATS URLs.
 * Consistent with the SLUG_RE guard in scan-ats-full.mjs.
 */
export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops-seeds/1.0)';

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

// ── HTTP helper (local — avoids importing providers/_http.mjs to keep seeds/ self-contained) ──

/**
 * Minimal fetch wrapper with timeout + user-agent header.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DEFAULT_USER_AGENT },
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
 * with a `companies` array. We fetch page 1 with a large per_page to get the
 * most recent batch; subsequent pages can be fetched if needed (most users want
 * the latest batch anyway).
 *
 * @param {{ timeoutMs?: number, maxPages?: number }} [opts]
 * @returns {Promise<SeedCompany[]>}
 */
export async function fetchYCCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = 3 } = {}) {
  /** @type {SeedCompany[]} */
  const all = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
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
    if (entries.length === 0) break; // No more pages.

    for (const e of entries) {
      if (!seen.has(e.slug)) {
        seen.add(e.slug);
        all.push(e);
      }
    }

    // The YC API pagination: stop when we receive fewer than 1000 companies.
    const raw = /** @type {any} */ (payload);
    const batchSize = Array.isArray(raw?.companies) ? raw.companies.length : 0;
    if (batchSize < 1000) break;
  }

  return all;
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
};
