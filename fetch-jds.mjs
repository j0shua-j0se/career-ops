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
 *   node fetch-jds.mjs --file <batch.json> --out <out.json> [--max-chars 3500] [--concurrency 3] [--timeout-ms 25000]
 *   node fetch-jds.mjs --help
 *
 * Input (--file): a JSON array of {key, url, company?, title?, location?} — the
 * shape scan-loop.mjs's `next` action returns as `batch` for the `score` step.
 *
 * Output (--out): a JSON array, same order, of
 *   {key, url, company, title, location, status, liveness, chars, text}
 * where status is one of:
 *   'ok'              — text is the compacted JD.
 *   'expired'         — classifyLiveness says the posting is gone.
 *   'robots-blocked'  — robots.txt disallows fetching this path; never navigated.
 *   'unsafe-url'      — egress guard refused the URL (private/invalid/loopback).
 *   'blocked'         — anti-bot/challenge page (Cloudflare, CAPTCHA, WAF denial).
 *   'error'           — navigation/timeout/other failure; retry or fall back.
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
import { validateFlags, flagValue, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage:
  node fetch-jds.mjs --file <batch.json> --out <out.json> [--max-chars 3500] [--concurrency 3] [--timeout-ms 25000]
  node fetch-jds.mjs --help                  # print this usage block and exit
  node fetch-jds.mjs -h                      # alias for --help`;

const DEFAULT_MAX_CHARS = 3500;
const DEFAULT_CONCURRENCY = 3;
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
    return { allowed: false, status: 'robots-blocked', code: verdict.code, reason: verdict.reason };
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

/**
 * Fetch and compact one entry's JD.
 *
 * `newPage` is a factory, not a page — it is called ONLY after the gate
 * passes, so a URL robots.txt disallows or the egress guard refuses never
 * gets so much as a page/context created for it, let alone navigated. That
 * makes this function the single seam to test "never navigated" against: pass
 * a `newPage` that throws, and a blocked URL must still resolve normally.
 *
 * @param {{key?:string, url:string, company?:string, title?:string, location?:string}} entry
 * @param {{newPage: () => Promise<object>, checkRobotsFn?: typeof checkRobots, maxChars?: number}} deps
 */
export async function fetchOne(entry, { newPage, checkRobotsFn = checkRobots, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const base = {
    key: entry.key ?? entry.url,
    url: entry.url,
    company: entry.company ?? '',
    title: entry.title ?? '',
    location: entry.location ?? '',
  };

  const gate = await gateUrl(entry.url, { checkRobotsFn });
  if (!gate.allowed) {
    return { ...base, status: gate.status, liveness: gate.code, chars: 0, text: '' };
  }

  let page;
  try {
    page = await newPage();
  } catch (err) {
    return { ...base, status: 'error', liveness: 'browser_error', chars: 0, text: '' };
  }

  try {
    const verdict = await checkUrlLiveness(page, entry.url);

    if (verdict.result === 'expired') {
      return { ...base, status: 'expired', liveness: verdict.code, chars: 0, text: '' };
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
    ['--file', '--out', '--max-chars', '--concurrency', '--timeout-ms', '--help', '-h'],
    USAGE,
    { valueFlags: ['--file', '--out', '--max-chars', '--concurrency', '--timeout-ms'], requireOperand: true },
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
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-jds: fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
