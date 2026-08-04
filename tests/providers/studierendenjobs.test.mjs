// tests/providers/studierendenjobs.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — studierendenjobs');

const mod = await import(pathToFileURL(join(ROOT, 'providers/studierendenjobs.mjs')).href);
const provider = mod.default;
const { resolveListUrl, cityFromHost, parseListing } = mod;

// Markup shape taken from the live München board.
const FIXTURE = `
<div class="results">
  <a href="/anzeige/232848-werkstudent-social-media-marketing-mwd-2" class="card">Werkstudent Social Media Marketing (m/w/d)</a>
  <a href="/anzeige/232946-werkstudent-it-support-mwd-ferienjob" class="card"><span>Werkstudent IT-Support (m/w/d) Ferienjob</span></a>
  <a href="/anzeige/232864-front-office-internship" class="card">Front Office Internship</a>
  <a href="/anzeige/232864-front-office-internship" class="card">Front Office Internship</a>
  <a href="/jobratgeber">Jobratgeber</a>
  <a href="/anzeige/999999-leer"></a>
</div>`;

if (provider.id === 'studierendenjobs') pass('id is "studierendenjobs"');
else fail(`id should be "studierendenjobs", got ${provider.id}`);

// ── detect / resolveListUrl ───────────────────────────────────────────
for (const url of [
  'https://www.studierendenjobs-muenchen.de',
  'https://studierendenjobs-muenchen.de/stellenangebote',
  'https://www.studentenjobs-nuernberg.de',
]) {
  if (provider.detect({ careers_url: url })) pass(`detect() claims ${url}`);
  else fail(`detect() should claim ${url}`);
}

for (const url of [
  'https://jobs.lever.co/example',
  'https://www.werkswelt.de/index.php?id=jobs',
  'ftp://studierendenjobs-muenchen.de',
  'not-a-url',
]) {
  if (provider.detect({ careers_url: url }) === null) pass(`detect() declines ${url}`);
  else fail(`detect() should decline ${url}`);
}

if (resolveListUrl({ careers_url: 'https://www.studierendenjobs-muenchen.de' })
  === 'https://www.studierendenjobs-muenchen.de/stellenangebote') {
  pass('resolveListUrl() defaults a bare host to /stellenangebote');
} else {
  fail(`resolveListUrl() default path wrong: ${resolveListUrl({ careers_url: 'https://www.studierendenjobs-muenchen.de' })}`);
}

// ── cityFromHost ──────────────────────────────────────────────────────
if (cityFromHost('https://www.studierendenjobs-muenchen.de/stellenangebote') === 'München') {
  pass('cityFromHost() maps muenchen → München');
} else {
  fail(`cityFromHost() muenchen: got ${cityFromHost('https://www.studierendenjobs-muenchen.de/stellenangebote')}`);
}
if (cityFromHost('https://studentenjobs-nuernberg.de') === 'Nürnberg') {
  pass('cityFromHost() maps nuernberg → Nürnberg');
} else {
  fail(`cityFromHost() nuernberg: got ${cityFromHost('https://studentenjobs-nuernberg.de')}`);
}
if (cityFromHost('https://studierendenjobs-freiburg.de') === 'Freiburg') {
  pass('cityFromHost() capitalizes an unmapped city');
} else {
  fail(`cityFromHost() freiburg: got ${cityFromHost('https://studierendenjobs-freiburg.de')}`);
}

// ── parseListing ──────────────────────────────────────────────────────
const rows = parseListing(FIXTURE);
if (rows.length === 3) pass('parseListing() returns 3 rows (dedups, skips non-job and empty-title anchors)');
else fail(`parseListing() should return 3 rows, got ${rows.length}: ${JSON.stringify(rows)}`);

if (rows[1]?.title === 'Werkstudent IT-Support (m/w/d) Ferienjob') pass('parseListing() strips nested tags from the title');
else fail(`parseListing() nested title wrong: ${rows[1]?.title}`);

if (rows[0]?.id === '232848') pass('parseListing() captures the posting id');
else fail(`parseListing() id wrong: ${rows[0]?.id}`);

if (parseListing(null).length === 0) pass('parseListing() tolerates a non-string');
else fail('parseListing(null) should return []');

// ── fetch ─────────────────────────────────────────────────────────────
let requested = null;
const jobs = await provider.fetch(
  { name: 'Studierendenjobs München', careers_url: 'https://www.studierendenjobs-muenchen.de' },
  { transport: 'http', fetchText: async (u) => { requested = u; return FIXTURE; }, fetchJson: async () => ({}) },
);

if (requested === 'https://www.studierendenjobs-muenchen.de/stellenangebote') pass('fetch() requests the listing URL');
else fail(`fetch() requested ${requested}`);

if (jobs.length === 3) pass('fetch() returns 3 jobs');
else fail(`fetch() should return 3 jobs, got ${jobs.length}`);

if (jobs[0]?.url === 'https://www.studierendenjobs-muenchen.de/anzeige/232848-werkstudent-social-media-marketing-mwd-2') {
  pass('fetch() absolutizes the job URL against the board origin');
} else {
  fail(`fetch() url wrong: ${jobs[0]?.url}`);
}

if (jobs.every((j) => j.location === 'München')) pass('fetch() derives location from the hostname');
else fail(`fetch() location wrong: ${jobs.map((j) => j.location).join(', ')}`);

const overridden = await provider.fetch(
  { name: 'X', careers_url: 'https://www.studierendenjobs-muenchen.de', location: 'Garching' },
  { transport: 'http', fetchText: async () => FIXTURE, fetchJson: async () => ({}) },
);
if (overridden.every((j) => j.location === 'Garching')) pass('fetch() honors an explicit portals.yml location');
else fail(`fetch() should honor entry.location, got ${overridden[0]?.location}`);
