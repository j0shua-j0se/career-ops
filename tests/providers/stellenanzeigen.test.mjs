// tests/providers/stellenanzeigen.test.mjs
//
// The card fixtures below are trimmed from a real 2026-08-19 response, keeping
// the attributes the parser actually reads and the styled-components class
// hashes beside them — so a rewrite that changes only the hashes stays green,
// which is the whole reason the parser matches on data-* attributes.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — stellenanzeigen');

const card = (id, href, title, company, location) =>
  `<div data-jobid="${id}" class="sc-f285d297-16 ZfYLm">` +
  `<a data-testid="qa-hitzone" class="sc-1b2c3d4-0 kQwEr" href="${href}" title="${title}">` +
  `<h3 class="sc-9a8b7c6-2 pLmNo">${title.slice(0, 12)}&hellip;</h3></a>` +
  `<div data-testid="company-name" class="sc-11aa22bb-3 xYzAb">${company}</div>` +
  `<div class="sc-33cc44dd-4 mNbVc">${location}</div>` +
  `<div class="sc-55ee66ff-5 qWeRt">Vollzeit</div></div>`;

const page = (...cards) =>
  `<html><body><main><div class="results">${cards.join('')}</div></main></body></html>`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/stellenanzeigen.mjs')).href);
  const sa = mod.default;
  const { splitCards, parseCard, searchUrl } = mod;

  if (sa.id === 'stellenanzeigen') pass('stellenanzeigen.id is "stellenanzeigen"');
  else fail(`stellenanzeigen.id is ${JSON.stringify(sa.id)}`);

  // ── searchUrl ───────────────────────────────────────────────────────────
  // The pagination parameter is pinned because getting it wrong FAILS SILENTLY:
  // `seite=2`, `p=2` and `offset=2` are all accepted by the URL and all return
  // page one byte-identically. The fetch loop stops when a page adds nothing
  // new, so a wrong name caps the board at 25 results and looks like a small
  // board rather than a bug. Verified against the live site 2026-08-19.
  const p1 = new URL(searchUrl('Werkstudent Data'));
  if (p1.searchParams.get('fulltext') === 'Werkstudent Data') {
    pass('searchUrl puts the keyword in fulltext');
  } else {
    fail(`searchUrl fulltext = ${JSON.stringify(p1.searchParams.get('fulltext'))}`);
  }
  if (!p1.searchParams.has('page')) {
    pass('searchUrl omits the page parameter for page 1');
  } else {
    fail(`searchUrl page 1 carried page=${p1.searchParams.get('page')}`);
  }

  const p2 = new URL(searchUrl('Werkstudent Data', { page: 2 }));
  if (p2.searchParams.get('page') === '2') {
    pass('searchUrl paginates with `page` (not `seite`/`p`/`offset`, which silently return page 1)');
  } else {
    fail(`searchUrl page 2 = ${p2.search}`);
  }
  if (!['seite', 'p', 'offset'].some((k) => p2.searchParams.has(k))) {
    pass('searchUrl uses no known-inert pagination alias');
  } else {
    fail(`searchUrl page 2 carried an inert alias: ${p2.search}`);
  }
  if (p2.origin === 'https://www.stellenanzeigen.de' && p2.pathname === '/suche/') {
    pass('searchUrl targets /suche/, the path robots.txt permits for `*`');
  } else {
    fail(`searchUrl target = ${p2.origin}${p2.pathname}`);
  }

  // ── splitCards ──────────────────────────────────────────────────────────
  const html = page(
    card('111', '/job/111/werkstudent-data', 'Werkstudent Data Engineering (m/w/d)', 'Thomas Magnete GmbH', 'Herdorf'),
    card('222', '/job/222/data-scientist', 'Data Scientist &amp; Analyst', 'ACME &amp; Co. KG', 'Hamburg'),
  );
  const cards = splitCards(html);
  if (cards.length === 2) pass('splitCards finds one chunk per data-jobid');
  else fail(`splitCards returned ${cards.length} chunks`);

  if (splitCards('<html><body>no jobs here</body></html>').length === 0) {
    pass('splitCards returns nothing when the page has no cards');
  } else {
    fail('splitCards invented a card on a card-free page');
  }

  // ── parseCard ───────────────────────────────────────────────────────────
  const first = parseCard(cards[0]);
  if (first && first.title === 'Werkstudent Data Engineering (m/w/d)') {
    pass('parseCard reads the untruncated title from the hitzone anchor');
  } else {
    fail(`parseCard title = ${JSON.stringify(first && first.title)}`);
  }
  if (first && first.url === 'https://www.stellenanzeigen.de/job/111/werkstudent-data') {
    pass('parseCard absolutises the relative href');
  } else {
    fail(`parseCard url = ${JSON.stringify(first && first.url)}`);
  }
  if (first && first.company === 'Thomas Magnete GmbH') pass('parseCard reads the company from data-testid');
  else fail(`parseCard company = ${JSON.stringify(first && first.company)}`);
  if (first && first.location === 'Herdorf') pass('parseCard takes the location as the first text node after the company');
  else fail(`parseCard location = ${JSON.stringify(first && first.location)}`);
  if (first && first.ref === '111') pass('parseCard keeps the data-jobid as ref');
  else fail(`parseCard ref = ${JSON.stringify(first && first.ref)}`);

  // Entities: the board writes &amp; in both titles and company names, and a
  // literal "&amp;" reaching a CV or a tracker row is visible to a recruiter.
  const second = parseCard(cards[1]);
  if (second && second.title === 'Data Scientist & Analyst' && second.company === 'ACME & Co. KG') {
    pass('parseCard decodes HTML entities in title and company');
  } else {
    fail(`parseCard entities = ${JSON.stringify(second && { t: second.title, c: second.company })}`);
  }

  // A card with no anchor is markup drift, not a job — dropping it beats
  // emitting a row with an empty URL that later fails a liveness check.
  const noAnchor = parseCard('999" class="x"><div data-testid="company-name">Ghost GmbH</div></div>');
  if (noAnchor === null) pass('parseCard returns null when the hitzone anchor is missing');
  else fail(`parseCard on anchor-less card = ${JSON.stringify(noAnchor)}`);

  // ── detect ──────────────────────────────────────────────────────────────
  if (sa.detect({ careers_url: 'https://www.stellenanzeigen.de' })) {
    pass('detect matches www.stellenanzeigen.de');
  } else {
    fail('detect missed www.stellenanzeigen.de');
  }
  if (sa.detect({ careers_url: 'https://stellenanzeigen.de/suche/' })) {
    pass('detect matches the apex domain');
  } else {
    fail('detect missed the apex domain');
  }
  if (sa.detect({ careers_url: 'https://boards.greenhouse.io/acme' }) === null) {
    pass('detect ignores other hosts');
  } else {
    fail('detect claimed a non-stellenanzeigen host');
  }
  // Suffix matching must be on a dot boundary: an attacker-controlled
  // "notstellenanzeigen.de" is a different registrable domain.
  if (sa.detect({ careers_url: 'https://notstellenanzeigen.de' }) === null) {
    pass('detect does not match a host merely ending in the name');
  } else {
    fail('detect matched notstellenanzeigen.de');
  }
  if (sa.detect({ careers_url: 'ftp://www.stellenanzeigen.de' }) === null) {
    pass('detect rejects non-http(s) schemes');
  } else {
    fail('detect accepted an ftp URL');
  }
  if (sa.detect({ careers_url: 'not a url' }) === null) pass('detect tolerates an unparseable URL');
  else fail('detect accepted garbage');

  // ── fetch ───────────────────────────────────────────────────────────────
  // A board with no keywords cannot be queried at all — there is no
  // company-scoped listing to fall back to — so it must fail loudly rather
  // than return zero jobs and read as "nothing new today".
  let threw = false;
  try {
    await sa.fetch({ name: 'x', careers_url: 'https://www.stellenanzeigen.de' }, { fetchText: async () => '' });
  } catch {
    threw = true;
  }
  if (threw) pass('fetch throws when no keywords are configured');
  else fail('fetch silently returned for a keyword-less entry');

  const requested = [];
  const jobs = await sa.fetch(
    {
      name: 'x',
      careers_url: 'https://www.stellenanzeigen.de',
      stellenanzeigen: { keywords: ['Werkstudent Data'], pages: 3 },
    },
    {
      fetchText: async (url) => {
        requested.push(url);
        // Page 2 repeats page 1, which is what the board does past the end of
        // the result set.
        return new URL(url).searchParams.get('page') === '2' ? html : html;
      },
    },
  );
  if (jobs.length === 2) pass('fetch dedups by URL across pages');
  else fail(`fetch returned ${jobs.length} jobs`);
  if (requested.length === 2) {
    pass('fetch stops paging as soon as a page contributes nothing new');
  } else {
    fail(`fetch made ${requested.length} requests: ${JSON.stringify(requested)}`);
  }
  if (jobs[0] && jobs[0].title && jobs[0].url && jobs[0].company) {
    pass('fetch emits the Job shape (title/url/company/location)');
  } else {
    fail(`fetch job shape = ${JSON.stringify(jobs[0])}`);
  }

  // One bad keyword must not take the board down with it.
  const partial = await sa.fetch(
    {
      name: 'x',
      careers_url: 'https://www.stellenanzeigen.de',
      stellenanzeigen: { keywords: ['boom', 'Werkstudent Data'] },
    },
    {
      fetchText: async (url) => {
        if (new URL(url).searchParams.get('fulltext') === 'boom') throw new Error('network');
        return html;
      },
    },
  );
  if (partial.length === 2) pass('fetch survives a failing keyword and keeps the rest');
  else fail(`fetch after a failing keyword returned ${partial.length}`);
} catch (err) {
  fail(`stellenanzeigen provider threw: ${err.message}`);
}
