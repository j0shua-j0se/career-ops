/**
 * tests/harvest-companies.test.mjs — coverage for harvest-companies.mjs
 *
 * Tests the pure, network-free functions with inline fixtures:
 * - titleLooksRelevant / isQualifyingSighting / germanyEvidenceTag / DE_ONLY_PORTALS
 * - parseLeadsJson (array form, {"leads":[...]} form, malformed input, drops)
 * - filterAndGroup (window, positive-evidence region gate, per-company Germany
 *   evidence gate, title gate, companyKey clustering) — including the four
 *   scenarios the region-gate tightening was built for: a blank-location US
 *   company from greenhouse-api (excluded), a blank-location company from
 *   arbeitsagentur-api (included), a 'Munich' company (included), and a
 *   'Remote, US' company (excluded).
 * - buildExistingIndex (name + resolved-board indexing across both lists)
 * - resolveViaUrls / entryFieldsForVendor
 * - harvestCompanyKey — identical display text always clusters together,
 *   even when a stale stored normalized_company column disagrees with
 *   itself across scan runs (the "BMW Group reported twice" fix); genuinely
 *   different spellings still stay separate.
 * - OFF_LIMITS_HOSTS / isOffLimitsHost / isOffLimitsUrl / isOffLimitsCandidate
 *   — the binding off-limits denylist (bmwgroup.jobs/BMW Group by name,
 *   linkedin.com, xing.com, stepstone.de, indeed.*), including end-to-end
 *   through harvestCompanies() that BMW Group reports as source:'off-limits'.
 * - harvestCompanies() end-to-end with a fake probe ctx (no live network)
 * - CLI behavior (--self-test, --help, default preview never writes, --write
 *   opt-in, unknown flag, missing --in file) via execFileSync — no live network.
 */

import {
  titleLooksRelevant, isQualifyingSighting, germanyEvidenceTag, DE_ONLY_PORTALS,
  parseLeadsJson, filterAndGroup, buildExistingIndex,
  resolveViaUrls, entryFieldsForVendor, harvestCompanyKey,
  OFF_LIMITS_HOSTS, isOffLimitsHost, isOffLimitsUrl, isOffLimitsCandidate,
  harvestCompanies, DEFAULT_DAYS, DEFAULT_PROBE_LIMIT,
} from '../harvest-companies.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { pass, fail } from './helpers.mjs';

console.log('\nharvest-companies.mjs — company harvest');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} — expected ${e}, got ${a}`);
}

// ============================================================================
// 1. titleLooksRelevant / isQualifyingSighting / germanyEvidenceTag
// ============================================================================
console.log('\n--- 1. titleLooksRelevant / isQualifyingSighting / germanyEvidenceTag ---');

ok('titleLooksRelevant: student title', titleLooksRelevant('Werkstudent (m/w/d) Data Science'));
ok('titleLooksRelevant: entry-level tech title', titleLooksRelevant('Junior AI Engineer'));
ok('titleLooksRelevant: rejects irrelevant title', !titleLooksRelevant('Sales Account Executive'));
ok('titleLooksRelevant: non-string title is falsy, never throws', !titleLooksRelevant(undefined) && !titleLooksRelevant(null));

// DE_ONLY_PORTALS is the exported constant the coordinator asked for.
eq('DE_ONLY_PORTALS: the documented six sources', [...DE_ONLY_PORTALS].sort(), [
  'arbeitsagentur-api', 'fau-api', 'pinloop-api', 'stellenanzeigen-api', 'stellenwerk-api', 'studierendenjobs-api',
].sort());

// Positive evidence only — a blank/uninformative location must NOT pass
// unless the source itself is Germany-only (this is the fix: 'unknown' used
// to pass through unconditionally, which is why caci/gdit/caresource/
// acxiomllc — all blank-location US employers from a generic aggregator —
// showed up as harvest candidates).
ok('isQualifyingSighting: home city passes with no portal needed', isQualifyingSighting({ location: 'Erlangen' }));
ok('isQualifyingSighting: Munich commuter ring passes', isQualifyingSighting({ location: 'Garching' }));
ok('isQualifyingSighting: a bare "Munich" location passes', isQualifyingSighting({ location: 'Munich' }));
ok('isQualifyingSighting: blank location from an ordinary portal does NOT qualify', !isQualifyingSighting({ location: '', portal: 'greenhouse-api' }));
ok('isQualifyingSighting: blank location with no portal at all does NOT qualify', !isQualifyingSighting({ location: '' }));
ok('isQualifyingSighting: elsewhere-in-Germany qualifies with no DE-only portal (any German location is in scope since 2026-10-03)', isQualifyingSighting({ location: 'Berlin', portal: 'arbeitnow-api' }));
ok('isQualifyingSighting: "Remote, US" is abroad, rejected', !isQualifyingSighting({ location: 'Remote, US' }));
ok('isQualifyingSighting: abroad rejected outright', !isQualifyingSighting({ location: 'New York, USA' }));
ok('isQualifyingSighting: blank location from arbeitsagentur-api (DE-only) qualifies', isQualifyingSighting({ location: '', portal: 'arbeitsagentur-api' }));
ok('isQualifyingSighting: DE-only portal matching is case-insensitive', isQualifyingSighting({ location: '', portal: 'Arbeitsagentur-API' }));
ok('isQualifyingSighting: a DE-only portal cannot rescue an explicitly foreign location', !isQualifyingSighting({ location: 'New York, USA', portal: 'arbeitsagentur-api' }));

// germanyEvidenceTag — the four evidence types the per-company gate accepts.
eq('germanyEvidenceTag: a home city → "city"', germanyEvidenceTag({ location: 'Erlangen' }), 'city');
eq('germanyEvidenceTag: elsewhere-in-Germany text → "city" too (harvesting is not a commute decision)', germanyEvidenceTag({ location: 'Berlin' }), 'city');
eq('germanyEvidenceTag: "Deutschland" in the location text → "de-text"', germanyEvidenceTag({ location: 'Remote, Deutschland' }), 'de-text');
eq('germanyEvidenceTag: "Germany" in the location text → "de-text"', germanyEvidenceTag({ location: 'Remote - Germany' }), 'de-text');
eq('germanyEvidenceTag: a .de URL host → "de-host"', germanyEvidenceTag({ location: '', url: 'https://acme.de/jobs/1' }), 'de-host');
eq('germanyEvidenceTag: a DE-only portal → "de-portal"', germanyEvidenceTag({ location: '', portal: 'stellenwerk-api' }), 'de-portal');
eq('germanyEvidenceTag: bare "Remote" with no country/city/host/portal proves nothing', germanyEvidenceTag({ location: 'Remote' }), null);
eq('germanyEvidenceTag: an ordinary blank sighting from a generic portal proves nothing', germanyEvidenceTag({ location: '', portal: 'greenhouse-api' }), null);

// ============================================================================
// 2. parseLeadsJson
// ============================================================================
console.log('\n--- 2. parseLeadsJson ---');

{
  const r = parseLeadsJson('[{"company":"Acme","title":"Werkstudent AI","url":"https://jobs.lever.co/acme","location":"Erlangen"}]');
  eq('parseLeadsJson: bare array form, 1 lead', r.leads.length, 1);
  eq('parseLeadsJson: fields carried through', r.leads[0], { company: 'Acme', title: 'Werkstudent AI', url: 'https://jobs.lever.co/acme', location: 'Erlangen', portal: '' });
}
{
  const r = parseLeadsJson('{"leads":[{"company":"Acme"}]}');
  eq('parseLeadsJson: {"leads":[...]} wrapper form', r.leads.length, 1);
  eq('parseLeadsJson: missing optional fields default to empty strings', r.leads[0], { company: 'Acme', title: '', url: '', location: '', portal: '' });
}
{
  // Optional portal tag — lets a Pinloop-style feed opt into the DE-only bypass.
  const r = parseLeadsJson('[{"company":"Acme","portal":"pinloop-api"}]');
  eq('parseLeadsJson: an optional portal field is carried through', r.leads[0].portal, 'pinloop-api');
}
{
  const r = parseLeadsJson('not json');
  ok('parseLeadsJson: malformed JSON never throws', r.leads.length === 0 && r.warnings.length > 0);
}
{
  const r = parseLeadsJson('[{"title":"no company"}, "a string entry", {"company":"  "}]');
  ok('parseLeadsJson: drops entries with no usable company', r.leads.length === 0 && r.warnings.length === 3);
}
{
  const r = parseLeadsJson('{"not":"a list"}');
  ok('parseLeadsJson: rejects a top-level object with no leads array', r.leads.length === 0 && r.warnings.length === 1);
}
eq('parseLeadsJson: empty input → no leads, no warnings', parseLeadsJson(''), { leads: [], warnings: [] });
eq('parseLeadsJson: non-string input → no leads, no warnings', parseLeadsJson(undefined), { leads: [], warnings: [] });

// ============================================================================
// 3. filterAndGroup
// ============================================================================
console.log('\n--- 3. filterAndGroup ---');

const NOW = Date.parse('2026-09-24T00:00:00Z');
const day = 86400000;
const row = (overrides) => ({
  company: 'Acme', title: 'Werkstudent Data Science', location: 'Erlangen', portal: 'arbeitnow-api',
  url: 'https://jobs.lever.co/acme', date: new Date(NOW - 1 * day), status: 'added', normCompany: '', ...overrides,
});

{
  const rows = [
    // Both suffixes strip to the same normalizeCompanyName key ('acme') and
    // are the same length (9 chars), so the tie-break below is exercised —
    // "GmbH" is deliberately NOT used here: normalizeCompanyName does not
    // strip it (only the English legal-suffix forms Inc/Ltd/Corp/LLC do), so
    // "Acme GmbH" would key differently from "Acme" and never cluster.
    row({ company: 'Acme Corp', normCompany: 'ignored-stale-value' }),
    row({ company: 'Acme Inc.', normCompany: 'also-ignored' }),
    row({ company: 'Too Old', normCompany: 'tooold', date: new Date(NOW - (DEFAULT_DAYS + 5) * day) }),
    row({ company: 'Abroad Co', normCompany: 'abroadco', location: 'New York, USA' }),
    row({ company: 'Irrelevant Co', normCompany: 'irrelevantco', title: 'Sales Manager' }),
    row({ company: 'No Date', normCompany: 'nodate', date: undefined }),
  ];
  const { groups, matchedRows } = filterAndGroup(rows, { days: DEFAULT_DAYS, now: NOW });
  eq('filterAndGroup: only 2 rows survive the window/region/title gates', matchedRows, 2);
  eq('filterAndGroup: they cluster into 1 company', groups.length, 1);
  eq('filterAndGroup: sightings summed correctly', groups[0].sightings, 2);
  // Both candidate names tie at 1 sighting and the same length (9 chars) —
  // the tie-break keeps the FIRST-seen name rather than replacing on a
  // non-strict improvement (see filterAndGroup's `count > bestCount` check).
  eq('filterAndGroup: normalized-company clustering picks the first-seen name on a length tie', groups[0].company, 'Acme Corp');
  ok('filterAndGroup: carries the sighted URL forward', groups[0].urls.includes('https://jobs.lever.co/acme'));
  eq('filterAndGroup: carries the "city" evidence tag', groups[0].evidence, ['city']);
}

// The four scenarios the region-gate tightening was built for (coordinator's
// explicit request): a blank-location US employer sourced from a generic
// aggregator (greenhouse-api) must be excluded even though it used to pass
// under the old 'unknown'-always-qualifies gate; a blank-location employer
// sourced from a Germany-only portal (arbeitsagentur-api) must still be
// included; an explicit 'Munich' location must be included; 'Remote, US'
// must be excluded (classifies abroad).
{
  const rows = [
    row({ company: 'Blank US Co', normCompany: 'blankusco', location: '', portal: 'greenhouse-api' }),
    row({ company: 'Blank DE Portal Co', normCompany: 'blankdeportalco', location: '', portal: 'arbeitsagentur-api' }),
    row({ company: 'Munich Co', normCompany: 'munichco', location: 'Munich' }),
    row({ company: 'Remote US Co', normCompany: 'remoteusco', location: 'Remote, US' }),
  ];
  const { groups } = filterAndGroup(rows, { days: DEFAULT_DAYS, now: NOW });
  const byCompany = Object.fromEntries(groups.map((g) => [g.company, g]));
  ok('filterAndGroup: blank-location company from greenhouse-api (a non-DE-only portal) is EXCLUDED', !byCompany['Blank US Co']);
  ok('filterAndGroup: blank-location company from arbeitsagentur-api (DE-only) is INCLUDED', !!byCompany['Blank DE Portal Co']);
  eq('filterAndGroup: the DE-only-portal inclusion carries "de-portal" evidence', byCompany['Blank DE Portal Co']?.evidence, ['de-portal']);
  ok('filterAndGroup: a "Munich" company is INCLUDED', !!byCompany['Munich Co']);
  eq('filterAndGroup: the Munich inclusion carries "city" evidence', byCompany['Munich Co']?.evidence, ['city']);
  ok('filterAndGroup: a "Remote, US" company is EXCLUDED', !byCompany['Remote US Co']);
}

// Per-company evidence gate as a SEPARATE check from the row-level gate: a
// company whose only qualifying sightings are bare "Remote" (no country, no
// city, no .de host, no DE-only portal — passes isQualifyingSighting via the
// 'remote' verdict, but proves nothing about being German) must still be
// dropped, and droppedForNoEvidence must count it.
{
  const rows = [row({ company: 'Ambiguous Remote Co', normCompany: 'ambiguousremoteco', location: 'Remote' })];
  const { groups, matchedRows, droppedForNoEvidence } = filterAndGroup(rows, { days: DEFAULT_DAYS, now: NOW });
  eq('filterAndGroup: a bare-"Remote" sighting still counts as matched (row gate passes)', matchedRows, 1);
  eq('filterAndGroup: but the company itself is dropped (no direct Germany evidence)', groups.length, 0);
  eq('filterAndGroup: droppedForNoEvidence reflects the drop', droppedForNoEvidence, 1);
}
{
  // Boundary: exactly at the day cutoff is excluded (strictly less-than cutoff kept).
  const boundaryRows = [row({ date: new Date(NOW - DEFAULT_DAYS * day - 1) })];
  const { matchedRows } = filterAndGroup(boundaryRows, { days: DEFAULT_DAYS, now: NOW });
  eq('filterAndGroup: a row 1ms past the window is excluded', matchedRows, 0);
}
{
  const capped = filterAndGroup([{ company: '', title: 'x', date: new Date(NOW) }], { now: NOW });
  eq('filterAndGroup: rows with no company are dropped, no throw', capped.matchedRows, 0);
}
eq('filterAndGroup: empty input → empty output', filterAndGroup([], { now: NOW }), { groups: [], matchedRows: 0, droppedForNoEvidence: 0 });

// ============================================================================
// 4. buildExistingIndex / resolveViaUrls / entryFieldsForVendor
// ============================================================================
console.log('\n--- 4. buildExistingIndex / resolveViaUrls / entryFieldsForVendor ---');

{
  const idx = buildExistingIndex({
    tracked_companies: [{ name: 'Existing Co', careers_url: 'https://job-boards.greenhouse.io/existing' }],
    job_boards: [{ name: 'Some Aggregator', careers_url: 'https://arbeitnow.com/api/job-board-api' }],
  });
  // normalizeCompanyName strips the generic "Co" descriptor, same as it
  // strips legal suffixes like "GmbH"/"Inc." — the index key is whatever that
  // shared normalizer produces, not a raw lowercase of the name.
  ok('buildExistingIndex: indexes a tracked_companies name', idx.names.has('existing'));
  ok('buildExistingIndex: indexes a job_boards name too', idx.names.has('some aggregator'));
  ok('buildExistingIndex: indexes the resolved board key', idx.boards.has('greenhouse:existing'));
  ok('buildExistingIndex: an aggregator URL with no recognizable ATS host adds no board key', idx.boards.size === 1);
}
eq('buildExistingIndex: tolerates a missing/empty doc', buildExistingIndex({}), { names: new Set(), boards: new Set() });

{
  const hit = resolveViaUrls({ urls: ['https://acme.example.com/careers', 'https://jobs.lever.co/acme'] });
  eq('resolveViaUrls: resolves the first recognizable URL', hit, { vendor: 'lever', slug: 'acme', boardUrl: 'https://jobs.lever.co/acme' });
  ok('resolveViaUrls: null when nothing resolves', resolveViaUrls({ urls: ['https://acme.example.com/careers'] }) === null);
  ok('resolveViaUrls: tolerates a missing urls array', resolveViaUrls({}) === null);
}

eq('entryFieldsForVendor: greenhouse gets an api: line', entryFieldsForVendor('greenhouse', 'acme'), { api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' });
eq('entryFieldsForVendor: workday gets an explicit provider: line', entryFieldsForVendor('workday', 'acme'), { provider: 'workday' });
eq('entryFieldsForVendor: softgarden gets an explicit provider: line', entryFieldsForVendor('softgarden', 'acme'), { provider: 'softgarden' });
eq('entryFieldsForVendor: lever needs no extra fields', entryFieldsForVendor('lever', 'acme'), {});

// ============================================================================
// 4b. harvestCompanyKey — the "BMW Group reported twice" fix
// ============================================================================
console.log('\n--- 4b. harvestCompanyKey ---');

ok('harvestCompanyKey: identical display text always keys identically', harvestCompanyKey({ company: 'BMW Group' }) === harvestCompanyKey({ company: 'BMW Group' }));
ok('harvestCompanyKey: "BMW Group" and "BMW" share a key ("Group" is a generic descriptor)', harvestCompanyKey({ company: 'BMW Group' }) === harvestCompanyKey({ company: 'BMW' }));
ok('harvestCompanyKey: ignores the row\'s own (possibly stale) normCompany column entirely', harvestCompanyKey({ company: 'BMW Group', normCompany: 'this-value-is-ignored' }) === harvestCompanyKey({ company: 'BMW Group', normCompany: 'bmw' }));
ok('harvestCompanyKey: genuinely different spellings still key differently', harvestCompanyKey({ company: 'Fraunhofer IIS' }) !== harvestCompanyKey({ company: 'Fraunhofer-Institut für Integrierte Schaltungen IIS' }));
ok('harvestCompanyKey: ignores surrounding whitespace', harvestCompanyKey({ company: '  Acme  ' }) === harvestCompanyKey({ company: 'Acme' }));
ok('harvestCompanyKey: tolerates a missing company field, never throws', harvestCompanyKey({}) === '');

// The end-to-end regression: two scan-history rows with the IDENTICAL company
// display text "BMW Group" but DIFFERENT stored normalized_company values
// (mirroring the real data/scan-history.tsv bug — one row predates "Group"
// being added to normalizeCompanyName's generic-descriptor strip list) must
// cluster into ONE group, not two.
{
  const now = Date.parse('2026-09-24T00:00:00Z');
  const staleKeyRows = [
    { company: 'BMW Group', title: 'Werkstudent Data Science', location: 'München', portal: 'arbeitsagentur-api', url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/1', date: new Date(now - 1 * 86400000), status: 'added', normCompany: 'bmw group' },
    { company: 'BMW Group', title: 'Werkstudent AI Engineer', location: 'München', portal: 'arbeitsagentur-api', url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/2', date: new Date(now - 2 * 86400000), status: 'added', normCompany: 'bmw' },
  ];
  const { groups } = filterAndGroup(staleKeyRows, { days: DEFAULT_DAYS, now });
  eq('filterAndGroup: identical "BMW Group" text clusters into ONE group despite disagreeing stored normalized_company columns', groups.length, 1);
  eq('filterAndGroup: the merged group carries both sightings', groups[0]?.sightings, 2);
}

// ============================================================================
// 4c. Off-limits denylist (binding user rule)
// ============================================================================
console.log('\n--- 4c. Off-limits denylist ---');

eq('OFF_LIMITS_HOSTS: the four literal hosts (indeed.* is a wildcard, matched separately)', [...OFF_LIMITS_HOSTS].sort(), ['bmwgroup.jobs', 'linkedin.com', 'stepstone.de', 'xing.com'].sort());

ok('isOffLimitsHost: exact host (bmwgroup.jobs)', isOffLimitsHost('bmwgroup.jobs'));
ok('isOffLimitsHost: subdomain of a denylisted host', isOffLimitsHost('www.bmwgroup.jobs'));
ok('isOffLimitsHost: linkedin.com subdomain', isOffLimitsHost('de.linkedin.com'));
ok('isOffLimitsHost: xing.com', isOffLimitsHost('xing.com'));
ok('isOffLimitsHost: stepstone.de', isOffLimitsHost('stepstone.de'));
ok('isOffLimitsHost: indeed.* wildcard covers every TLD', isOffLimitsHost('indeed.com') && isOffLimitsHost('indeed.de') && isOffLimitsHost('indeed.co.uk'));
ok('isOffLimitsHost: indeed.* wildcard covers subdomains too', isOffLimitsHost('to.indeed.com'));
ok('isOffLimitsHost: a DIFFERENT BMW domain (jobs.bmwgroup.com) is not on the literal host list', !isOffLimitsHost('jobs.bmwgroup.com'));
ok('isOffLimitsHost: an unrelated host is not off-limits', !isOffLimitsHost('example.com'));
ok('isOffLimitsHost: a suffix-spoofed look-alike host is not matched', !isOffLimitsHost('bmwgroup.jobs.evil.com'));
ok('isOffLimitsHost: empty/non-string input is not off-limits, never throws', !isOffLimitsHost('') && !isOffLimitsHost(undefined));

ok('isOffLimitsUrl: resolves the hostname from a full URL', isOffLimitsUrl('https://de.linkedin.com/jobs/view/123'));
ok('isOffLimitsUrl: an unparseable URL is not off-limits, never throws', !isOffLimitsUrl('not a url'));

ok('isOffLimitsCandidate: BMW Group is off-limits by NAME regardless of its urls', isOffLimitsCandidate({ company: 'BMW Group', urls: ['https://www.arbeitsagentur.de/x'] }));
ok('isOffLimitsCandidate: "BMW" alone also matches (same normalized name)', isOffLimitsCandidate({ company: 'BMW', urls: [] }));
ok('isOffLimitsCandidate: a differently-cased "bmw group" also matches (same normalized name)', isOffLimitsCandidate({ company: 'bmw group', urls: [] }));
ok('isOffLimitsCandidate: a company seen only via LinkedIn/Indeed is NOT off-limits (its own ATS can still be probed by name)', !isOffLimitsCandidate({ company: 'Some Co', urls: ['https://de.linkedin.com/jobs/view/1', 'https://to.indeed.com/abc'] }));
ok('isOffLimitsCandidate: "BMW AG" is off-limits by name', isOffLimitsCandidate({ company: 'BMW AG', urls: [] }));
ok('isOffLimitsCandidate: a MIX of off-limits and legitimate URLs is NOT off-limits', !isOffLimitsCandidate({ company: 'Some Co', urls: ['https://de.linkedin.com/jobs/view/1', 'https://jobs.lever.co/someco'] }));
ok('isOffLimitsCandidate: no urls at all is not off-limits', !isOffLimitsCandidate({ company: 'Some Co', urls: [] }));
ok('isOffLimitsCandidate: an ordinary candidate is untouched', !isOffLimitsCandidate({ company: 'Acme', urls: ['https://jobs.lever.co/acme'] }));

{
  const skipsOffLimits = resolveViaUrls({ urls: ['https://de.linkedin.com/jobs/view/1', 'https://jobs.lever.co/acme'] });
  ok('resolveViaUrls: skips an off-limits URL and resolves the next legitimate one', skipsOffLimits?.vendor === 'lever');
  ok('resolveViaUrls: an off-limits-only url list never resolves', resolveViaUrls({ urls: ['https://de.linkedin.com/jobs/view/1'] }) === null);
}

// ============================================================================
// 5. harvestCompanies() — end to end, fake probe ctx, no live network
// ============================================================================
console.log('\n--- 5. harvestCompanies() end-to-end ---');

const tsvHeader = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
function tsvRow(fields) {
  const cols = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location', 'fingerprint', 'posted_at', 'trust_score', 'trust_flags', 'normalized_company'];
  return cols.map((c) => fields[c] ?? '').join('\t');
}
const TODAY = '2026-09-24';

{
  const scanHistoryContent = [
    tsvHeader,
    // Resolves via the url tier — arbeitnow's Job.url already carries the
    // employer's own Lever board (mirrors what an aggregator's upstream-link
    // policy actually produces per ADDING_A_PROVIDER.md rule 2).
    // 'NewCo Inc.' (not 'NewCo GmbH' — normalizeCompanyName does not strip
    // GmbH, only the English legal-suffix forms) so this clusters with the
    // bare 'NewCo' row below under harvestCompanyKey's fresh recompute.
    tsvRow({ url: 'https://jobs.lever.co/newco/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent Data Science (m/w/d)', company: 'NewCo Inc.', status: 'added', location: 'Erlangen', normalized_company: 'newco' }),
    tsvRow({ url: 'https://jobs.lever.co/newco/2', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent AI Engineer', company: 'NewCo', status: 'added', location: 'Erlangen', normalized_company: 'newco' }),
    // Needs a probe — its URL is the aggregator's own page, not the employer's.
    tsvRow({ url: 'https://someaggregator.example/jobs/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent AI', company: 'ProbeCo', status: 'added', location: 'Erlangen', normalized_company: 'probeco' }),
    // Already tracked by name — must be excluded entirely.
    tsvRow({ url: 'https://job-boards.greenhouse.io/existing/jobs/1', first_seen: TODAY, portal: 'greenhouse-api', title: 'Werkstudent AI', company: 'Existing', status: 'added', location: 'Erlangen', normalized_company: 'existing' }),
    // Out of region — must be excluded.
    tsvRow({ url: 'https://someaggregator.example/jobs/2', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent AI', company: 'Abroad Co', status: 'added', location: 'New York, USA', normalized_company: 'abroadco' }),
    // Skipped status — must be excluded (not an 'added' sighting).
    tsvRow({ url: 'https://jobs.lever.co/skipped/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent AI', company: 'SkippedCo', status: 'skipped_expired', location: 'Erlangen', normalized_company: 'skippedco' }),
  ].join('\n') + '\n';

  const portalsDoc = {
    tracked_companies: [{ name: 'Existing', careers_url: 'https://jobs.lever.co/existing' }],
  };

  // Fake ctx for the probe tier — discover-ats.mjs's resolveCompany calls the
  // REAL provider modules (greenhouse/ashby/lever/...) but only ever reaches
  // the network through ctx.fetchJson/fetchText, so this fixture intercepts
  // those and never lets a request leave the process (mirrors
  // tests/discover-ats.test.mjs's own fake-ctx pattern).
  const fakeCtx = {
    fetchJson: async (url) => {
      if (String(url).includes('boards-api.greenhouse.io/v1/boards/probeco/jobs')) {
        return {
          jobs: [{
            id: 1, absolute_url: 'https://job-boards.greenhouse.io/probeco/jobs/1',
            title: 'Werkstudent AI', location: { name: 'Erlangen' }, first_published: TODAY,
          }],
        };
      }
      const err = new Error('HTTP 404 Not Found');
      err.status = 404;
      throw err;
    },
    fetchText: async () => { throw new Error('unused in this fixture'); },
  };

  const noProbe = await harvestCompanies({ scanHistoryContent, portalsDoc, now: Date.parse(`${TODAY}T00:00:00Z`) + 12 * 3600000 });
  eq('harvestCompanies (no --probe): 4 rows pass status/region/title gates', noProbe.metadata.matchedRows, 4);
  eq('harvestCompanies (no --probe): 3 distinct candidate companies (NewCo, ProbeCo, AbroadCo — Existing excluded, Skipped excluded)', noProbe.metadata.groupedCompanies, 3);
  eq('harvestCompanies (no --probe): 1 already tracked by name', noProbe.metadata.alreadyTracked, 1);
  const newco = noProbe.results.find((r) => r.company === 'NewCo');
  ok('harvestCompanies (no --probe): NewCo resolves via the url tier with 2 sightings', newco?.source === 'url' && newco.vendor === 'lever' && newco.sightings === 2);
  const probeco = noProbe.results.find((r) => r.company === 'ProbeCo');
  ok('harvestCompanies (no --probe): ProbeCo is unresolved (no --probe requested)', probeco?.source === 'unresolved');
  eq('harvestCompanies (no --probe): no probing happened', noProbe.metadata.probed, 0);

  const withProbe = await harvestCompanies({
    scanHistoryContent, portalsDoc, now: Date.parse(`${TODAY}T00:00:00Z`) + 12 * 3600000,
    probe: true, limit: DEFAULT_PROBE_LIMIT, ctx: fakeCtx, concurrency: 2,
  });
  const probecoResolved = withProbe.results.find((r) => r.company === 'ProbeCo');
  ok('harvestCompanies (--probe): ProbeCo resolves via discover-ats with a fake ctx, no live network', probecoResolved?.source === 'probe' && probecoResolved.vendor === 'greenhouse');
  const abroad = withProbe.results.find((r) => r.company === 'Abroad Co');
  ok('harvestCompanies (--probe): a company that never passed the region gate is absent entirely', abroad === undefined);
  eq('harvestCompanies (--probe): metadata reflects one probe', withProbe.metadata.probed, 1);
  ok('harvestCompanies (--probe): resolvedViaProbe counted', withProbe.metadata.resolvedViaProbe === 1);

  // --limit: capping probes below the number of unresolved candidates leaves
  // the excess as 'unresolved', never a fabricated 4th source value.
  const limited = await harvestCompanies({
    scanHistoryContent, portalsDoc, now: Date.parse(`${TODAY}T00:00:00Z`) + 12 * 3600000,
    probe: true, limit: 0, ctx: fakeCtx,
  });
  const probecoLimited = limited.results.find((r) => r.company === 'ProbeCo');
  ok('harvestCompanies (--probe --limit 0): nothing is probed, ProbeCo stays unresolved', probecoLimited?.source === 'unresolved' && limited.metadata.probed === 0);
  ok('harvestCompanies (--probe --limit 0): probeSkippedDueToLimit reflects the skip', limited.metadata.probeSkippedDueToLimit >= 1);

  // Every result's source is one of exactly the four documented values.
  ok('harvestCompanies: every result source is url|probe|unresolved|off-limits',
    [...noProbe.results, ...withProbe.results].every((r) => ['url', 'probe', 'unresolved', 'off-limits'].includes(r.source)));
}

// board-slug dedup: a company sighted under a NEW display name that resolves
// to a board portals.yml already tracks under a DIFFERENT name must not be
// reported as a fresh candidate.
{
  const scanHistoryContent = [
    tsvHeader,
    tsvRow({ url: 'https://jobs.lever.co/existing/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent AI', company: 'Existing Rebrand GmbH', status: 'added', location: 'Erlangen', normalized_company: 'existingrebrand' }),
  ].join('\n') + '\n';
  const portalsDoc = { tracked_companies: [{ name: 'Existing', careers_url: 'https://jobs.lever.co/existing' }] };
  const r = await harvestCompanies({ scanHistoryContent, portalsDoc, now: Date.parse(`${TODAY}T00:00:00Z`) + 12 * 3600000 });
  eq('harvestCompanies: a board already tracked under a different name is NOT reported as fresh', r.results.length, 0);
  eq('harvestCompanies: it is counted as a duplicate board, not silently dropped', r.metadata.duplicateBoards, 1);
}

// BMW Group end to end — the exact scenario the off-limits rule targets.
// Mirrors the real data/scan-history.tsv shape: München-located sightings
// from a mix of a legitimate DE-only portal (arbeitsagentur-api) and an
// off-limits one (linkedin.com, via the 'websearch' portal's URL). Even
// though the company has a real, in-reach, evidence-carrying sighting, it
// must be reported as 'off-limits' — never probed, never written — and must
// never even reach resolveViaUrls or the probe tier.
{
  const scanHistoryContent = [
    tsvHeader,
    tsvRow({ url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/1', first_seen: TODAY, portal: 'arbeitsagentur-api', title: 'Werkstudent Data Science (m/w/d)', company: 'BMW Group', status: 'added', location: 'München', normalized_company: 'bmw' }),
    tsvRow({ url: 'https://de.linkedin.com/jobs/view/werkstudent-ai-bmw', first_seen: TODAY, portal: 'websearch', title: 'Werkstudent Artificial Intelligence (w/m/x)', company: 'BMW Group', status: 'added', location: 'München', normalized_company: 'bmw group' }),
    tsvRow({ url: 'https://jobs.lever.co/acme/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent Data Science', company: 'Acme', status: 'added', location: 'Erlangen', normalized_company: 'acme' }),
  ].join('\n') + '\n';
  const fakeCtxNeverCalled = {
    fetchJson: async () => { throw new Error('must never be called — BMW Group is off-limits'); },
    fetchText: async () => { throw new Error('must never be called — BMW Group is off-limits'); },
  };
  const r = await harvestCompanies({
    scanHistoryContent, portalsDoc: { tracked_companies: [] },
    now: Date.parse(`${TODAY}T00:00:00Z`) + 12 * 3600000, probe: true, ctx: fakeCtxNeverCalled,
  });
  const bmw = r.results.find((row) => row.company === 'BMW Group');
  ok('harvestCompanies: BMW Group reports as source:"off-limits"', bmw?.source === 'off-limits');
  ok('harvestCompanies: BMW Group carries no vendor/careers_url (never resolved)', bmw?.vendor === null && bmw?.careers_url === null);
  eq('harvestCompanies: metadata.offLimits counts it', r.metadata.offLimits, 1);
  ok('harvestCompanies: BMW Group is not counted as a normal candidate', r.metadata.candidates === 1 && r.metadata.groupedCompanies === 2);
  const acme = r.results.find((row) => row.company === 'Acme');
  ok('harvestCompanies: an ordinary company in the same run is unaffected', acme?.source === 'url' && acme.vendor === 'lever');
}

// ============================================================================
// 6. CLI behavior (execFileSync — no live network)
// ============================================================================
console.log('\n--- 6. CLI behavior ---');

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'harvest-companies.mjs');

try {
  execFileSync('node', [scriptPath, '--self-test'], { encoding: 'utf-8', timeout: 15000 });
  ok('--self-test exits 0', true);
} catch (e) {
  ok('--self-test exits 0', false);
  console.log(`    exit code: ${e.status}, stderr: ${e.stderr?.slice(0, 200)}`);
}

const helpOut = execFileSync('node', [scriptPath, '--help'], { encoding: 'utf-8', timeout: 15000 });
ok('--help prints usage', helpOut.includes('Usage:') && helpOut.includes('--write') && helpOut.includes('--probe'));
ok('--help documents the --days default', /--days 45/.test(helpOut));

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'harvest-companies-test-'));
  const scratchPortals = join(tmpDir, 'portals.yml');
  const scratchScanHistory = join(tmpDir, 'scan-history.tsv');
  const scratchContent = 'tracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n\njob_boards:\n  - name: Foo\n';
  writeFileSync(scratchPortals, scratchContent);
  writeFileSync(scratchScanHistory, tsvHeader + '\n');
  const env = { ...process.env, CAREER_OPS_PORTALS: scratchPortals, CAREER_OPS_SCAN_HISTORY: scratchScanHistory };
  try {
    // Empty scan-history → no candidates → no network, exit 0, valid envelope.
    const emptyOut = execFileSync('node', [scriptPath], { encoding: 'utf-8', timeout: 15000, env });
    const emptyJson = JSON.parse(emptyOut);
    ok('empty scan-history → valid JSON envelope', typeof emptyJson === 'object' && 'metadata' in emptyJson && 'results' in emptyJson);
    eq('empty scan-history → results []', emptyJson.results, []);
    ok('empty scan-history → previewOnly true', emptyJson.metadata.previewOnly === true);
    ok('empty scan-history → written false', emptyJson.metadata.written === false);
    eq('default run → portals.yml byte-for-byte unchanged', readFileSync(scratchPortals, 'utf-8'), scratchContent);

    // --write with nothing fresh still leaves the file untouched.
    const writeOut = execFileSync('node', [scriptPath, '--write'], { encoding: 'utf-8', timeout: 15000, env });
    const writeJson = JSON.parse(writeOut);
    ok('--write accepted (valid JSON, exit 0)', typeof writeJson === 'object' && 'metadata' in writeJson);
    eq('--write with nothing fresh → portals.yml still unchanged', readFileSync(scratchPortals, 'utf-8'), scratchContent);

    // A real candidate, written end to end via discover-ats's own splice writer.
    writeFileSync(scratchScanHistory, [
      tsvHeader,
      tsvRow({ url: 'https://jobs.lever.co/newco/1', first_seen: TODAY, portal: 'arbeitnow-api', title: 'Werkstudent Data Science', company: 'NewCo', status: 'added', location: 'Erlangen', normalized_company: 'newco' }),
    ].join('\n') + '\n');
    const populatedPreview = JSON.parse(execFileSync('node', [scriptPath], { encoding: 'utf-8', timeout: 15000, env }));
    ok('populated scan-history, no --write → previewOnly, portals.yml untouched', populatedPreview.metadata.previewOnly === true);
    eq('populated scan-history, no --write → portals.yml unchanged', readFileSync(scratchPortals, 'utf-8'), scratchContent);
    ok('populated scan-history → pendingEntries shows the would-be YAML', populatedPreview.pendingEntries.includes('name: NewCo'));

    const populatedWrite = JSON.parse(execFileSync('node', [scriptPath, '--write'], { encoding: 'utf-8', timeout: 15000, env }));
    ok('populated scan-history + --write → written true', populatedWrite.metadata.written === true);
    const afterWrite = readFileSync(scratchPortals, 'utf-8');
    ok('populated scan-history + --write → portals.yml now carries NewCo', afterWrite.includes('name: NewCo') && afterWrite.includes('careers_url: https://jobs.lever.co/newco'));
    ok('populated scan-history + --write → the Existing entry is preserved byte-for-byte around the splice', afterWrite.includes('name: Existing') && afterWrite.includes('job_boards:'));

    // Idempotent: running --write again with the same history adds nothing new.
    const rewrite = JSON.parse(execFileSync('node', [scriptPath, '--write'], { encoding: 'utf-8', timeout: 15000, env }));
    eq('re-running --write with the same data is idempotent (0 fresh)', rewrite.metadata.fresh, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

let flagExit = 0;
try {
  execFileSync('node', [scriptPath, '--bogus'], { encoding: 'utf-8', timeout: 15000 });
} catch (e) {
  flagExit = e.status;
}
ok('unknown flag → nonzero exit', flagExit !== 0);

let missingInExit = 0;
try {
  execFileSync('node', [scriptPath, '--in', '/definitely/does/not/exist.json'], { encoding: 'utf-8', timeout: 15000 });
} catch (e) {
  missingInExit = e.status;
}
ok('missing --in file → nonzero exit', missingInExit !== 0);
