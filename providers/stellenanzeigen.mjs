// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// stellenanzeigen.de provider — one of the larger German general job boards,
// and the one that carries the Mittelstand postings the ATS-native providers
// (greenhouse/ashby/lever) never see, because those employers do not run an
// ATS with a public board at all.
//
// ── Why this parses the search page ───────────────────────────────────────
// There is no JSON to read. The page is a React Server Components render:
// no `application/ld+json`, no `__NEXT_DATA__`, only `self.__next_f` push
// chunks that are an internal streaming format, not a documented payload.
// Parsing those would couple this file to a framework's wire protocol.
//
// The server-rendered HTML, by contrast, is stable where it matters — every
// card carries `data-jobid` and `data-testid` attributes, which are test hooks
// the site maintains deliberately. The CSS class names beside them are
// styled-components hashes (`sc-f285d297-16 ZfYLm`) that change on every build,
// so nothing here matches on a class.
//
// ── robots.txt ────────────────────────────────────────────────────────────
// Checked 2026-08-19. `User-agent: *` disallows /api/tracking/, /ajax/*,
// /job/drucken/, /job/preview/ and a handful of account paths. `/suche/` is
// NOT disallowed for `*` — the only rule touching it is scoped to bingbot
// (`Disallow: /suche/*fulltext=`), which does not apply to us. The sitemap is
// advertised but is an index of index files; the search page reaches the same
// postings in one request per keyword, so it is the cheaper route.
//
// Configure via a `job_boards` entry:
//
//   - name: stellenanzeigen.de — Werkstudent Data/AI
//     provider: stellenanzeigen
//     careers_url: https://www.stellenanzeigen.de
//     stellenanzeigen:
//       keywords: ["Werkstudent Data", "Werkstudent KI"]  # required
//       pages: 2                  # search pages per keyword (default 1)
//
// ── There is deliberately no location option ──────────────────────────────
// The search form posts `locationId`, an internal numeric id, not a place name.
// The only resolver is /ajax/suggestort/, which robots.txt Disallows for `*`.
// A name-based `ort=`/`umkreis=` pair IS accepted by the URL and then silently
// ignored: the response is the nationwide set with an "add a location for more
// precise results" nudge, which reads like a working filter and is not one.
// Verified 2026-08-19 — `ort=Erlangen&umkreis=50` returned Hamburg and Herdorf.
//
// So this provider does not pretend to filter by place. scan.mjs applies
// location_filter to what comes back, the same recall-first arrangement
// arbeitsagentur uses.

const ORIGIN = 'https://www.stellenanzeigen.de';
const DEFAULT_PAGES = 1;
const MAX_PAGES = 10;
const PAGE_TIMEOUT_MS = 20_000;

/**
 * Split the search HTML into one string per job card.
 *
 * `data-jobid` opens every card and nothing else on the page uses it, so the
 * split is unambiguous. The first chunk is everything before the first card and
 * is discarded.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function splitCards(html) {
  return String(html).split(/<div data-jobid="/).slice(1);
}

/**
 * Pull one job out of a single card's HTML.
 *
 * Order inside a card is fixed by the template: the hitzone anchor carries the
 * canonical href and the full title, `data-testid="company-name"` carries the
 * employer, and the first text node after the company block is the location.
 * Everything after that is contract type and benefit chips, which scan.mjs does
 * not consume from this source.
 *
 * @param {string} card - One chunk from splitCards().
 * @returns {{title: string, url: string, company: string, location: string, ref: string}|null}
 */
export function parseCard(card) {
  const ref = (card.match(/^([^"]+)"/) ?? [])[1] ?? '';

  // The hitzone anchor is the whole-card click target: it holds both the
  // canonical path and an untruncated title attribute. The visible <h3> repeats
  // the title but is the one the site truncates with an ellipsis.
  const hit = card.match(/<a[^>]*data-testid="qa-hitzone"[^>]*>/);
  const anchor = hit ? hit[0] : '';
  const href = (anchor.match(/href="([^"]+)"/) ?? [])[1] ?? '';
  const title = decodeEntities((anchor.match(/title="([^"]*)"/) ?? [])[1] ?? '').trim();
  if (!href || !title) return null;

  // Company: the text inside the element tagged company-name. The tag sits on a
  // wrapper, so take the first non-empty text node inside it.
  const companyBlock = card.match(/data-testid="company-name"[^>]*>([\s\S]{0,400}?)<\/(?:div|span|p|a)>/);
  const company = companyBlock ? textOf(companyBlock[1]) : '';

  // Location: the first text node AFTER the company block. Matching forward
  // from the company rather than by class is what survives a rebuild.
  let location = '';
  if (companyBlock && typeof companyBlock.index === 'number') {
    const after = card.slice(companyBlock.index + companyBlock[0].length);
    for (const t of textNodes(after)) {
      // Skip the logo's alt-text echo of the company name and any chip that is
      // a contract type rather than a place.
      if (!t || t === company) continue;
      location = t;
      break;
    }
  }

  return {
    title,
    url: href.startsWith('http') ? href : `${ORIGIN}${href}`,
    company,
    location,
    ref,
  };
}

/** First non-empty text node in an HTML fragment, entity-decoded. */
function textOf(fragment) {
  for (const t of textNodes(fragment)) if (t) return t;
  return '';
}

/** Every text node in an HTML fragment, in order, entity-decoded and trimmed. */
function* textNodes(fragment) {
  for (const chunk of String(fragment).split(/<[^>]*>/)) {
    const t = decodeEntities(chunk).replace(/\s+/g, ' ').trim();
    if (t) yield t;
  }
}

/**
 * Build one search URL.
 *
 * @param {string} keyword
 * @param {{page?: number}} [opts]
 * @returns {string}
 */
export function searchUrl(keyword, { page = 1 } = {}) {
  const qs = new URLSearchParams({ fulltext: keyword });
  // `page`, and only `page`. Verified 2026-08-19 against the German-language
  // guesses a reader would reach for first: `seite=2`, `p=2` and `offset=2` are
  // all accepted by the URL and all return page ONE, byte-identical to the
  // unparameterised request. Nothing 404s, nothing warns.
  //
  // That shape is why this is pinned in a test: the fetch loop below stops as
  // soon as a page contributes no new URLs, so a wrong parameter name does not
  // fail — it silently caps the provider at 25 results per keyword and looks
  // like a board with 25 jobs on it.
  if (page > 1) qs.set('page', String(page));
  return `${ORIGIN}/suche/?${qs.toString()}`;
}

function resolveConfig(entry) {
  const cfg = entry?.stellenanzeigen ?? {};
  const keywords = Array.isArray(cfg.keywords) ? cfg.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  if (keywords.length === 0) {
    throw new Error(
      `stellenanzeigen: ${entry?.name ?? 'entry'} has no stellenanzeigen.keywords — this board has no company-scoped listing, so a keyword is the only way to query it`,
    );
  }
  const pages = Number.isInteger(cfg.pages) ? Math.min(Math.max(cfg.pages, 1), MAX_PAGES) : DEFAULT_PAGES;
  return { keywords, pages };
}

/** @type {Provider} */
export default {
  id: 'stellenanzeigen',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.host.toLowerCase();
    if (host !== 'stellenanzeigen.de' && !host.endsWith('.stellenanzeigen.de')) return null;
    return { url };
  },

  async fetch(entry, ctx) {
    const { keywords, pages } = resolveConfig(entry);
    /** @type {Map<string, any>} */
    const byUrl = new Map();

    for (const keyword of keywords) {
      for (let page = 1; page <= pages; page++) {
        const url = searchUrl(keyword, { page });
        let html;
        try {
          html = await ctx.fetchText(url, {
            headers: { accept: 'text/html,application/xhtml+xml' },
            timeoutMs: PAGE_TIMEOUT_MS,
          });
        } catch (err) {
          // One failed keyword must not kill the board — the same rule the
          // other multi-query providers follow.
          console.warn(`stellenanzeigen: "${keyword}" page ${page} failed: ${err?.message ?? err}`);
          break;
        }

        const cards = splitCards(html);
        if (cards.length === 0) {
          // A zero-card page is a legitimate answer for a narrow keyword. Only
          // warn on the FIRST page, where it more often means the markup moved.
          if (page === 1) {
            console.warn(`stellenanzeigen: "${keyword}" returned no job cards — the card markup may have changed`);
          }
          break;
        }

        let added = 0;
        for (const card of cards) {
          const job = parseCard(card);
          if (!job) continue;
          if (byUrl.has(job.url)) continue;
          byUrl.set(job.url, {
            title: job.title,
            url: job.url,
            company: job.company,
            location: job.location,
          });
          added++;
        }
        // The board repeats the last page indefinitely rather than 404ing, so
        // stop as soon as a page contributes nothing new.
        if (added === 0) break;
      }
    }

    return [...byUrl.values()];
  },
};
