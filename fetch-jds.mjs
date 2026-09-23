#!/usr/bin/env node

/**
 * fetch-jds.mjs — zero-token job-description pre-fetcher.
 *
 * WHY: a triage worker (modes/triage.md) spends ~7-8k tokens per posting (up to
 * ~24k when a browser is needed) mostly on WebFetch/browser page text and tool
 * round trips, against a triage budget of ~500 reasoning tokens. This script
 * pre-fetches and compacts each JD with Playwright + pure text rules, so one
 * worker can triage a whole batch from one small local JSON file instead of
 * fetching every posting itself.
 *
 * Reuses the project's existing liveness stack rather than reinventing it:
 *   - liveness-api.mjs: checkLivenessViaApi — the same zero-token ATS API rung
 *     check-liveness.mjs consults FIRST, before any browser (Workday, Greenhouse,
 *     Lever, Ashby, ...). A confirmed-live posting also hands back the API's own
 *     description text, used directly instead of ever opening a page for it —
 *     this is what fixes the false `expired` on ATS SPAs that don't render
 *     under headless Playwright (Workday) and the false `robots-blocked` on a
 *     soft-200 robots.txt (Greenhouse): the API route is a public JSON
 *     endpoint, not the job page, so neither failure mode can reach it.
 *   - liveness-browser.mjs: newLivenessPage / checkUrlLiveness / rejectPrivateOrInvalid /
 *     validateUrlSecurity / isChallengeResult — the same egress guard, UA, and
 *     navigation pattern check-liveness.mjs uses.
 *   - robots-gate.mjs: checkRobots — the same robots.txt policy gate.
 *   - liveness-core.mjs (via checkUrlLiveness): classifyLiveness verdicts.
 *
 * Headless only — deliberately does NOT use check-liveness.mjs's headed
 * fallback. A challenge/CAPTCHA page is reported as `blocked`, never solved or
 * bypassed.
 *
 * Usage:
 *   node fetch-jds.mjs --file <batch.json> --out <out.json> [--max-chars 3500] [--concurrency 6] [--timeout-ms 25000]
 *                      [--gate-out <gated.txt>] [--rest-out <rest.json>]
 *   node fetch-jds.mjs --help
 *
 * --gate-out / --rest-out split the batch before any model sees it: verdicts
 * the triage contract already makes deterministic (expired, not fetchable) and
 * the German hard stop are written as ready-to-record TRIAGE lines, and only
 * the remainder goes to a worker. See splitGatedResults().
 *
 * Input (--file): a JSON array of {key, url, company?, title?, location?} — the
 * shape scan-loop.mjs's `next` action returns as `batch` for the `score` step.
 *
 * Output (--out): a JSON array, same order, of
 *   {key, url, company, title, location, status, liveness, chars, text}
 * where status is one of:
 *   'ok'                 — text is the compacted JD (from the ATS API or the page).
 *   'expired'            — a STRONG signal the posting is gone (HTTP 404/410, an
 *                          explicit expired/closed text match, a redirect to a
 *                          listing/search page) — see EXPIRED_CODE_STATUS below.
 *   'robots-blocked'     — robots.txt explicitly disallows fetching this path
 *                          (checkRobots code 'disallowed'); never navigated.
 *   'robots-unconfirmed' — robots.txt permission could not be confirmed (a
 *                          soft-200 body, an unreadable policy, ...) — NOT a
 *                          real refusal, but never navigated either; the triage
 *                          worker falls back to WebFetch/browser for these.
 *   'unsafe-url'         — egress guard refused the URL (private/invalid/loopback).
 *   'blocked'            — anti-bot/challenge page (Cloudflare, CAPTCHA, WAF denial).
 *   'error'              — navigation/timeout/other failure, OR a classifyLiveness
 *                          `expired` code that is NOT a strong signal (e.g.
 *                          'insufficient_content' — a page that simply didn't
 *                          render, most often an ATS SPA under headless
 *                          Playwright, not proof the posting is gone); retry or
 *                          fall back.
 */

import { readFile, writeFile } from 'fs/promises';
import { chromium } from 'playwright';
import {
  newLivenessPage,
  checkUrlLiveness,
  rejectPrivateOrInvalid,
  validateUrlSecurity,
  isChallengeResult,
  sameOrigin,
} from './liveness-browser.mjs';
import { checkRobots } from './robots-gate.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { fetchText } from './providers/_http.mjs';
import { validateFlags, flagValue, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage:
  node fetch-jds.mjs --file <batch.json> --out <out.json> [--max-chars 3500] [--concurrency 6] [--timeout-ms 25000]
                     [--gate-out <gated.txt>] [--rest-out <rest.json>]
      --gate-out  TRIAGE lines for verdicts that need no model (expired, not fetchable,
                  German hard stop), in the form \`scan-loop.mjs record\` reads
      --rest-out  the entries still needing a triage worker
  node fetch-jds.mjs --help                  # print this usage block and exit
  node fetch-jds.mjs -h                      # alias for --help`;

const DEFAULT_MAX_CHARS = 3500;
// A batch is one scan-loop scoring turn — 12 postings, almost always 12
// different hosts — and most entries never open a page at all, because the
// API-first path answers Greenhouse/Lever/Ashby/Workday without the browser.
// Each entry that does open one gets its own context, closed in a finally, so
// the ceiling is this many live contexts in a single headless Chromium.
// 3 meant a 12-URL batch waited through four sequential rounds of a 25s
// timeout; 6 halves that. --concurrency still tunes it, down as well as up.
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 25_000;
const SIGNAL_CAP_CHARS = 800;

// ─── compactJdText ──────────────────────────────────────────────────────────

// Nav/footer/legal chrome that carries no JD signal. Matched against the WHOLE
// trimmed line (after whitespace normalization) so a sentence that happens to
// contain "share" is never dropped — only a line that IS one of these labels.
const BOILERPLATE_EXACT_PATTERNS = [
  /^(login|log ?in|sign ?in|anmelden|register|registrieren)$/i,
  /^(menu|menü|navigation)$/i,
  /^(share|teilen|share (this )?job|diesen job teilen)$/i,
  /^(impressum|datenschutz(erklärung)?|privacy policy|privacy notice)$/i,
  /^(terms (of use|of service)|nutzungsbedingungen|agb)$/i,
  /^cookie(s)?( policy| einstellungen| settings| hinweis)?$/i,
  /^(facebook|twitter|x \(twitter\)|linkedin|instagram|youtube|xing|whatsapp|tiktok)$/i,
  /^(home|startseite|karriere ?(startseite)?)$/i,
  /^(zur (übersicht|jobsuche)|back to (search|results|jobs?)|zurück zur (suche|übersicht))$/i,
  /^©\s?\d{4}/,
];

// Phrase-style boilerplate (consent banners) that can span most of a line but
// still carries no JD content — matched as a substring, not a whole-line label.
const BOILERPLATE_PHRASE_PATTERNS = [
  /this (website|site) uses cookies/i,
  /we use cookies/i,
  /diese (website|seite) verwendet cookies/i,
  /wir verwenden cookies/i,
  /accept all cookies|alle (cookies )?akzeptieren|essenzielle cookies|manage (my )?cookie preferences/i,
  /all rights reserved|alle rechte vorbehalten/i,
];

function isBoilerplateLine(line) {
  return BOILERPLATE_EXACT_PATTERNS.some((p) => p.test(line))
    || BOILERPLATE_PHRASE_PATTERNS.some((p) => p.test(line));
}

// Hard-disqualifier signals triage needs even when they fall past the head cut:
// language level, hours/contract, pay, experience/degree, location/remote.
const SIGNAL_PATTERNS = [
  /\b(deutsch|german|englisch|english)\b/i,
  /\b(c1|c2|b1|b2|a1|a2)\b/i,
  /fließend|fliessend|verhandlungssicher|\bfluent\b/i,
  /\bstunden\b|\bhours?\b|\bh\s*\/\s*woche\b/i,
  /\bvollzeit\b|\bteilzeit\b|full[-\s]?time|part[-\s]?time|\bbefristet\b|\bunbefristet\b|\bwerkstudent\b/i,
  /€|\beur\b|\bgehalt\b|\bsalary\b|\bvergütung\b|\btvöd\b|\be\d{1,2}\b/i,
  /\bjahre\b|\byears?\b|\berfahrung\b|\bexperience\b|\bbachelor\b|\bmaster\b|\bstudium\b|\benrolled\b|\beingeschrieben\b/i,
  /\bremote\b|\bhomeoffice\b|home office|\bhybrid\b|vor ort|on[-\s]?site/i,
];

function hasSignal(line) {
  return SIGNAL_PATTERNS.some((p) => p.test(line));
}

/**
 * Pure text compactor. Normalises whitespace, drops empty/near-empty lines,
 * exact duplicate lines, and obvious nav/legal boilerplate; keeps the head up
 * to `maxChars`, then appends hard-disqualifier signal lines found beyond that
 * cut (capped at ~800 extra chars) under a `--- signals beyond cut ---` marker.
 *
 * Untrusted-content note: this function only stores text for later human/LLM
 * reading. It never evaluates, executes, or otherwise interprets it.
 *
 * @param {string} rawText
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function compactJdText(rawText, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!rawText || typeof rawText !== 'string') return '';

  const seen = new Set();
  const lines = [];
  for (const raw of rawText.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/[ \t\f\v ]+/g, ' ').trim();
    if (line.length <= 2) continue;
    if (isBoilerplateLine(line)) continue;
    if (seen.has(line)) continue; // exact duplicate line
    seen.add(line);
    lines.push(line);
  }

  if (lines.length === 0) return '';

  const headLines = [];
  let headChars = 0;
  let cutIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const addLen = lines[i].length + (headLines.length > 0 ? 1 : 0); // +1 for the joining \n
    if (headChars + addLen > maxChars) {
      cutIndex = i;
      break;
    }
    headLines.push(lines[i]);
    headChars += addLen;
  }

  let result = headLines.join('\n');
  if (cutIndex < lines.length) {
    const remainder = lines.slice(cutIndex);
    const signalLines = [];
    let signalChars = 0;
    for (const line of remainder) {
      if (!hasSignal(line)) continue;
      const addLen = line.length + 1;
      if (signalChars + addLen > SIGNAL_CAP_CHARS) break;
      signalLines.push(line);
      signalChars += addLen;
    }
    if (signalLines.length > 0) {
      result += '\n--- signals beyond cut ---\n' + signalLines.join('\n');
    }
  }

  return result;
}

// ─── htmlToText ─────────────────────────────────────────────────────────────

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : m));
}

// Block-level tags whose CLOSE (or self-close, for <br>) marks a line break in
// plain-reading order. Deliberately conservative — this is not an HTML parser,
// just enough structure preservation that a Workday/Greenhouse job description
// reads as paragraphs and list items rather than one run-on line.
const BLOCK_CLOSE_TAGS = /<\/(p|div|li|h[1-6]|tr|blockquote|section|article|ul|ol)\s*>/gi;
const BR_TAGS = /<br\s*\/?>/gi;
const LI_OPEN_TAG = /<li\b[^>]*>/gi;

/**
 * Convert an ATS API's HTML job-description field to plain text: strip tags,
 * decode entities, keep line breaks at block-level elements. Not a full HTML
 * parser — a `<script>`/`<style>` body is not stripped as a unit (ATS JD HTML
 * doesn't carry either in practice), and malformed markup degrades to "tags
 * removed, text kept" rather than throwing.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let text = html
    .replace(BR_TAGS, '\n')
    .replace(BLOCK_CLOSE_TAGS, '\n')
    .replace(LI_OPEN_TAG, '\n- ')
    .replace(/<[^>]+>/g, ''); // strip every remaining tag
  text = decodeHtmlEntities(text);
  return text;
}

// ─── pre-navigation safety gate ─────────────────────────────────────────────

/**
 * Decide whether a URL may be navigated at all, BEFORE any browser touches it.
 * Runs the same egress guard checkUrlLiveness uses (rejectPrivateOrInvalid +
 * validateUrlSecurity) and the project's robots.txt gate (checkRobots).
 *
 * Exported as its own seam so tests can prove a disallowed/unsafe URL is never
 * navigated, by stubbing `checkRobotsFn` and asserting the caller never reaches
 * `page.goto` (see tests/fetch-jds.test.mjs).
 *
 * @param {string} url
 * @param {{checkRobotsFn?: typeof checkRobots}} [options]
 * @returns {Promise<{allowed:true}|{allowed:false, status:string, code:string, reason:string}>}
 */
export async function gateUrl(url, { checkRobotsFn = checkRobots } = {}) {
  const guard = rejectPrivateOrInvalid(url);
  if (guard) {
    return { allowed: false, status: 'unsafe-url', code: guard.code, reason: guard.reason };
  }
  try {
    await validateUrlSecurity(url);
  } catch (err) {
    return { allowed: false, status: 'unsafe-url', code: 'egress_blocked', reason: err.message };
  }
  const verdict = await checkRobotsFn(url);
  if (!verdict.retry) {
    // 'disallowed' is the one code that means the site actually declined (an
    // explicit robots.txt rule). Every other non-retry code — 'not_robots'
    // (soft-200: the body isn't a policy file), 'unreadable' (non-200 status
    // reading the policy), 'bad_url' — is the gate saying permission could not
    // be CONFIRMED, which is not the same thing as being refused. Treating it
    // as a refusal (the pre-fix behavior) turned every Greenhouse posting
    // behind a soft-200 robots.txt into a false 'robots-blocked' SKIP.
    const status = verdict.code === 'disallowed' ? 'robots-blocked' : 'robots-unconfirmed';
    return { allowed: false, status, code: verdict.code, reason: verdict.reason };
  }
  return { allowed: true };
}

// Below this fraction of body length, the preferred container is assumed to
// have missed the real content (see pickContainerText).
const CONTAINER_MIN_BODY_FRACTION = 0.4;
// Below this absolute length, the preferred container is assumed too small to
// be the JD body regardless of how it compares to body length (so a tiny
// whole page never forces a fallback that changes nothing).
const CONTAINER_MIN_CHARS = 1500;

/**
 * Pick between a "preferred" container's text (main/article/[role=main]) and
 * the whole document body's text, given both already extracted.
 *
 * The naive rule ("use main/article if it looks non-trivial, i.e. > 200
 * chars") false-negatives on pages where `main`/`article` wraps a SMALL
 * header/summary element rather than the actual JD body — StepStone's
 * `-inline.html` fragment is the reference case: a direct Playwright probe
 * (headless, same UA/context as checkUrlLiveness) found `main` there holds
 * only a 298-char title/company/location/"Studentenjob" snippet while
 * `document.body.innerText` carries the full ~11,800-char posting, tasks
 * section included. No iframe, no shadow root, nothing lazy-loaded on
 * scroll — the JD text is simply outside whatever `main` wraps on that page.
 * A fixed 200-char floor never catches this because the small container
 * still clears it.
 *
 * Rule: use the preferred container only when it is BOTH long enough in
 * absolute terms (>= CONTAINER_MIN_CHARS) AND a substantial fraction of the
 * body's length (>= CONTAINER_MIN_BODY_FRACTION) — i.e. it looks like it
 * actually contains the page's content, not just a fragment of it. Otherwise
 * fall back to the whole body, same signal `checkUrlLiveness` itself favors.
 *
 * Pure function — no DOM, no I/O — so the threshold logic is unit-testable
 * without a browser (see tests/fetch-jds.test.mjs).
 *
 * @param {string} preferredText
 * @param {string} bodyText
 * @returns {string}
 */
export function pickContainerText(preferredText, bodyText) {
  const preferred = (preferredText || '').trim();
  const body = (bodyText || '').trim();
  if (!preferred) return body;
  if (!body) return preferred;
  const substantial = preferred.length >= CONTAINER_MIN_CHARS
    && preferred.length >= CONTAINER_MIN_BODY_FRACTION * body.length;
  return substantial ? preferred : body;
}

/**
 * Grab page text for compacting: prefer `main`/`article`/`[role=main]` when it
 * looks substantial relative to the whole document (see pickContainerText),
 * otherwise fall back to the whole document body.
 *
 * Also folds in same-origin CHILD FRAMES, exactly like `checkUrlLiveness` does
 * for its own verdict (see liveness-browser.mjs's iCIMS comment): some ATS
 * (iCIMS, Infineon's Oracle/Taleo-based tenant, ...) render the actual JD
 * inside a same-origin content iframe and leave the top-level document as nav
 * + cookie-banner chrome. Without this, `status: 'ok'` entries for those ATS
 * would carry only boilerplate and no JD — checkUrlLiveness's verdict already
 * paid for loading those frames, so this just reads what is already there,
 * with no extra wait/poll.
 */
async function extractPageText(page) {
  const parts = [];
  try {
    const { preferredText, bodyText } = await page.evaluate(() => {
      const preferred = document.querySelector('main, article, [role="main"]');
      return {
        preferredText: preferred?.innerText ?? '',
        bodyText: document.body?.innerText ?? '',
      };
    });
    const main = pickContainerText(preferredText, bodyText);
    if (main) parts.push(main);
  } catch {
    // top-level read failed; frame text (if any) may still be useful below
  }

  if (typeof page?.frames === 'function' && typeof page?.mainFrame === 'function') {
    let finalUrl = '';
    try { finalUrl = page.url(); } catch { /* leave empty — sameOrigin then rejects */ }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if (!sameOrigin(frame.url() || '', finalUrl)) continue;
        const frameText = await frame.evaluate(() => document.body?.innerText ?? '');
        if (frameText && frameText.trim()) parts.push(frameText);
      } catch {
        // detached or cross-origin mid-read; the top-level text still stands
      }
    }
  }

  return parts.join('\n');
}

// classifyLiveness (liveness-core.mjs) can produce `result: 'expired'` from
// several codes; only some are strong enough to report `expired` here without
// ever having navigated a real, rendered page. The rest are conservatively
// downgraded to `error` so the triage worker falls back to WebFetch/browser
// instead of silently SKIPping a posting that may well still be live.
//
// Full inventory of classifyLiveness's `expired` codes, and why each maps the
// way it does:
//   http_gone            expired — HTTP 404/410, unambiguous.
//   expired_url          expired — redirected to a URL whose PATH names the
//                                  job gone/closed (e.g. .../job-no-longer-available.html).
//   expired_body         expired — explicit "no longer available"/"closed"/
//                                  "filled" text match in the rendered body.
//   not_found_body       expired — a blocking status (403/429/5xx) whose body
//                                  STILL explicitly reads not-found; the body
//                                  outranks the status code in both directions.
//   listing_page         expired — the final page is a listing/search page
//                                  ("N jobs found"), not a single posting.
//   insufficient_content  error  — body under MIN_CONTENT_CHARS. This is the
//                                  SPA-not-rendered case (Workday and others
//                                  never mount their client-side app under a
//                                  plain headless hit): thin content is NOT
//                                  proof the posting is gone, only that this
//                                  render attempt didn't work. A false
//                                  `expired` here is the worst failure mode —
//                                  triage.md SKIPs an `expired` status without
//                                  ever fetching, silently dropping a live
//                                  posting.
// (Every other classifyLiveness code — bot_challenge, access_blocked,
// server_error, site_error, redirected_off_posting, aggregator_delisted,
// apply_control_visible, email_apply_channel, no_apply_control — is not an
// `expired` result at all and is handled by the branches below this map.)
const EXPIRED_CODE_STATUS = {
  http_gone: 'expired',
  expired_url: 'expired',
  expired_body: 'expired',
  not_found_body: 'expired',
  listing_page: 'expired',
  insufficient_content: 'error',
};

// ─── zero-token German hard stop ────────────────────────────────────────────

// The German requirement that config/profile.yml's culture_screen treats as a
// hard stop for an A2 speaker: "sehr gute Deutschkenntnisse", "verhandlungs-
// sicheres Deutsch", "fließend", C1/C2 — and their English equivalents. On
// 2026-09-23 triage passed a Siemens role at 4.3 that the full evaluation then
// SKIPped on "Sehr gute Deutsch- und Englischkenntnisse", which was sitting in
// the pre-fetched text all along: ~196k tokens and 7 minutes to find a phrase
// a regex can see. Plain "gute Deutschkenntnisse" is deliberately NOT here —
// the profile does not treat it as a hard stop.
const GERMAN_HARD_STOP_RES = [
  /\bsehr\s+gute[nrs]?\s+deutsch(?!land)(?:kenntniss\w*|-|\b)/i,
  /\bverhandlungssicher\w*\s+(?:\w+\s+){0,2}deutsch(?!land)/i,
  /\bdeutsch(?!land)\w*\s+(?:\w+\s+){0,4}verhandlungssicher/i,
  /\bflie(?:ß|ss)end\w*\s+(?:\w+\s+){0,2}deutsch(?!land)/i,
  /\bdeutsch(?!land)\w*\s+(?:\w+\s+){0,4}flie(?:ß|ss)end/i,
  /\bdeutsch(?!land)\w*[^.\n]{0,25}\bc[12]\b/i,
  /\b[cC][12]\b[^.\n]{0,15}\bdeutsch(?!land)/i,
  /\b(?:fluent|native|very\s+good|excellent|business[- ]fluent)\s+(?:command\s+of\s+|skills\s+in\s+|in\s+)?german\b/i,
  /\bgerman\b[^.\n]{0,12}\b(?:fluent(?:ly)?|native|c1|c2)\b/i,
];

// Any of these in the same line turns the requirement into a preference, and
// German offered as an ALTERNATIVE to English ("Deutsch- oder Englisch-
// kenntnisse") means English alone qualifies — both keep the posting.
const GERMAN_HEDGE_RE = /\b(von vorteil|vorteilhaft|wünschenswert|wuenschenswert|idealerweise|ein plus|nice to have|a plus|is a plus|optional|preferred|beneficial|an advantage|advantageous|gerne|hilfreich|helpful|wäre schön)\b/i;
const GERMAN_ALTERNATIVE_RE = /deutsch\w*[\s-]*(?:oder|bzw\.?|und\s*\/\s*oder)\s*englisch|englisch\w*[\s-]*(?:oder|bzw\.?|und\s*\/\s*oder)\s*deutsch|german\s+(?:or|and\/or)\s+english|english\s+(?:or|and\/or)\s+german/i;

/**
 * The line of a job description that states a hard-stop German requirement,
 * verbatim, or null. Conservative by construction: a line that hedges the
 * requirement or offers English as an alternative never counts, because the
 * expensive error here is discarding a posting the candidate could have held.
 *
 * @param {string} text compacted JD text
 * @returns {string|null}
 */
export function germanHardStop(text) {
  if (!text || typeof text !== 'string') return null;
  for (const raw of text.split(/\r?\n|(?<=[.;!?])\s+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!GERMAN_HARD_STOP_RES.some((re) => re.test(line))) continue;
    if (GERMAN_HEDGE_RE.test(line) || GERMAN_ALTERNATIVE_RE.test(line)) continue;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return null;
}

// ─── zero-token verdicts ────────────────────────────────────────────────────

// One TRIAGE cell. parseTriageLine (loop-core.mjs) splits on `|` and reads the
// score from the third cell, so a pipe inside a company or role would shift the
// score and the line would be dropped silently — flatten them first.
function triageCell(value) {
  return String(value ?? '').replace(/[|\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || '?';
}

/**
 * Split a fetched batch into verdicts that need no model and the rest.
 *
 * Every rule here is one the triage contract (modes/triage.md) already makes
 * deterministic, or the German hard stop config/profile.yml defines — this
 * only stops paying a worker to apply them:
 *   - `expired`                     → SKIP, "Posting inaccessible or expired"
 *   - `robots-blocked` / `unsafe-url` → SKIP, "Not fetchable (robots.txt / unsafe URL)"
 *   - `ok` text with germanHardStop → FAIL 2.0/5, quoting the requirement verbatim
 * Anything else — including `blocked`, `error` and `robots-unconfirmed`, where
 * the contract still lets the worker try WebFetch — stays in `rest`.
 *
 * `gatedLines` are `{key}\tTRIAGE: ...` lines in exactly the form
 * `scan-loop.mjs record` reads, so they can be recorded next to the worker's.
 *
 * @param {Array<{key:string, company?:string, title?:string, status:string, text?:string}>} results
 * @returns {{gatedLines: string[], rest: object[], counts: {german:number, expired:number, notFetchable:number}}}
 */
export function splitGatedResults(results) {
  const gatedLines = [];
  const rest = [];
  const counts = { german: 0, expired: 0, notFetchable: 0 };
  for (const r of Array.isArray(results) ? results : []) {
    const head = `${r.key}\tTRIAGE:`;
    const who = `${triageCell(r.company)} | ${triageCell(r.title)}`;
    if (r.status === 'expired') {
      gatedLines.push(`${head} SKIP | ${who} | 0/5 | Posting inaccessible or expired`);
      counts.expired++;
      continue;
    }
    if (r.status === 'robots-blocked' || r.status === 'unsafe-url') {
      gatedLines.push(`${head} SKIP | ${who} | 0/5 | Not fetchable (robots.txt / unsafe URL)`);
      counts.notFetchable++;
      continue;
    }
    const quote = r.status === 'ok' ? germanHardStop(r.text) : null;
    if (quote) {
      gatedLines.push(`${head} FAIL | ${who} | 2.0/5 | Hard DQ (zero-token gate): German requirement "${triageCell(quote)}"`);
      counts.german++;
      continue;
    }
    rest.push(r);
  }
  return { gatedLines, rest, counts };
}

// ─── plain-HTTP rung ────────────────────────────────────────────────────────

// Hosts whose job pages are server-rendered and readable over a plain request
// while headless Chromium's navigation to them fails. Measured, not assumed:
// on the 2026-09-22 and 09-23 passes, StepStone navigations ended in
// `navigation_error` 4/4 and 4/5 times, and every failed batch pushed a
// WebFetch retry into the triage worker, while a plain GET of the same
// `-inline.html` page returned 200 with the full description in ~0.9 s and no
// redirect. Add a host here only with the same kind of evidence.
const PLAIN_HTTP_HOSTS = /(?:^|\.)stepstone\.de$/i;

// Words a real job description carries somewhere, in the languages these
// boards post in. A 200 with none of them is a consent wall, a search page or
// an interstitial, not a JD — and falls through to the browser.
const JD_SECTION_RE = /\b(aufgaben|dein profil|ihr profil|anforderungen|qualifikationen?|wir bieten|das bieten wir|responsibilities|requirements|qualifications|your tasks|what you will do|we offer)\b/i;

// Below this the page is a fragment (title/company/apply button), which the
// browser path already handles; the plain rung only claims a full JD.
const PLAIN_MIN_CHARS = 600;

/**
 * Read a JD with a single plain HTTP request, for PLAIN_HTTP_HOSTS only.
 *
 * Deliberately one-directional: it returns an `ok` result or `null`, never an
 * `expired` or `error`. Over plain HTTP a 403 is ambiguous — a StepStone
 * posting the browser saw as 410 answers 403 here — so no failure is
 * interpreted; every non-success simply hands the entry to the existing
 * browser path, exactly as before this rung existed. The worst it can do is
 * nothing. `fetchText` refuses redirects, so a public URL cannot bounce the
 * request somewhere private.
 *
 * @param {string} url
 * @param {{fetchTextFn?: typeof fetchText, maxChars?: number}} [deps]
 * @returns {Promise<{status:'ok', liveness:'plain_http', chars:number, text:string} | null>}
 */
export async function fetchPlainJd(url, { fetchTextFn = fetchText, maxChars = DEFAULT_MAX_CHARS } = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!PLAIN_HTTP_HOSTS.test(host)) return null;

  let html;
  try {
    html = await fetchTextFn(url);
  } catch {
    return null;
  }
  // A full page, unlike an API description, carries script and style bodies
  // that htmlToText would keep as text; drop them before extracting.
  const visible = String(html ?? '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = htmlToText(visible);
  if (!JD_SECTION_RE.test(text)) return null;
  const compact = compactJdText(text, { maxChars });
  if (!compact || compact.length < PLAIN_MIN_CHARS) return null;
  return { status: 'ok', liveness: 'plain_http', chars: compact.length, text: compact };
}

/**
 * Fetch and compact one entry's JD.
 *
 * `newPage` is a factory, not a page — it is called ONLY after the gate
 * passes, so a URL robots.txt disallows or the egress guard refuses never
 * gets so much as a page/context created for it, let alone navigated. That
 * makes this function the single seam to test "never navigated" against: pass
 * a `newPage` that throws, and a blocked URL must still resolve normally.
 *
 * Rung 1, before any of that: `checkLivenessViaApiFn` (liveness-api.mjs's
 * `checkLivenessViaApi`, same as check-liveness.mjs uses) — a zero-token check
 * against the posting's ATS API (Workday, Greenhouse, Lever, Ashby, ...). This
 * runs BEFORE the robots gate deliberately: it targets a fixed-host public
 * JSON API, never the job page itself, so the job page's robots.txt has no
 * say over it — matching check-liveness.mjs, which applies no robots check to
 * this rung either. A confirmed-live result carrying `description` text is
 * used directly as the JD (`status: 'ok'`), and a confirmed-gone result is
 * `status: 'expired'` — no browser is ever opened for either case. Anything
 * else (not an ATS URL, network/timeout, `uncertain`, or `active` with no
 * usable description) falls through to the existing gate + browser path.
 *
 * @param {{key?:string, url:string, company?:string, title?:string, location?:string}} entry
 * @param {{newPage: () => Promise<object>, checkRobotsFn?: typeof checkRobots, checkLivenessViaApiFn?: typeof checkLivenessViaApi, maxChars?: number}} deps
 */
export async function fetchOne(entry, {
  newPage,
  checkRobotsFn = checkRobots,
  checkLivenessViaApiFn = checkLivenessViaApi,
  fetchTextFn = fetchText,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const base = {
    key: entry.key ?? entry.url,
    url: entry.url,
    company: entry.company ?? '',
    title: entry.title ?? '',
    location: entry.location ?? '',
  };

  let api = null;
  try {
    api = await checkLivenessViaApiFn(entry.url);
  } catch {
    api = null; // API rung is best-effort; any failure here just falls through
  }
  if (api?.result === 'expired') {
    return { ...base, status: 'expired', liveness: api.code, chars: 0, text: '' };
  }
  if (api?.result === 'active' && api.description) {
    const compact = compactJdText(htmlToText(api.description), { maxChars });
    if (compact) {
      return { ...base, status: 'ok', liveness: api.code, chars: compact.length, text: compact };
    }
    // Confirmed live but nothing usable came out of the description field —
    // fall through to the gate + browser path rather than reporting `ok` with
    // no text.
  }
  // Every other outcome (null = not an ATS URL / inconclusive, `uncertain`, or
  // `active` with no description) is inconclusive FOR OUR PURPOSES (we need
  // JD text, not just a verdict) — fall through.

  const gate = await gateUrl(entry.url, { checkRobotsFn });
  if (!gate.allowed) {
    return { ...base, status: gate.status, liveness: gate.code, chars: 0, text: '' };
  }

  // Rung 2 — a plain HTTP read, for hosts where it is measured to work and the
  // browser is measured not to. Placed AFTER the gate on purpose: robots.txt
  // and the egress guard still decide first, and fetchText refuses redirects.
  const plain = await fetchPlainJd(entry.url, { fetchTextFn, maxChars });
  if (plain) return { ...base, ...plain };

  let page;
  try {
    page = await newPage();
  } catch (err) {
    return { ...base, status: 'error', liveness: 'browser_error', chars: 0, text: '' };
  }

  try {
    const verdict = await checkUrlLiveness(page, entry.url);

    if (verdict.result === 'expired') {
      // See EXPIRED_CODE_STATUS above: only a strong signal is reported
      // `expired`; an unrecognized future code defaults to `error` rather than
      // silently trusting a new classifyLiveness code to mean "gone".
      const status = EXPIRED_CODE_STATUS[verdict.code] ?? 'error';
      return { ...base, status, liveness: verdict.code, chars: 0, text: '' };
    }
    if (isChallengeResult(verdict)) {
      return { ...base, status: 'blocked', liveness: verdict.code, chars: 0, text: '' };
    }
    // Every other `uncertain` code (navigation_error, redirected_off_posting,
    // site_error, server_error, blocked_host, aggregator_delisted, ...) means
    // either the page never loaded properly or the text we'd capture is not
    // trustworthy as THIS posting's JD — report `error` so the triage worker
    // falls back to WebFetch/browser rather than triaging the wrong page.
    // `no_apply_control` is the one exception: it means real content loaded
    // (classifyLiveness already required >= its own MIN_CONTENT_CHARS to reach
    // it), just with no apply button detected — still good JD text for triage.
    if (verdict.result === 'uncertain' && verdict.code !== 'no_apply_control') {
      return { ...base, status: 'error', liveness: verdict.code, chars: 0, text: '' };
    }

    // Do NOT re-gate on a content-length threshold here: classifyLiveness
    // already decided `active`/`no_apply_control` using its own rules (an
    // apply control alone is sufficient — see `hasApplyControl` in
    // liveness-core.mjs, checked BEFORE that function's own length check), and
    // re-imposing a stricter length floor on top of an already-active verdict
    // produced a false `error` for real, live, thin-JD pages. Case in point:
    // StepStone's own `-inline.html` fragment renders only title/company/apply
    // — genuinely short — yet `check-liveness.mjs` correctly calls it `active`
    // via `apply_control_visible`; a length re-check here turned that into
    // `error` (`no_content`) even though the posting is live. Whatever text we
    // extracted, short or long, is reported as `ok`; only a truly EMPTY compact
    // result (extraction failed outright) falls back to `error`.
    const rawText = await extractPageText(page);
    const compact = compactJdText(rawText, { maxChars });
    if (!compact) {
      return { ...base, status: 'error', liveness: 'no_content', chars: 0, text: '' };
    }
    return { ...base, status: 'ok', liveness: verdict.code, chars: compact.length, text: compact };
  } catch (err) {
    return { ...base, status: 'error', liveness: 'exception', chars: 0, text: '' };
  }
}

// ─── concurrency pool ───────────────────────────────────────────────────────

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, runner);
  await Promise.all(workers);
  return results;
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise.then((v) => { clearTimeout(timer); return v; }), timeout]);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  validateFlags(
    args,
    ['--file', '--out', '--max-chars', '--concurrency', '--timeout-ms', '--gate-out', '--rest-out', '--help', '-h'],
    USAGE,
    { valueFlags: ['--file', '--out', '--max-chars', '--concurrency', '--timeout-ms', '--gate-out', '--rest-out'], requireOperand: true },
  );

  const filePath = flagValue(args, '--file');
  const outPath = flagValue(args, '--out');
  if (!filePath || !outPath) {
    console.error('fetch-jds: --file and --out are both required.');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const maxChars = safeIntFlag(flagValue(args, '--max-chars'), DEFAULT_MAX_CHARS);
  const concurrency = safeIntFlag(flagValue(args, '--concurrency'), DEFAULT_CONCURRENCY);
  const timeoutMs = safeIntFlag(flagValue(args, '--timeout-ms'), DEFAULT_TIMEOUT_MS);

  let batch;
  try {
    const raw = await readFile(filePath, 'utf-8');
    batch = JSON.parse(raw);
  } catch (err) {
    console.error(`fetch-jds: could not read/parse --file ${filePath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(batch)) {
    console.error(`fetch-jds: --file ${filePath} must contain a JSON array.`);
    process.exitCode = 1;
    return;
  }

  console.log(`fetch-jds: fetching ${batch.length} URL(s) (concurrency ${concurrency}, timeout ${timeoutMs}ms, max-chars ${maxChars})...`);

  const browser = await chromium.launch({ headless: true });
  let results;
  try {
    results = await runPool(batch, async (entry) => {
      const fallback = () => ({
        key: entry.key ?? entry.url,
        url: entry.url,
        company: entry.company ?? '',
        title: entry.title ?? '',
        location: entry.location ?? '',
        status: 'error',
        liveness: 'timeout',
        chars: 0,
        text: '',
      });

      // newPage() is only invoked by fetchOne AFTER its gate passes, so a
      // robots-blocked or unsafe URL never gets a page/context created at all.
      let createdPage = null;
      const newPage = async () => {
        createdPage = await newLivenessPage(browser);
        return createdPage;
      };
      try {
        return await withTimeout(fetchOne(entry, { newPage, maxChars }), timeoutMs, fallback);
      } finally {
        if (createdPage) await createdPage.context().close().catch(() => {});
      }
    }, concurrency);
  } finally {
    await browser.close();
  }

  await writeFile(outPath, JSON.stringify(results, null, 2), 'utf-8');

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`fetch-jds: wrote ${results.length} result(s) to ${outPath} — ${summary}`);

  // Optional: the verdicts no model is needed for, ready for `scan-loop.mjs
  // record`, and the remainder for the triage worker. --out above is always
  // the full batch, so callers that ignore these flags see no change.
  const gateOut = flagValue(args, '--gate-out');
  const restOut = flagValue(args, '--rest-out');
  if (gateOut || restOut) {
    const { gatedLines, rest, counts: g } = splitGatedResults(results);
    if (gateOut) await writeFile(gateOut, gatedLines.length ? `${gatedLines.join('\n')}\n` : '', 'utf-8');
    if (restOut) await writeFile(restOut, JSON.stringify(rest, null, 2), 'utf-8');
    console.log(`fetch-jds: zero-token verdicts ${gatedLines.length} (german=${g.german} expired=${g.expired} not-fetchable=${g.notFetchable}); ${rest.length} left for the triage worker`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-jds: fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
