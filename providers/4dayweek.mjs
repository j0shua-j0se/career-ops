// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// 4 Day Week provider — board-wide aggregator of 4-day-week / reduced-hours
// roles. Public, zero-auth JSON API, v2: https://4dayweek.io/api/v2/jobs
//
// v1 (`/api/jobs`, the original wiring here) is NOT used. The site's
// robots.txt (verified 2026-09-01) reads:
//   Allow: /   Allow: /api/v1   Allow: /api/v2   Allow: /api/mcp   Disallow: /api/
// Under RFC 9309 longest-match, `/api/jobs` is matched only by the
// `Disallow: /api/` rule — none of the three `Allow:` carve-outs prefix-match
// a path that isn't `/api/v1…`, `/api/v2…` or `/api/mcp…`. `/api/v2/jobs` is
// unambiguously allowed. (`/api/v1/jobs` is also allowed by robots.txt but
// 404s live, so v2 is used exclusively — verified 2026-09-01.)
//
// Response shape (verified live against GET /api/v2 — a self-describing
// index — and GET /api/v2/jobs, cross-checked with the published
// openapi.yaml's V2ListResponse/V2Job schemas; the live response's field
// names win where they disagree with the doc, e.g. the docs mention split
// `office_locations`/`remote_allowed` arrays but the wire shape is a single
// `locations[]`):
//   { data: [ { id, slug, title, url, work_arrangement, is_remote,
//       locations: [{ city, country, continent, work_arrangement, is_primary }],
//       posted_at (RFC3339 UTC), company: { name, ... }, ... } ],
//     page, limit, total, has_more }
//
// Unlike the old v1 feed, v2 supplies a ready-made absolute `url` per job, so
// building one from `slug` is only a fallback for a missing/malformed url.
// `posted_at` is an RFC3339 timestamp, not v1's epoch-seconds `posted`.
//
// v2 takes `posted_after` (an integer day-count, capped at 365 by the API
// itself) so a bounded `ctx.sinceMs` window can be pushed server-side instead
// of paginating through postings scan.mjs's own downstream date filter would
// discard anyway — mirrors how providers/workday.mjs is the only other
// provider that reads ctx.sinceMs. The param is omitted when the window is
// wider than the API can express, rather than sending a narrower cap that
// would silently exclude postings the caller still wants; scan.mjs's own
// filter is the backstop either way, so omitting only costs extra pages.
//
// Paginated via ?page=N&limit=100 (100 is the API's documented per-page max);
// bounded by max_pages (default 3, cap 50) and the `has_more` response flag.
// v2 lists live jobs only — no is_expired field or filter, unlike v1.
//
// Wire in via a `job_boards:` entry with `provider: 4dayweek`.

const API_BASE = 'https://4dayweek.io/api/v2';
const JOBS_ENDPOINT = `${API_BASE}/jobs`;
const TRUSTED_HOST = '4dayweek.io';
const JOB_BASE = `https://${TRUSTED_HOST}/job`;
const PAGE_SIZE = 100; // API-documented max `limit`
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const PAGE_DELAY_MS = 200; // polite pacing; well under the documented 60 req/min
const POSTED_AFTER_CAP_DAYS = 365; // the API's own cap on `posted_after`
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function detectFourDayEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider === '4dayweek') return { url: JOBS_ENDPOINT };
  if (entry.provider) return null;

  for (const value of [entry.api, entry.careers_url]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) {
        return { url: JOBS_ENDPOINT };
      }
    } catch {
      // Ignore malformed URLs; another provider may still claim the entry.
    }
  }
  return null;
}

/** @param {string} url */
function assertFourDayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`4dayweek: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`4dayweek: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`4dayweek: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// RFC3339 UTC → epoch ms. NaN-safe: a missing/unparseable timestamp yields undefined.
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Resolve the `posted_after` (days) query value from ctx.sinceMs, honouring
 * the API's own 365-day cap. Returns null when there is no bounded window,
 * or the window is wider than the API can express — an omitted param only
 * costs extra pagination (scan.mjs applies its own postedAt filter
 * downstream regardless), never incorrect results.
 *
 * Exported for unit tests.
 * @param {number | undefined | null} sinceMs
 * @param {number} [now]
 * @returns {number | null}
 */
export function resolvePostedAfterDays(sinceMs, now = Date.now()) {
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null;
  const days = Math.ceil((now - sinceMs) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days > POSTED_AFTER_CAP_DAYS) return null;
  return days;
}

/**
 * Normalize a single 4 Day Week v2 job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (postings without one are dropped).
 *   - url:      the API's own `url` when present and on 4dayweek.io;
 *               otherwise built as `https://4dayweek.io/job/<slug>` from a
 *               safe slug token. Dropped if neither yields a valid,
 *               same-host URL (defence in depth against a tampered response).
 *   - company:  `company.name`, falling back to the portal entry name, then
 *               "4 Day Week".
 *   - location: the primary `locations[]` entry (`is_primary`, else the
 *               first) as "city, country"; "Remote" is appended when the
 *               job's (or that location's) work_arrangement is "remote".
 *   - postedAt: `posted_at` (RFC3339 UTC) → epoch ms (omitted when absent
 *               or unparseable).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalize4dwJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const slug = typeof j.slug === 'string' ? j.slug.trim() : '';

  let url = typeof j.url === 'string' ? j.url.trim() : '';
  if (!url && SLUG_RE.test(slug)) url = `${JOB_BASE}/${encodeURIComponent(slug)}`;
  if (!url) return null;
  try {
    if (new URL(url).hostname !== TRUSTED_HOST) return null;
  } catch {
    return null;
  }

  const company =
    j.company && typeof j.company === 'object' && typeof j.company.name === 'string' && j.company.name.trim()
      ? j.company.name.trim()
      : typeof fallbackCompany === 'string' && fallbackCompany.trim()
        ? fallbackCompany.trim()
        : '4 Day Week';

  const locs = Array.isArray(j.locations) ? j.locations : [];
  const primary = locs.find((l) => l && typeof l === 'object' && l.is_primary === true) || locs[0] || {};
  const city = typeof primary.city === 'string' ? primary.city.trim() : '';
  const country = typeof primary.country === 'string' ? primary.country.trim() : '';
  const base = [city, country].filter(Boolean).join(', ');
  const remote = j.work_arrangement === 'remote' || primary.work_arrangement === 'remote';
  const location = [base, remote ? 'Remote' : ''].filter(Boolean).join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number }} */
  const job = { title, url, company, location };
  const postedAt = toEpochMs(j.posted_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: '4dayweek',

  detect: detectFourDayEntry,

  async fetch(entry, ctx) {
    assertFourDayUrl(JOBS_ENDPOINT);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const postedAfterDays = resolvePostedAfterDays(ctx?.sinceMs);
    const wait = (ms) => (ctx?.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await wait(PAGE_DELAY_MS);
      let url = `${JOBS_ENDPOINT}?page=${page}&limit=${PAGE_SIZE}&sort=date`;
      if (postedAfterDays !== null) url += `&posted_after=${postedAfterDays}`;
      // redirect:'error' prevents SSRF via server-side redirects
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.data)) {
        throw new Error(
          `4dayweek: unexpected API response on page ${page} — expected { data: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.data) {
        const normalized = normalize4dwJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.has_more === false) break; // last page per the API flag
      if (json.data.length < PAGE_SIZE) break; // short page → last page
    }
    return out;
  },
};
