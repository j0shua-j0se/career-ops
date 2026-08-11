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
import { selectQueries, isProviderCovered, groupBySite, PROVIDER_COVERED_SITES } from '../websearch-plan.mjs';

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
