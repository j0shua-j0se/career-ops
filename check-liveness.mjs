#!/usr/bin/env node

/**
 * check-liveness.mjs — Playwright job link liveness checker
 *
 * Tests whether job posting URLs are still active or have expired.
 * Uses the same detection logic as scan.md step 7.5.
 * Zero Claude API tokens. Two rungs: a free public-API check first
 * (liveness-api.mjs, no browser), then Playwright for everything else.
 *
 * Usage:
 *   node check-liveness.mjs <url1> [url2] ...
 *   node check-liveness.mjs --file urls.txt
 *   node check-liveness.mjs --file data/pipeline.md
 *
 * `--file` takes either a plain one-URL-per-line list or `data/pipeline.md`
 * itself, so the `pipeline` mode Liveness sweep no longer needs the agent to
 * hand-copy URLs into a temp file first — the step that gets skipped in practice.
 *
 * Exit code: 0 if all active, 1 if any expired or uncertain
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
  jitteredDelayMs,
  sleep,
} from './liveness-browser.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { checkRobots } from './robots-gate.mjs';
import { extractPipelineUrls } from './liveness-core.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage:
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] <url1> [url2] ...
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] --file urls.txt
  node check-liveness.mjs --help                  # print this usage block and exit
  node check-liveness.mjs -h                      # alias for --help`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  // Portals like pracuj.pl serve a Cloudflare anti-bot wall to headless Chromium.
  // On a challenge we retry once in a headed browser (which clears it); pass
  // --no-fallback to stay fully headless (e.g. on a machine with no display).
  const noFallback = args.includes('--no-fallback');
  // --throttle or --throttle=<ms>: wait base..2*base ms (jittered) between checks
  // to stay under rate-based WAF limits. pracuj.pl's Cloudflare flags the session
  // after ~2 rapid hits, so a bulk run needs spacing. Default base 5000ms.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  const positional = args.filter((a) => a !== '--no-fallback' && a !== throttleArg);

  // Reject unknown flags instead of letting them fall through as URLs. Without
  // this, a typo (or a plausible-but-wrong flag like `--url https://…`) is
  // checked as if it were a posting, reports "invalid URL" as an `uncertain`
  // result, and flips the exit code to 1 — so a caller reading only the exit
  // status sees a liveness failure that never happened.
  const unknownFlags = positional.filter((a) => a.startsWith('--') && a !== '--file');
  if (unknownFlags.length > 0) {
    console.error(`check-liveness: unknown option(s): ${unknownFlags.join(', ')}`);
    console.error('Usage: node check-liveness.mjs [--no-fallback] [--throttle[=ms]] <url1> [url2] ...');
    console.error('       node check-liveness.mjs [--no-fallback] [--throttle[=ms]] --file urls.txt');
    console.error('Note: URLs are positional — there is no --url flag.');
    process.exit(2);
  }

  if (positional.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let urls, skippedLines = 0;
  if (positional[0] === '--file') {
    if (!positional[1]) {
      console.error('check-liveness: --file needs a path (a URL list or data/pipeline.md).');
      process.exit(1);
    }
    const text = await readFile(positional[1], 'utf-8');
    ({ urls, skipped: skippedLines } = extractPipelineUrls(text));
    if (urls.length === 0) {
      // An inbox with nothing pending is a normal state, not a failure — exiting
      // non-zero here would read as "something expired" to the pipeline sweep.
      // Lines that were present but unusable mean the wrong file was passed.
      if (skippedLines > 0) {
        console.error(`check-liveness: no http(s) URLs in ${positional[1]} (${skippedLines} line(s) unusable) — wrong file?`);
        process.exit(1);
      }
      console.log(`Nothing to check: no pending URLs in ${positional[1]}.`);
      process.exit(0);
    }
  } else {
    urls = positional;
  }

  const notes = [
    noFallback ? null : 'headed fallback on challenge',
    throttleBaseMs ? `throttle ~${throttleBaseMs / 1000}-${(throttleBaseMs * 2) / 1000}s` : null,
  ].filter(Boolean);
  console.log(`Checking ${urls.length} URL(s)...${notes.length ? ` (${notes.join(', ')})` : ''}`);
  // Never drop input silently: a mistyped path or an all-`local:` inbox should be
  // visible, not read as "everything was checked".
  if (skippedLines > 0) {
    console.log(`(skipped ${skippedLines} line(s) with no http(s) URL — processed rows, local: entries, or prose)`);
  }
  console.log('');

  // Lazy browser: the API rung resolves ATS postings with no browser at all, so we
  // only launch Playwright if a URL actually needs the fallback.
  let browser = null, page = null, headed = null;
  // One robots.txt read per host, not per URL: a sweep of 40 Siemens
  // requisitions must not fetch the same policy 40 times.
  const robotsCache = new Map();
  const robotsRefusals = new Map();
  async function robotsAllowsRetry(url) {
    let host;
    try { host = new URL(url).host; } catch { return { retry: false, reason: 'unparseable URL' }; }
    if (!robotsCache.has(host)) robotsCache.set(host, await checkRobots(url));
    return robotsCache.get(host);
  }
  async function ensureBrowser() {
    if (browser) return;
    browser = await chromium.launch({ headless: true });
    page = await newLivenessPage(browser);
    headed = noFallback ? null : createHeadedPageProvider(chromium);
  }

  let active = 0, expired = 0, uncertain = 0, viaApi = 0;

  // Sequential — project rule: never Playwright in parallel
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let result, reason, usedBrowser = false;

    // Rung 1: zero-token ATS API check. A conclusive active/expired wins; otherwise fall through.
    const api = await checkLivenessViaApi(url);
    if (api) {
      ({ result, reason } = api);
      viaApi++;
    } else {
      // Rung 2: Playwright — handles non-ATS pages and inconclusive API results.
      await ensureBrowser();
      // The headed retry exists to clear a bot challenge. That is legitimate
      // against a WAF default on a site whose published policy allows access,
      // and NOT legitimate against a site that has declined in robots.txt —
      // there it circumvents the exact mechanism the site was told to rely on.
      // Gate it: one cheap policy read, cached per host, and on refusal the
      // challenge stands as `uncertain` rather than being pushed through.
      let getHeadedPage;
      if (headed) {
        const verdict = await robotsAllowsRetry(url);
        if (verdict.retry) getHeadedPage = () => headed.get();
        else robotsRefusals.set(url, verdict.reason);
      }
      ({ result, reason } = await checkUrlLivenessWithFallback(page, url, { getHeadedPage }));
      if (result !== 'active' && robotsRefusals.has(url)) {
        reason = `${reason} — headed retry withheld: ${robotsRefusals.get(url)}`;
      }
      usedBrowser = true;
    }

    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} ${api ? '(api) ' : '      '}${url}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired++;
    else uncertain++;

    // Throttle only matters between browser checks (the API is cheap, not WAF-rate-limited).
    const wait = usedBrowser && i < urls.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
    if (wait) await sleep(wait);
  }

  if (headed) await headed.close();
  if (browser) await browser.close();

  console.log(`\nResults: ${active} active  ${expired} expired  ${uncertain} uncertain  (${viaApi} via API, no browser)`);
  if (expired > 0 || uncertain > 0) process.exitCode = 1;
}

// Guarded so tests can import extractPipelineUrls without launching the CLI.
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  });
}
