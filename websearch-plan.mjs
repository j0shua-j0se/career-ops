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
 * YIELD
 * Staleness alone can't tell a productive query from a dead one — rotation
 * used to be the only signal. `ingest-jobs.mjs` now appends a row to
 * data/websearch-yield.tsv (date, query, source, leads, queued_new, dup_url,
 * dup_title) per `query` tag on an ingested offer. A query with 3+ logged
 * runs and zero `queued_new` across all of them is RETIRED — skipped by
 * default, listed under --summary, re-enabled with --include-retired. Among
 * the rest: never-run queries lead, then queries with any logged new lead,
 * then plain staleness.
 *
 * Usage:
 *   node websearch-plan.mjs                    # JSON plan
 *   node websearch-plan.mjs --summary          # human-readable
 *   node websearch-plan.mjs --limit 8          # override how many to run
 *   node websearch-plan.mjs --all              # every enabled, non-retired query
 *   node websearch-plan.mjs --include-retired  # also consider retired queries
 *   node websearch-plan.mjs --record q1 q2     # mark queries as run (by name)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const PORTALS_PATH = join(CAREER_OPS, 'portals.yml');
const STATE_PATH = join(CAREER_OPS, 'data/websearch-state.json');
const YIELD_PATH = process.env.CAREER_OPS_WEBSEARCH_YIELD || join(CAREER_OPS, 'data/websearch-yield.tsv');

// A run of this size costs real tokens for something that mostly re-finds
// already-known postings (measured: 10 queries + 6 Indeed searches ~114k
// tokens, 55 leads, 0 new). Yield-based retirement is what makes a smaller
// default safe — dead queries stop eating slots instead of just rotating
// through them. At 6 a pass, 32 queries cycle in ~5-6 passes.
const DEFAULT_LIMIT = 6;

// A query that has run at least this many times and never produced a single
// queued-new lead is retired: it keeps consuming a WebSearch slot every
// rotation for a result that history says will not change.
const RETIRE_AFTER_RUNS = 3;

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

/**
 * The query names following `--record`, stopping at the next flag.
 *
 * Filtering flags out instead of stopping at one swallowed the VALUES of every
 * later flag: `--record "Name" --hits 4 --ingested 0 --note "..."` recorded four
 * "queries" — the real one plus `4`, `0` and the note text — wrote three junk
 * keys into the staleness state, and printed "Recorded 4 query/queries" as if
 * that had gone well.
 *
 * @param {string[]} rest - argv after the `--record` token.
 * @returns {string[]}
 */
export function collectRecordNames(rest) {
  const stop = rest.findIndex((a) => a.startsWith('--'));
  return stop === -1 ? [...rest] : rest.slice(0, stop);
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
 * Parse data/websearch-yield.tsv: date, query, source, leads, queued_new,
 * dup_url, dup_title — one row per query per ingest-jobs.mjs run that carried
 * a `query` tag. Malformed/short lines are skipped rather than thrown on: a
 * corrupt yield log must cost ranking quality, never the sweep.
 *
 * @param {string} text
 * @returns {Array<{date:string, query:string, source:string, leads:number, queuedNew:number, dupUrl:number, dupTitle:number}>}
 */
export function parseYieldLog(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const [date, query, source, leads, queuedNew, dupUrl, dupTitle] = cols;
    if (!query) continue;
    rows.push({
      date, query, source,
      leads: Number(leads) || 0,
      queuedNew: Number(queuedNew) || 0,
      dupUrl: Number(dupUrl) || 0,
      dupTitle: Number(dupTitle) || 0,
    });
  }
  return rows;
}

/** Fold parsed yield rows into per-query { runs, totalQueuedNew }. */
export function aggregateYield(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const cur = m.get(r.query) ?? { runs: 0, totalQueuedNew: 0 };
    cur.runs += 1;
    cur.totalQueuedNew += r.queuedNew;
    m.set(r.query, cur);
  }
  return m;
}

export function loadYieldMap(path = YIELD_PATH) {
  if (!existsSync(path)) return new Map();
  try {
    return aggregateYield(parseYieldLog(readFileSync(path, 'utf-8')));
  } catch {
    // Same posture as loadState(): a corrupt log costs ranking quality, not
    // the sweep. Everything reads as "no yield data yet" (unknown, not retired).
    return new Map();
  }
}

/**
 * Enrich each enabled query with staleness + yield state. Shared by
 * selectQueries() (which then filters/sorts/slices it) and --summary's
 * "retired by yield" listing, so the two can never disagree about who's retired.
 *
 * A query with no yield rows yet is UNKNOWN, not retired — `runs` stays 0 and
 * `retired` stays false until it has actually been logged.
 *
 * @param {Array<{name:string, query:string, enabled?:boolean}>} queries
 * @param {{lastRun: Record<string, string>}} state
 * @param {Map<string, {runs:number, totalQueuedNew:number}>} [yieldMap]
 */
export function buildQueryStates(queries, state, yieldMap = new Map()) {
  const enabled = (Array.isArray(queries) ? queries : [])
    .filter((q) => q && q.enabled !== false && typeof q.query === 'string' && q.query.trim());

  return enabled.map((q) => {
    const last = state?.lastRun?.[q.name];
    const ts = last ? Date.parse(last) : NaN;
    const y = yieldMap.get(q.name);
    const runs = y?.runs ?? 0;
    const totalQueuedNew = y?.totalQueuedNew ?? 0;
    return {
      name: q.name,
      query: q.query.trim(),
      lastRun: last ?? null,
      ts: Number.isFinite(ts) ? ts : -Infinity,
      providerCovered: isProviderCovered(q.query),
      runs,
      totalQueuedNew,
      retired: runs >= RETIRE_AFTER_RUNS && totalQueuedNew === 0,
    };
  });
}

/**
 * Choose which queries to run.
 *
 * Selection order (within each providerCovered tier — see below):
 *   1. never-run queries lead — on the first pass that is all of them, which
 *      is the correct outcome for a section that has never executed.
 *   2. queries whose logged runs produced at least one queued-new lead —
 *      history says these are worth the slot.
 *   3. plain staleness (stalest first) for everything else.
 *
 * Retired queries (RETIRE_AFTER_RUNS+ logged runs, zero queued_new across all
 * of them) are excluded unless `includeRetired` is set — see buildQueryStates().
 *
 * @param {Array<{name:string, query:string, enabled?:boolean}>} queries
 * @param {{lastRun: Record<string, string>}} state
 * @param {{limit?: number, all?: boolean, yieldMap?: Map, includeRetired?: boolean}} [opts]
 */
export function selectQueries(queries, state, opts = {}) {
  const { limit = DEFAULT_LIMIT, all = false, yieldMap = new Map(), includeRetired = false } = opts;
  const withAge = buildQueryStates(queries, state, yieldMap);
  const usable = includeRetired ? withAge : withAge.filter((q) => !q.retired);

  // Sites that now have a zero-token provider sort LAST. Their queries stay
  // enabled — a search engine occasionally surfaces something a board search
  // misses — but spending a WebSearch budget on StepStone and Indeed, which
  // scan.mjs already sweeps in full every pass, is the definition of wasted
  // effort. Without this, 4 of the first 10 slots went to covered sites.
  const tierRank = (q) => (q.ts === -Infinity ? 0 : (q.totalQueuedNew > 0 ? 1 : 2));
  usable.sort((a, b) => (a.providerCovered - b.providerCovered) || (tierRank(a) - tierRank(b)) || (a.ts - b.ts));
  return all ? usable : usable.slice(0, Math.max(1, limit));
}

/**
 * Recommended Indeed MCP (search, location) pairs from portals.yml's
 * `indeed_searches`, with the same yield-based retirement as selectQueries()
 * — keyed by `indeed:<search>@<location>` ids in data/websearch-yield.tsv,
 * since ingest-jobs.mjs can't tell an Indeed MCP call apart from a WebSearch
 * one except by whatever `query` id the agent tags the offer with.
 *
 * @param {Array<{search:string, location:string}>} list
 * @param {Map<string, {runs:number, totalQueuedNew:number}>} yieldMap
 * @param {{includeRetired?: boolean}} [opts]
 */
export function indeedSearchId(entry) {
  return `indeed:${String(entry?.search ?? '').trim()}@${String(entry?.location ?? '').trim()}`;
}

export function selectIndeedSearches(list, yieldMap = new Map(), { includeRetired = false } = {}) {
  const items = (Array.isArray(list) ? list : [])
    .filter((e) => e && e.search && e.location)
    .map((e) => {
      const id = indeedSearchId(e);
      const y = yieldMap.get(id);
      const runs = y?.runs ?? 0;
      const totalQueuedNew = y?.totalQueuedNew ?? 0;
      return {
        search: e.search, location: e.location, id, runs, totalQueuedNew,
        retired: runs >= RETIRE_AFTER_RUNS && totalQueuedNew === 0,
      };
    });
  return {
    active: items.filter((i) => includeRetired || !i.retired),
    retired: items.filter((i) => i.retired),
  };
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

// Fallback when portals.yml has no indeed_searches list yet — see AGENTS.md
// (search_queries neighbourhood) for why these three.
const DEFAULT_INDEED_SEARCHES = [
  { search: 'Werkstudent Data', location: 'Erlangen' },
  { search: 'Working Student Machine Learning', location: 'München' },
  { search: 'Werkstudent KI', location: 'Nürnberg' },
];

function main(argv) {
  const portals = loadPortals();
  const state = loadState();
  const yieldMap = loadYieldMap();
  const all = argv.includes('--all');
  const includeRetired = argv.includes('--include-retired');
  const limIdx = argv.indexOf('--limit');
  const limit = limIdx !== -1 ? Number(argv[limIdx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT;

  // --record: mark the named queries as run now.
  const recIdx = argv.indexOf('--record');
  if (recIdx !== -1) {
    const names = collectRecordNames(argv.slice(recIdx + 1));
    if (names.length === 0) {
      console.error('websearch-plan: --record needs at least one query name.');
      process.exit(1);
    }

    // A name that matches no configured query is always a mistake, and a silent
    // one: the junk key is written, the query the user meant stays unrecorded,
    // and it keeps resurfacing as the stalest thing in the plan while appearing
    // to have been run.
    const configured = new Set((portals.search_queries ?? [])
      .filter((q) => q && typeof q.name === 'string')
      .map((q) => q.name));
    const unknown = names.filter((n) => !configured.has(n));
    if (unknown.length > 0) {
      console.error(`websearch-plan: --record got ${unknown.length} name(s) that match no query in portals.yml → search_queries:`);
      for (const n of unknown) console.error(`  • ${JSON.stringify(n)}`);
      console.error('Nothing was recorded. Names must match exactly — copy them from `--summary`.');
      process.exit(1);
    }

    const now = new Date().toISOString();
    for (const n of names) state.lastRun[n] = now;
    saveState(state);
    console.log(`Recorded ${names.length} query/queries as run at ${now}.`);
    return;
  }

  const selected = selectQueries(portals.search_queries ?? [], state, { limit, all, yieldMap, includeRetired });
  const total = (portals.search_queries ?? []).filter((q) => q && q.enabled !== false).length;
  const retiredQueries = buildQueryStates(portals.search_queries ?? [], state, yieldMap).filter((q) => q.retired);
  const indeedList = Array.isArray(portals.indeed_searches) && portals.indeed_searches.length
    ? portals.indeed_searches : DEFAULT_INDEED_SEARCHES;
  const indeed = selectIndeedSearches(indeedList, yieldMap, { includeRetired });

  if (selected.length === 0 && !argv.includes('--summary')) {
    console.log('No enabled, non-retired search_queries in portals.yml — nothing to run.');
    return;
  }

  if (argv.includes('--summary')) {
    console.log(`\nWebSearch plan — ${selected.length} of ${total} enabled quer${total === 1 ? 'y' : 'ies'} (stalest first)\n`);
    for (const { site, items } of groupBySite(selected)) {
      console.log(`  ── ${site}`);
      for (const q of items) {
        console.log(`     ${q.lastRun ? `last run ${q.lastRun.slice(0, 10)}` : 'never run'} · ${q.name}`);
      }
    }
    if (retiredQueries.length) {
      console.log(`\n  Retired by yield, re-enable with --include-retired:`);
      for (const q of retiredQueries) console.log(`     ${q.name} (${q.runs} runs, 0 new)`);
    }
    console.log('\n  Run each `query` with the WebSearch tool; collect {url, company, title, location}');
    console.log('  and tag each offer query: "<name>" so ingest-jobs.mjs logs its yield. Then:\n');
    console.log('    node ingest-jobs.mjs --file offers.json --source websearch\n');
    console.log(`    node websearch-plan.mjs --record ${selected.slice(0, 2).map((q) => JSON.stringify(q.name)).join(' ')} ...\n`);
    console.log('  Do NOT fetch linkedin.com or xing.com directly — reach them via the search engine.');

    console.log(`  Indeed searches (agent-run via MCP, not by this script):`);
    for (const i of indeed.active) console.log(`     ${i.search} @ ${i.location}  (${i.runs} runs, ${i.totalQueuedNew} new) · tag offers query: "${i.id}"`);
    if (indeed.retired.length) {
      console.log(`   retired by yield, re-enable with --include-retired:`);
      for (const i of indeed.retired) console.log(`     ${i.search} @ ${i.location}`);
    }
    return;
  }

  console.log(JSON.stringify({
    total,
    selected: selected.map(({ name, query, lastRun }) => ({ name, query, lastRun })),
    retired: retiredQueries.map((q) => q.name),
    indeedSearches: indeed,
    ingest: 'node ingest-jobs.mjs --file offers.json --source websearch',
    record: 'node websearch-plan.mjs --record "<name>" ...',
  }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
