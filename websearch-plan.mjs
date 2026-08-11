#!/usr/bin/env node
/**
 * websearch-plan.mjs — decide which `search_queries` to run this pass.
 *
 * WHY THIS EXISTS
 * `portals.yml` → `search_queries` holds 32 enabled `site:` queries covering
 * LinkedIn, XING, Google Careers, BMW and a dozen named employers. **No script
 * reads that section.** Only `validate-portals.mjs` (which checks syntax) and
 * `ingest-jobs.mjs` (which mentions it in a comment) reference the key at all.
 * They were configured, enabled, documented — and had never run.
 *
 * They cannot be automated: WebSearch is a tool the AGENT calls, exactly like
 * the Indeed MCP. What CAN be removed is the guesswork, which is what this does.
 *
 * WHY THESE SOURCES ARE REACHED THIS WAY AND NOT FETCHED
 * LinkedIn (`User-agent: * → Disallow: /`) and XING (`Disallow: /jobs/search/`,
 * whose matching `Allow` is scoped to `User-agent: Perplexity-User`) both refuse
 * automated fetching in robots.txt. They do permit search engines to index their
 * job pages — which is why a `site:` query returns results at all. Going through
 * a search engine is the route those sites allow; fetching them directly is not.
 * Do not "upgrade" this to a scraper.
 *
 * ROTATION
 * Running all 32 every pass is how this step gets skipped: it is too much work,
 * so it does not happen, and a step that does not happen is indistinguishable
 * from a source with no jobs. The plan therefore returns the STALEST N, tracked
 * in data/websearch-state.json, so every query runs regularly without any single
 * pass being expensive.
 *
 * Usage:
 *   node websearch-plan.mjs                 # JSON plan
 *   node websearch-plan.mjs --summary       # human-readable
 *   node websearch-plan.mjs --limit 8       # override how many to run
 *   node websearch-plan.mjs --all           # every enabled query
 *   node websearch-plan.mjs --record q1 q2  # mark queries as run (by name)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = join(ROOT, 'portals.yml');
const STATE_PATH = join(ROOT, 'data/websearch-state.json');

// Enough to make real progress in one pass without turning the scan stage into
// half an hour of searching. At 10 a pass, 32 queries cycle in ~3 passes.
const DEFAULT_LIMIT = 10;

/**
 * Sites that `scan.mjs` already sweeps zero-token every pass. Their
 * `search_queries` are deprioritised, not deleted: a search engine sometimes
 * surfaces a posting a board search missed, so they still run on rotation —
 * just after the sources that have no other route in.
 *
 * Keep this in step with providers/: when a source graduates to a provider, add
 * it here, or its queries keep eating the WebSearch budget forever.
 */
export const PROVIDER_COVERED_SITES = [
  'stepstone.de',
  'indeed.com',
  'arbeitsagentur.de',
  'arbeitnow.com',
];

/** @param {string} query a `site:`-style search query */
export function isProviderCovered(query) {
  const m = /site:([^\s)"']+)/i.exec(String(query || ''));
  if (!m) return 0;
  const host = m[1].replace(/^www\./, '').toLowerCase();
  return PROVIDER_COVERED_SITES.some((s) => host === s || host.endsWith(`.${s}`) || host.startsWith(`${s}/`)) ? 1 : 0;
}

export function loadState(path = STATE_PATH) {
  if (!existsSync(path)) return { lastRun: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { lastRun: parsed?.lastRun ?? {} };
  } catch {
    // A corrupt state file must not stop the sweep — it only costs freshness
    // ordering, so treat it as "nothing has run yet".
    return { lastRun: {} };
  }
}

export function saveState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Choose which queries to run, stalest first.
 *
 * Never-run queries sort ahead of everything: on the first pass that is all of
 * them, which is the correct outcome for a section that has never executed.
 *
 * @param {Array<{name:string, query:string, enabled?:boolean}>} queries
 * @param {{lastRun: Record<string, string>}} state
 * @param {{limit?: number, all?: boolean}} [opts]
 */
export function selectQueries(queries, state, { limit = DEFAULT_LIMIT, all = false } = {}) {
  const enabled = (Array.isArray(queries) ? queries : [])
    .filter((q) => q && q.enabled !== false && typeof q.query === 'string' && q.query.trim());

  const withAge = enabled.map((q) => {
    const last = state?.lastRun?.[q.name];
    const ts = last ? Date.parse(last) : NaN;
    return {
      name: q.name,
      query: q.query.trim(),
      lastRun: last ?? null,
      ts: Number.isFinite(ts) ? ts : -Infinity,
      providerCovered: isProviderCovered(q.query),
    };
  });

  // Sites that now have a zero-token provider sort LAST. Their queries stay
  // enabled — a search engine occasionally surfaces something a board search
  // misses — but spending a WebSearch budget on StepStone and Indeed, which
  // scan.mjs already sweeps in full every pass, is the definition of wasted
  // effort. Without this, 4 of the first 10 slots went to covered sites.
  // Within each tier: stalest first, -Infinity (never run) leading, and ties
  // keep config order so output is stable between passes.
  withAge.sort((a, b) => (a.providerCovered - b.providerCovered) || (a.ts - b.ts));
  return all ? withAge : withAge.slice(0, Math.max(1, limit));
}

/** Group selected queries by the site they target, purely for readable output. */
export function groupBySite(selected) {
  const groups = new Map();
  for (const q of selected) {
    const m = /site:([^\s)"']+)/i.exec(q.query);
    const site = m ? m[1].replace(/^www\./, '') : 'web';
    if (!groups.has(site)) groups.set(site, []);
    groups.get(site).push(q);
  }
  return [...groups.entries()].map(([site, items]) => ({ site, items }));
}

function loadPortals() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    return yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

function main(argv) {
  const portals = loadPortals();
  const state = loadState();
  const all = argv.includes('--all');
  const limIdx = argv.indexOf('--limit');
  const limit = limIdx !== -1 ? Number(argv[limIdx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT;

  // --record: mark the named queries as run now.
  const recIdx = argv.indexOf('--record');
  if (recIdx !== -1) {
    const names = argv.slice(recIdx + 1).filter((a) => !a.startsWith('--'));
    if (names.length === 0) {
      console.error('websearch-plan: --record needs at least one query name.');
      process.exit(1);
    }
    const now = new Date().toISOString();
    for (const n of names) state.lastRun[n] = now;
    saveState(state);
    console.log(`Recorded ${names.length} query/queries as run at ${now}.`);
    return;
  }

  const selected = selectQueries(portals.search_queries ?? [], state, { limit, all });
  const total = (portals.search_queries ?? []).filter((q) => q && q.enabled !== false).length;

  if (selected.length === 0) {
    console.log('No enabled search_queries in portals.yml — nothing to run.');
    return;
  }

  if (argv.includes('--summary')) {
    console.log(`\nWebSearch plan — ${selected.length} of ${total} enabled quer${total === 1 ? 'y' : 'ies'} (stalest first)\n`);
    for (const { site, items } of groupBySite(selected)) {
      console.log(`  ── ${site}`);
      for (const q of items) {
        console.log(`     ${q.lastRun ? `last run ${q.lastRun.slice(0, 10)}` : 'never run'} · ${q.name}`);
        console.log(`       ${q.query}`);
      }
    }
    console.log('\n  Run each `query` with the WebSearch tool. For every job posting in the results,');
    console.log('  collect {url, company, title, location} — the search snippet usually carries all');
    console.log('  four. Then:\n');
    console.log('    node ingest-jobs.mjs --file offers.json --source websearch\n');
    console.log('  Mark them run so the next pass rotates to the others:\n');
    console.log(`    node websearch-plan.mjs --record ${selected.slice(0, 2).map((q) => JSON.stringify(q.name)).join(' ')} ...\n`);
    console.log('  Do NOT fetch linkedin.com or xing.com directly — both Disallow it in robots.txt.');
    console.log('  Reaching them through a search engine is the route they permit.\n');
    return;
  }

  console.log(JSON.stringify({
    total,
    selected: selected.map(({ name, query, lastRun }) => ({ name, query, lastRun })),
    ingest: 'node ingest-jobs.mjs --file offers.json --source websearch',
    record: 'node websearch-plan.mjs --record "<name>" ...',
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
