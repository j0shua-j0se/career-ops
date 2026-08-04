// tests/providers/fau.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — fau');

const mod = await import(pathToFileURL(join(ROOT, 'providers/fau.mjs')).href);
const provider = mod.default;
const { resolveListUrl, buildRequestUrls, parseListing, describe } = mod;

// Markup shape taken from the live jobs.fau.de search results. Card 3 repeats
// card 1's URL (the union must dedup it); card 4 has no title (must be dropped);
// the trailing anchor is site chrome, not a job card.
const FIXTURE = `
<div class="job-list">
  <a class="job-link" href="https://www.jobs.fau.de/jobs/hiwi-kimono-projekt-fau-1756/">
    <div class="job-title">Studentische Hilfskraft im KIMONO-Projekt</div>
    <div class="job-salary"><span class="label">Entgelt: </span>TV-L E 13</div>
    <div class="job-limitation"><span class="label">Befristung: </span>befristet</div>
    <div class="job-workingtime"><span class="label">Arbeitszeit: </span>Teilzeit: 8 Std./Woche</div>
    <div class="job-startdate"><span class="label">Einstellungstermin: </span>01.10.2026</div>
    <div class="job-validthrough"><span class="label">Bewerbungsschluss: </span>07.08.2026</div>
  </a>
  <a class="job-link" href="https://www.jobs.fau.de/jobs/wiss-mitarbeiter-networking-fau-1815/">
    <div class="job-title">Wissenschaftlicher Mitarbeiter Next-Generation-Networking</div>
    <div class="job-workingtime"><span class="label">Arbeitszeit: </span>Vollzeit</div>
  </a>
  <a class="job-link" href="https://www.jobs.fau.de/jobs/hiwi-kimono-projekt-fau-1756/">
    <div class="job-title">Studentische Hilfskraft im KIMONO-Projekt</div>
  </a>
  <a class="job-link" href="https://www.jobs.fau.de/jobs/kaputt-fau-9999/">
    <div class="job-salary"><span class="label">Entgelt: </span>TV-L E 5</div>
  </a>
  <a class="nav-link" href="https://www.jobs.fau.de/impressum/">Impressum</a>
</div>`;

const mockCtx = (log) => ({
  transport: 'http',
  fetchText: async (u) => { log.push(u); return FIXTURE; },
  fetchJson: async () => ({}),
  sleep: async () => {},
});

if (provider.id === 'fau') pass('id is "fau"');
else fail(`id should be "fau", got ${provider.id}`);

// ── detect / resolveListUrl ───────────────────────────────────────────
for (const url of [
  'https://www.jobs.fau.de/jobs/',
  'https://jobs.fau.de',
  'https://www.jobs.fau.de/jobs/?free_txt=Data',
]) {
  if (provider.detect({ careers_url: url })) pass(`detect() claims ${url}`);
  else fail(`detect() should claim ${url}`);
}

// www.fau.de is the university website, not the job board — must not be claimed.
for (const url of [
  'https://www.fau.de/',
  'https://www.fau.de/fau/stellenmarkt/',
  'https://www.stellenwerk.de/erlangen-nuernberg',
  'ftp://jobs.fau.de',
  'not-a-url',
]) {
  if (provider.detect({ careers_url: url }) === null) pass(`detect() declines ${url}`);
  else fail(`detect() should decline ${url}`);
}

if (resolveListUrl({ careers_url: 'https://jobs.fau.de' }) === 'https://www.jobs.fau.de/jobs/') {
  pass('resolveListUrl() normalizes a bare host to the www /jobs/ listing');
} else {
  fail(`resolveListUrl() wrong: ${resolveListUrl({ careers_url: 'https://jobs.fau.de' })}`);
}

// ── buildRequestUrls ──────────────────────────────────────────────────
const LIST = 'https://www.jobs.fau.de/jobs/';

const bare = buildRequestUrls(LIST, {});
if (bare.length === 1 && bare[0] === LIST) pass('buildRequestUrls() falls back to the bare listing with no config');
else fail(`buildRequestUrls() bare wrong: ${JSON.stringify(bare)}`);

const queried = buildRequestUrls(LIST, { keywords: ['Hilfskraft', 'Machine Learning', 'Hilfskraft', ''] });
if (queried.length === 2) pass('buildRequestUrls() dedups and drops empty keywords');
else fail(`buildRequestUrls() should build 2 keyword URLs, got ${JSON.stringify(queried)}`);

if (queried[0] === `${LIST}?free_txt=Hilfskraft&free_txt_fields=title`) {
  pass('buildRequestUrls() searches the title field, not the description');
} else {
  fail(`buildRequestUrls() keyword URL wrong: ${queried[0]}`);
}

if (queried[1].includes('free_txt=Machine+Learning')) pass('buildRequestUrls() form-encodes a multi-word keyword');
else fail(`buildRequestUrls() encoding wrong: ${queried[1]}`);

const categorized = buildRequestUrls(LIST, { categories: ['hiwi', 'wiss'] });
if (categorized[0] === `${LIST}?job_category%5B%5D=hiwi`) {
  pass('buildRequestUrls() encodes job_category[] as an array param');
} else {
  fail(`buildRequestUrls() category URL wrong: ${categorized[0]}`);
}

const both = buildRequestUrls(LIST, { keywords: ['Data'], categories: ['hiwi'] });
if (both.length === 2) pass('buildRequestUrls() combines keywords and categories');
else fail(`buildRequestUrls() combined wrong: ${JSON.stringify(both)}`);

// ── parseListing ──────────────────────────────────────────────────────
const rows = parseListing(FIXTURE);
if (rows.length === 2) pass('parseListing() returns 2 rows (dedups by URL, drops the title-less card and site chrome)');
else fail(`parseListing() should return 2 rows, got ${rows.length}: ${JSON.stringify(rows)}`);

if (rows[0]?.title === 'Studentische Hilfskraft im KIMONO-Projekt') pass('parseListing() reads the card title');
else fail(`parseListing() title wrong: ${rows[0]?.title}`);

if (rows[0]?.workingTime === 'Teilzeit: 8 Std./Woche') pass('parseListing() strips the bold label off Arbeitszeit');
else fail(`parseListing() workingTime wrong: ${rows[0]?.workingTime}`);

if (rows[0]?.validThrough === '07.08.2026') pass('parseListing() captures the Bewerbungsschluss deadline');
else fail(`parseListing() validThrough wrong: ${rows[0]?.validThrough}`);

// Card 2 carries only a working time — the other fields must not leak in from card 1.
if (rows[1]?.salary === '' && rows[1]?.validThrough === '') {
  pass('parseListing() does not pair fields across card boundaries');
} else {
  fail(`parseListing() leaked fields into card 2: ${JSON.stringify(rows[1])}`);
}

if (parseListing(null).length === 0) pass('parseListing() tolerates a non-string');
else fail('parseListing(null) should return []');

// ── describe ──────────────────────────────────────────────────────────
if (describe(rows[0]) === 'Arbeitszeit: Teilzeit: 8 Std./Woche · Entgelt: TV-L E 13 · Befristung: befristet · Einstellungstermin: 01.10.2026 · Bewerbungsschluss: 07.08.2026') {
  pass('describe() folds the card metadata into one line');
} else {
  fail(`describe() wrong: ${describe(rows[0])}`);
}

if (describe(rows[1]) === 'Arbeitszeit: Vollzeit') pass('describe() drops empty fields');
else fail(`describe() should drop empty fields, got: ${describe(rows[1])}`);

// ── fetch ─────────────────────────────────────────────────────────────
const log = [];
const jobs = await provider.fetch(
  { name: 'FAU Erlangen-Nürnberg', careers_url: 'https://www.jobs.fau.de/jobs/', keywords: ['Hilfskraft', 'Data'] },
  mockCtx(log),
);

if (log.length === 2) pass('fetch() issues one GET per configured keyword');
else fail(`fetch() should issue 2 requests, got ${log.length}: ${JSON.stringify(log)}`);

if (jobs.length === 2) pass('fetch() unions results across keywords and dedups by URL');
else fail(`fetch() should return 2 jobs, got ${jobs.length}`);

if (jobs[0]?.description?.includes('8 Std./Woche')) pass('fetch() carries hours/week through in description');
else fail(`fetch() description wrong: ${jobs[0]?.description}`);

if (jobs[0]?.postedAt === undefined) pass('fetch() omits postedAt (no publication date on the card)');
else fail(`fetch() must not set postedAt, got ${jobs[0]?.postedAt}`);

if (jobs.every((j) => j.location === 'Erlangen-Nürnberg')) pass('fetch() derives location from the institution');
else fail(`fetch() location wrong: ${jobs.map((j) => j.location).join(', ')}`);

const overridden = await provider.fetch(
  { name: 'FAU', careers_url: 'https://jobs.fau.de', keywords: ['Data'], location: 'Nürnberg' },
  mockCtx([]),
);
if (overridden.every((j) => j.location === 'Nürnberg')) pass('fetch() honors an explicit portals.yml location');
else fail(`fetch() should honor entry.location, got ${overridden[0]?.location}`);

const probeLog = [];
await provider.fetch(
  { name: 'FAU', careers_url: 'https://jobs.fau.de', keywords: ['Hilfskraft', 'Data', 'KI'] },
  { ...mockCtx(probeLog), maxPages: 1 },
);
if (probeLog.length === 1) pass('fetch() honors ctx.maxPages so the health probe issues one request');
else fail(`fetch() with maxPages:1 should issue 1 request, got ${probeLog.length}`);
