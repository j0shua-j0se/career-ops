// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Indeed provider.
//
// THIS WAS PREVIOUSLY DECLARED IMPOSSIBLE, AND THAT WAS WRONG.
// `portals.yml` → KNOWN GAPS said Indeed "cannot get a provider", and the
// reasoning looked sound: the Publisher API is gone, the RSS endpoint returns
// 403, and the Indeed MCP is a tool only an agent can call. But nobody had
// tried the ordinary search page through a rendering fetcher. It returns HTTP
// 200 with the full result set embedded as JSON, no CAPTCHA, no credential.
//
// ROBOTS
// de.indeed.com/robots.txt gives `User-agent: * → Allow: /`, and its Disallow
// list covers country-SEGMENT paths (`/jobs/DE/`, `/jobs/CA/`, …), `/m/…`
// mobile endpoints and various RPC paths. The search endpoint used here,
// `/jobs?q=…&l=…`, matches none of those. Re-read robots.txt before pointing
// this at any other path — in particular `/jobs/DE/` IS disallowed, so never
// build a country-segment URL.
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

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);

const DEFAULT_DOMAIN = 'de.indeed.com';
const DEFAULT_RADIUS = 50;
const MAX_QUERIES = 12;
const FETCH_TIMEOUT_MS = 120_000;
// Every Indeed host is `<cc>.indeed.com` or `indeed.com`. Anything else is a
// misconfiguration or a redirect somewhere unexpected, and must not be fetched.
const HOST_RE = /^([a-z]{2}\.)?indeed\.com$/i;

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
    const url = `https://${domain}/viewjob?jk=${encodeURIComponent(jobkey)}`;
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

/** Render one search URL via the scrapling CLI. */
async function renderViaScrapling(url) {
  const out = join(tmpdir(), `career-ops-indeed-${randomBytes(6).toString('hex')}.html`);
  try {
    await execFileAsync('scrapling', ['extract', 'stealthy-fetch', url, out], {
      timeout: FETCH_TIMEOUT_MS,
      windowsHide: true,
    });
    return readFileSync(out, 'utf-8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /not recognized|not found/i.test(String(err.message)))) {
      throw new Error(
        'indeed: the `scrapling` CLI is not on PATH. Indeed has no public job API and a plain fetch is '
        + 'refused, so this provider cannot run without it. Install it (pipx install scrapling && '
        + 'scrapling install) or disable the Indeed board in portals.yml.',
      );
    }
    throw new Error(`indeed: scrapling failed for ${url} — ${err?.message ?? err}`);
  } finally {
    try { unlinkSync(out); } catch { /* best effort */ }
  }
}

/** @type {Provider} */
export default {
  id: 'indeed',

  async fetch(entry) {
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

    const out = [];
    const seen = new Set();
    for (const query of queries) {
      const url = buildSearchUrl(query, { domain, city, radius });
      const html = await renderViaScrapling(url);
      const jobs = parseIndeedHtml(html, domain);
      // A large page with no cards means the payload key moved, or a challenge
      // was served. Either way say so — silence is indistinguishable from
      // "this query genuinely has no results".
      if (jobs.length === 0 && html.length > 200_000) {
        throw new Error(
          `indeed: rendered ${html.length} bytes for "${query}" but found no job cards. Either the `
          + 'mosaic-provider-jobcards payload moved, or a bot challenge was served instead of results.',
        );
      }
      for (const j of jobs) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        out.push(j);
      }
    }
    return out;
  },
};
