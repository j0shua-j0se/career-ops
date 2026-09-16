// tests/websearch-plan.test.mjs — portals.yml → search_queries held 32 enabled
// `site:` queries covering LinkedIn, XING, Google Careers, BMW and a dozen named
// employers. NOTHING read that section: only validate-portals.mjs (syntax) and a
// comment in ingest-jobs.mjs referenced the key. They were configured, enabled,
// documented — and had never run once.
//
// They cannot be automated: WebSearch is an agent tool. What this removes is the
// guesswork about WHICH to run, and the all-or-nothing cost that made the step
// get skipped.
import { pass, fail } from './helpers.mjs';
import {
  selectQueries, isProviderCovered, groupBySite, PROVIDER_COVERED_SITES, collectRecordNames,
  parseYieldLog, aggregateYield, buildQueryStates, selectIndeedSearches, indeedSearchId,
} from '../websearch-plan.mjs';

console.log('\nWebSearch plan');

const q = (name, query, enabled = true) => ({ name, query, enabled });
const queries = [
  q('LinkedIn A', 'site:linkedin.com/jobs "Werkstudent" Erlangen'),
  q('XING A', 'site:xing.com/jobs "Werkstudent" Bayern'),
  q('StepStone A', 'site:stepstone.de "Werkstudent" Nürnberg'),
  q('Indeed A', 'site:de.indeed.com "Werkstudent" München'),
  q('BMW A', 'site:bmwgroup.jobs "Praktikum"'),
  q('Disabled A', 'site:example.com "x"', false),
];

// --- Rotation. Running all 32 every pass is how the step gets skipped.
{
  const sel = selectQueries(queries, { lastRun: {} }, { limit: 3 });
  sel.length === 3
    ? pass('the plan is capped so one pass is affordable')
    : fail(`expected 3 queries, got ${sel.length}`);

  sel.every(s => s.name !== 'Disabled A')
    ? pass('disabled queries are never selected')
    : fail('a disabled query was selected');
}

// Never-run queries lead: on the first pass that is all of them, which is the
// right answer for a section that has never executed.
{
  const state = { lastRun: { 'LinkedIn A': '2026-08-01T00:00:00Z' } };
  const sel = selectQueries(queries, state, { limit: 6, all: false });
  const names = sel.map(s => s.name);
  names.indexOf('XING A') < names.indexOf('LinkedIn A')
    ? pass('a never-run query sorts ahead of one that ran recently')
    : fail(`staleness ordering wrong: ${names.join(', ')}`);
}

{
  const state = { lastRun: { 'XING A': '2026-01-01T00:00:00Z', 'LinkedIn A': '2026-08-01T00:00:00Z' } };
  const sel = selectQueries(queries.filter(x => /LinkedIn A|XING A/.test(x.name)), state, { limit: 2 });
  sel[0].name === 'XING A'
    ? pass('among run queries, the stalest goes first')
    : fail(`expected XING A first, got ${sel[0].name}`);
}

// --- Provider-covered sites are deprioritised, not deleted.
// Spending a WebSearch budget on StepStone and Indeed — which scan.mjs sweeps
// in full every pass — is wasted effort. Before this, 4 of the first 10 slots
// went to covered sites.
{
  isProviderCovered('site:stepstone.de "x"') === 1 && isProviderCovered('site:de.indeed.com "x"') === 1
    ? pass('StepStone and Indeed queries are recognised as provider-covered')
    : fail('provider-covered detection missed a covered site');

  isProviderCovered('site:linkedin.com/jobs "x"') === 0 && isProviderCovered('site:xing.com/jobs "x"') === 0
    ? pass('LinkedIn and XING are NOT treated as covered — they have no provider and cannot get one')
    : fail('an uncovered site was treated as covered');

  const sel = selectQueries(queries, { lastRun: {} }, { limit: 3 });
  sel.every(s => !/StepStone|Indeed/.test(s.name))
    ? pass('covered sites do not consume the first slots')
    : fail(`a covered site took a top slot: ${sel.map(s => s.name).join(', ')}`);

  // ...but they are still reachable, so nothing is silently dropped.
  const all = selectQueries(queries, { lastRun: {} }, { all: true });
  all.some(s => s.name === 'StepStone A')
    ? pass('covered queries still appear in --all — deprioritised, not deleted')
    : fail('a covered query vanished entirely');
}

// A source graduating to a provider must be added to the list, or its queries
// eat the budget forever. Pin the ones that have graduated.
PROVIDER_COVERED_SITES.includes('stepstone.de') && PROVIDER_COVERED_SITES.includes('indeed.com')
  ? pass('the covered-site list names the sources that became providers today')
  : fail('a graduated source is missing from PROVIDER_COVERED_SITES');

// --- Grouping is cosmetic but must not lose or duplicate queries.
{
  const sel = selectQueries(queries, { lastRun: {} }, { all: true });
  const grouped = groupBySite(sel).flatMap(g => g.items);
  grouped.length === sel.length
    ? pass('grouping preserves every selected query')
    : fail(`grouping changed the count: ${sel.length} -> ${grouped.length}`);
}

// --- Degenerate input must not throw: a broken portals.yml costs freshness
// ordering at worst, never the sweep.
selectQueries([], { lastRun: {} }, {}).length === 0
  && selectQueries(null, null, {}).length === 0
  && selectQueries([{ name: 'x' }], { lastRun: {} }, {}).length === 0
  ? pass('empty, null and malformed query lists yield nothing without throwing')
  : fail('degenerate input mishandled');

// --- `--record` argument parsing. The bug this pins wrote junk into the
// staleness state and reported success while doing it: collecting every
// non-flag argument after --record swallowed the VALUES of any later flag, so
// `--record "Name" --hits 4 --ingested 0 --note "..."` recorded the real query
// PLUS "4", "0" and the note text as three more "queries". Those keys then sat
// in data/websearch-state.json looking like queries that had been run.
{
  const one = collectRecordNames(['LinkedIn A', '--hits', '4', '--ingested', '0', '--note', 'all 4 expired']);
  one.length === 1 && one[0] === 'LinkedIn A'
    ? pass('--record stops at the next flag instead of eating its values')
    : fail(`collectRecordNames swallowed flag values: ${JSON.stringify(one)}`);

  const many = collectRecordNames(['LinkedIn A', 'XING A', 'BMW A']);
  many.length === 3
    ? pass('--record still accepts several names before any flag')
    : fail(`collectRecordNames dropped names: ${JSON.stringify(many)}`);

  collectRecordNames([]).length === 0
    ? pass('--record with no names yields nothing (the caller errors)')
    : fail('collectRecordNames invented a name from an empty tail');

  collectRecordNames(['--hits', '4']).length === 0
    ? pass('--record immediately followed by a flag yields no names')
    : fail('collectRecordNames read a flag as a query name');
}

// --- Yield log parsing/aggregation.
// The measured problem this whole feature exists for: a pass can run 10+6
// queries and collect only already-known postings, and staleness rotation
// alone can't tell a dead query from one that just hasn't run yet.
{
  const text = [
    '2026-09-01\tLinkedIn A\twebsearch\t5\t2\t3\t0',
    '2026-09-05\tLinkedIn A\twebsearch\t4\t0\t4\t0',
    '2026-09-01\tBMW A\twebsearch\t3\t0\t2\t1',
    '2026-09-05\tBMW A\twebsearch\t2\t0\t2\t0',
    '2026-09-09\tBMW A\twebsearch\t3\t0\t3\t0',
    '', // blank line must be skipped, not crash
    'short\trow', // malformed (< 7 cols) must be skipped, not crash
  ].join('\n');
  const rows = parseYieldLog(text);
  rows.length === 5
    ? pass('parseYieldLog reads well-formed rows and skips blank/malformed ones')
    : fail(`expected 5 parsed rows, got ${rows.length}: ${JSON.stringify(rows)}`);

  const agg = aggregateYield(rows);
  const li = agg.get('LinkedIn A');
  const bmw = agg.get('BMW A');
  (li?.runs === 2 && li?.totalQueuedNew === 2)
    ? pass('aggregateYield sums runs and queued_new for a query with a productive run')
    : fail(`LinkedIn A aggregation wrong: ${JSON.stringify(li)}`);
  (bmw?.runs === 3 && bmw?.totalQueuedNew === 0)
    ? pass('aggregateYield sums runs and queued_new for a query with zero yield across all runs')
    : fail(`BMW A aggregation wrong: ${JSON.stringify(bmw)}`);
}

// --- Ranking: never-run first, then queries with a logged productive run,
// then plain staleness — the exact order the task specifies.
{
  const rankQueries = [
    q('Never Run', 'site:example.com/a "x"'),
    q('Productive', 'site:example.com/b "x"'),
    q('Stale Only', 'site:example.com/c "x"'),
  ];
  const state = {
    lastRun: {
      Productive: '2026-09-10T00:00:00Z',
      'Stale Only': '2026-01-01T00:00:00Z', // stalest by date, but NOT productive
    },
  };
  const yieldMap = new Map([
    ['Productive', { runs: 2, totalQueuedNew: 1 }],
    ['Stale Only', { runs: 1, totalQueuedNew: 0 }],
  ]);
  const sel = selectQueries(rankQueries, state, { limit: 3, yieldMap });
  const names = sel.map((s) => s.name);
  JSON.stringify(names) === JSON.stringify(['Never Run', 'Productive', 'Stale Only'])
    ? pass('rank order is never-run, then productive-yield, then staleness — even though "Stale Only" is chronologically stalest')
    : fail(`expected [Never Run, Productive, Stale Only], got ${JSON.stringify(names)}`);
}

// --- Retirement: 3+ logged runs with 0 queued_new across all of them is
// skipped by default, and listed so --summary can surface it; opt back in
// with includeRetired. A query with NO yield log yet is "unknown", not
// retired, even with zero runs.
{
  const retireQueries = [
    q('Dead Query', 'site:example.com/dead "x"'),
    q('Unknown Query', 'site:example.com/unknown "x"'),
  ];
  const state = { lastRun: { 'Dead Query': '2026-09-01T00:00:00Z', 'Unknown Query': '2026-09-01T00:00:00Z' } };
  const yieldMap = new Map([
    ['Dead Query', { runs: 3, totalQueuedNew: 0 }],
  ]);

  const states = buildQueryStates(retireQueries, state, yieldMap);
  const dead = states.find((s) => s.name === 'Dead Query');
  const unknown = states.find((s) => s.name === 'Unknown Query');
  (dead?.retired === true && unknown?.retired === false)
    ? pass('buildQueryStates marks >=3 runs / 0 queued_new as retired, and a never-logged query as NOT retired (unknown)')
    : fail(`retirement flags wrong: dead=${JSON.stringify(dead)} unknown=${JSON.stringify(unknown)}`);

  const defaultSel = selectQueries(retireQueries, state, { all: true, yieldMap });
  defaultSel.every((s) => s.name !== 'Dead Query')
    ? pass('a retired query is excluded from selection by default')
    : fail('a retired query was selected without --include-retired');

  const withRetired = selectQueries(retireQueries, state, { all: true, yieldMap, includeRetired: true });
  withRetired.some((s) => s.name === 'Dead Query')
    ? pass('--include-retired brings a retired query back into consideration')
    : fail('includeRetired:true did not restore the retired query');

  // Only 2 runs logged, still 0 yield: NOT yet retired (below the threshold).
  const belowThreshold = new Map([['Dead Query', { runs: 2, totalQueuedNew: 0 }]]);
  buildQueryStates(retireQueries, state, belowThreshold).find((s) => s.name === 'Dead Query').retired === false
    ? pass('a query below RETIRE_AFTER_RUNS logged runs is not retired yet, regardless of yield')
    : fail('a query with only 2 logged runs was retired early');
}

// --- Default --limit dropped from 10 to 6 (measured: the old default cost
// ~114k tokens for mostly-duplicate results); --limit still overrides it.
{
  const many = Array.from({ length: 10 }, (_, i) => q(`Q${i}`, `site:example.com/${i} "x"`));
  const def = selectQueries(many, { lastRun: {} }, {});
  def.length === 6
    ? pass('the default selection size is 6, not 10')
    : fail(`expected a default of 6, got ${def.length}`);

  const overridden = selectQueries(many, { lastRun: {} }, { limit: 9 });
  overridden.length === 9
    ? pass('--limit still overrides the new default')
    : fail(`expected --limit to override to 9, got ${overridden.length}`);
}

// --- Indeed MCP searches: can't be driven by this script (it's an agent tool
// call), but the same yield-based retirement applies via `indeed:<search>@
// <location>` ids in data/websearch-yield.tsv.
{
  const list = [
    { search: 'Werkstudent Data', location: 'Erlangen' },
    { search: 'Werkstudent KI', location: 'Nürnberg' },
  ];
  indeedSearchId(list[0]) === 'indeed:Werkstudent Data@Erlangen'
    ? pass('indeedSearchId builds the indeed:<search>@<location> id')
    : fail(`unexpected indeed id: ${indeedSearchId(list[0])}`);

  const yieldMap = new Map([
    ['indeed:Werkstudent KI@Nürnberg', { runs: 3, totalQueuedNew: 0 }],
  ]);
  const { active, retired } = selectIndeedSearches(list, yieldMap);
  (active.length === 1 && active[0].search === 'Werkstudent Data' && retired.length === 1 && retired[0].search === 'Werkstudent KI')
    ? pass('selectIndeedSearches retires a dead (search, location) pair and keeps the rest active')
    : fail(`Indeed selection wrong: active=${JSON.stringify(active)} retired=${JSON.stringify(retired)}`);

  const { active: withRetired } = selectIndeedSearches(list, yieldMap, { includeRetired: true });
  withRetired.length === 2
    ? pass('selectIndeedSearches --include-retired brings the retired Indeed pair back')
    : fail(`expected 2 active pairs with includeRetired, got ${withRetired.length}`);
}
