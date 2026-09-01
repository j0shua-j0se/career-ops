// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// Infineon provider — single-company (pattern: deutschebahn/fau — no usable
// JSON API, so this reads the public job sitemap instead).
//
// ── Why the sitemap, not an API ─────────────────────────────────────────────
// jobs.infineon.com runs Eightfold AI's "PCSX" product. Both the tenant's own
// API and the shared Eightfold API are gated: verified live 2026-09-01,
//   GET https://jobs.infineon.com/api/apply/v2/jobs        -> 403 {"message":"Not authorized for PCSX"}
//   GET https://infineon.eightfold.ai/api/apply/v2/jobs    -> 403 {"message":"Not authorized for PCSX"}
// There is no usable JSON API to hit, and this provider does not attempt to
// defeat that gate.
//
// robots.txt (fetched 2026-09-01, `Disallow: /` by default) explicitly ALLOWS
// /careers and /api/apply, and names the sitemap:
//   Sitemap: https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com
// That index resolves (verified live 2026-09-01) to exactly two children:
//   sitemap.xml     — 1348 <loc> entries: the bare /careers landing page plus
//                      1347 /careers/job/{id}-{slug} postings
//   sitemap_cat.xml — 160 <loc> entries, all /careers/{code} category landing
//                      pages (e.g. /careers/hr, /careers/it) — not jobs
// This provider walks the index, fetches each child sitemap, and keeps only
// URLs matching /careers/job/{id}-{slug}.
//
// ── postedAt is deliberately OMITTED ─────────────────────────────────────
// Each <url> in sitemap.xml carries a <lastmod>, but that is a page-modification
// timestamp (when Infineon's CMS last rewrote that sitemap row), not a
// publication date — nothing in the sitemap ties it to when the posting first
// went live. Mapping it onto postedAt would feed a wrong number into recency
// filters, exactly the class of bug this session has been fighting elsewhere
// (beesite host drift, arbeitsagentur search-response fields). scan.mjs's
// buildPostingAgeFilter passes undated postings through, and the portal scan
// runs with includeUndated: true, so leaving Infineon jobs undated does not
// silently drop them.
//
// ── The slug ambiguity (the crux of this provider) ──────────────────────────
// A job URL carries NO delimiter between the title and the location:
//   /careers/job/563808969260056-staff-specialist-marketing-bangalore-india-
// Confirmed unreliable live (2026-09-01) — the same kind of posting appears
// with and without a trailing country word, and with and without a trailing
// dash, so there is no fixed position or fixed delimiter to split on:
//   ...-senior-staff-engineer-soc-implementation-munich                (no country, no trailing dash)
//   ...-internship-diversity-and-inclusion-f-m-div--munich-germany-    (country, trailing dash)
//   ...-senior-manager-digitalization-analytics-artificial-intelligence-dresden-germany-  (country, no trailing dash)
// Guessing a split point (e.g. "last word is the country, second-to-last is
// the city") would sometimes cut a title word off into `location` and
// sometimes leave a city sitting in `title` — a wrong location silently
// mis-filters a posting against portals.yml's location_filter, which is worse
// than no location at all. So this provider puts the WHOLE de-slugged text in
// `title` and leaves `location` empty, the same trade-off FAU accepted for
// the mirror-image problem (a bare listing with no way to find more postings).
// A `title_filter` in portals.yml still matches normally, since the location
// words are simply extra tokens at the end of the title string.

const SITEMAP_INDEX_URL = 'https://jobs.infineon.com/careers/sitemap_index.xml?domain=infineon.com';
const ALLOWED_HOSTS = ['jobs.infineon.com'];
const MAX_SITEMAPS = 5; // index currently lists 2 children; headroom for a future split
const MAX_JOBS = 2000; // live board carried ~1347 job URLs (verified 2026-09-01)
const SITEMAP_TIMEOUT_MS = 20_000; // sitemap.xml is a few hundred KB, server-generated
const REQUEST_DELAY_MS = 200; // polite pacing between the index and each child sitemap

/**
 * Mandatory SSRF guard: an explicit host allowlist on top of `_http.mjs`'s
 * baseline (which only blocks private/loopback/link-local addresses).
 * Mirrors `assertGreenhouseUrl` in greenhouse.mjs.
 * @param {string} url
 */
function assertInfineonUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`infineon: invalid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new Error(`infineon: URL must use HTTPS: ${url}`);
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new Error(`infineon: untrusted hostname "${host}" — must be jobs.infineon.com`);
  return u;
}

/** Extract every <loc> from a sitemap or sitemap-index document. */
export function parseLocs(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * Parse one posting URL's slug into a de-slugged title. Returns null for a
 * URL that isn't a /careers/job/{id}-{slug} posting (category pages, the bare
 * /careers landing page, or anything off-shape).
 *
 * See the module comment above for why `location` is never derived here.
 * @param {string} url
 */
export function parseJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/careers\/job\/(\d+)-([^/]*)$/);
  if (!m) return null;
  const [, id, rawSlug] = m;
  let slug = rawSlug.replace(/-+$/, ''); // a trailing dash is cosmetic slugification, not data
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed percent-encoding: keep the raw (still percent-encoded) slug
    // rather than throwing the whole posting away.
  }
  const title = slug.replace(/-+/g, ' ').trim();
  if (!title) return null;
  return { id, title, url: u.href };
}

/**
 * Resolve the sitemap-index URL from `api:`/`careers_url:`, defaulting to the
 * well-known one when the entry just points at the careers site in general.
 * @param {import('./_types.js').PortalEntry} entry
 */
export function resolveSitemapIndexUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  if (typeof raw !== 'string' || !raw) return SITEMAP_INDEX_URL;
  let u;
  try {
    u = assertInfineonUrl(raw);
  } catch {
    return null;
  }
  // An explicit sitemap-index URL is honored verbatim; anything else on the
  // same host (e.g. the plain /careers listing) falls back to the known
  // index — same host, just not the specific file.
  return /sitemap_index\.xml/i.test(u.pathname) ? u.href : SITEMAP_INDEX_URL;
}

/** @type {Provider} */
export default {
  id: 'infineon',

  detect(entry) {
    const raw = entry.api || entry.careers_url || '';
    if (typeof raw !== 'string' || !raw) return null;
    try {
      assertInfineonUrl(raw);
    } catch {
      return null;
    }
    return { url: resolveSitemapIndexUrl(entry) || SITEMAP_INDEX_URL };
  },

  async fetch(entry, ctx) {
    const indexUrl = resolveSitemapIndexUrl(entry);
    if (!indexUrl) throw new Error(`infineon: cannot resolve a jobs.infineon.com sitemap for ${entry.name}`);
    // Re-assert right before the request: resolveSitemapIndexUrl already
    // validated the host, but checking again here — like assertGreenhouseUrl
    // does — guarantees the URL actually fetched can never drift from the
    // allowlist regardless of how this function evolves.
    assertInfineonUrl(indexUrl);

    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

    const indexXml = await ctx.fetchText(indexUrl, {
      headers: { accept: 'application/xml,text/xml' },
      timeoutMs: SITEMAP_TIMEOUT_MS,
      redirect: 'error',
    });
    let childUrls = parseLocs(indexXml).filter((u) => {
      try {
        assertInfineonUrl(u);
        return true;
      } catch {
        return false;
      }
    });
    if (childUrls.length === 0) {
      console.warn(`infineon: ${indexUrl} returned no child sitemaps — sitemap format may have changed`);
      return [];
    }
    // verify-portals.mjs's health probe passes maxPages: 1 — one child
    // sitemap is enough to tell a live board from a broken one; don't walk
    // every child for it.
    if (Number.isInteger(ctx.maxPages) && ctx.maxPages > 0) childUrls = childUrls.slice(0, ctx.maxPages);
    childUrls = childUrls.slice(0, MAX_SITEMAPS);

    const jobs = [];
    const seen = new Set();
    for (let i = 0; i < childUrls.length; i++) {
      if (i > 0) await wait(REQUEST_DELAY_MS);
      let xml;
      try {
        xml = await ctx.fetchText(childUrls[i], {
          headers: { accept: 'application/xml,text/xml' },
          timeoutMs: SITEMAP_TIMEOUT_MS,
          redirect: 'error',
        });
      } catch (err) {
        // One bad child sitemap (e.g. a future Eightfold change 404s
        // sitemap_cat.xml) must not take the whole board down with it.
        const cause = err instanceof Error ? err.message : String(err);
        console.warn(`infineon: ${childUrls[i]} failed — ${cause} (skipping this sitemap)`);
        continue;
      }
      for (const loc of parseLocs(xml)) {
        const parsed = parseJobUrl(loc);
        if (!parsed || seen.has(parsed.url)) continue;
        seen.add(parsed.url);
        jobs.push({ title: parsed.title, url: parsed.url, company: entry.name, location: '' });
        if (jobs.length >= MAX_JOBS) return jobs;
      }
    }
    return jobs;
  },
};
