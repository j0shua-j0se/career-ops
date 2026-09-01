// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Zalando provider — single-company (pattern: infineon/deutschebahn — no usable
// JSON API, so this reads the public job sitemap instead).
//
// ── Why the sitemap, not the listing page ───────────────────────────────────
// jobs.zalando.com/en/jobs is a client-rendered Next.js shell: verified live
// 2026-09-01, the static HTML carries no `__NEXT_DATA__` and no interceptable
// JSON API — there is nothing to scrape at the list-page level.
//
// robots.txt (fetched 2026-09-01) is `Allow: /` (only /en/onboarding and
// /de/onboarding are disallowed) and names the sitemap:
//   Sitemap: https://jobs.zalando.com/sitemap.xml
// That sitemap has 300 <loc> entries (verified 2026-09-01): 165 are real job
// postings shaped `/en/jobs/{numericId}-{Title-With-Hyphens}`; the rest are
// marketing pages (home, /en, /de, /en/jobs, /de/jobs, /en/blog/*, /de/blog/*,
// /en/where-we-work/*, /en/what-we-do/*, /en/our-culture/*, etc.) — filtered
// out by requiring the numeric-id job path shape, not assumed away.
//
// ── postedAt is deliberately OMITTED ─────────────────────────────────────
// Each <url> carries a <lastmod>, but that is a page-modification timestamp
// (when Zalando's CMS last touched that sitemap row — e.g. every job row in a
// fetch shared the identical <lastmod> instant, confirming it is a generation
// timestamp, not a publish date), not when the posting first went live.
// Mapping it onto postedAt would feed a wrong number into recency filters.
// scan.mjs's buildPostingAgeFilter passes undated postings through, and the
// portal scan runs with includeUndated: true, so leaving these undated does
// not silently drop them.
//
// ── The location decision (the crux of this provider) ───────────────────────
// Unlike Infineon's slug (title and location run together with no delimiter,
// so guessing is actively unsafe), Zalando's job URL carries NO location data
// at all — e.g. `/en/jobs/2725192-Senior-Principal-Software-Engineer-(all-genders)`.
// There is nothing to parse a location out of and nothing to guess: hardcoding
// "Berlin" (Zalando's HQ) would be flatly wrong for the many non-Berlin
// postings, and inventing a location is worse than omitting one.
//
// Leaving `location` empty (Infineon's choice) was considered, but rejected
// here: this candidate's location_filter is the primary gate, and 165
// unfiltered rows sliding through it — even from a "Berlin" board most people
// assume is one city — is exactly the bug that flooded the pipeline this
// session (iCIMS's 188 location-less rows, #… see career-ops session notes).
// A silent, uncountable flood through the one filter meant to keep the scan
// relevant is a worse failure mode here than the network cost of fixing it.
//
// The individual job pages ARE server-rendered (confirmed live 2026-09-01
// across Berlin/Bucharest/Hanover/Ansbach postings) and embed the real
// location unambiguously, twice, as a Workday-sourced `"offices":["Country -
// City"]` field inside a Next.js RSC-streamed script chunk (quotes are
// backslash-escaped because it's a JSON blob nested in a JS string literal):
//   self.__next_f.push([1,"...\"job\":{...,\"offices\":[\"Germany - Berlin\"],...}..."])
// So this provider fetches each job's detail page to read that field. The
// board is small enough (165 live postings, MAX_JOBS below gives headroom)
// that this is a bounded, one-off cost per scan — comparable to or cheaper
// than deutschebahn.mjs's already-accepted 60-page walk — not an unbounded
// full-ATS-style sweep. It is capped by MAX_JOBS, paced by REQUEST_DELAY_MS,
// and a single detail-page failure degrades that one job to an empty location
// (never a guessed one) rather than failing the whole board.
//
// The portal health probe (verify-portals.mjs) passes `ctx.maxPages: 1` to
// mean "prove this is alive without hammering the site" — honored by
// `detailBudget` below, which attempts a detail fetch for only that many jobs
// per call instead of walking the whole board just to answer a liveness check.

const SITEMAP_URL = 'https://jobs.zalando.com/sitemap.xml';
const ALLOWED_HOSTS = ['jobs.zalando.com'];
const MAX_JOBS = 400; // live board carried 165 job URLs (verified 2026-09-01) — headroom for growth
const SITEMAP_TIMEOUT_MS = 20_000; // sitemap.xml is well under 100KB, server-generated
const DETAIL_TIMEOUT_MS = 15_000; // each job page is ~130KB static HTML
const REQUEST_DELAY_MS = 200; // polite pacing between detail-page requests

/**
 * Mandatory SSRF guard: an explicit host allowlist on top of `_http.mjs`'s
 * baseline (which only blocks private/loopback/link-local addresses).
 * Mirrors `assertInfineonUrl` in infineon.mjs / `assertGreenhouseUrl` in
 * greenhouse.mjs.
 * @param {string} url
 */
function assertZalandoUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`zalando: invalid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new Error(`zalando: URL must use HTTPS: ${url}`);
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new Error(`zalando: untrusted hostname "${host}" — must be jobs.zalando.com`);
  return u;
}

/** Extract every <loc> from the sitemap document. */
export function parseSitemapLocs(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * Parse one URL's path into a job's {id, title}. Returns null for anything
 * that isn't a `/en/jobs/{numericId}-{slug}` (or `/de/jobs/...`) posting —
 * the sitemap also carries the bare listing pages, blog posts, and marketing
 * pages, none of which match this shape.
 *
 * Title recovery: decode percent-escapes, then collapse hyphen runs to a
 * single space (the same convention as `providers/infineon.mjs`). Zalando's
 * slugs use a Greenhouse-style scheme (single space -> "-", a literal " - "
 * -> "---") so this loses the punctuation of an em-dash-separated suffix
 * (e.g. "... (all genders) - Tradebyte" -> "... (all genders) Tradebyte")
 * but keeps every word — "cleanly recoverable" for matching/scoring purposes,
 * not necessarily punctuation-perfect.
 * @param {string} url
 */
export function parseJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/(?:en|de)\/jobs\/(\d+)-(.+)$/);
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

// JSON-style unescape for the small alphabet actually seen in office names
// (ASCII letters, spaces, hyphens). Not a general JS-string-literal parser —
// just enough to undo \uXXXX / \/ / \\ if Zalando ever puts one in a city name.
function jsUnescape(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

/**
 * Extract the job's location from a detail-page HTML body. The page is a
 * Next.js RSC stream; job data (sourced from Zalando's Workday backend) is
 * embedded as a JS string literal, so its JSON quotes are backslash-escaped:
 *   \"offices\":[\"Germany - Berlin\"]
 * Verified live 2026-09-01 across several postings, always present, always
 * shaped "{Country} - {City}" (or occasionally more than one office for a
 * multi-site posting — joined with " / "). Returns '' when the field is
 * absent (page shape changed, or the fetch returned something unexpected) —
 * never a guessed value.
 * @param {string} html
 */
export function extractLocationFromDetailHtml(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/\\"offices\\":\[(.*?)\]/);
  if (!m) return '';
  // Content between two `\"` delimiters: any run of non-quote/non-backslash
  // chars, or a backslash NOT immediately followed by a quote (so a \uXXXX
  // escape is consumed but the closing \" is never mistaken for one).
  const items = [...m[1].matchAll(/\\"((?:[^"\\]|\\[^"])*)\\"/g)].map((x) => jsUnescape(x[1]).trim()).filter(Boolean);
  return items.join(' / ');
}

/**
 * Resolve the sitemap URL from `api:`/`careers_url:`, defaulting to the
 * well-known one when the entry just points at the jobs site in general.
 * @param {import('./_types.js').PortalEntry} entry
 */
export function resolveSitemapUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  if (typeof raw !== 'string' || !raw) return SITEMAP_URL;
  let u;
  try {
    u = assertZalandoUrl(raw);
  } catch {
    return null;
  }
  return /sitemap\.xml/i.test(u.pathname) ? u.href : SITEMAP_URL;
}

/** @type {Provider} */
export default {
  id: 'zalando',

  detect(entry) {
    const raw = entry.api || entry.careers_url || '';
    if (typeof raw !== 'string' || !raw) return null;
    try {
      assertZalandoUrl(raw);
    } catch {
      return null;
    }
    return { url: resolveSitemapUrl(entry) || SITEMAP_URL };
  },

  async fetch(entry, ctx) {
    const sitemapUrl = resolveSitemapUrl(entry);
    if (!sitemapUrl) throw new Error(`zalando: cannot resolve jobs.zalando.com sitemap for ${entry.name}`);
    // Re-assert right before the request — like assertGreenhouseUrl does —
    // so the URL actually fetched can never drift from the allowlist
    // regardless of how resolveSitemapUrl evolves.
    assertZalandoUrl(sitemapUrl);

    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

    const xml = await ctx.fetchText(sitemapUrl, {
      headers: { accept: 'application/xml,text/xml' },
      timeoutMs: SITEMAP_TIMEOUT_MS,
      redirect: 'error',
    });

    const locs = parseSitemapLocs(xml).filter((u) => {
      try {
        assertZalandoUrl(u);
        return true;
      } catch {
        return false;
      }
    });

    const seen = new Set();
    let parsed = [];
    for (const loc of locs) {
      const p = parseJobUrl(loc);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      parsed.push(p);
    }
    parsed = parsed.slice(0, MAX_JOBS);

    // The health probe passes maxPages:1 to mean "prove this board is alive
    // without hammering it" — only attempt that many detail-page fetches;
    // the rest are returned with an empty location rather than walking all
    // ~165 postings on every liveness check.
    const detailBudget = Number.isInteger(ctx.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : parsed.length;

    const jobs = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      let location = '';
      if (i < detailBudget) {
        if (i > 0) await wait(REQUEST_DELAY_MS);
        try {
          assertZalandoUrl(p.url);
          const html = await ctx.fetchText(p.url, {
            headers: { accept: 'text/html' },
            timeoutMs: DETAIL_TIMEOUT_MS,
            redirect: 'error',
          });
          location = extractLocationFromDetailHtml(html);
        } catch (err) {
          // One posting's detail page failing (timeout, 404, a budget cutoff
          // during the health probe) must not take down the whole board —
          // it still passes through, just with an empty location instead of
          // a guessed one. See the module comment for why empty beats invented.
        }
      }
      jobs.push({ title: p.title, url: p.url, company: entry.name, location });
    }
    return jobs;
  },
};
