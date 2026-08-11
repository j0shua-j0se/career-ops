// tests/indeed-provider.test.mjs — Indeed was declared impossible to automate,
// in portals.yml → KNOWN GAPS and in this project's own notes. The reasoning
// looked sound (Publisher API gone, RSS 403s, MCP is agent-only) and was wrong:
// nobody had tried the ordinary search page through a rendering fetcher. It
// returns HTTP 200 with the full result set embedded as JSON, no CAPTCHA and no
// credential.
//
// These run against a saved payload — no network.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseIndeedHtml, buildSearchUrl } from '../providers/indeed.mjs';

console.log('\nIndeed provider');

const html = readFileSync(join(ROOT, 'tests/fixtures/indeed-search.html'), 'utf-8');
const jobs = parseIndeedHtml(html);

jobs.length >= 10
  ? pass(`parses the mosaic job-card payload (${jobs.length} jobs)`)
  : fail(`expected 10+ jobs from the fixture, got ${jobs.length}`);

jobs.every(j => j.title && j.company && j.location)
  ? pass('every job carries title, company and location')
  : fail('a job is missing title/company/location');

// The permalink must be built from the job key, NOT from `link`/`viewJobLink`:
// those carry per-session tracking parameters, which would defeat dedup against
// scan-history and re-add the same posting on every scan.
jobs.every(j => /^https:\/\/de\.indeed\.com\/viewjob\?jk=[A-Za-z0-9]+$/.test(j.url))
  ? pass('URLs are clean jk permalinks, with no tracking parameters to defeat dedup')
  : fail(`a URL is not a clean permalink: ${jobs.find(j => !/viewjob\?jk=[A-Za-z0-9]+$/.test(j.url))?.url}`);

new Set(jobs.map(j => j.url)).size === jobs.length
  ? pass('no duplicate URLs within a page')
  : fail('duplicate URLs emitted');

// pubDate is a real epoch timestamp, not "vor 3 Tagen" prose — one of the
// concrete advantages of the JSON payload over DOM scraping.
jobs.filter(j => Number.isFinite(j.postedAt)).length === jobs.length
  ? pass('every job carries a real epoch timestamp')
  : fail('a job is missing postedAt');

jobs.every(j => !j.postedAt || j.postedAt < Date.now() + 86400000)
  ? pass('no implausible future timestamps survive the guard')
  : fail('a future timestamp was accepted');

// A known row, to catch a parser that "works" but mis-assigns fields. This is
// the Siemens Healthineers posting evaluated as report 037.
{
  const hit = jobs.find(j => /04db8e142b4bbd1d/.test(j.url));
  hit && /Siemens Healthineers/i.test(hit.company) && /Forchheim/i.test(hit.location)
    ? pass('a known posting maps company/location to the right fields')
    : fail(`field mis-assignment: ${JSON.stringify(hit)}`);
}

// --- URL building. `/jobs/DE/` IS robots-Disallowed; `/jobs?q=` is not.
{
  const u = buildSearchUrl('werkstudent data science', { city: 'Erlangen', radius: 50 });
  /^https:\/\/de\.indeed\.com\/jobs\?/.test(u) && /q=werkstudent\+data\+science/.test(u) && /l=Erlangen/.test(u)
    ? pass('buildSearchUrl targets the permitted /jobs?q= endpoint')
    : fail(`unexpected search URL: ${u}`);

  !/\/jobs\/[A-Z]{2}\//.test(u)
    ? pass('never builds a robots-Disallowed /jobs/{CC}/ country-segment path')
    : fail('built a Disallowed country-segment path');
}

// Host allowlist: a redirect or misconfiguration must not send the fetcher
// somewhere arbitrary.
try {
  buildSearchUrl('x', { domain: 'evil.example.com' });
  fail('a non-Indeed host should be refused');
} catch {
  pass('a non-Indeed host is refused');
}

try {
  buildSearchUrl('   ', { city: 'Erlangen' });
  fail('an empty query should throw');
} catch {
  pass('an empty query throws instead of searching everything');
}

// Garbage in, empty out — never a throw, so one odd page cannot kill a sweep.
parseIndeedHtml('').length === 0
  && parseIndeedHtml('<html><body>nothing</body></html>').length === 0
  && parseIndeedHtml('<script>window.mosaic.providerData["mosaic-provider-jobcards"]={bad json;</script>').length === 0
  ? pass('empty, non-listing and malformed payloads yield zero jobs without throwing')
  : fail('malformed input mishandled');
