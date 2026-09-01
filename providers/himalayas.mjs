// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { sleep } from './_http.mjs';

// Himalayas provider - board-wide remote jobs API
// (https://himalayas.app/jobs/api?limit=50). Returns { jobs: [...] }. The
// full feed is fetched, page by page, so scan.mjs's title_filter /
// location_filter can do the local gating consistently with other zero-token
// board providers.
//
// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION — verified live 2026-09-01
//
// `?limit=50` does NOT change the page size. The API hard-caps every page at
// 20 jobs regardless of the requested `limit` (confirmed: requesting 50 and
// getting back exactly 20, with the response's own `limit` field reporting
// 20). The response also carries `totalCount` (~105,800+ live) and a cursor:
//
//   GET https://himalayas.app/jobs/api?limit=50
//   → { comments, updatedAt, offset, limit, totalCount, nextCursor, jobs: [...] }
//
// `nextCursor` is an opaque base64 string (decodes to `{isoTimestamp}|{id}` —
// e.g. `2026-09-01T08:25:40.535768Z|2138589` — but it is treated as opaque
// here; only the API is meant to interpret it). Fetching the next page means
// passing it straight back as a `cursor` query param:
//
//   GET https://himalayas.app/jobs/api?limit=50&cursor={nextCursor}
//
// Verified this actually advances (not just echoes page 1): zero job-guid
// overlap between two successive pages, and pubDate continues its descending
// (newest-first) order across the page boundary with no gap or repeat.
//
// Exhaustion: once the cursor has walked past the oldest available posting,
// the response comes back `{ ..., jobs: [] }` with NO `nextCursor` key at
// all (`undefined`, not `null` or `""`) — that combination is the stop
// signal. An invalid/garbage cursor is a distinct, real error: HTTP 400 with
// body `{"ok":false,"errors":"Invalid cursor."}` — since every cursor this
// provider sends is one the API itself returned, that path is not expected
// to trigger in normal operation, and ctx.fetchJson's non-2xx guard throws
// rather than swallowing it.
//
// The board has ~105,800+ live postings at 20/page (~5,300 pages) — walking
// all of it every scan would be both slow and impolite, so this provider
// bounds itself the way the other multi-page providers do (see avature.mjs,
// radancy.mjs, arbeitnow.mjs): a per-entry `max_pages` / `max_jobs` override,
// each clamped to a hard ceiling, plus a polite delay between page requests.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.

const FEED_BASE = 'https://himalayas.app/jobs/api';
const TRUSTED_HOST = 'himalayas.app';

// Requested page size. The API currently ignores this and always serves 20 —
// sent anyway in case that ever changes; parsing does not depend on the value.
const REQUEST_LIMIT = 50;

// 25 pages (~500 postings) is the default because this provider runs inside a
// curated portal scan alongside forty other boards, not on its own. At 100
// pages the walk took longer than the whole rest of the scan and timed it out
// — a board that returns nothing because it never finished is no better than
// the 20-posting cap this pagination was added to fix. The date window below
// is the bound that actually matters; this is the backstop for when there is
// no window to work with.
const DEFAULT_MAX_PAGES = 25; // ~500 postings at the observed 20/page
const MAX_PAGES_CAP = 500; // ~10,000 postings hard ceiling, even with an override
const DEFAULT_MAX_JOBS = 2000; // default cap on total postings pulled

// Pause between successive page requests. A full walk to the default cap is
// 100 sequential requests to one host; mirrors avature's/radancy's
// INTER_PAGE_DELAY_MS so a wide max_pages override doesn't read as a burst.
const INTER_PAGE_DELAY_MS = 150;

/** @param {string} url */
function assertHimalayasUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`himalayas: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`himalayas: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`himalayas: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Build a feed page URL. First page omits `cursor`; later pages pass back
 * exactly the `nextCursor` string the previous response returned.
 * @param {string} [cursor]
 */
function buildFeedUrl(cursor) {
  const u = new URL(FEED_BASE);
  u.searchParams.set('limit', String(REQUEST_LIMIT));
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.href;
}

// The page-1 URL, e.g. for detect()'s informational return value.
const FEED_URL = buildFeedUrl();

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** Resolve the total-postings cap: a positive integer `max_jobs` on the entry, else default. */
function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return v;
  return DEFAULT_MAX_JOBS;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanHimalayasUrl(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function locationText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .join(', ');
}

// Himalayas pubDate is currently epoch seconds. Accept milliseconds and
// parseable date strings too so the parser survives small API shape changes.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** @type {Provider} */
export default {
  id: 'himalayas',

  detect(entry) {
    return entry?.provider === 'himalayas' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings from the Himalayas public feed, walking
   * the cursor-paginated API until it's exhausted or a bound is hit.
   * @param {{ provider?: string, max_pages?: number, max_jobs?: number }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any>, sleep?: (ms: number) => Promise<void> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    let cursor;
    let totalCount;
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const feedUrl = assertHimalayasUrl(buildFeedUrl(cursor));
      // redirect:'error' prevents SSRF via server-side redirects; combined with
      // assertHimalayasUrl above it keeps the request pinned to himalayas.app.
      const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(
          `himalayas: unexpected API response on page ${page} - expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      if (Number.isFinite(json.totalCount)) totalCount = json.totalCount;

      const parsed = parseHimalayasResponse(json);
      jobs.push(...parsed);

      // The feed is pubDate-descending (verified: no overlap between successive
      // pages, order continuous across the boundary), so once a whole page sits
      // outside the caller's window every later page does too. This makes the
      // walk proportional to the window instead of to the page cap.
      //
      // Undated postings never trigger it: the stop fires only when the page
      // carried at least one dated posting and every dated one was too old. A
      // page of nothing but undated postings tells us nothing about where we
      // are in the timeline, so it is not evidence to stop on.
      if (Number.isFinite(ctx?.sinceMs)) {
        const dated = parsed.map((j) => j.postedAt).filter((t) => Number.isFinite(t));
        if (dated.length > 0 && dated.every((t) => t < ctx.sinceMs)) break;
      }

      // Exhaustion signal, confirmed live: an empty `jobs` array paired with no
      // `nextCursor` key at all (not "", not null). Either half missing on its
      // own is not trusted as "done" — only that combination is.
      const next = typeof json.nextCursor === 'string' && json.nextCursor.trim() ? json.nextCursor.trim() : '';
      if (json.jobs.length === 0 && !next) break;
      if (!next) break; // defensive: no cursor to continue with, even if this page wasn't empty

      if (jobs.length >= maxJobs) { truncated = true; break; }
      if (page === maxPages) { truncated = true; break; } // more pages remained (next is truthy) but the cap was hit

      cursor = next;
    }

    // Never truncate silently (AGENTS.md): with ~105,800+ live postings this
    // provider stops well short of the full board by design, so say so and
    // report the count actually returned rather than the pre-slice buffer.
    const returned = Math.min(jobs.length, maxJobs);
    if (truncated) {
      console.error(
        `⚠️  himalayas: truncated at ${returned} of ${totalCount ?? 'unknown'} postings`
        + ` — raise max_pages/max_jobs on this entry for more`,
      );
    }
    return jobs.slice(0, maxJobs);
  },
};

/**
 * Parse one Himalayas public jobs API page response. Exported for unit tests.
 *
 * Shape: `{ jobs: [...] }`, where each job currently carries `title`,
 * `companyName`, `locationRestrictions`, `applicationLink`, `guid`,
 * `pubDate`, and `companySlug`. `applicationLink` is preferred over `guid`
 * and used as the dedup key after HTTPS + host validation.
 *
 * @param {unknown} json - raw parsed API response (one page)
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseHimalayasResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.jobs)) return [];

  const jobs = [];
  for (const item of json.jobs) {
    if (!item || typeof item !== 'object') continue;

    const title = cleanText(item.title);
    if (!title) continue;

    const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
    if (!url) continue;

    jobs.push({
      title,
      url,
      company: cleanText(item.companyName),
      location: locationText(item.locationRestrictions),
      postedAt: toEpochMs(item.pubDate),
    });
  }

  return jobs;
}
