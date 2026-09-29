// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// StepStone provider — the largest German job board.
//
// POLICY (rewritten 2026-09-24 — read this before changing the fetch path)
// This provider used to shell out to `scrapling extract stealthy-fetch`, a
// bot-detection-evasion CLI, to render the search page. On 2026-09-23,
// StepStone started answering HTTP 403 to BOTH this machine AND the user's own
// browser on the same IP — very likely triggered by that stealth traffic
// tripping StepStone's own abuse detection and blocking the whole egress IP,
// not just the automation. That is exactly the outcome bot-detection evasion
// exists to prevent, achieved by using it.
//
// The fix is not a stealthier fetch. It is fetching the way this repo fetches
// every other provider: a PLAIN HTTP request through `providers/_http.mjs`
// (`fetchText`), carrying the project's honest default User-Agent
// (`career-ops/1.0`, see user-agent.mjs) — no fingerprint spoofing, no headless
// browser, no CAPTCHA solving, no proxy/IP rotation. If StepStone still refuses
// the honest request (403/429, or a recognisable bot-challenge page even on a
// 200), this provider does NOT retry harder or escalate — it returns zero jobs
// for that request and trips `lib/host-circuit.mjs`'s circuit breaker for
// `www.stepstone.de`, so every OTHER caller in this repo (the Indeed-style
// PLAIN_HTTP rung in fetch-jds.mjs, the Playwright liveness rung, and
// check-liveness.mjs) stops sending it requests too, for 14 days. That is the
// whole point of the breaker: a job board that has started refusing this
// machine gets left alone rather than hammered.
//
// Every fetch consults the breaker FIRST, before a single request goes out —
// see `isHostBlocked` below. `node lib/host-circuit.mjs --list` shows the
// current state; `--clear www.stepstone.de` lifts a block early once access is
// confirmed restored (e.g. the user can load stepstone.de in their own browser
// again).
//
// ROBOTS
// Only the modern `/jobs/{query}/in-{city}` search path is used. StepStone's
// robots.txt (checked 2026-08-11, re-checked per-request via robots-gate.mjs
// below) Disallows the legacy `/5/` search endpoints, `/public-api/`,
// `/jobagent/`, `/m/` and `/mobile/` — none of which this touches — and does
// not Disallow `/jobs/`. Keep it that way: if a future change needs a
// different path, re-read robots.txt first. A disallowed path is a REFUSAL,
// same as robots-gate.mjs treats it everywhere else in this repo — this
// provider does not retry it with different headers.
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

// The shared decoder, not a private copy: five providers grew their own and the
// weakest emitted C0 control characters. test-all.mjs fails the build if a
// provider declares decodeEntities itself (#2902).
import { decodeEntities } from './_html-entities.mjs';
import { fetchText } from './_http.mjs';
import { checkRobots } from '../robots-gate.mjs';
import { isHostBlocked, tripHost, describeBlock } from '../lib/host-circuit.mjs';

const HOST = 'www.stepstone.de';
const DEFAULT_RADIUS = 30;
const DEFAULT_CITY = 'erlangen';
// A search page over plain HTTP is a normal server-rendered response, not a
// multi-second headless render — 20s leaves comfortable room for a slow day
// without letting one stalled query stall a whole board.
const MAX_QUERIES = 12;
const FETCH_TIMEOUT_MS = 20_000;
// A refusal earns the requesting host a two-week cooldown everywhere in this
// repo — see lib/host-circuit.mjs's file doc for why 14 days.
const CIRCUIT_TRIP_DAYS = 14;

// A search that legitimately matches nothing still renders a full page, so
// "no cards" alone cannot mean "the parser broke". Without this the provider
// reads a healthy empty result as a fault — the failure the Indeed board hit
// in production, where one narrow query aborted four working ones.
export const EMPTY_RESULT_RE = /keine\s+(?:passenden\s+)?(?:stellenangebote|jobs|treffer)|0\s+passende\s+jobs|nichts\s+gefunden|no\s+(?:matching\s+)?jobs\s+found/i;

// A recognisable bot-block/challenge page, even when it answers HTTP 200 (a
// WAF "soft block" that never reaches the origin). Matched in addition to the
// status-code check below, because a plain `fetchText` cannot see a JS
// challenge execute — only that the body it got back is one, not a search
// results page. Any hit here is treated exactly like a 403: trip the breaker,
// send no more requests this run.
export const BOT_BLOCK_RE = /\b(access denied|pardon our interruption|attention required|are you a human|verify you are human|unusual traffic|request blocked|cf-error-details|captcha)\b/i;

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
async function fetchStepstonePage(url, { fetchTextFn = fetchText } = {}) {
  return fetchTextFn(url, { timeoutMs: FETCH_TIMEOUT_MS });
}

/** @type {Provider} */
export default {
  id: 'stepstone',

  async fetch(entry, deps = {}) {
    const {
      fetchTextFn = fetchText,
      checkRobotsFn = checkRobots,
      isHostBlockedFn = isHostBlocked,
      tripHostFn = tripHost,
    } = deps;

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

    // Circuit breaker — consulted BEFORE any request, every run. A host that
    // has already refused this machine gets no further traffic until the
    // cooldown elapses, no matter how many queries are configured.
    const blocked = isHostBlockedFn(HOST);
    if (blocked) {
      console.error(`⚠️  stepstone: ${HOST} is circuit-broken (${describeBlock(blocked)}) — sending no requests this run. `
        + `Once access is confirmed restored, clear it with \`node lib/host-circuit.mjs --clear ${HOST}\`.`);
      return [];
    }

    const city = cfg.city ?? DEFAULT_CITY;
    const radius = cfg.radius ?? DEFAULT_RADIUS;
    const out = [];
    const seen = new Set();

    // Per-query resilience: one narrow query must not abort the board. See the
    // Indeed provider for the incident this prevents.
    const failures = [];
    let succeeded = 0;
    let tripped = false;

    for (const query of queries) {
      if (tripped) break; // the breaker just tripped mid-loop — stop sending requests now, not after the loop finishes.

      const url = buildSearchUrl(query, city, radius);

      const robotsVerdict = await checkRobotsFn(url);
      if (!robotsVerdict.retry && robotsVerdict.code === 'disallowed') {
        failures.push(`"${query}": robots.txt disallows ${url} — ${robotsVerdict.reason}`);
        continue;
      }

      let html = '';
      let jobs = [];
      try {
        html = await fetchStepstonePage(url, { fetchTextFn });
        jobs = parseStepstoneHtml(html);
      } catch (err) {
        const status = err?.status;
        if (status === 403 || status === 429) {
          tripHostFn(HOST, {
            status,
            reason: `stepstone: HTTP ${status} on ${url}`,
            days: CIRCUIT_TRIP_DAYS,
          });
          failures.push(`"${query}": HTTP ${status} — circuit breaker tripped for ${HOST} (${CIRCUIT_TRIP_DAYS} days)`);
          tripped = true;
          continue;
        }
        failures.push(`"${query}": ${err?.message ?? err}`);
        continue;
      }

      if (BOT_BLOCK_RE.test(html)) {
        tripHostFn(HOST, {
          status: 200,
          reason: `stepstone: bot-challenge page served for ${url}`,
          days: CIRCUIT_TRIP_DAYS,
        });
        failures.push(`"${query}": bot-challenge page (HTTP 200 body) — circuit breaker tripped for ${HOST} (${CIRCUIT_TRIP_DAYS} days)`);
        tripped = true;
        continue;
      }

      if (jobs.length === 0) {
        // A genuinely empty search is a normal outcome, not a fault.
        if (EMPTY_RESULT_RE.test(html)) { succeeded++; continue; }
        // Cards absent AND no empty-marker on a full page: the data-at hooks
        // this provider parses have probably moved. Record it, keep going.
        if (html.length > 50_000) {
          failures.push(
            `"${query}": rendered ${html.length} bytes with neither job cards nor an empty-results `
            + 'marker — the data-at hooks may have changed; check parseStepstoneHtml',
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
    if (succeeded === 0 && failures.length > 0 && !tripped) {
      throw new Error(`stepstone: every query failed —\n  ${failures.join('\n  ')}`);
    }
    if (failures.length > 0) {
      console.error(`⚠️  stepstone: ${failures.length} of ${queries.length} queries failed (continuing):\n  ${failures.join('\n  ')}`);
    }

    return out;
  },
};
