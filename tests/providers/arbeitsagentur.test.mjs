// tests/providers/arbeitsagentur.test.mjs — moved verbatim from test-all.mjs (#1440).
// Fixtures follow the v6 search shape (#2494): the response list is
// `ergebnisliste`, and a posting carries `referenznummer` /
// `stellenangebotsTitel` / `firma` / `stellenlokationen[]`.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — arbeitsagentur');

/** One posting in the v6 search shape. */
const v6 = (referenznummer, stellenangebotsTitel, ort, extra = {}) => ({
  referenznummer,
  stellenangebotsTitel,
  firma: 'Co',
  stellenlokationen: [{ adresse: { ort, region: 'BERLIN', land: 'DEUTSCHLAND' } }],
  ...extra,
});

/** A v6 search response. */
const page = (...jobs) => ({ ergebnisliste: jobs });

try {
  const arbeitsagenturModule = await import(pathToFileURL(join(ROOT, 'providers/arbeitsagentur.mjs')).href);
  const aa = arbeitsagenturModule.default;
  const { parseArbeitsagenturConfig, buildLocation, normalizeJob, describeJob, buildDetailId, fetchDetailDescription } = arbeitsagenturModule;

  if (aa.id === 'arbeitsagentur') pass('arbeitsagentur.id is "arbeitsagentur"');
  else fail(`arbeitsagentur.id is ${JSON.stringify(aa.id)}`);

  // parseArbeitsagenturConfig — defaults when block is absent
  const def = parseArbeitsagenturConfig({});
  if (def.keywords.length === 0 && def.wo === '' && def.umkreis === 50 && def.days === 30 && def.size === 100 && def.remoteNationwide === false) {
    pass('parseArbeitsagenturConfig applies defaults (umkreis 50, days 30, size 100)');
  } else {
    fail(`parseArbeitsagenturConfig defaults = ${JSON.stringify(def)}`);
  }

  // parseArbeitsagenturConfig — sanitizes keywords and clamps numbers
  const cfg = parseArbeitsagenturConfig({
    arbeitsagentur: { keywords: ['  ML Engineer  ', '', 7, 'NLP'], wo: ' Berlin ', umkreis: 999999, size: 0, days: -3, remoteNationwide: 'yes' },
  });
  if (cfg.keywords.length === 2 && cfg.keywords[0] === 'ML Engineer' && cfg.keywords[1] === 'NLP') {
    pass('parseArbeitsagenturConfig trims keywords and drops empty/non-string entries');
  } else {
    fail(`parseArbeitsagenturConfig keywords = ${JSON.stringify(cfg.keywords)}`);
  }
  if (cfg.wo === 'Berlin' && cfg.umkreis === 1000 && cfg.size === 1 && cfg.days === 1 && cfg.remoteNationwide === false) {
    pass('parseArbeitsagenturConfig clamps umkreis/size/days and treats non-true remoteNationwide as false');
  } else {
    fail(`parseArbeitsagenturConfig sanitized = ${JSON.stringify(cfg)}`);
  }

  // buildLocation — reads the first entry of the v6 `stellenlokationen` array.
  // v6's `region` is an uppercase federal-state enum (BADEN_WUERTTEMBERG), not a
  // display name, so it is deliberately dropped rather than joined onto the city.
  if (buildLocation([{ adresse: { ort: 'Berlin', region: 'BERLIN', land: 'DEUTSCHLAND' } }]) === 'Berlin') {
    pass('buildLocation takes the city and omits Germany and the region enum');
  } else {
    fail(`buildLocation DE = ${JSON.stringify(buildLocation([{ adresse: { ort: 'Berlin', region: 'BERLIN', land: 'DEUTSCHLAND' } }]))}`);
  }
  if (buildLocation([{ adresse: { ort: 'Wien', land: 'OESTERREICH' } }]) === 'Wien, OESTERREICH') {
    pass('buildLocation appends a non-German country');
  } else {
    fail(`buildLocation non-DE = ${JSON.stringify(buildLocation([{ adresse: { ort: 'Wien', land: 'OESTERREICH' } }]))}`);
  }
  // 11% of a sampled page carried more than one location; the downstream shape is
  // a single string, so the first is used — matching v4's single `arbeitsort`.
  if (buildLocation([{ adresse: { ort: 'Hamburg', land: 'DEUTSCHLAND' } }, { adresse: { ort: 'Bremen' } }]) === 'Hamburg') {
    pass('buildLocation uses the first of several locations');
  } else {
    fail(`buildLocation multi = ${JSON.stringify(buildLocation([{ adresse: { ort: 'Hamburg' } }, { adresse: { ort: 'Bremen' } }]))}`);
  }
  if (buildLocation(null) === '' && buildLocation('x') === '' && buildLocation([]) === '' && buildLocation([{}]) === '') {
    pass('buildLocation returns "" for missing/garbage input');
  } else {
    fail('buildLocation should return "" for missing/garbage input');
  }

  // normalizeJob — happy path encodes the reference number into the detail URL
  const norm = normalizeJob(v6('10000-123/4 X', '  ML Engineer  ', 'Berlin', { firma: ' ACME ' }));
  if (norm && norm.title === 'ML Engineer' && norm.company === 'ACME'
      && norm.url === 'https://www.arbeitsagentur.de/jobsuche/jobdetail/' + encodeURIComponent('10000-123/4 X')
      && norm.refnr === '10000-123/4 X') {
    pass('normalizeJob trims fields and URL-encodes the reference number');
  } else {
    fail(`normalizeJob = ${JSON.stringify(norm)}`);
  }
  if (normalizeJob({ stellenangebotsTitel: 'No refnr' }) === null && normalizeJob({ referenznummer: 'x', stellenangebotsTitel: '' }) === null) {
    pass('normalizeJob returns null without a reference number or title');
  } else {
    fail('normalizeJob should return null when the reference number or title is missing');
  }

  // fetch() — nationwide single-keyword pass, dedup across keywords, header sent
  let sentApiKey = null;
  let sentUrl = null;
  const mkCtx = (byWas) => ({
    fetchJson: async (url, opts) => {
      sentApiKey = opts?.headers?.['X-API-Key'] ?? sentApiKey;
      sentUrl = url;
      const was = new URL(url).searchParams.get('was');
      return page(...(byWas[was] || []));
    },
  });
  const fetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML', 'NLP'] } },
    mkCtx({
      ML: [v6('A', 'ML Engineer', 'Berlin')],
      NLP: [
        v6('A', 'ML Engineer', 'Berlin'), // dup reference number
        v6('B', 'NLP Scientist', 'Köln'),
      ],
    }),
  );
  if (fetched.length === 2 && !('refnr' in fetched[0])) pass('aa.fetch() dedups by reference number and strips it from output');
  else fail(`aa.fetch() returned ${JSON.stringify(fetched)}`);
  if (sentApiKey === 'jobboerse-jobsuche') pass('aa.fetch() sends the X-API-Key header');
  else fail(`aa.fetch() X-API-Key = ${JSON.stringify(sentApiKey)}`);
  // The v4 path is gone (404 as of 2026-08-04, #2494); pin the version so a
  // silent revert can't reintroduce a dead endpoint.
  if (sentUrl && sentUrl.includes('/pc/v6/jobs')) pass('aa.fetch() queries the v6 jobs endpoint');
  else fail(`aa.fetch() endpoint = ${JSON.stringify(sentUrl)}`);

  // fetch() — remoteNationwide pass keeps only remote-titled wide hits
  let calls = 0;
  const remoteFetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true } },
    {
      fetchJson: async (url) => {
        calls++;
        const hasWo = new URL(url).searchParams.has('wo');
        // Pass A (wo set) → local hit; Pass B (no wo) → one remote-titled, one not.
        return hasWo
          ? page(v6('L', 'ML Engineer', 'Berlin'))
          : page(v6('R', 'ML Engineer (Remote)', 'Hamburg'), v6('X', 'Onsite ML Engineer', 'Hamburg'));
      },
    },
  );
  if (calls === 2 && remoteFetched.some(j => j.url.endsWith('R')) && !remoteFetched.some(j => j.url.endsWith('X'))) {
    pass('aa.fetch() remoteNationwide keeps remote-titled wide hits and drops onsite ones');
  } else {
    fail(`aa.fetch() remoteNationwide = ${calls} calls, ${JSON.stringify(remoteFetched.map(j => j.url))}`);
  }

  // parseArbeitsagenturConfig — remoteMatch mode + remoteMaxPages (config-driven remote detection)
  const rcfg = parseArbeitsagenturConfig({ arbeitsagentur: { keywords: ['ML'], remoteMatch: 'filter', remoteMaxPages: 50 } });
  if (rcfg.remoteMatch === 'filter' && rcfg.remoteMaxPages === 20) {
    pass('parseArbeitsagenturConfig parses remoteMatch and clamps remoteMaxPages');
  } else {
    fail(`parseArbeitsagenturConfig remoteMatch/maxPages = ${JSON.stringify({ m: rcfg.remoteMatch, p: rcfg.remoteMaxPages })}`);
  }
  const rdef = parseArbeitsagenturConfig({ arbeitsagentur: { keywords: ['ML'], remoteMatch: 'bogus' } });
  if (rdef.remoteMatch === 'title' && rdef.remoteMaxPages === 1) {
    pass('parseArbeitsagenturConfig defaults remoteMatch to "title" and remoteMaxPages to 1');
  } else {
    fail(`parseArbeitsagenturConfig remote defaults = ${JSON.stringify({ m: rdef.remoteMatch, p: rdef.remoteMaxPages })}`);
  }

  // fetch() — remoteMatch:'filter' narrows server-side with homeoffice=nv_true and
  // paginates, but still requires the posting's own title to claim remote before
  // tagging it. v6 exposes only a boolean `homeofficemoeglich`, which is exactly
  // what nv_true already filtered on, so it cannot separate a fully-remote role
  // from an office-anchored hybrid (#2494). Tagging on nv_true alone would smuggle
  // hybrids past the commute filter, so unproven candidates keep their real city.
  let usedHomeoffice = false;
  const pagesSeen = new Set();
  const filterFetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true, remoteMatch: 'filter', remoteMaxPages: 5, size: 2 } },
    {
      fetchJson: async (url) => {
        const sp = new URL(url).searchParams;
        if (sp.has('wo')) return page(v6('L', 'ML Engineer', 'Berlin'));
        usedHomeoffice = usedHomeoffice || sp.get('homeoffice') === 'nv_true';
        pagesSeen.add(sp.get('page'));
        return Number(sp.get('page')) === 1
          ? page( // full page (== size) → pagination continues
              v6('R1', 'ML Engineer — 100% Remote', 'München', { homeofficemoeglich: true }),
              v6('R2', 'ML Scientist', 'Stuttgart', { homeofficemoeglich: true }),
            )
          : page(v6('R3', 'NLP Engineer (Homeoffice)', 'Köln', { homeofficemoeglich: true })); // short → stop
      },
    },
  );
  const munich = filterFetched.find(j => j.url.endsWith('R1'));
  const stuttgart = filterFetched.find(j => j.url.endsWith('R2'));
  const koeln = filterFetched.find(j => j.url.endsWith('R3'));
  const TAG = /Deutschlandweit \(Homeoffice\)/;
  if (usedHomeoffice && pagesSeen.has('1') && pagesSeen.has('2') && munich && TAG.test(munich.location)) {
    pass('aa.fetch() remoteMatch:filter sends homeoffice=nv_true, paginates, and tags titles that claim remote');
  } else {
    fail(`aa.fetch() filter mode = ${JSON.stringify({ usedHomeoffice, pages: [...pagesSeen], munichLoc: munich?.location })}`);
  }
  if (stuttgart && !TAG.test(stuttgart.location) && stuttgart.location === 'Stuttgart') {
    pass('aa.fetch() leaves a nv_true hit untagged when its title does not claim remote (hybrid stays commute-filtered)');
  } else {
    fail(`aa.fetch() unproven nv_true hit = ${JSON.stringify({ loc: stuttgart?.location })}`);
  }
  if (koeln && TAG.test(koeln.location)) {
    pass('aa.fetch() tags remote-titled hits found on later pages');
  } else {
    fail(`aa.fetch() later-page remote hit = ${JSON.stringify({ loc: koeln?.location })}`);
  }
  // The boolean must never be treated as proof on its own: every fixture above
  // carries homeofficemoeglich:true, and R2 still has to stay untagged.
  if (stuttgart && stuttgart.location === 'Stuttgart') {
    pass('aa.fetch() never tags on homeofficemoeglich alone');
  } else {
    fail(`aa.fetch() tagged on the boolean alone: ${JSON.stringify({ loc: stuttgart?.location })}`);
  }

  // fetch() — a duplicate reference number across pagination pages is kept once.
  const wideRefs = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];
  const batchFetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true, remoteMatch: 'filter', remoteMaxPages: 5, size: 7 } },
    {
      fetchJson: async (url) => {
        const sp = new URL(url).searchParams;
        if (sp.has('wo')) return page();
        // Page 1 is full (== size) so pagination continues; W1 repeats on page 2.
        return Number(sp.get('page')) === 1
          ? page(...wideRefs.map(r => v6(r, 'ML Engineer (Remote)', 'München')))
          : page(v6('W1', 'ML Engineer (Remote)', 'München'));
      },
    },
  );
  if (batchFetched.length === wideRefs.length && batchFetched.every(j => TAG.test(j.location))) {
    pass('aa.fetch() keeps each duplicated reference number once and tags every proven candidate');
  } else {
    fail(`aa.fetch() paginated tagging = ${JSON.stringify(batchFetched.map(j => j.location))}`);
  }

  // fetch() — no keywords throws; total outage throws (not silent)
  let noKw = false;
  try { await aa.fetch({ name: 'AA', arbeitsagentur: {} }, mkCtx({})); } catch { noKw = true; }
  if (noKw) pass('aa.fetch() throws when no keywords are configured');
  else fail('aa.fetch() should throw without keywords');

  let outage = false;
  try {
    await aa.fetch({ name: 'AA', arbeitsagentur: { keywords: ['ML'] } }, { fetchJson: async () => { throw new Error('HTTP 503'); } });
  } catch { outage = true; }
  if (outage) pass('aa.fetch() throws when every keyword request fails (no silent empty)');
  else fail('aa.fetch() should throw on total outage');

  // fetch() — one keyword answers (empty) while another fails → NOT a total
  // outage; partial success must not throw.
  let partialThrew = false;
  let partial;
  try {
    partial = await aa.fetch(
      { name: 'AA', arbeitsagentur: { keywords: ['OK', 'BAD'] } },
      { fetchJson: async (url) => {
          if (new URL(url).searchParams.get('was') === 'BAD') throw new Error('HTTP 503');
          return page(); // OK answers, just empty
        } },
    );
  } catch { partialThrew = true; }
  if (!partialThrew && Array.isArray(partial) && partial.length === 0) {
    pass('aa.fetch() does not throw when one keyword succeeds empty and another fails');
  } else {
    fail(`aa.fetch() partial-success threw=${partialThrew}, result=${JSON.stringify(partial)}`);
  }

  // fetch() — Pass A succeeds with jobs, optional Pass B fails → Pass A jobs kept.
  const passBFail = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true } },
    { fetchJson: async (url) => {
        // Pass A (wo set) returns a job; Pass B (no wo) throws.
        if (new URL(url).searchParams.has('wo')) return page(v6('L', 'ML Engineer', 'Berlin'));
        throw new Error('HTTP 503');
      } },
  );
  if (passBFail.length === 1 && passBFail[0].url.endsWith('L')) {
    pass('aa.fetch() preserves primary (Pass A) results when the remote pass (Pass B) fails');
  } else {
    fail(`aa.fetch() Pass B failure dropped primary: ${JSON.stringify(passBFail)}`);
  }

  // ============================================================================
  // FINDING 1/2 (#2637): the search response's extra free fields (externeURL,
  // arbeitszeitVollzeit, homeofficemoeglich, verguetungsangabe, vertragsdauer,
  // istGeringfuegigeBeschaeftigung) folded into description, plus the opt-in
  // v4 detail fetch. See providers/arbeitsagentur.mjs describeJob()/
  // fetchDetailDescription() for the reasoning.
  // ============================================================================

  // A raw v6 search hit carrying every field FINDING 1 says is free.
  const rawFull = {
    referenznummer: '11949-17338293-S',
    stellenangebotsTitel: 'Data Scientist',
    firma: 'Xchannels.ai FlexCo',
    stellenlokationen: [{ adresse: { ort: 'Wien,Landstraße', land: 'OESTERREICH' } }],
    arbeitszeitVollzeit: true,
    homeofficemoeglich: true,
    verguetungsangabe: 'AT_GEHALT',
    vertragsdauer: 'UNBEFRISTET',
    istGeringfuegigeBeschaeftigung: true,
    externeURL: 'https://jobs.example.com/public/emps/jobs/abc-123',
    alleBerufe: ['Data Scientist'],
  };

  // ---- describeJob: the free-text fold (no first-class Job field for these) ----
  const fullDesc = describeJob(rawFull);
  if (fullDesc === 'Vollzeit · Homeoffice möglich · Vertrag: UNBEFRISTET · Vergütung: AT_GEHALT · Geringfügige Beschäftigung · Extern: https://jobs.example.com/public/emps/jobs/abc-123') {
    pass('describeJob() folds all six facts in order, separated by " · "');
  } else {
    fail(`describeJob() full fold wrong: ${JSON.stringify(fullDesc)}`);
  }

  const noInfoDesc = describeJob({ ...rawFull, verguetungsangabe: 'KEINE_ANGABEN' });
  if (!noInfoDesc.includes('Vergütung')) pass('describeJob() drops verguetungsangabe when it is the "no information" sentinel (KEINE_ANGABEN)');
  else fail(`describeJob() should have dropped Vergütung: ${JSON.stringify(noInfoDesc)}`);

  const emptyDesc = describeJob({ referenznummer: 'x', stellenangebotsTitel: 'y' });
  if (emptyDesc === '') pass('describeJob() returns "" when none of the optional facts are present');
  else fail(`describeJob() should be empty for a bare posting: ${JSON.stringify(emptyDesc)}`);

  if (describeJob(null) === '' && describeJob(undefined) === '' && describeJob('nope') === '') {
    pass('describeJob() tolerates non-object input without throwing');
  } else {
    fail('describeJob() should return "" for null/undefined/non-object input');
  }

  // A false flag is not "no information" — it just isn't worth printing
  // (most postings aren't home-office; a wall of "Homeoffice: nein" would be noise).
  const falseFlagsDesc = describeJob({ ...rawFull, arbeitszeitVollzeit: false, homeofficemoeglich: false, istGeringfuegigeBeschaeftigung: false, vertragsdauer: '', externeURL: '' });
  if (falseFlagsDesc === 'Vergütung: AT_GEHALT') pass('describeJob() omits false/absent boolean and empty-string facts, keeping only real signal');
  else fail(`describeJob() should have kept only Vergütung: ${JSON.stringify(falseFlagsDesc)}`);

  // ---- normalizeJob: the new fields survive into description; url/dedup key unchanged ----
  const jobWithFacts = normalizeJob(rawFull);
  if (jobWithFacts && jobWithFacts.description === fullDesc) pass('normalizeJob() carries describeJob()\'s fold into job.description');
  else fail(`normalizeJob() description wrong: ${JSON.stringify(jobWithFacts && jobWithFacts.description)}`);
  if (jobWithFacts && jobWithFacts.url === 'https://www.arbeitsagentur.de/jobsuche/jobdetail/11949-17338293-S') {
    pass('normalizeJob() keeps the arbeitsagentur.de detail page as job.url (the dedup key), not externeURL');
  } else {
    fail(`normalizeJob() url wrong: ${JSON.stringify(jobWithFacts && jobWithFacts.url)}`);
  }

  // A posting missing all the FINDING 1 fields must not break — same as before this change.
  const bareJob = normalizeJob({ referenznummer: '999', stellenangebotsTitel: 'Bare Posting' });
  if (bareJob && bareJob.description === '' && bareJob.title === 'Bare Posting') {
    pass('normalizeJob() on a posting missing the optional fields still returns a valid job with description ""');
  } else {
    fail(`normalizeJob() should tolerate a bare posting: ${JSON.stringify(bareJob)}`);
  }

  // ---- buildDetailId: base64(refnr), verified against a live refnr/id pair ----
  if (buildDetailId('11949-17338293-S') === 'MTE5NDktMTczMzgyOTMtUw==') {
    pass('buildDetailId() matches the live-verified base64(refnr) id scheme');
  } else {
    fail(`buildDetailId() wrong: ${buildDetailId('11949-17338293-S')}`);
  }

  // ---- fetchDetailDescription: success, non-string body, and failure all degrade to '' ----
  const okCtx = { fetchJson: async (url) => {
    // encodeURIComponent() percent-encodes the base64 id's "=" padding, so match
    // on the un-padded portion rather than the raw buildDetailId() output.
    if (!url.includes('MTE5NDktMTczMzgyOTMtUw')) throw new Error(`unexpected id in url: ${url}`);
    return { stellenangebotsBeschreibung: '  Full JD text.  ' };
  } };
  const okText = await fetchDetailDescription('11949-17338293-S', okCtx);
  if (okText === 'Full JD text.') pass('fetchDetailDescription() returns the trimmed stellenangebotsBeschreibung on success');
  else fail(`fetchDetailDescription() success case wrong: ${JSON.stringify(okText)}`);

  const missingFieldCtx = { fetchJson: async () => ({ someOtherField: true }) };
  const missingText = await fetchDetailDescription('x', missingFieldCtx);
  if (missingText === '') pass('fetchDetailDescription() returns "" when stellenangebotsBeschreibung is absent/non-string');
  else fail(`fetchDetailDescription() should be "" without the field: ${JSON.stringify(missingText)}`);

  const failCtx = { fetchJson: async () => { const e = new Error('403 Forbidden'); throw e; } };
  const failText = await fetchDetailDescription('x', failCtx);
  if (failText === '') pass('fetchDetailDescription() swallows a fetch failure (e.g. v6-style 403) and returns ""');
  else fail(`fetchDetailDescription() should degrade to "" on failure: ${JSON.stringify(failText)}`);

  // ---- parseArbeitsagenturConfig: fetchDetails/maxDetailFetches default off, clamped ----
  const detailDefaultCfg = parseArbeitsagenturConfig({ arbeitsagentur: { keywords: ['x'] } });
  if (detailDefaultCfg.fetchDetails === false && detailDefaultCfg.maxDetailFetches === 20) {
    pass('parseArbeitsagenturConfig() defaults fetchDetails to false and maxDetailFetches to 20');
  } else {
    fail(`parseArbeitsagenturConfig() detail defaults wrong: ${JSON.stringify({ fetchDetails: detailDefaultCfg.fetchDetails, maxDetailFetches: detailDefaultCfg.maxDetailFetches })}`);
  }
  const enabledCfg = parseArbeitsagenturConfig({ arbeitsagentur: { keywords: ['x'], fetchDetails: true, maxDetailFetches: 500 } });
  if (enabledCfg.fetchDetails === true && enabledCfg.maxDetailFetches === 100) {
    pass('parseArbeitsagenturConfig() honors fetchDetails:true and clamps maxDetailFetches to the hard cap (100)');
  } else {
    fail(`parseArbeitsagenturConfig() clamp wrong: ${JSON.stringify({ fetchDetails: enabledCfg.fetchDetails, maxDetailFetches: enabledCfg.maxDetailFetches })}`);
  }
  // A truthy-but-not-strictly-true value must not silently enable a per-posting request fan-out.
  const stringyCfg = parseArbeitsagenturConfig({ arbeitsagentur: { keywords: ['x'], fetchDetails: 'true' } });
  if (stringyCfg.fetchDetails === false) pass('parseArbeitsagenturConfig() requires fetchDetails === true (boolean), not a truthy string');
  else fail(`parseArbeitsagenturConfig() should reject a non-boolean fetchDetails: ${JSON.stringify(stringyCfg.fetchDetails)}`);

  // ---- fetch(): the opt-in detail fetch is bounded by maxDetailFetches, off by default ----
  const rawHit = (n) => ({
    referenznummer: `REF-${n}`,
    stellenangebotsTitel: `Job ${n}`,
    firma: 'Test GmbH',
    stellenlokationen: [{ adresse: { ort: 'Berlin', land: 'DEUTSCHLAND' } }],
  });

  // Default (fetchDetails absent) must never touch the v4 detail endpoint.
  let detailCallsOff = 0;
  const offCtx = {
    fetchJson: async (url) => {
      if (url.includes('/v4/jobdetails/')) detailCallsOff++;
      return { ergebnisliste: [rawHit(1), rawHit(2), rawHit(3)] };
    },
    sleep: async () => {},
  };
  const offJobs = await aa.fetch({ name: 'Test Portal', arbeitsagentur: { keywords: ['Data Scientist'] } }, offCtx);
  if (offJobs.length === 3 && detailCallsOff === 0) {
    pass('fetch() never calls the v4 detail endpoint when fetchDetails is not set (default off)');
  } else {
    fail(`fetch() default-off wrong: ${offJobs.length} jobs, ${detailCallsOff} detail calls`);
  }

  // fetchDetails:true with maxDetailFetches:2 over 3 deduped jobs: capped at 2 detail
  // requests and 1 sleep (limit - 1), regardless of the 3 jobs available.
  let detailCallsOn = 0;
  let sleepCalls = 0;
  const onCtx = {
    fetchJson: async (url) => {
      if (url.includes('/v4/jobdetails/')) {
        detailCallsOn++;
        return { stellenangebotsBeschreibung: `Detail body #${detailCallsOn}` };
      }
      return { ergebnisliste: [rawHit(1), rawHit(2), rawHit(3)] };
    },
    sleep: async () => { sleepCalls++; },
  };
  const onJobs = await aa.fetch({ name: 'Test Portal', arbeitsagentur: { keywords: ['Data Scientist'], fetchDetails: true, maxDetailFetches: 2 } }, onCtx);
  if (detailCallsOn === 2) pass('fetch() caps v4 detail requests at maxDetailFetches even though more postings are available');
  else fail(`fetch() detail cap wrong: expected 2 detail calls, got ${detailCallsOn}`);
  if (sleepCalls === 1) pass('fetch() paces detail requests with one sleep between calls, none after the last');
  else fail(`fetch() sleep pacing wrong: expected 1 sleep call, got ${sleepCalls}`);
  const withDetail = onJobs.filter(j => j.description && j.description.startsWith('Detail body'));
  const withoutDetail = onJobs.filter(j => !j.description);
  if (withDetail.length === 2 && withoutDetail.length === 1) {
    pass('fetch() attaches the fetched detail body only to the postings within the cap, leaving the rest untouched');
  } else {
    fail(`fetch() detail attachment wrong: ${JSON.stringify(onJobs.map(j => j.description))}`);
  }

  // A detail-fetch failure (e.g. a v6-shaped 403 on some tenant) must not drop the posting.
  let failingDetailCalls = 0;
  const failingDetailCtx = {
    fetchJson: async (url) => {
      if (url.includes('/v4/jobdetails/')) { failingDetailCalls++; throw new Error('403 Forbidden'); }
      return { ergebnisliste: [rawHit(1)] };
    },
    sleep: async () => {},
  };
  const survivedJobs = await aa.fetch({ name: 'Test Portal', arbeitsagentur: { keywords: ['Data Scientist'], fetchDetails: true, maxDetailFetches: 5 } }, failingDetailCtx);
  if (survivedJobs.length === 1 && failingDetailCalls === 1 && survivedJobs[0].description === '') {
    pass('fetch() survives a detail-fetch failure — the posting stays, just without the extra body');
  } else {
    fail(`fetch() should tolerate a detail-fetch failure: ${JSON.stringify(survivedJobs)}`);
  }

} catch (e) {
  fail(`arbeitsagentur provider tests crashed: ${e.message}`);
}
