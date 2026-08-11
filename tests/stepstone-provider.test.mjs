// tests/stepstone-provider.test.mjs — StepStone is the largest German job board
// and was the biggest hole in the scanner: 2 rows in its entire history,
// because it had no provider and lived only as an agent-driven Stage 1b step
// that got skipped in practice.
//
// It cannot be a `ctx.fetchJson` provider — StepStone publishes no usable job
// API (`/public-api/` is Disallowed in robots.txt) and refuses a plain fetch —
// so the provider shells out to the `scrapling` CLI and parses the rendered
// listing markup. That makes the PARSER the thing worth pinning, and these run
// against a saved fixture with no network.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseStepstoneHtml, buildSearchUrl, parseTimeAgo } from '../providers/stepstone.mjs';

console.log('\nStepStone provider');

const html = readFileSync(join(ROOT, 'tests/fixtures/stepstone-search.html'), 'utf-8');
const jobs = parseStepstoneHtml(html, Date.UTC(2026, 7, 11));

jobs.length >= 3
  ? pass(`parses job cards from the fixture (${jobs.length})`)
  : fail(`expected at least 3 jobs from the fixture, got ${jobs.length}`);

// Every emitted job must carry a title and an absolute stepstone URL — those
// two are the contract; company/location are best-effort.
jobs.every(j => j.title && /^https:\/\/www\.stepstone\.de\/stellenangebote--/.test(j.url))
  ? pass('every job has a title and an absolute stepstone.de posting URL')
  : fail('a job is missing a title or has a non-absolute URL');

// The bug that made the first parse useless: StepStone nests an SVG icon span
// INSIDE the labelled element, so a non-greedy match to the first closing tag
// returned an empty string, and a fixed-width window fused sibling markup onto
// the text. Both are pinned here.
jobs.every(j => !/[<>]/.test(`${j.title}${j.company}${j.location}`))
  ? pass('no raw markup leaks into title, company or location')
  : fail(`markup leaked into a field: ${JSON.stringify(jobs.find(j => /[<>]/.test(`${j.title}${j.company}${j.location}`)))}`);

jobs.filter(j => j.company).length === jobs.length
  ? pass('company is extracted for every card (the nested-icon case)')
  : fail(`${jobs.length - jobs.filter(j => j.company).length} card(s) lost their company`);

jobs.filter(j => j.location).length === jobs.length
  ? pass('location is extracted for every card')
  : fail('a card lost its location');

// A known row from the fixture, to catch a parser that "works" but mis-assigns.
{
  const mhi = jobs.find(j => /Mitsubishi/i.test(j.company));
  mhi && /DevOps/i.test(mhi.title) && /Erlangen/i.test(mhi.location)
    ? pass('a known card maps company/title/location to the right fields')
    : fail(`field mis-assignment: ${JSON.stringify(mhi)}`);
}

// URLs are the dedup key, so duplicates within one page must collapse.
new Set(jobs.map(j => j.url)).size === jobs.length
  ? pass('no duplicate URLs within a single page')
  : fail('duplicate URLs emitted from one page');

// --- Dates. A wrong date is worse than none: scan-ats-full's recency filter
// treats a missing date as "do not penalize", but acts on a wrong one.
parseTimeAgo('vor 3 Tagen', Date.UTC(2026, 7, 11)) === Date.UTC(2026, 7, 8)
  ? pass('"vor 3 Tagen" resolves to three days before now')
  : fail(`German relative date wrong: ${parseTimeAgo('vor 3 Tagen', Date.UTC(2026, 7, 11))}`);

parseTimeAgo('Gestern', Date.UTC(2026, 7, 11)) === Date.UTC(2026, 7, 10)
  ? pass('"Gestern" resolves to yesterday')
  : fail('"Gestern" mishandled');

parseTimeAgo('2 weeks ago', Date.UTC(2026, 7, 11)) === Date.UTC(2026, 7, 11) - 14 * 86400000
  ? pass('English "2 weeks ago" also parses')
  : fail('English relative date mishandled');

parseTimeAgo('irgendwann', Date.UTC(2026, 7, 11)) === undefined && parseTimeAgo('') === undefined
  ? pass('an unrecognized date yields undefined, never a guessed timestamp')
  : fail('unrecognized date produced a value — a wrong date is worse than none');

// --- URL building. Only the modern /jobs/ path is permitted by robots.txt.
{
  const u = buildSearchUrl('werkstudent data science', 'erlangen', 50);
  u === 'https://www.stepstone.de/jobs/werkstudent-data-science/in-erlangen?radius=50'
    ? pass('buildSearchUrl uses the robots-permitted /jobs/ path and slugifies the query')
    : fail(`unexpected search URL: ${u}`);
}

/\/jobs\//.test(buildSearchUrl('x')) && !/\/5\/|public-api|jobagent/.test(buildSearchUrl('x'))
  ? pass('never targets a robots.txt-Disallowed path (/5/, /public-api/, /jobagent/)')
  : fail('search URL targets a Disallowed path');

// Radius is clamped rather than passed through blindly.
/radius=100$/.test(buildSearchUrl('x', 'erlangen', 9999)) && /radius=0$/.test(buildSearchUrl('x', 'erlangen', -5))
  ? pass('radius is clamped to 0..100')
  : fail('radius not clamped');

try {
  buildSearchUrl('   ');
  fail('an empty query should throw rather than build a bare search URL');
} catch {
  pass('an empty query throws instead of silently searching everything');
}

// Empty/garbage input must yield no jobs rather than throwing.
parseStepstoneHtml('').length === 0 && parseStepstoneHtml('<html><body>nope</body></html>').length === 0
  ? pass('empty or non-listing HTML yields zero jobs without throwing')
  : fail('non-listing HTML mishandled');
