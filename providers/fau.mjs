// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// FAU (Friedrich-Alexander-Universität Erlangen-Nürnberg) provider —
// single-institution (pattern: hecklerkoch/rheinmetall — SSR board, plain GETs).
// The board at https://www.jobs.fau.de/jobs/ is WordPress, server-rendered, and
// zero-auth. The WP REST API is deliberately locked down (/wp-json/wp/v2/types
// returns 403 "Die Unterstützung der REST-API ist eingeschränkt"), so parsing
// the SSR list is the only zero-token path.
//
// ── The pagination trap (the reason this provider looks unusual) ────────────
// The bare /jobs/ page renders only the first TEN postings, sorted
// alphabetically, and has no working pagination: /jobs/page/2/ returns 410 Gone
// and ?paged=2 redirects to the same 410. There is no "next" link and no total
// count — the truncation is completely silent.
//
// The SEARCH endpoint is not truncated the same way. Verified: /jobs/ listed
// none of fau-1756, fau-1817 or fau-1800, while
// ?free_txt=Hilfskraft&free_txt_fields=title returned all three plus two more.
// So this provider issues ONE GET PER CONFIGURED KEYWORD and unions the results
// by URL, instead of reading the listing once (same shape as tencent.mjs's
// `keywords:`). Configure the terms in portals.yml (user layer) — they are
// search targeting, not site structure:
//
//   - name: FAU Erlangen-Nürnberg
//     careers_url: https://www.jobs.fau.de/jobs/
//     provider: fau
//     keywords: ["Hilfskraft", "Data", "Machine Learning", "KI"]
//     categories: ["hiwi", "wiss"]
//
// With neither key set we fall back to a single bare-listing GET and warn, so a
// misconfigured entry degrades to "10 alphabetical results" rather than to zero.
//
// ── Query parameters (observed on the live form) ───────────────────────────
//   free_txt            free-text term
//   free_txt_fields     "title" | "title|description"
//   job_category[]      wiss · promo · postdoc · n-wiss · unimgt · it · tech ·
//                       medges · hiwi · azubi
//   job_employmenttype[]  FULL_TIME | PART_TIME
//   job_limitation[]    TEMPORARY | PERMANENT
//   job_salary[]        a2–a16 · e2–e15 · tva-l-bbig
//   meta_key            title | datePosted | validThrough | jobStartDate
//   order               ASC | DESC
//
// ── Card markup ────────────────────────────────────────────────────────────
//   <a class="job-link" href="https://www.jobs.fau.de/jobs/{slug}-{id}/">
//     <div class="job-title">…</div>
//     <div class="job-salary"><span class="label">Entgelt: </span>TV-L E 13</div>
//     <div class="job-limitation"><span class="label">Befristung: </span>…</div>
//     <div class="job-workingtime"><span class="label">Arbeitszeit: </span>Teilzeit: 8 Std./Woche</div>
//     <div class="job-startdate"><span class="label">Einstellungstermin: </span>01.10.2026</div>
//     <div class="job-validthrough"><span class="label">Bewerbungsschluss: </span>07.08.2026</div>
//   </a>
//
// Unusually rich for a list page, so the metadata is folded into `description`
// (list-page data carried for free — no extra request, scanner stays zero-token).
// Hours/week and the TV-L band are the two fields worth having; a first-class
// `hours_per_week` / `deadline` on the Job contract would be the proper home.
//
// postedAt is deliberately OMITTED. `job-startdate` is the Einstellungstermin
// (when the role begins) and `job-validthrough` is the Bewerbungsschluss (when
// applications close) — neither is a publication date, and mapping either one
// onto postedAt would feed recency filters a number that means something else.
//
// The cards carry no per-posting location. FAU is geographically fixed to
// Erlangen / Nürnberg / Fürth, so location is derived from the institution, not
// read from the posting; override it per-entry with `location:` in portals.yml.

const DEFAULT_LOCATION = 'Erlangen-Nürnberg';
const MAX_JOBS = 500;
const MAX_REQUESTS = 24; // bound the fan-out; one GET per query/category
const REQUEST_DELAY_MS = 250; // polite pacing — university server, sequential GETs
// The cap the bare listing was observed to truncate at. It rendered 48 cards on
// 2026-09-01, so the cap is not currently in force — but /jobs/page/2/ still
// answers 410, so there is still no way to page past one if it returns. Kept as
// a warning threshold only: nothing branches on it.
const TRUNCATION_HINT = 10;

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Resolve the listing URL from api:/careers_url; default to /jobs/. */
export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  // Only the job board host — www.fau.de at large is the university website.
  if (host !== 'jobs.fau.de' && host !== 'www.jobs.fau.de') return null;
  return 'https://www.jobs.fau.de/jobs/';
}

/** Normalize a portals.yml list field into trimmed, deduped, non-empty strings. */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const v of value) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Build the set of listing URLs to fetch: one per free-text keyword, one per
 * category, or the bare listing when the entry configures neither.
 * @param {string} listUrl @param {object} entry
 */
export function buildRequestUrls(listUrl, entry = {}) {
  const keywords = stringList(entry.keywords);
  const categories = stringList(entry.categories);
  if (keywords.length === 0 && categories.length === 0) return [listUrl];

  // The bare listing is ALWAYS fetched, first, even when keywords are set.
  //
  // It used to be excluded, on the premise that it truncates at ten and the
  // keywords therefore superset it. That premise expired: on 2026-09-01 the
  // bare listing rendered 48 cards, and every hit from every configured
  // keyword ("Hilfskraft" 5, "KI" 1, "Informatik" 2, "Data" 0, "Machine
  // Learning" 0) was already among them — so the configured fan-out was
  // returning 8 of FAU's 48 postings and reporting success.
  //
  // Including it costs one GET and is correct under either premise: if the
  // listing truncates again the keywords still add what it drops, and if it
  // does not, nothing is lost to a keyword list that happens to be narrow.
  const urls = [listUrl];
  for (const q of keywords) {
    const p = new URLSearchParams({ free_txt: q, free_txt_fields: 'title' });
    urls.push(`${listUrl}?${p}`);
  }
  for (const c of categories) {
    const p = new URLSearchParams();
    p.append('job_category[]', c);
    urls.push(`${listUrl}?${p}`);
  }
  return urls.slice(0, MAX_REQUESTS);
}

/** True when an attribute string carries `cls` as a whole class token. */
function hasClass(attrs, cls) {
  const m = attrs.match(/class="([^"]*)"/i);
  return m ? m[1].split(/\s+/).includes(cls) : false;
}

/**
 * Read one `job-{field}` div out of a card block, minus its bold label. The
 * divs carry no nested divs, so a non-greedy match to the first `</div>` is
 * exact; if FAU ever nests one, this returns a truncated value rather than
 * swallowing the rest of the card.
 */
function field(block, name) {
  const m = block.match(new RegExp(`<div[^>]*class="[^"]*\\bjob-${name}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`, 'i'));
  if (!m) return '';
  return clean(m[1].replace(/<span[^>]*class="[^"]*\blabel\b[^"]*"[^>]*>[\s\S]*?<\/span>/i, ''));
}

/**
 * Parse an SSR listing/search page into raw records. Anchors on the `job-link`
 * card, then reads the metadata divs inside that same card — pairing fields
 * across card boundaries would attribute one posting's hours to another.
 *
 * Attribute order is not assumed: the whole opening tag is captured first and
 * `class`/`href` read out of it, so a markup reshuffle doesn't silently return
 * zero cards.
 * @param {string} html
 */
export function parseListing(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    if (!hasClass(attrs, 'job-link')) continue;
    const hrefM = attrs.match(/href="([^"]+)"/i);
    if (!hrefM) continue;
    const url = decodeEntities(hrefM[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const block = m[2];
    const title = field(block, 'title');
    if (!title) continue;
    seen.add(url);
    out.push({
      url,
      title,
      salary: field(block, 'salary'),
      limitation: field(block, 'limitation'),
      workingTime: field(block, 'workingtime'),
      startDate: field(block, 'startdate'),
      validThrough: field(block, 'validthrough'),
    });
  }
  return out;
}

/**
 * Fold the card metadata into a one-line description. Hours/week and the TV-L
 * band are the fields worth carrying downstream; empty ones are dropped.
 */
export function describe(row) {
  return [
    row.workingTime && `Arbeitszeit: ${row.workingTime}`,
    row.salary && `Entgelt: ${row.salary}`,
    row.limitation && `Befristung: ${row.limitation}`,
    row.startDate && `Einstellungstermin: ${row.startDate}`,
    row.validThrough && `Bewerbungsschluss: ${row.validThrough}`,
  ].filter(Boolean).join(' · ');
}

/** @type {Provider} */
export default {
  id: 'fau',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveListUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`fau: cannot resolve listing URL for ${entry.name}`);

    const location = entry.location || DEFAULT_LOCATION;
    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
    let urls = buildRequestUrls(listUrl, entry);
    // The health probe (verify-portals.mjs) passes maxPages: 1 — one request is
    // enough to tell a live board from a broken one; don't fan out for it.
    if (Number.isInteger(ctx.maxPages) && ctx.maxPages > 0) urls = urls.slice(0, ctx.maxPages);
    if (urls.length === 1 && urls[0] === listUrl) {
      console.warn(`fau: ${entry.name} has no keywords/categories — relying on the bare listing alone, which has silently truncated before and cannot be paginated`);
    }

    const jobs = [];
    const seen = new Set();
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await wait(REQUEST_DELAY_MS);
      const html = await ctx.fetchText(urls[i], { headers: { accept: 'text/html' } });
      const rows = parseListing(html);
      if (rows.length === 0 && i === 0) {
        console.warn(`fau: ${urls[i]} returned no job cards — markup may have changed`);
      }
      if (rows.length >= TRUNCATION_HINT) {
        console.warn(`fau: ${urls[i]} returned ${rows.length} cards and the board cannot be paginated — results may be truncated; narrow the query`);
      }
      for (const row of rows) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        jobs.push({
          title: row.title,
          url: row.url,
          company: entry.name,
          location,
          description: describe(row),
        });
        if (jobs.length >= MAX_JOBS) return jobs;
      }
    }
    return jobs;
  },
};
