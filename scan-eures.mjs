#!/usr/bin/env node

/**
 * scan-eures.mjs — EURES (European Job Mobility Portal) scanner via Playwright
 *
 * EURES aggregates the member states' public employment service vacancies.
 * Results are rendered client-side by an Angular app and the portal's own
 * search API refuses non-browser clients, so this drives a real browser —
 * the same arrangement `scan-interamt.mjs` uses for Wicket.
 *
 * The parsing rules live in `eures-core.mjs` (pure, unit-tested). This file is
 * the only part that touches the network or the disk.
 *
 * **This scanner is slow on purpose.** europa.eu's robots.txt sets
 * `Crawl-delay: 10` for `User-agent: *`, so every page load is spaced ten
 * seconds apart. A three-keyword, two-page scan therefore takes about a
 * minute. Do not "optimise" the sleep away.
 *
 * Reads `eures_searches` from portals.yml; falls back to a generic set.
 *
 *   eures_searches:
 *     - was: "Werkstudent Data"
 *     - was: "Werkstudent KI"
 *   eures:
 *     location_codes: ["de"]   # ISO country codes; [] searches all of EURES
 *     pages: 2
 *
 * Usage:
 *   node scan-eures.mjs
 *   node scan-eures.mjs --dry-run
 *   node scan-eures.mjs --keyword "Werkstudent Data"
 *   node scan-eures.mjs --pages 3
 *   node scan-eures.mjs --all          # skip the incremental date filter
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  buildTitleFilter,
  buildLocationFilter,
  scanFilterFingerprint,
  filterSkipStatus,
  normalizeUrlForDedup,
} from './scan.mjs';
import {
  buildSearchUrl,
  toOffer,
  CRAWL_DELAY_MS,
  DEFAULT_RESULTS_PER_PAGE,
} from './eures-core.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// ── Config ───────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY = 'data/scan-history.tsv';
const CARD_SELECTOR = 'search-page-jv-result-summary';
const NAV_TIMEOUT_MS = 60_000;
const CARD_TIMEOUT_MS = 45_000;
const MAX_PAGES = 10;

// Generic fallback — configure eures_searches in portals.yml for your roles.
const DEFAULT_KEYWORDS = ['Werkstudent', 'Data Engineer', 'Machine Learning'];

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DEBUG = args.includes('--debug');
const NO_DATE_FILTER = args.includes('--all');

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`Error: ${flag} requires a value`);
    process.exit(1);
  }
  return v;
}

const SINGLE_KEYWORD = argValue('--keyword');
const PAGES_OVERRIDE = argValue('--pages');

// ── Load portals.yml ─────────────────────────────────────────────────

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

const euresConfig = config.eures || {};
const euresSearches = config.eures_searches || DEFAULT_KEYWORDS.map((k) => ({ was: k }));
const keywords = SINGLE_KEYWORD
  ? [SINGLE_KEYWORD]
  : euresSearches.map((s) => s.was).filter(Boolean);

const locationCodes = Array.isArray(euresConfig.location_codes)
  ? euresConfig.location_codes
  : ['de'];

const pages = (() => {
  const raw = PAGES_OVERRIDE !== null ? Number(PAGES_OVERRIDE) : euresConfig.pages;
  if (!Number.isInteger(raw) || raw < 1) return 1;
  return Math.min(raw, MAX_PAGES);
})();

// ── Filters ───────────────────────────────────────────────

// Both filters come from scan.mjs rather than being reimplemented here. The
// obvious local version — lowercase the string, `includes` each keyword — is
// wrong in two ways that produce no error and no warning:
//
//   * `location_filter` has THREE tiers (`always_allow`, `block`, `allow`), and
//     always_allow deliberately outranks block. A copy that reads only
//     `allow`/`block` silently ignores every always_allow entry: this profile
//     keeps its whole home region there, so the filter reports "0 filtered" and
//     looks satisfied while doing nothing.
//   * `title_filter.positive` supports AND-groups ("werkstudent + data" means
//     both words, any order) and word-boundary matching, so `includes` both
//     over- and under-matches.
//
// Sharing the builders means this scanner cannot drift from what `scan.mjs`
// and every provider already enforce.
const matchesTitle = buildTitleFilter(config.title_filter);
const locationFilter = buildLocationFilter(config.location_filter);
// Title/location skips are recorded with this fingerprint and dedup only while
// the filters stay the same, so a portals.yml filter change re-admits them.
const FILTER_FP = scanFilterFingerprint(config);

/** Most recent first_seen date for 'eures' rows in scan history, or null. */
function loadLastScanDate() {
  if (!existsSync(SCAN_HISTORY)) return null;
  let latest = null;
  readFileSync(SCAN_HISTORY, 'utf-8')
    .split('\n')
    .slice(1)
    .forEach((line) => {
      const parts = line.split('\t');
      if (parts[2] !== 'eures') return;
      const d = new Date(`${parts[1] || ''}T00:00:00Z`);
      if (!Number.isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
    });
  return latest;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scraper ──────────────────────────────────────────────────────────

/**
 * Read every result card on the current page.
 *
 * `search-page-jv-result-summary` is the Angular component's own element name.
 * The ECL utility classes beside it (`ecl-u-pv-l`, `ecl-content-block`) belong
 * to the Commission's shared design system and are reused across unrelated
 * europa.eu sites, so they are not identifying; the component tag is.
 */
async function extractCards(page) {
  return page.$$eval(CARD_SELECTOR, (cards) =>
    cards
      .map((card) => {
        const anchor = card.querySelector('a[href*="jv-details"]');
        if (!anchor) return null;
        const meta = [...card.querySelectorAll('li.ecl-content-block__primary-meta-item')].map(
          (li) => li.textContent.replace(/\s+/g, ' ').trim(),
        );
        return {
          href: anchor.getAttribute('href') || '',
          title: (anchor.textContent || '').replace(/\s+/g, ' ').trim(),
          meta,
        };
      })
      .filter(Boolean),
  );
}

/**
 * Run one keyword across the configured number of pages.
 *
 * `firstRequest` suppresses the crawl delay before the very first navigation of
 * the whole run — there is nothing to be polite about before the first request.
 */
async function searchEures(page, keyword, state) {
  const found = [];
  const seenOnThisKeyword = new Set();

  for (let n = 1; n <= pages; n++) {
    if (!state.first) await sleep(CRAWL_DELAY_MS);
    state.first = false;

    const url = buildSearchUrl(keyword, {
      page: n,
      resultsPerPage: DEFAULT_RESULTS_PER_PAGE,
      locationCodes,
    });
    if (DEBUG) console.log(`\n    GET ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForSelector(CARD_SELECTOR, { timeout: CARD_TIMEOUT_MS });
    } catch {
      // No cards rendered. On page 1 that is a real "no results" answer for a
      // narrow keyword; on a later page it is the end of the result set.
      break;
    }
    // The card list streams in after the first element appears.
    await page.waitForTimeout(2000);

    const cards = await extractCards(page);
    let added = 0;
    for (const card of cards) {
      const offer = toOffer(card);
      if (!offer) continue;
      if (seenOnThisKeyword.has(offer.url)) continue;
      seenOnThisKeyword.add(offer.url);
      found.push(offer);
      added++;
    }

    // Past the last page the portal re-serves the final page rather than 404ing,
    // so stop as soon as a page contributes nothing new.
    if (added === 0) break;
  }

  return found;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync('data', { recursive: true });

  if (keywords.length === 0) {
    console.error('Error: no keywords — set eures_searches in portals.yml or pass --keyword');
    process.exit(1);
  }

  const { seen, filterRecheck } = loadSeenUrls({ filterFingerprint: FILTER_FP });
  const date = localToday();

  const lastScanDate = NO_DATE_FILTER ? null : loadLastScanDate();
  if (NO_DATE_FILTER) {
    console.log('  --all: date filter disabled — fetching all available offers');
  } else if (lastScanDate) {
    console.log(`  Last EURES scan: ${lastScanDate.toISOString().slice(0, 10)} — skipping older offers`);
  }

  const estimate = Math.round((keywords.length * pages * CRAWL_DELAY_MS) / 1000);
  console.log(`  ${keywords.length} keyword(s) x ${pages} page(s), 10s crawl-delay — roughly ${estimate}s`);

  let totalFound = 0;
  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dateSkipped = [];
  const dupeSkipped = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  const state = { first: true };

  try {
    for (const kw of keywords) {
      process.stdout.write(`  Searching "${kw}"... `);
      try {
        const found = await searchEures(page, kw, state);
        totalFound += found.length;
        process.stdout.write(`${found.length} found\n`);

        for (const offer of found) {
          const location = [offer.location, offer.contract].filter(Boolean).join(' · ');
          const canonical = { ...offer, location };
          const posted = offer.postedAt ? new Date(offer.postedAt) : null;

          if (!matchesTitle(offer.title)) { if (!seen.has(canonical.url)) titleSkipped.push(canonical); seen.add(canonical.url); continue; }
          if (!locationFilter(offer.location, offer.url, offer.title)) { if (!seen.has(canonical.url)) locationSkipped.push(canonical); seen.add(canonical.url); continue; }
          // Same-day offers pass: lastScanDate is the day of the last run, and
          // an offer published later that same day is not stale.
          if (lastScanDate && posted && posted < lastScanDate && !filterRecheck.has(normalizeUrlForDedup(canonical.url))) { if (!seen.has(canonical.url)) dateSkipped.push(canonical); seen.add(canonical.url); continue; }
          if (seen.has(canonical.url)) { dupeSkipped.push(canonical); continue; }
          seen.add(canonical.url);
          newOffers.push(canonical);
        }
      } catch (err) {
        process.stdout.write('ERROR\n');
        errors.push({ keyword: kw, error: err.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!DRY_RUN) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, filterSkipStatus('skipped_title', FILTER_FP));
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, filterSkipStatus('skipped_location', FILTER_FP));
    if (dateSkipped.length > 0) await appendToScanHistory(dateSkipped, date, 'skipped_date');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`EURES Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Keywords searched:  ${keywords.length}`);
  console.log(`Pages per keyword:  ${pages}`);
  console.log(`Countries:          ${locationCodes.length > 0 ? locationCodes.join(', ') : 'all'}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered by date:   ${dateSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.keyword}": ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    console.log(DRY_RUN ? '\n(dry run — not saved)' : '\nSaved to data/pipeline.md');
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

// Import-safety guard: a test that imports this module must not run the scan.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
