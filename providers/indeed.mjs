// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { safeEncodeURIComponent } from './_safe-url.mjs';
import { fetchText } from './_http.mjs';
import { checkRobots } from '../robots-gate.mjs';
import { isHostBlocked, tripHost, describeBlock } from '../lib/host-circuit.mjs';

// Indeed provider.
//
// THIS WAS PREVIOUSLY DECLARED IMPOSSIBLE, AND THAT WAS WRONG.
// `portals.yml` → KNOWN GAPS said Indeed "cannot get a provider", and the
// reasoning looked sound: the Publisher API is gone, the RSS endpoint returns
// 403, and the Indeed MCP is a tool only an agent can call. But nobody had
// tried the ordinary search page through an honest HTTP request. It answers a
// plain `fetchText` with HTTP 200 and the full result set embedded as JSON, no
// CAPTCHA, no credential, no rendering needed.
//
// POLICY (rewritten 2026-09-24 — read this before changing the fetch path)
// This provider used to shell out to `scrapling extract stealthy-fetch`, a
// bot-detection-evasion CLI, alongside providers/stepstone.mjs. It never had
// to: the search page is plain server-rendered HTML with the job data inlined
// as JSON, exactly the shape `fetchText` (providers/_http.mjs) already reads
// for every other provider in this repo. Stealth fetching was strictly worse
// here — StepStone's near-identical setup started 403ing this machine's WHOLE
// IP on 2026-09-23, very likely because of exactly that kind of traffic — so
// this provider now uses the same plain HTTP path, carrying the project's
// honest default User-Agent (`career-ops/1.0`), no fingerprint spoofing, no
// headless browser, no CAPTCHA solving, no proxy/IP rotation.
//
// If Indeed ever refuses the honest request (403/429, or a recognisable
// bot-challenge page even on a 200), this provider does NOT retry harder — it
// returns zero jobs for that request and trips `lib/host-circuit.mjs`'s
// circuit breaker for the domain in question, so every other caller in this
// repo stops sending it requests too, for 14 days. Every fetch consults the
// breaker FIRST, before a single request goes out. `node lib/host-circuit.mjs
// --list` shows current state; `--clear <domain>` lifts a block early once
// access is confirmed restored.
//
// ROBOTS
// de.indeed.com/robots.txt gives `User-agent: * → Allow: /`, and its Disallow
// list covers country-SEGMENT paths (`/jobs/DE/`, `/jobs/CA/`, …), `/m/…`
// mobile endpoints and various RPC paths. The search endpoint used here,
// `/jobs?q=…&l=…`, matches none of those. Every request is checked against
// robots.txt at fetch time (robots-gate.mjs), not just documented here — a
// disallowed path is a refusal and this provider does not retry it. In
// particular `/jobs/DE/` IS disallowed, so never build a country-segment URL.
//
// WHY THE DATA IS TRUSTWORTHY
// Indeed ships its results as a JSON blob in
// `window.mosaic.providerData["mosaic-provider-jobcards"]`, which is the same
// payload its own UI renders from. That is far more stable than scraping cards
// out of the DOM, and it carries a real publication timestamp (`pubDate`)
// rather than "vor 3 Tagen" prose.
//
// Wire in via a `job_boards:` entry:
//   - name: Indeed — Werkstudent Data & AI (Erlangen 50 km)
//     provider: indeed
//     indeed:
//       domain: de.indeed.com
//       city: Erlangen
//       radius: 50
//       queries: ["werkstudent data science", "praktikum machine learning"]

const DEFAULT_DOMAIN = 'de.indeed.com';
const DEFAULT_RADIUS = 50;
const MAX_QUERIES = 12;
// A search page over plain HTTP is a normal server-rendered response, not a
// multi-second headless render — 20s leaves comfortable room for a slow day
// without letting one stalled query stall a whole board.
const FETCH_TIMEOUT_MS = 20_000;
// A refusal earns the requesting host a two-week cooldown everywhere in this
// repo — see lib/host-circuit.mjs's file doc for why 14 days.
const CIRCUIT_TRIP_DAYS = 14;
// Every Indeed host is `<cc>.indeed.com` or `indeed.com`. Anything else is a
// misconfiguration or a redirect somewhere unexpected, and must not be fetched.
const HOST_RE = /^([a-z]{2}\.)?indeed\.com$/i;

// Indeed OMITS the mosaic payload entirely when a search matches nothing — it
// does not ship an empty results array. So "no payload" is ambiguous between
// "this query found nothing" and "the format moved", and these markers are what
// separate them. Getting this wrong is expensive in the unobvious direction: it
// makes a perfectly healthy scraper look broken.
// `no jobs with this search condition` is the exact string Indeed's own page
// carries on a zero-result search — in ENGLISH even on de.indeed.com, which is
// why a German-only pattern missed it. Verified against a live empty query
// ("praktikum data science" in Erlangen, 597 KB, no payload, no CAPTCHA).
export const EMPTY_RESULT_RE = /no\s+jobs\s+with\s+this\s+search\s+condition|keine\s+(?:passenden\s+)?stellenanzeigen|nichts\s+gefunden|did\s+not\s+match\s+any\s+jobs|no\s+jobs\s+(?:were\s+)?found/i;

// A recognisable bot-block/challenge page, even when it answers HTTP 200 (a
// WAF "soft block" that never reaches the origin). Matched in addition to the
// status-code check below, because a plain `fetchText` cannot see a JS
// challenge execute — only that the body it got back is one, not a search
// results page. Any hit here is treated exactly like a 403: trip the breaker,
// send no more requests this run.
export const BOT_BLOCK_RE = /\b(access denied|pardon our interruption|attention required|are you a human|verify you are human|unusual traffic|request blocked|cf-error-details|captcha)\b/i;

/**
 * Pull the job-card payload out of a rendered search page.
 *
 * Exported so the parser can be exercised against a saved fixture with no
 * network. Returns [] rather than throwing on unexpected shapes — the caller
 * decides whether an empty result from a large page means the format moved.
 *
 * @param {string} html
 * @param {string} domain host the page came from, used to build absolute URLs
 * @returns {Array<{title:string,url:string,company:string,location:string,postedAt?:number}>}
 */
export function parseIndeedHtml(html, domain = DEFAULT_DOMAIN) {
  const src = String(html || '');
  const m = /window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{[\s\S]*?\});/.exec(src);
  if (!m) return [];

  let blob;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return [];
  }

  const results = blob?.metaData?.mosaicProviderJobCardsModel?.results
    ?? blob?.results
    ?? [];
  if (!Array.isArray(results)) return [];

  const out = [];
  const seen = new Set();
  for (const r of results) {
    const jobkey = typeof r?.jobkey === 'string' ? r.jobkey.trim() : '';
    const title = String(r?.title ?? r?.displayTitle ?? '').trim();
    if (!jobkey || !title) continue;

    // The canonical permalink. Built from the job key rather than taken from
    // `link`/`viewJobLink`, which carry per-session tracking parameters that
    // would defeat dedup against scan-history.
    // A lone surrogate in jobkey throws URIError out of encodeURIComponent and
    // aborts this loop, losing every posting on the page. Drop just this one.
    const encodedKey = safeEncodeURIComponent(jobkey);
    if (encodedKey === null) continue;
    const url = `https://${domain}/viewjob?jk=${encodedKey}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const job = {
      title,
      url,
      company: String(r?.company ?? '').trim(),
      location: String(r?.formattedLocation ?? r?.jobLocationCity ?? '').trim(),
    };

    // pubDate is epoch ms. Guard it: a nonsense timestamp is worse than none,
    // because the recency filter acts on a date it has and ignores one it lacks.
    const pub = Number(r?.pubDate ?? r?.createDate);
    if (Number.isFinite(pub) && pub > 0 && pub < Date.now() + 86_400_000) job.postedAt = pub;

    out.push(job);
  }
  return out;
}

/** Build a search URL. Never a `/jobs/{CC}/` country-segment path — robots-Disallowed. */
export function buildSearchUrl(query, { domain = DEFAULT_DOMAIN, city = '', radius = DEFAULT_RADIUS } = {}) {
  if (!HOST_RE.test(domain)) throw new Error(`indeed: refusing to fetch a non-Indeed host: ${domain}`);
  const q = String(query || '').trim();
  if (!q) throw new Error('indeed: empty query');
  const u = new URL(`https://${domain}/jobs`);
  u.searchParams.set('q', q);
  if (city) u.searchParams.set('l', String(city).trim());
  const r = Number(radius);
  if (Number.isFinite(r) && r > 0) u.searchParams.set('radius', String(Math.min(100, Math.round(r))));
  return u.toString();
}

/**
 * Fetch one search URL over plain HTTP and return its HTML.
 *
 * Deliberately the ONLY transport this provider uses now — no headless
 * browser, no stealth fetch. `fetchText` (providers/_http.mjs) carries the
 * project's honest default User-Agent and enforces the shared SSRF guards; it
 * throws with `.status` set on a non-2xx response, which is how the caller
 * tells a refusal (403/429) apart from a network error.
 *
 * @param {string} url
 * @param {{fetchTextFn?: typeof fetchText}} [deps]
 * @returns {Promise<string>}
 */
async function fetchIndeedPage(url, { fetchTextFn = fetchText } = {}) {
  return fetchTextFn(url, { timeoutMs: FETCH_TIMEOUT_MS });
}

/** @type {Provider} */
export default {
  id: 'indeed',

  async fetch(entry, deps = {}) {
    const {
      fetchTextFn = fetchText,
      checkRobotsFn = checkRobots,
      isHostBlockedFn = isHostBlocked,
      tripHostFn = tripHost,
    } = deps;

    const cfg = entry?.indeed ?? {};
    const queries = Array.isArray(cfg.queries) ? cfg.queries.filter(Boolean) : [];
    if (queries.length === 0) {
      throw new Error(
        `indeed: board "${entry?.name ?? '?'}" has no indeed.queries — nothing to search. `
        + 'Add e.g. queries: ["werkstudent data science"].',
      );
    }
    if (queries.length > MAX_QUERIES) {
      throw new Error(`indeed: ${queries.length} queries exceeds the cap of ${MAX_QUERIES} — split the board.`);
    }

    const domain = cfg.domain ?? DEFAULT_DOMAIN;
    if (!HOST_RE.test(domain)) throw new Error(`indeed: invalid domain "${domain}"`);
    const city = cfg.city ?? '';
    const radius = cfg.radius ?? DEFAULT_RADIUS;

    // Circuit breaker — consulted BEFORE any request, every run. A domain that
    // has already refused this machine gets no further traffic until the
    // cooldown elapses, no matter how many queries are configured.
    const blocked = isHostBlockedFn(domain);
    if (blocked) {
      console.error(`⚠️  indeed: ${domain} is circuit-broken (${describeBlock(blocked)}) — sending no requests this run. `
        + `Once access is confirmed restored, clear it with \`node lib/host-circuit.mjs --clear ${domain}\`.`);
      return [];
    }

    const out = [];
    const seen = new Set();
    // One bad query must not take the board down with it. The first version
    // threw on the first zero-result query, which aborted the whole fetch —
    // so a single narrow query ("praktikum data science" in Erlangen, a search
    // that genuinely matches nothing) silently cost the four queries that
    // worked. The board reported `unknown` in portal-health and contributed
    // zero rows while looking configured and enabled.
    const failures = [];
    let succeeded = 0;
    let tripped = false;

    for (const query of queries) {
      if (tripped) break; // the breaker just tripped mid-loop — stop sending requests now, not after the loop finishes.

      const url = buildSearchUrl(query, { domain, city, radius });

      const robotsVerdict = await checkRobotsFn(url);
      if (!robotsVerdict.retry && robotsVerdict.code === 'disallowed') {
        failures.push(`"${query}": robots.txt disallows ${url} — ${robotsVerdict.reason}`);
        continue;
      }

      let jobs = [];
      let html = '';
      try {
        html = await fetchIndeedPage(url, { fetchTextFn });
        jobs = parseIndeedHtml(html, domain);
      } catch (err) {
        const status = err?.status;
        if (status === 403 || status === 429) {
          tripHostFn(domain, {
            status,
            reason: `indeed: HTTP ${status} on ${url}`,
            days: CIRCUIT_TRIP_DAYS,
          });
          failures.push(`"${query}": HTTP ${status} — circuit breaker tripped for ${domain} (${CIRCUIT_TRIP_DAYS} days)`);
          tripped = true;
          continue;
        }
        failures.push(`"${query}": ${err?.message ?? err}`);
        continue;
      }

      if (BOT_BLOCK_RE.test(html)) {
        tripHostFn(domain, {
          status: 200,
          reason: `indeed: bot-challenge page served for ${url}`,
          days: CIRCUIT_TRIP_DAYS,
        });
        failures.push(`"${query}": bot-challenge page (HTTP 200 body) — circuit breaker tripped for ${domain} (${CIRCUIT_TRIP_DAYS} days)`);
        tripped = true;
        continue;
      }

      if (jobs.length === 0) {
        // A genuinely empty search is a normal outcome, not a fault.
        if (EMPTY_RESULT_RE.test(html)) { succeeded++; continue; }
        // No cards, no empty-marker, and a substantial page: the payload moved
        // or a challenge was served. Record it — but keep going.
        if (html.length > 200_000) {
          failures.push(
            `"${query}": rendered ${html.length} bytes with neither job cards nor an empty-results `
            + 'marker — the mosaic-provider-jobcards payload may have moved, or a challenge was served',
          );
          continue;
        }
      }

      succeeded++;
      for (const j of jobs) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        out.push(j);
      }
    }

    // A circuit trip is not a provider fault to fail the scan over — it is the
    // provider correctly refusing to keep hammering a host that just declined
    // it. Report zero jobs and a clear warning, same as the already-blocked
    // early return above, rather than throwing and aborting the whole run.
    //
    // Only a total wipeout THAT IS NOT a circuit trip is a board-level fault
    // worth failing on: that is the signal that something systemic changed,
    // rather than one query being narrow.
    if (succeeded === 0 && failures.length > 0 && !tripped) {
      throw new Error(`indeed: every query failed —\n  ${failures.join('\n  ')}`);
    }
    if (failures.length > 0) {
      console.error(`⚠️  indeed: ${failures.length} of ${queries.length} queries failed (continuing):\n  ${failures.join('\n  ')}`);
    }
    return out;
  },
};
