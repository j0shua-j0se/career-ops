// tests/indeed-plan.test.mjs — Indeed cannot be a providers/ module (no public
// API, RSS 403s, and its MCP is a tool only the agent can call), so the sweep is
// always performed by whoever drives the run. That made it a judgement call
// every pass — and a judgement call that gets skipped is indistinguishable from
// a source that yields nothing: Indeed contributed 3 rows in the scanner's
// entire history while producing two of six evaluations in the one pass that
// used it.
//
// indeed-plan.mjs removes the judgement by emitting the exact search_jobs
// argument objects. These tests pin the shape the agent depends on.
import { pass, fail } from './helpers.mjs';
import { buildPlan, defaultQueries } from '../indeed-plan.mjs';

console.log('\nIndeed search plan');

const profile = {
  location: { city: 'Erlangen', country: 'Germany' },
  target_roles: { primary: ['Working Student AI / Machine Learning', 'Data Scientist'] },
};

{
  const plan = buildPlan(profile, {});
  plan.country_code === 'DE'
    ? pass('country_code is derived from the profile country')
    : fail(`expected DE, got ${plan.country_code}`);

  plan.locations.includes('Erlangen') && plan.locations.includes('Germany')
    ? pass('searches both the home city and the wider country (city-scoped search misses remote)')
    : fail(`unexpected locations: ${JSON.stringify(plan.locations)}`);

  // Every call must be directly usable as MCP arguments — no post-processing.
  plan.calls.length > 0 && plan.calls.every(c => c.search && c.location && c.country_code === 'DE')
    ? pass(`every call is a ready-to-use search_jobs argument object (${plan.calls.length} calls)`)
    : fail('a call is missing search/location/country_code');

  plan.calls.length === plan.queries.length * plan.locations.length
    ? pass('calls are the full query × location cross-product')
    : fail('call count does not match queries × locations');

  // German contract nouns are how these roles are TITLED in this market; an
  // English-only plan misses most of them. This is the single most important
  // property of the default query set.
  plan.queries.some(q => /Werkstudent/i.test(q)) && plan.queries.some(q => /Praktikum/i.test(q))
    ? pass('the default plan searches German student-contract terms, not only English')
    : fail('German student vocabulary missing — most of this market would be invisible');

  plan.queries.some(q => /Abschlussarbeit|Hilfskraft/i.test(q))
    ? pass('thesis and HiWi vocabulary is covered')
    : fail('Abschlussarbeit/Hilfskraft missing from the default queries');

  /ingest-jobs\.mjs/.test(plan.ingest)
    ? pass('the plan names the ingest command, so results have one write path')
    : fail('plan does not name ingest-jobs.mjs');
}

// portals.yml overrides win, so the user can retarget without editing code.
{
  const plan = buildPlan(profile, { indeed: { queries: ['Custom Query'], locations: ['Munich'], country_code: 'AT' } });
  plan.queries.length === 1 && plan.queries[0] === 'Custom Query'
    ? pass('portals.yml indeed.queries overrides the derived defaults')
    : fail('query override ignored');
  plan.locations.join() === 'Munich' && plan.country_code === 'AT'
    ? pass('location and country_code overrides are honoured')
    : fail('location/country override ignored');
}

// The query list is deduped and bounded: Indeed's search box is not an ATS
// keyword sieve, and portals.yml → title_filter has 65 terms because it filters
// a dataset AFTER the fact. Feeding those in would return mostly noise.
{
  const qs = defaultQueries(['Data Scientist', 'Data Scientist', 'AI Engineer']);
  new Set(qs.map(q => q.toLowerCase())).size === qs.length
    ? pass('duplicate queries are collapsed')
    : fail('duplicate queries survived');
  qs.length <= 14
    ? pass(`the query list is bounded (${qs.length} ≤ 14)`)
    : fail(`query list too long: ${qs.length}`);
}

// A profile with no country and no override cannot silently guess a market.
try {
  buildPlan({ location: {} }, {});
  fail('a profile with no country should throw rather than guess a country_code');
} catch {
  pass('an undeterminable country_code throws instead of guessing a market');
}

// A profile with no target roles must still produce a usable plan.
buildPlan({ location: { city: 'Erlangen', country: 'Germany' } }, {}).calls.length > 0
  ? pass('a profile with no target_roles still yields a usable plan')
  : fail('empty target_roles produced an empty plan');
