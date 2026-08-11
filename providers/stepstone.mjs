// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// StepStone provider — the largest German job board, and until now the biggest
// hole in this scanner.
//
// WHY THIS IS NOT A `ctx.fetchJson` PROVIDER
// StepStone publishes no usable job API. `/public-api/` is explicitly
// Disallowed in their robots.txt, the search page carries JSON-LD for the PAGE
// (WebPage / BreadcrumbList / FAQ) but not for the postings, and a plain
// `fetch` is refused outright by their edge. What does work is the `scrapling`
// CLI already installed on this machine, which renders the page and returns
// HTTP 200. So this provider shells out to that binary and parses the rendered
// listing markup.
//
// ROBOTS
// Only the modern `/jobs/{query}/in-{city}` search path is used. StepStone's
// robots.txt (checked 2026-08-11) Disallows the legacy `/5/` search endpoints,
// `/public-api/`, `/jobagent/`, `/m/` and `/mobile/` — none of which this
// touches — and does not Disallow `/jobs/`. Keep it that way: if a future
// change needs a different path, re-read robots.txt first.
//
// WHY MARKUP PARSING IS ACCEPTABLE HERE
// StepStone annotates its listing cards with stable `data-at` hooks
// (`job-item`, `job-item-title`, `job-item-company-name`, `job-item-location`,
// `job-item-timeago`). Those are test/analytics hooks, far more stable than
// class names, and a card missing them is skipped rather than guessed at. If
// StepStone drops them the provider returns zero jobs and says so loudly — it
// must never silently degrade into returning garbage.
//
// Wire in via a `job_boards:` entry:
//   - name: StepStone — Werkstudent Data Science (Erlangen 50km)
//     provider: stepstone
//     stepstone:
//       queries: ["werkstudent-data-science", "werkstudent-machine-learning"]
//       city: erlangen
//       radius: 50

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);

const HOST = 'www.stepstone.de';
const DEFAULT_RADIUS = 30;
const DEFAULT_CITY = 'erlangen';
// A rendered search page is ~1MB and takes several seconds; a handful of
// queries is the useful range. The cap stops a mis-typed config from turning
// one board into a multi-hour crawl.
const MAX_QUERIES = 12;
const FETCH_TIMEOUT_MS = 120_000;

/** Decode the HTML entities that actually appear in StepStone card text. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Relative German/English "time ago" text -> epoch ms.
 *
 * StepStone prints "vor 3 Tagen" / "vor 2 Wochen" / "Gestern". An unrecognized
 * value yields undefined rather than a guess: scan-ats-full's recency filter
 * treats a missing date as "don't penalize", whereas a wrong date silently
 * includes or excludes the posting.
 *
 * @param {string} text
 * @param {number} nowMs
 * @returns {number|undefined}
 */
export function parseTimeAgo(text, nowMs = Date.now()) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return undefined;
  const DAY = 86_400_000;
  if (/\b(heute|today)\b/.test(t)) return nowMs;
  if (/\b(gestern|yesterday)\b/.test(t)) return nowMs - DAY;
  const m = /(\d+)\s*(minute|minuten|stunde|stunden|tag|tagen|woche|wochen|monat|monaten|hour|hours|day|days|week|weeks|month|months)/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2];
  if (/^(minute|minuten)/.test(unit)) return nowMs - n * 60_000;
  if (/^(stunde|stunden|hour)/.test(unit)) return nowMs - n * 3_600_000;
  if (/^(tag|day)/.test(unit)) return nowMs - n * DAY;
  if (/^(woche|week)/.test(unit)) return nowMs - n * 7 * DAY;
  if (/^(monat|month)/.test(unit)) return nowMs - n * 30 * DAY;
  return undefined;
}

/**
 * Parse rendered StepStone search HTML into normalized jobs. Exported for tests
 * so the parser can be exercised against a saved fixture with no network.
 *
 * A card is only emitted when it has BOTH a title and a resolvable URL. Company
 * and location are best-effort — scan.mjs tolerates empty strings there, and an
 * empty location is honest, whereas a guessed one would mis-tier the posting in
 * triage-prefilter.
 *
 * @param {string} html
 * @param {number} [nowMs]
 * @returns {Array<{title:string,url:string,company:string,location:string,postedAt?:number}>}
 */
export function parseStepstoneHtml(html, nowMs = Date.now()) {
  const out = [];
  const seen = new Set();
  const src = String(html || '');

  // Split on card boundaries rather than regexing the whole document: it keeps
  // each field's match scoped to its own card, so a card missing a company
  // cannot borrow the next card's.
  const cards = src.split(/data-at=["']job-item["']/i).slice(1);

  for (const card of cards) {
    // The anchor carries the posting id; take the first /stellenangebote-- link.
    const href = /href=["'](\/stellenangebote--[^"']+)["']/i.exec(card);
    if (!href) continue;
    const url = `https://${HOST}${decodeEntities(href[1])}`;
    if (seen.has(url)) continue;

    const titleBlock = /data-at=["']job-item-title["'][^>]*>([\s\S]{0,400}?)<\/a>/i.exec(card)
      || /data-at=["']job-item-title["'][^>]*>([\s\S]{0,400}?)<\//i.exec(card);
    const title = titleBlock ? stripTags(titleBlock[1]) : '';
    if (!title) continue;

    const job = {
      title,
      url,
      company: fieldText(card, 'job-item-company-name'),
      location: fieldText(card, 'job-item-location'),
    };
    const postedAt = parseTimeAgo(fieldText(card, 'job-item-timeago'), nowMs);
    if (postedAt !== undefined) job.postedAt = postedAt;

    seen.add(url);
    out.push(job);
  }

  return out;
}

/**
 * Text of one `data-at`-hooked field within a card.
 *
 * The value cannot be read with a non-greedy match to the next closing tag:
 * StepStone nests an SVG icon span INSIDE the labelled element, so the first
 * `</span>` closes the icon and yields an empty string. Instead the slice runs
 * from the hook to the next `data-at` hook (or a bounded fallback) and is then
 * stripped of tags — the SVG contributes no text of its own.
 *
 * @param {string} card
 * @param {string} hook
 * @returns {string} field text, or '' when the hook is absent
 */
function fieldText(card, hook) {
  const start = card.search(new RegExp(`data-at=["']${hook}["']`, 'i'));
  if (start === -1) return '';

  // Find the opening tag this attribute belongs to, so its name is known.
  const tagOpen = card.lastIndexOf('<', start);
  if (tagOpen === -1) return '';
  const nameMatch = /^<([a-z][a-z0-9-]*)/i.exec(card.slice(tagOpen, tagOpen + 24));
  if (!nameMatch) return '';
  const tag = nameMatch[1].toLowerCase();

  const tagEnd = card.indexOf('>', start);
  if (tagEnd === -1) return '';
  if (card[tagEnd - 1] === '/') return ''; // self-closing: no text content

  // Walk to the element's own closing tag, counting nesting. A fixed-width
  // window cannot do this: StepStone nests an icon span inside the labelled
  // element (so the first `</span>` is not the end) and the element may be the
  // card's last hooked field (so "up to the next data-at" has no boundary
  // either). Both produced text with sibling markup fused onto it.
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  re.lastIndex = tagEnd + 1;
  let depth = 1;
  let end = -1;
  for (let m = re.exec(card); m; m = re.exec(card)) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) { end = m.index; break; }
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    }
  }
  // Unbalanced markup (truncated card): fall back to a bounded slice rather
  // than returning the rest of the document.
  const raw = card.slice(tagEnd + 1, end === -1 ? Math.min(card.length, tagEnd + 800) : end);
  // Drop a trailing partial tag left by that fallback — `<[^>]+>` cannot match
  // an unterminated one, so it would survive stripTags as literal text.
  return stripTags(raw.replace(/<[^>]*$/, ''));
}

/** Build a search URL. Only the modern /jobs/ path — see the robots note above. */
export function buildSearchUrl(query, city = DEFAULT_CITY, radius = DEFAULT_RADIUS) {
  const q = String(query || '').trim().replace(/\s+/g, '-').toLowerCase();
  if (!q) throw new Error('stepstone: empty query');
  const c = String(city || DEFAULT_CITY).trim().replace(/\s+/g, '-').toLowerCase();
  const r = Number.isFinite(Number(radius)) ? Math.max(0, Math.min(100, Number(radius))) : DEFAULT_RADIUS;
  return `https://${HOST}/jobs/${encodeURIComponent(q)}/in-${encodeURIComponent(c)}?radius=${r}`;
}

/**
 * Render one search URL via the scrapling CLI and return its HTML.
 * Throws with an actionable message when scrapling is absent — a missing
 * binary must not read as "no jobs found".
 */
async function renderViaScrapling(url) {
  const out = join(tmpdir(), `career-ops-stepstone-${randomBytes(6).toString('hex')}.html`);
  try {
    await execFileAsync('scrapling', ['extract', 'stealthy-fetch', url, out], {
      timeout: FETCH_TIMEOUT_MS,
      windowsHide: true,
    });
    return readFileSync(out, 'utf-8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /not recognized|not found/i.test(String(err.message)))) {
      throw new Error(
        'stepstone: the `scrapling` CLI is not on PATH. StepStone has no usable API and a plain fetch is '
        + 'refused, so this provider cannot run without it. Install it (pipx install scrapling && scrapling install) '
        + 'or disable the StepStone board in portals.yml.',
      );
    }
    throw new Error(`stepstone: scrapling failed for ${url} — ${err?.message ?? err}`);
  } finally {
    try { unlinkSync(out); } catch { /* best effort */ }
  }
}

/** @type {Provider} */
export default {
  id: 'stepstone',

  async fetch(entry) {
    const cfg = entry?.stepstone ?? {};
    const queries = Array.isArray(cfg.queries) ? cfg.queries.filter(Boolean) : [];
    if (queries.length === 0) {
      throw new Error(
        `stepstone: board "${entry?.name ?? '?'}" has no stepstone.queries — nothing to search. `
        + 'Add e.g. queries: ["werkstudent-data-science"].',
      );
    }
    if (queries.length > MAX_QUERIES) {
      throw new Error(`stepstone: ${queries.length} queries exceeds the cap of ${MAX_QUERIES} — split the board.`);
    }

    const city = cfg.city ?? DEFAULT_CITY;
    const radius = cfg.radius ?? DEFAULT_RADIUS;
    const out = [];
    const seen = new Set();

    for (const query of queries) {
      const url = buildSearchUrl(query, city, radius);
      const html = await renderViaScrapling(url);
      const jobs = parseStepstoneHtml(html);
      // Zero cards from a page that rendered at all means the markup hooks moved.
      // Say so — silence here would look exactly like "this query has no jobs".
      if (jobs.length === 0 && html.length > 50_000) {
        throw new Error(
          `stepstone: rendered ${html.length} bytes for "${query}" but found no job cards. `
          + 'The data-at hooks this provider parses have probably changed — update parseStepstoneHtml.',
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
