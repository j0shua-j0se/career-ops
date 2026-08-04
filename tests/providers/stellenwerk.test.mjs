// tests/providers/stellenwerk.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — stellenwerk');

const mod = await import(pathToFileURL(join(ROOT, 'providers/stellenwerk.mjs')).href);
const provider = mod.default;
const { parseSitemap, parseJobUrl, postedAtFrom, deslugTitle, regionName, resolveCity } = mod;

// Shape taken from the live sitemap: a single flat <urlset>, <loc> only, every
// city portal mixed together, city landing pages and static pages interleaved.
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.stellenwerk.de</loc></url>
<url><loc>https://www.stellenwerk.de/aachen</loc></url>
<url><loc>https://www.stellenwerk.de/erlangen-nuernberg</loc></url>
<url><loc>https://www.stellenwerk.de/erlangen-nuernberg/werkstudent-software-development-edge-ai-mwd-260707-272145</loc></url>
<url><loc>https://www.stellenwerk.de/erlangen-nuernberg/werkstudent-mwd-devopsmlops-260709-272329</loc></url>
<url><loc>https://www.stellenwerk.de/erlangen-nuernberg/working-student-machine-learning-for-audio-compression-all-genders-260709-272345</loc></url>
<url><loc>https://www.stellenwerk.de/erlangen-nuernberg/impressum</loc></url>
<url><loc>https://www.stellenwerk.de/muenchen/werkstudent-mwd-data-science-260710-272400</loc></url>
</urlset>`;

if (provider.id === 'stellenwerk') pass('id is "stellenwerk"');
else fail(`id should be "stellenwerk", got ${provider.id}`);

// ── detect ────────────────────────────────────────────────────────────
for (const url of [
  'https://www.stellenwerk.de/erlangen-nuernberg',
  'https://stellenwerk.de/muenchen',
]) {
  if (provider.detect({ careers_url: url })) pass(`detect() claims ${url}`);
  else fail(`detect() should claim ${url}`);
}

for (const url of [
  'https://www.jobs.fau.de/jobs/',
  'https://www.studierendenjobs-muenchen.de',
  'ftp://stellenwerk.de/muenchen',
  'not-a-url',
]) {
  if (provider.detect({ careers_url: url }) === null) pass(`detect() declines ${url}`);
  else fail(`detect() should decline ${url}`);
}

// ── parseSitemap ──────────────────────────────────────────────────────
const locs = parseSitemap(SITEMAP);
if (locs.length === 8) pass('parseSitemap() extracts every <loc>');
else fail(`parseSitemap() should find 8 locs, got ${locs.length}`);

if (parseSitemap(null).length === 0) pass('parseSitemap() tolerates a non-string');
else fail('parseSitemap(null) should return []');

// ── parseJobUrl ───────────────────────────────────────────────────────
const parsed = parseJobUrl('https://www.stellenwerk.de/erlangen-nuernberg/werkstudent-mwd-devopsmlops-260709-272329');
if (parsed && parsed.city === 'erlangen-nuernberg' && parsed.slug === 'werkstudent-mwd-devopsmlops' && parsed.dateStr === '260709' && parsed.id === '272329') {
  pass('parseJobUrl() splits city, slug, date and id');
} else {
  fail(`parseJobUrl() wrong: ${JSON.stringify(parsed)}`);
}

// A slug that itself contains digits must not confuse the trailing date/id.
const withDigits = parseJobUrl('https://www.stellenwerk.de/erlangen-nuernberg/researcher-mfd-in-data-analytics-100prozent-tv-l-e13-260216-263137');
if (withDigits?.dateStr === '260216' && withDigits?.id === '263137') {
  pass('parseJobUrl() anchors the date/id at the end of the slug');
} else {
  fail(`parseJobUrl() digit-slug wrong: ${JSON.stringify(withDigits)}`);
}

for (const [url, why] of [
  ['https://www.stellenwerk.de/erlangen-nuernberg', 'a city landing page'],
  ['https://www.stellenwerk.de/erlangen-nuernberg/impressum', 'a static page with no date/id tail'],
  ['https://www.jobs.fau.de/jobs/some-role-260709-272329', 'another host'],
  ['not-a-url', 'a malformed URL'],
]) {
  if (parseJobUrl(url) === null) pass(`parseJobUrl() rejects ${why}`);
  else fail(`parseJobUrl() should reject ${why}: ${url}`);
}

// ── postedAtFrom ──────────────────────────────────────────────────────
if (postedAtFrom('260715') === Date.UTC(2026, 6, 15)) pass('postedAtFrom() reads YYMMDD as 2026-07-15');
else fail(`postedAtFrom('260715') wrong: ${postedAtFrom('260715')}`);

for (const [v, why] of [
  ['260231', '31 February (Date.UTC would silently roll it over)'],
  ['261315', 'month 13'],
  ['260700', 'day 0'],
  ['abcdef', 'a non-numeric segment'],
  ['', 'an empty segment'],
]) {
  if (postedAtFrom(v) === undefined) pass(`postedAtFrom() drops ${why}`);
  else fail(`postedAtFrom('${v}') should be undefined, got ${postedAtFrom(v)}`);
}

// ── deslugTitle ───────────────────────────────────────────────────────
if (deslugTitle('werkstudent-mwd-devopsmlops') === 'Werkstudent (m/w/d) Devopsmlops') {
  pass('deslugTitle() expands the gender tag and title-cases the rest');
} else {
  fail(`deslugTitle() wrong: ${deslugTitle('werkstudent-mwd-devopsmlops')}`);
}

// The whole point of hyphen→space: a "Machine Learning" title_filter term must match.
if (deslugTitle('working-student-machine-learning-for-audio-compression').toLowerCase().includes('machine learning')) {
  pass('deslugTitle() turns hyphens into spaces so multi-word filter terms match');
} else {
  fail(`deslugTitle() did not produce a matchable phrase: ${deslugTitle('working-student-machine-learning-for-audio-compression')}`);
}

if (deslugTitle('') === '') pass('deslugTitle() tolerates an empty slug');
else fail('deslugTitle("") should return ""');

// The lookup table is keyed by text lifted out of a URL. With a plain object
// literal, GENDER_TAGS['constructor'] resolves up the prototype chain to a
// truthy Function and gets stringified into the title.
const proto = deslugTitle('senior-constructor-engineer');
if (proto === 'Senior Constructor Engineer') pass('deslugTitle() does not resolve slug words up the prototype chain');
else fail(`deslugTitle() leaked a prototype member: ${proto}`);

if (deslugTitle('valueof-tostring-hasownproperty') === 'Valueof Tostring Hasownproperty') {
  pass('deslugTitle() is unaffected by other Object.prototype member names');
} else {
  fail(`deslugTitle() leaked a prototype member: ${deslugTitle('valueof-tostring-hasownproperty')}`);
}

// ── regionName / resolveCity ──────────────────────────────────────────
if (regionName('erlangen-nuernberg') === 'Erlangen-Nürnberg') pass('regionName() maps erlangen-nuernberg → Erlangen-Nürnberg');
else fail(`regionName() wrong: ${regionName('erlangen-nuernberg')}`);

if (regionName('hamburg') === 'Hamburg') pass('regionName() capitalizes an unmapped portal');
else fail(`regionName() unmapped wrong: ${regionName('hamburg')}`);

// Same prototype-chain trap as deslugTitle: the city comes from the URL path.
if (regionName('constructor') === 'Constructor') pass('regionName() does not resolve a city slug up the prototype chain');
else fail(`regionName() leaked a prototype member: ${regionName('constructor')}`);

if (resolveCity({ careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg' }) === 'erlangen-nuernberg') {
  pass('resolveCity() reads the city from careers_url');
} else {
  fail(`resolveCity() wrong: ${resolveCity({ careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg' })}`);
}

if (resolveCity({ careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg', city: 'Muenchen' }) === 'muenchen') {
  pass('resolveCity() lets an explicit city: override the URL');
} else {
  fail('resolveCity() should honor an explicit city:');
}

if (resolveCity({ careers_url: 'https://www.jobs.fau.de/jobs/' }) === null) pass('resolveCity() declines a non-stellenwerk host');
else fail('resolveCity() should decline a non-stellenwerk host');

// ── fetch ─────────────────────────────────────────────────────────────
let requested = null;
const jobs = await provider.fetch(
  { name: 'stellenwerk Erlangen-Nürnberg', careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg' },
  { transport: 'http', fetchText: async (u) => { requested = u; return SITEMAP; }, fetchJson: async () => ({}) },
);

if (requested === 'https://www.stellenwerk.de/sitemap.xml') pass('fetch() reads the advertised sitemap');
else fail(`fetch() requested ${requested}`);

if (jobs.length === 3) pass('fetch() keeps only postings under the configured city');
else fail(`fetch() should return 3 jobs, got ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);

if (!jobs.some((j) => j.url.includes('/muenchen/'))) pass('fetch() excludes other city portals from the shared sitemap');
else fail('fetch() leaked a München posting into the Erlangen-Nürnberg board');

if (!jobs.some((j) => j.url.endsWith('/impressum'))) pass('fetch() excludes static pages');
else fail('fetch() included a static page');

if (jobs[0]?.postedAt === Date.UTC(2026, 6, 7)) pass('fetch() derives postedAt from the slug date');
else fail(`fetch() postedAt wrong: ${jobs[0]?.postedAt}`);

if (jobs.every((j) => j.location === 'Erlangen-Nürnberg')) pass('fetch() labels postings with the portal region');
else fail(`fetch() location wrong: ${jobs.map((j) => j.location).join(', ')}`);

if (jobs.every((j) => j.company === '')) pass('fetch() leaves company empty — the sitemap does not carry it');
else fail(`fetch() should not invent a company, got ${jobs.map((j) => j.company).join(', ')}`);

const overridden = await provider.fetch(
  { name: 'stellenwerk', careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg', location: 'Nürnberg' },
  { transport: 'http', fetchText: async () => SITEMAP, fetchJson: async () => ({}) },
);
if (overridden.every((j) => j.location === 'Nürnberg')) pass('fetch() honors an explicit portals.yml location');
else fail(`fetch() should honor entry.location, got ${overridden[0]?.location}`);

const empty = await provider.fetch(
  { name: 'stellenwerk', careers_url: 'https://www.stellenwerk.de/erlangen-nuernberg' },
  { transport: 'http', fetchText: async () => '<urlset></urlset>', fetchJson: async () => ({}) },
);
if (empty.length === 0) pass('fetch() returns [] on an empty sitemap instead of throwing');
else fail(`fetch() should return [] for an empty sitemap, got ${empty.length}`);
