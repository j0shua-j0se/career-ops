// tests/lib/resolve-employer-posting.test.mjs — coverage for
// lib/resolve-employer-posting.mjs. Every network-touching path is exercised
// with an injected fake `providers` Map or a fake `ctx` (never real fetch) —
// see the file's own header for why: tier 3 (discover-ats probe) and the
// final board fetch are the only two places this module can reach the
// network, and both take an injectable seam for exactly this reason.
import { pass, fail } from '../helpers.mjs';
import {
  normalizeTitle, titleTokens, jaccardSimilarity, findPortalsEntry,
  entryFromKnownUrls, resolveBoardEntry, bestTitleMatch, resolveEmployerPosting,
  refuseIfOffLimits, DEFAULT_MIN_SCORE,
} from '../../lib/resolve-employer-posting.mjs';

console.log('\nlib — resolve-employer-posting');

// ── normalizeTitle ──────────────────────────────────────────────────────
{
  const cases = [
    ['Werkstudent (m/w/d) Data Science', 'werkstudent data science'],
    ['Werkstudent:in Data Science', 'werkstudent data science'],
    ['Werkstudent*in Data Science', 'werkstudent data science'],
    ['Werkstudent (w/m/d) – Data Science', 'werkstudent data science'],
    ['Mitarbeiter*innen im Vertrieb', 'mitarbeiter im vertrieb'],
    ['  Extra   Spaces  ', 'extra spaces'],
    ['Software Engineer (f/m/x)', 'software engineer'],
  ];
  for (const [input, expected] of cases) {
    const got = normalizeTitle(input);
    if (got === expected) pass(`normalizeTitle(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`);
    else fail(`normalizeTitle(${JSON.stringify(input)}) === ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  // Un-mangled: "in" as an ordinary standalone word must survive (only the
  // *-/:-/‌-attached suffix form is stripped).
  if (normalizeTitle('Berater in Teilzeit').includes('in')) pass('normalizeTitle keeps a bare, unattached "in" word');
  else fail('normalizeTitle must not strip a bare "in" word');
}

// ── titleTokens / jaccardSimilarity ────────────────────────────────────
{
  const a = titleTokens('Werkstudent (m/w/d) Data Science');
  const b = titleTokens('Werkstudent:in Data Science — KI');
  const score = jaccardSimilarity(a, b);
  // {werkstudent, data, science} vs {werkstudent, data, science, ki} → 3/4
  if (Math.abs(score - 0.75) < 1e-9) pass('jaccardSimilarity: near-duplicate titles score 0.75');
  else fail(`jaccardSimilarity near-duplicate titles scored ${score}, expected 0.75`);

  if (jaccardSimilarity(titleTokens('Backend Engineer'), titleTokens('Marketing Manager')) === 0) {
    pass('jaccardSimilarity: disjoint titles score 0');
  } else {
    fail('jaccardSimilarity: disjoint titles should score 0');
  }
  if (jaccardSimilarity(titleTokens(''), titleTokens('')) === 0) pass('jaccardSimilarity: two empty titles score 0, not 1');
  else fail('jaccardSimilarity: two empty titles must score 0');
  if (jaccardSimilarity(titleTokens('Data Scientist'), titleTokens('Data Scientist')) === 1) {
    pass('jaccardSimilarity: identical titles score 1');
  } else {
    fail('jaccardSimilarity: identical titles should score 1');
  }
}

// ── findPortalsEntry ────────────────────────────────────────────────────
{
  const portals = {
    tracked_companies: [
      { name: 'Acme GmbH', careers_url: 'https://job-boards.greenhouse.io/acme' },
      { name: 'Disabled Co', careers_url: 'https://jobs.lever.co/disabled', enabled: false },
    ],
  };
  const hit = findPortalsEntry('acme gmbh', portals);
  if (hit && hit.careers_url === 'https://job-boards.greenhouse.io/acme') pass('findPortalsEntry matches by normalized company name');
  else fail(`findPortalsEntry did not match — got ${JSON.stringify(hit)}`);

  if (findPortalsEntry('Disabled Co', portals) === null) pass('findPortalsEntry skips enabled:false entries');
  else fail('findPortalsEntry must skip enabled:false entries');

  if (findPortalsEntry('Nonexistent Inc', portals) === null) pass('findPortalsEntry returns null for an unmatched company');
  else fail('findPortalsEntry should return null for an unmatched company');

  // Array form (bare tracked_companies list, not wrapped in an object) also works.
  const arr = [{ name: 'Bare Co', careers_url: 'https://jobs.lever.co/bare' }];
  if (findPortalsEntry('Bare Co', arr)?.careers_url === 'https://jobs.lever.co/bare') {
    pass('findPortalsEntry accepts a bare array of entries');
  } else {
    fail('findPortalsEntry should accept a bare array of entries');
  }

  if (findPortalsEntry('Acme GmbH', undefined) === null) pass('findPortalsEntry tolerates missing portals');
  else fail('findPortalsEntry should tolerate a missing portals argument');
}

// ── entryFromKnownUrls ──────────────────────────────────────────────────
{
  const hit = entryFromKnownUrls('Acme', ['https://acme.example.com/careers', 'https://jobs.lever.co/acme']);
  if (hit && hit.provider === 'lever' && hit.careers_url === 'https://jobs.lever.co/acme' && hit.name === 'Acme') {
    pass('entryFromKnownUrls resolves the first URL atsBoardFromUrl recognizes');
  } else {
    fail(`entryFromKnownUrls — got ${JSON.stringify(hit)}`);
  }
  if (entryFromKnownUrls('Acme', ['https://acme.example.com/careers']) === null) {
    pass('entryFromKnownUrls returns null when no URL resolves');
  } else {
    fail('entryFromKnownUrls should return null when no URL resolves');
  }
  if (entryFromKnownUrls('Acme', undefined) === null) pass('entryFromKnownUrls tolerates a missing urls list');
  else fail('entryFromKnownUrls should tolerate a missing urls list');

  // Off-limits hosts (harvest-companies.mjs's OFF_LIMITS_HOSTS) are skipped
  // outright — never even offered to atsBoardFromUrl.
  const skipsOffLimits = entryFromKnownUrls('Acme', ['https://de.linkedin.com/jobs/view/1', 'https://jobs.lever.co/acme']);
  if (skipsOffLimits?.provider === 'lever') pass('entryFromKnownUrls skips an off-limits URL and resolves the next legitimate one');
  else fail(`entryFromKnownUrls off-limits skip — got ${JSON.stringify(skipsOffLimits)}`);
  if (entryFromKnownUrls('Acme', ['https://de.linkedin.com/jobs/view/1']) === null) {
    pass('entryFromKnownUrls returns null when every URL is off-limits');
  } else {
    fail('entryFromKnownUrls should return null when every URL is off-limits');
  }
}

// ── resolveBoardEntry — tier order ──────────────────────────────────────
{
  const portals = { tracked_companies: [{ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme-portals' }] };
  const entry = await resolveBoardEntry(
    { company: 'Acme', urls: ['https://jobs.lever.co/acme-url'] },
    { ctx: {}, portals, probe: false },
  );
  if (entry?.careers_url === 'https://job-boards.greenhouse.io/acme-portals') {
    pass('resolveBoardEntry: portals tier wins over the urls tier');
  } else {
    fail(`resolveBoardEntry tier order — got ${JSON.stringify(entry)}`);
  }

  const urlOnly = await resolveBoardEntry(
    { company: 'Acme', urls: ['https://jobs.lever.co/acme-url'] },
    { ctx: {}, portals: { tracked_companies: [] }, probe: false },
  );
  if (urlOnly?.careers_url === 'https://jobs.lever.co/acme-url' && urlOnly.provider === 'lever') {
    pass('resolveBoardEntry: falls through to the urls tier when portals has no match');
  } else {
    fail(`resolveBoardEntry urls-tier fallback — got ${JSON.stringify(urlOnly)}`);
  }

  const noHit = await resolveBoardEntry(
    { company: 'Nobody Inc' },
    { ctx: {}, portals: { tracked_companies: [] }, probe: false },
  );
  if (noHit === null) pass('resolveBoardEntry: returns null when no tier resolves and probe is off');
  else fail(`resolveBoardEntry should return null — got ${JSON.stringify(noHit)}`);
}

// ── resolveBoardEntry — off-limits refusal at every tier ────────────────
{
  // Tier 1 (portals): an entry pointing at an off-limits host is refused
  // outright, not silently skipped in favor of another tier.
  const offLimitsPortals = { tracked_companies: [{ name: 'BMW Group', careers_url: 'https://www.bmwgroup.jobs/de/de/jobfinder/job.html' }] };
  const refusedPortals = await resolveBoardEntry(
    { company: 'BMW Group', urls: ['https://jobs.lever.co/should-not-be-tried'] },
    { ctx: {}, portals: offLimitsPortals, probe: false },
  );
  if (refusedPortals === null) pass('resolveBoardEntry: refuses an off-limits portals.yml entry, does not fall through to another tier');
  else fail(`resolveBoardEntry off-limits portals refusal — got ${JSON.stringify(refusedPortals)}`);

  // Tier 2 (urls): an off-limits-only urls list resolves to nothing.
  const refusedUrls = await resolveBoardEntry(
    { company: 'Some Co', urls: ['https://xing.com/jobs/123'] },
    { ctx: {}, portals: { tracked_companies: [] }, probe: false },
  );
  if (refusedUrls === null) pass('resolveBoardEntry: refuses when the only known URL is off-limits');
  else fail(`resolveBoardEntry off-limits urls refusal — got ${JSON.stringify(refusedUrls)}`);

  // Tier 3 (discover-ats probe): exercised via refuseIfOffLimits directly,
  // on an entry shaped exactly like what resolveBoardEntry builds from a
  // resolveCompany() result (see refuseIfOffLimits's own doc comment for why
  // a real probe can't be driven there through a fake ctx).
  const probeShapedOffLimits = { name: 'BMW Group', careers_url: 'https://www.bmwgroup.jobs/de/de/jobfinder/job.html', provider: 'bmwgroup' };
  if (refuseIfOffLimits(probeShapedOffLimits) === null) {
    pass('refuseIfOffLimits: refuses a probe-tier-shaped entry pointing at an off-limits host');
  } else {
    fail('refuseIfOffLimits should refuse a probe-tier-shaped off-limits entry');
  }
  const probeShapedOk = { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', provider: 'greenhouse' };
  if (refuseIfOffLimits(probeShapedOk) === probeShapedOk) {
    pass('refuseIfOffLimits: passes through an ordinary entry unchanged');
  } else {
    fail('refuseIfOffLimits should pass through an ordinary entry unchanged');
  }
  if (refuseIfOffLimits(null) === null) pass('refuseIfOffLimits: tolerates a null entry');
  else fail('refuseIfOffLimits should tolerate a null entry');
}

// ── resolveBoardEntry — tier 3 (discover-ats probe), fake ctx, no live network ──
{
  // Mirrors tests/discover-ats.test.mjs's own fake-ctx pattern: a fetchJson
  // that recognizes the real greenhouse boards-api URL shape and answers with
  // one job, so discover-ats.mjs's resolveCompany (imported for real) resolves
  // "Acme" to a Greenhouse board without any request leaving the process.
  const fakeCtx = {
    fetchJson: async (url) => {
      if (String(url).includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) {
        return {
          jobs: [{
            id: 1,
            absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
            title: 'Werkstudent Data Science (m/w/d)',
            location: { name: 'Erlangen' },
            first_published: '2026-01-01',
          }],
        };
      }
      const err = new Error('HTTP 404 Not Found');
      err.status = 404;
      throw err;
    },
    fetchText: async () => { throw new Error('unused in this fixture'); },
  };
  const probed = await resolveBoardEntry(
    { company: 'Acme' },
    { ctx: fakeCtx, portals: { tracked_companies: [] }, probe: true },
  );
  if (probed?.provider === 'greenhouse' && probed.careers_url === 'https://job-boards.greenhouse.io/acme') {
    pass('resolveBoardEntry: tier 3 probe resolves via discover-ats.resolveCompany with a fake ctx');
  } else {
    fail(`resolveBoardEntry tier-3 probe — got ${JSON.stringify(probed)}`);
  }

  const probedMiss = await resolveBoardEntry(
    { company: 'Totally Unknown Co' },
    { ctx: fakeCtx, portals: { tracked_companies: [] }, probe: true },
  );
  if (probedMiss === null) pass('resolveBoardEntry: tier 3 probe returns null when discover-ats cannot resolve');
  else fail(`resolveBoardEntry tier-3 probe miss — got ${JSON.stringify(probedMiss)}`);
}

// ── bestTitleMatch ───────────────────────────────────────────────────────
{
  const jobs = [
    { url: 'https://x/1', title: 'Marketing Manager (m/w/d)', location: 'Berlin' },
    { url: 'https://x/2', title: 'Werkstudent Data Science (m/w/d)', location: 'Erlangen' },
    { url: 'https://x/3', title: 'Werkstudent:in Data Science', location: 'Remote, USA' },
  ];
  const best = bestTitleMatch('Werkstudent Data Science', jobs, { minScore: DEFAULT_MIN_SCORE });
  if (best?.url === 'https://x/2') pass('bestTitleMatch picks the highest-scoring, non-abroad match');
  else fail(`bestTitleMatch — got ${JSON.stringify(best)}`);

  const noMatch = bestTitleMatch('Completely Unrelated Role', jobs, { minScore: DEFAULT_MIN_SCORE });
  if (noMatch === null) pass('bestTitleMatch returns null when nothing clears minScore');
  else fail(`bestTitleMatch should return null — got ${JSON.stringify(noMatch)}`);

  // The only match is abroad → must not be returned even though its title matches.
  const abroadOnly = bestTitleMatch('Werkstudent Data Science', [jobs[2]], { minScore: DEFAULT_MIN_SCORE });
  if (abroadOnly === null) pass('bestTitleMatch: an abroad-only match is filtered out, not returned');
  else fail(`bestTitleMatch should filter an abroad-only match — got ${JSON.stringify(abroadOnly)}`);

  if (bestTitleMatch('Anything', [], { minScore: DEFAULT_MIN_SCORE }) === null) {
    pass('bestTitleMatch returns null for an empty job list');
  } else {
    fail('bestTitleMatch should return null for an empty job list');
  }

  // Tie-break toward the more reachable location when scores are equal.
  const tieJobs = [
    { url: 'https://x/de', title: 'Werkstudent Data Science', location: 'Deutschlandweit' },
    { url: 'https://x/home', title: 'Werkstudent Data Science', location: 'Erlangen' },
  ];
  const tieBest = bestTitleMatch('Werkstudent Data Science', tieJobs, { minScore: DEFAULT_MIN_SCORE });
  if (tieBest?.url === 'https://x/home') pass('bestTitleMatch: equal scores tie-break toward the more reachable location');
  else fail(`bestTitleMatch tie-break — got ${JSON.stringify(tieBest)}`);
}

// ── resolveEmployerPosting — full pipeline, fake providers Map (no network) ──
{
  const fakeJobs = [
    { url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'Werkstudent Data Science (m/w/d)', location: 'Erlangen' },
    { url: 'https://job-boards.greenhouse.io/acme/jobs/2', title: 'Senior Backend Engineer', location: 'Berlin' },
  ];
  const fakeProviders = new Map([
    ['greenhouse', { id: 'greenhouse', fetch: async () => fakeJobs }],
    ['lever', { id: 'lever', fetch: async () => { throw new Error('lever fetch should not be called in this test'); } }],
  ]);
  const portals = { tracked_companies: [{ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', provider: 'greenhouse' }] };

  const result = await resolveEmployerPosting(
    { company: 'Acme', title: 'Werkstudent Data Science' },
    { ctx: {}, portals, providers: fakeProviders },
  );
  if (result?.url === 'https://job-boards.greenhouse.io/acme/jobs/1' && typeof result.score === 'number') {
    pass('resolveEmployerPosting: full pipeline resolves via portals tier + fake provider');
  } else {
    fail(`resolveEmployerPosting full pipeline — got ${JSON.stringify(result)}`);
  }

  // No board resolvable (empty portals, no urls, probe off) → null, no throw.
  const none = await resolveEmployerPosting(
    { company: 'Nobody Inc', title: 'Anything' },
    { ctx: {}, portals: { tracked_companies: [] }, providers: fakeProviders },
  );
  if (none === null) pass('resolveEmployerPosting: returns null when no board resolves');
  else fail(`resolveEmployerPosting should return null — got ${JSON.stringify(none)}`);

  // Board resolves, provider fetch throws → null (single failure channel, no throw).
  const throwingProviders = new Map([['greenhouse', { id: 'greenhouse', fetch: async () => { throw new Error('board unreachable'); } }]]);
  const fetchFails = await resolveEmployerPosting(
    { company: 'Acme', title: 'Werkstudent Data Science' },
    { ctx: {}, portals, providers: throwingProviders },
  );
  if (fetchFails === null) pass('resolveEmployerPosting: a provider fetch failure resolves to null, not a throw');
  else fail(`resolveEmployerPosting fetch failure — got ${JSON.stringify(fetchFails)}`);

  // Board resolves, fetch returns an empty board → null.
  const emptyProviders = new Map([['greenhouse', { id: 'greenhouse', fetch: async () => [] }]]);
  const emptyBoard = await resolveEmployerPosting(
    { company: 'Acme', title: 'Werkstudent Data Science' },
    { ctx: {}, portals, providers: emptyProviders },
  );
  if (emptyBoard === null) pass('resolveEmployerPosting: an empty board resolves to null');
  else fail(`resolveEmployerPosting empty board — got ${JSON.stringify(emptyBoard)}`);

  // No company at all → null without ever touching providers/ctx.
  const noCompany = await resolveEmployerPosting({ title: 'Anything' }, { ctx: {}, portals, providers: fakeProviders });
  if (noCompany === null) pass('resolveEmployerPosting: a missing company returns null');
  else fail('resolveEmployerPosting should return null for a missing company');

  // urls tier: no portals match, but a known URL resolves the board.
  const urlsPipeline = await resolveEmployerPosting(
    { company: 'Acme Two', title: 'Werkstudent Data Science', urls: ['https://job-boards.greenhouse.io/acme'] },
    { ctx: {}, portals: { tracked_companies: [] }, providers: fakeProviders },
  );
  if (urlsPipeline?.url === 'https://job-boards.greenhouse.io/acme/jobs/1') {
    pass('resolveEmployerPosting: resolves via the urls tier when portals has no match');
  } else {
    fail(`resolveEmployerPosting urls tier — got ${JSON.stringify(urlsPipeline)}`);
  }

  // minScore override: a lower floor accepts a weaker match that the default would reject.
  const looseMatch = await resolveEmployerPosting(
    { company: 'Acme', title: 'Data Science Working Student' },
    { ctx: {}, portals, providers: fakeProviders, minScore: 0.2 },
  );
  if (looseMatch?.url === 'https://job-boards.greenhouse.io/acme/jobs/1') {
    pass('resolveEmployerPosting: a lowered minScore accepts a weaker match');
  } else {
    fail(`resolveEmployerPosting minScore override — got ${JSON.stringify(looseMatch)}`);
  }

  // Off-limits end to end: a portals.yml entry for BMW Group pointing at its
  // own bmwgroup.jobs domain must never reach the provider layer at all —
  // resolveEmployerPosting refuses before any fetch happens.
  const bmwPortals = { tracked_companies: [{ name: 'BMW Group', careers_url: 'https://www.bmwgroup.jobs/de/de/jobfinder/job.html' }] };
  const bmwProviders = new Map([['bmwgroup', { id: 'bmwgroup', fetch: async () => { throw new Error('must never be called — off-limits'); } }]]);
  const bmwResult = await resolveEmployerPosting(
    { company: 'BMW Group', title: 'Werkstudent Data Science' },
    { ctx: {}, portals: bmwPortals, providers: bmwProviders },
  );
  if (bmwResult === null) pass('resolveEmployerPosting: refuses BMW Group end to end, never calls the provider');
  else fail(`resolveEmployerPosting BMW Group refusal — got ${JSON.stringify(bmwResult)}`);
}
