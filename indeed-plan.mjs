#!/usr/bin/env node
/**
 * indeed-plan.mjs — emit the exact Indeed searches to run for this profile.
 *
 * WHY THIS EXISTS
 * Indeed cannot be a `providers/` module. It publishes no public job API, its
 * RSS endpoint returns 403, and the only working route is an MCP `search_jobs`
 * tool — which is called by the AGENT, not by a node process. So `scan.mjs`
 * can never reach it, and the sweep has to be performed by whoever is driving
 * the run.
 *
 * That made it a judgement call every pass, and a judgement call that gets
 * skipped is indistinguishable from a source that yields nothing: Indeed
 * contributed 3 rows in this scanner's entire history, while producing two of
 * six evaluations in the single pass that actually used it.
 *
 * This script removes the judgement. It prints a concrete, ordered list of
 * `search_jobs` argument objects derived from the profile, so the agent's job
 * is mechanical: call the MCP once per row, collect the hits, hand them to
 * `ingest-jobs.mjs`. Nothing here talks to the network.
 *
 * Usage:
 *   node indeed-plan.mjs              # JSON plan (default)
 *   node indeed-plan.mjs --summary    # human-readable
 *
 * Queries come from `portals.yml` → `indeed.queries` when present; otherwise a
 * default set is derived from `config/profile.yml` → `target_roles.primary`
 * plus the German student-contract vocabulary that a DACH search needs and an
 * English-only term list would miss (Werkstudent, Praktikum, Abschlussarbeit).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(ROOT, 'config/profile.yml');
const PORTALS_PATH = join(ROOT, 'portals.yml');

// Indeed's search box is not an ATS keyword sieve: a query that is too broad
// returns thousands of irrelevant rows, and `portals.yml` → title_filter has 65
// terms precisely because it filters a full dataset AFTER the fact. A search
// plan needs few, specific, high-yield queries instead.
const MAX_QUERIES = 14;

function loadYaml(path) {
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * Default queries for a German student-tier AI/ML search.
 *
 * The German contract nouns are not decoration — they are how these roles are
 * titled in this market, and an English-only plan misses most of them. They are
 * paired with the profile's own primary target roles so the plan tracks the
 * user's targeting rather than a hardcoded idea of it.
 *
 * @param {string[]} primaryRoles from config/profile.yml → target_roles.primary
 */
export function defaultQueries(primaryRoles = []) {
  const german = [
    'Werkstudent Machine Learning',
    'Werkstudent Data Science',
    'Werkstudent Künstliche Intelligenz',
    'Werkstudent Datenanalyse',
    'Praktikum Data Science',
    'Praktikum Machine Learning',
    'Abschlussarbeit Machine Learning',
    'Studentische Hilfskraft Informatik',
  ];
  const english = ['Working Student Data Science', 'Working Student Machine Learning', 'AI Intern'];
  // Profile roles come last: they are the least market-specific phrasing, so
  // they fill remaining slots rather than displacing the German nouns.
  const fromProfile = primaryRoles.filter((r) => typeof r === 'string' && r.trim());
  const seen = new Set();
  const out = [];
  for (const q of [...german, ...english, ...fromProfile]) {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q.trim());
  }
  return out.slice(0, MAX_QUERIES);
}

/**
 * Build the plan: one object per MCP `search_jobs` call.
 *
 * @param {object} profile parsed config/profile.yml
 * @param {object} portals parsed portals.yml
 * @returns {{country_code: string, locations: string[], queries: string[], calls: Array<object>, ingest: string}}
 */
export function buildPlan(profile = {}, portals = {}) {
  const cfg = portals.indeed ?? {};
  const loc = profile.location ?? {};

  const city = cfg.city ?? loc.city ?? 'Germany';
  // A second, wider location catches remote and metro postings that a
  // city-scoped search misses; both are cheap because each is one MCP call.
  const locations = Array.isArray(cfg.locations) && cfg.locations.length
    ? cfg.locations.filter(Boolean)
    : [city, loc.country ?? 'Germany'].filter((v, i, a) => v && a.indexOf(v) === i);

  const queries = Array.isArray(cfg.queries) && cfg.queries.length
    ? cfg.queries.filter(Boolean).slice(0, MAX_QUERIES)
    : defaultQueries((profile.target_roles ?? {}).primary ?? []);

  const countryCode = cfg.country_code ?? (loc.country === 'Germany' ? 'DE' : undefined);
  if (!countryCode) {
    throw new Error(
      'indeed-plan: cannot determine country_code — set portals.yml → indeed.country_code, '
      + 'or config/profile.yml → location.country.',
    );
  }

  const calls = [];
  for (const location of locations) {
    for (const search of queries) {
      calls.push({ search, location, country_code: countryCode });
    }
  }

  return {
    country_code: countryCode,
    locations,
    queries,
    calls,
    ingest: 'node ingest-jobs.mjs --file <offers.json> --source indeed-mcp',
  };
}

function main(argv) {
  const plan = buildPlan(loadYaml(PROFILE_PATH), loadYaml(PORTALS_PATH));

  if (argv.includes('--summary')) {
    console.log(`\nIndeed search plan — ${plan.calls.length} call(s)\n`);
    console.log(`  country_code : ${plan.country_code}`);
    console.log(`  locations    : ${plan.locations.join(' · ')}`);
    console.log('\n  Queries:');
    for (const q of plan.queries) console.log(`    - ${q}`);
    console.log('\n  For EACH call, invoke the Indeed MCP `search_jobs` with {search, location,');
    console.log('  country_code}. Collect {url, company, title, location} for every hit, write them');
    console.log('  as a JSON array, then:\n');
    console.log(`    ${plan.ingest}\n`);
    console.log('  Then record the sweep so the run stage can complete:\n');
    console.log('    node run-all.mjs note-sources --note "indeed: N queries, M new"\n');
    return;
  }

  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
