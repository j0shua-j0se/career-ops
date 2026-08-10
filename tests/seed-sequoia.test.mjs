// tests/seed-sequoia.test.mjs — the Sequoia (Consider) seed rung.
//
// This rung differs from its three siblings in a way worth pinning: the board
// renders client-side, so there is no HTML to parse and the parser consumes a
// JSON API response instead. A GET of jobs.sequoiacap.com returns a 20 KB
// spinner shell — an HTML parser modelled on the Index rung would have returned
// zero companies forever and looked like a working integration.
//
// The rung's actual value is `jobSources`: Consider names each company's ATS
// vendor outright. Without it, toPortalEntry guesses Greenhouse for everyone,
// which silently mis-resolves every company on Ashby or Lever — 83 of the 254
// on this board at the time of writing. So the vendor mapping is the thing most
// worth protecting here, and most of these assertions are about it.
//
// All fixtures are inline. No network.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - Sequoia seed rung (seeds/vc-portfolios.mjs)');

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Shaped exactly like a real /api-boards/search-companies response. */
const FIXTURE = {
  total: 6,
  meta: { size: 25, sequence: 'Y3Vyc29yLTE=' },
  companies: [
    {
      name: 'Gong',
      slug: 'gong',
      domain: 'gong.io',
      website: { url: 'https://gong.io/', label: 'gong.io' },
      jobSources: [{ id: 'greenhouse', label: 'Greenhouse', value: 'greenhouse', count: 102 }],
    },
    {
      name: 'Harvey',
      slug: 'harvey',
      domain: 'harvey.ai',
      website: { url: 'https://harvey.ai/', label: 'harvey.ai' },
      jobSources: [{ id: 'ashbyhq', label: 'Ashby', value: 'ashbyhq', count: 373 }],
    },
    {
      name: 'Leverly',
      slug: 'leverly',
      domain: 'leverly.example',
      website: { url: 'https://leverly.example/', label: 'leverly.example' },
      jobSources: [{ id: 'lever', label: 'Lever', value: 'lever', count: 24 }],
    },
    {
      // Vendor career-ops has no provider for: must NOT get an ats hint.
      name: 'Cyera',
      slug: 'cyera',
      domain: 'cyera.io',
      website: { url: 'https://cyera.io/', label: 'cyera.io' },
      jobSources: [{ id: 'comeet', label: 'Comeet', value: 'comeet', count: 140 }],
    },
    {
      // No website object at all — the domain is the only source of a URL.
      name: 'DomainOnly',
      slug: 'domainonly',
      domain: 'domainonly.dev',
      jobSources: [],
    },
    {
      // Unsupported vendor first, supported vendor second: the supported one wins.
      name: 'MixedSources',
      slug: 'mixedsources',
      domain: 'mixed.example',
      website: { url: 'https://mixed.example/', label: 'mixed.example' },
      jobSources: [
        { id: 'rippling', label: 'Rippling', value: 'rippling', count: 383 },
        { id: 'greenhouse', label: 'Greenhouse', value: 'greenhouse', count: 4 },
      ],
    },
  ],
};

try {
  const mod = await import(pathToFileURL(join(ROOT, 'seeds/vc-portfolios.mjs')).href);
  const { parseSequoiaPayload, parseSeedEntries, toPortalEntry, SEED_SOURCES } = mod;

  if (typeof parseSequoiaPayload !== 'function') {
    fail('seeds/vc-portfolios.mjs does not export parseSequoiaPayload');
  } else {
    const out = parseSequoiaPayload(FIXTURE);
    const by = (slug) => out.find((c) => c.slug === slug);

    if (out.length === 6) pass('parseSequoiaPayload returns one entry per company');
    else fail(`expected 6 entries, got ${out.length}: ${JSON.stringify(out.map((c) => c.slug))}`);

    if (out.every((c) => c.source === 'sequoia')) pass('every entry is tagged source="sequoia"');
    else fail('an entry carried the wrong source tag');

    // ── The vendor mapping: the reason this rung exists ──────────────────────
    if (by('gong')?.ats === 'greenhouse') pass('jobSources "greenhouse" maps to the greenhouse vendor');
    else fail(`Gong ats was ${by('gong')?.ats}`);

    // "ashbyhq" is Consider's spelling; career-ops calls it "ashby". Getting
    // this wrong is invisible — the entry just falls back to a Greenhouse guess.
    if (by('harvey')?.ats === 'ashby') pass('jobSources "ashbyhq" is normalised to career-ops\' "ashby"');
    else fail(`Harvey ats was ${by('harvey')?.ats}, expected "ashby"`);

    if (by('leverly')?.ats === 'lever') pass('jobSources "lever" maps to the lever vendor');
    else fail(`Leverly ats was ${by('leverly')?.ats}`);

    // An unmapped vendor must leave ats unset so the entry falls through to the
    // slug guess, rather than being handed a board URL no provider can read.
    if (by('cyera') && by('cyera').ats === undefined) {
      pass('an unsupported vendor (comeet) leaves ats unset rather than inventing one');
    } else {
      fail(`Cyera got ats=${by('cyera')?.ats}, expected none`);
    }

    if (by('mixedsources')?.ats === 'greenhouse') {
      pass('the first *supported* vendor wins when an unsupported one is listed first');
    } else {
      fail(`MixedSources ats was ${by('mixedsources')?.ats}, expected greenhouse`);
    }

    // ── URLs ────────────────────────────────────────────────────────────────
    if (by('gong')?.url === 'https://gong.io/') pass('website.url is recorded as the company URL');
    else fail(`Gong url was ${by('gong')?.url}`);

    // Unlike the Index rung (which stores '' because its only href is the VC's
    // own page), Consider carries the real company site — so the toPortalEntry
    // last-resort fallback lands somewhere useful.
    if (by('domainonly')?.url === 'https://domainonly.dev') {
      pass('a missing website object falls back to https:// + domain');
    } else {
      fail(`DomainOnly url was ${by('domainonly')?.url}`);
    }

    // ── Slug derivation ─────────────────────────────────────────────────────
    if (by('leverly')?.name === 'Leverly') pass('the display name is preserved verbatim');
    else fail(`name was ${by('leverly')?.name}`);

    // stripLegalSuffix is shared with the other rungs and DOES apply here: a
    // trailing "Co"/"Inc"/"GmbH" is removed before the slug is derived, so the
    // slug tracks the brand rather than the legal entity. Pinned because it is
    // surprising and silently changes which ATS board gets probed.
    const legal = parseSequoiaPayload({
      companies: [{ name: 'Leverage Co', domain: 'leverage.example', jobSources: [] }],
    });
    if (legal.length === 1 && legal[0].name === 'Leverage' && legal[0].slug === 'leverage') {
      pass('a trailing legal suffix ("Leverage Co") is stripped before the slug is derived');
    } else {
      fail(`legal-suffix handling gave ${JSON.stringify(legal.map((c) => [c.name, c.slug]))}`);
    }

    // ── Malformed and hostile inputs ────────────────────────────────────────
    const bad = [
      ['null', null], ['undefined', undefined], ['empty string', ''],
      ['non-JSON string', 'not json at all'], ['empty object', {}],
      ['companies not an array', { companies: 'nope' }],
      ['array of junk', { companies: [null, 42, 'x', {}] }],
    ];
    let badOk = true;
    for (const [label, input] of bad) {
      let got;
      try { got = parseSequoiaPayload(input); } catch (e) { badOk = false; fail(`parseSequoiaPayload(${label}) threw: ${e.message}`); continue; }
      if (!Array.isArray(got) || got.length !== 0) { badOk = false; fail(`parseSequoiaPayload(${label}) returned ${JSON.stringify(got)}`); }
    }
    if (badOk) pass('malformed payloads (null, non-JSON, wrong shapes, junk entries) all yield an empty array');

    // A raw JSON string must parse identically to the object — a stored fixture
    // is text, and the fetcher hands over an already-parsed body.
    const viaString = parseSequoiaPayload(JSON.stringify(FIXTURE));
    if (eq(viaString.map((c) => c.slug), out.map((c) => c.slug))) {
      pass('a raw JSON string parses identically to the parsed object');
    } else {
      fail('string and object payloads disagreed');
    }

    // Duplicates within one page must collapse, or the cursor walk compounds them.
    const dupes = parseSequoiaPayload({ companies: [FIXTURE.companies[0], FIXTURE.companies[0]] });
    if (dupes.length === 1) pass('a repeated company within one page is de-duplicated by slug');
    else fail(`duplicate handling returned ${dupes.length} entries`);

    // ── Routing through the generic entry point ─────────────────────────────
    const routed = parseSeedEntries(FIXTURE, 'sequoia');
    if (routed.length === 6 && routed.some((c) => c.slug === 'harvey')) {
      pass('parseSeedEntries(payload, "sequoia") routes to parseSequoiaPayload');
    } else {
      fail(`parseSeedEntries routing returned ${routed.length} entries`);
    }

    // The router stringifies HTML sources; Sequoia's JSON must pass untouched.
    if (parseSeedEntries(JSON.stringify(FIXTURE), 'sequoia').length === 6) {
      pass('parseSeedEntries("sequoia") accepts a JSON string as well as an object');
    } else {
      fail('parseSeedEntries("sequoia") mishandled a JSON string');
    }

    // ── Registry ────────────────────────────────────────────────────────────
    const reg = SEED_SOURCES?.sequoia;
    if (reg && typeof reg.fetch === 'function' && typeof reg.label === 'string' && reg.label.length > 0) {
      pass('SEED_SOURCES.sequoia is registered with a fetch function and a label');
    } else {
      fail(`SEED_SOURCES.sequoia is ${JSON.stringify(reg)}`);
    }

    if (['yc', 'a16z', 'index', 'sequoia'].every((k) => k in (SEED_SOURCES ?? {}))) {
      pass('registering sequoia did not disturb the existing three rungs');
    } else {
      fail(`SEED_SOURCES keys are ${Object.keys(SEED_SOURCES ?? {}).join(', ')}`);
    }

    // ── End-to-end: the mis-resolution this rung prevents ───────────────────
    // Without the vendor hint toPortalEntry guesses Greenhouse for everyone.
    // These two assertions are the whole point of the integration.
    const harveyUrl = toPortalEntry(by('harvey')).careers_url;
    if (harveyUrl === 'https://jobs.ashbyhq.com/harvey') {
      pass('an Ashby company resolves to an Ashby board URL, not the Greenhouse guess');
    } else {
      fail(`Harvey resolved to ${harveyUrl}`);
    }

    const leverUrl = toPortalEntry(by('leverly')).careers_url;
    if (leverUrl === 'https://jobs.lever.co/leverly') {
      pass('a Lever company resolves to a Lever board URL');
    } else {
      fail(`Leverly resolved to ${leverUrl}`);
    }

    // An unmapped vendor should still produce the ordinary slug guess, not ''.
    const cyeraUrl = toPortalEntry(by('cyera')).careers_url;
    if (cyeraUrl === 'https://job-boards.greenhouse.io/cyera') {
      pass('an unmapped vendor still falls through to the slug-based Greenhouse probe');
    } else {
      fail(`Cyera resolved to ${cyeraUrl}`);
    }
  }

    // ── extractAtsFromJobUrl: recovering the REAL board token ───────────────
    // The seed's original weakness was guessing a board token from a display
    // name. It is wrong often: Gong's Greenhouse board is `gongio`, Ironclad's
    // Ashby board is `ironcladhq`. A posting URL is not a guess, so these
    // assertions protect the mechanism that reads it.
    const { extractAtsFromJobUrl } = mod;
    if (typeof extractAtsFromJobUrl !== 'function') {
      fail('seeds/vc-portfolios.mjs does not export extractAtsFromJobUrl');
    } else {
      const urlCases = [
        ['https://job-boards.greenhouse.io/gongio/jobs/4702757006', { ats: 'greenhouse', ats_id: 'gongio' }],
        ['https://boards.greenhouse.io/spacex/jobs/8691749002?gh_jid=8691749002', { ats: 'greenhouse', ats_id: 'spacex' }],
        // Greenhouse's EU host has the same path shape and must not be missed.
        ['https://job-boards.eu.greenhouse.io/navvis/jobs/4941329101', { ats: 'greenhouse', ats_id: 'navvis' }],
        ['https://jobs.ashbyhq.com/mach/a0a53e10-7535-4196', { ats: 'ashby', ats_id: 'mach' }],
        ['https://jobs.lever.co/acme/1234-5678', { ats: 'lever', ats_id: 'acme' }],
        // A leading double slash must not shift which segment is read as the token.
        ['https://jobs.ashbyhq.com//vanta/abc', { ats: 'ashby', ats_id: 'vanta' }],
      ];
      let urlOk = true;
      for (const [input, want] of urlCases) {
        const got = extractAtsFromJobUrl(input);
        if (!eq(got, want)) { urlOk = false; fail(`extractAtsFromJobUrl(${input}) gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
      }
      if (urlOk) pass('extractAtsFromJobUrl recovers the board token from Greenhouse (US+EU), Ashby and Lever URLs');

      // Workday and Rippling are a different KIND of hit: their board root cannot
      // be rebuilt from a slug, so the extractor returns it verbatim and
      // toPortalEntry uses it as-is. Without careersUrl these fall through to a
      // Greenhouse guess that is wrong by construction.
      const wd = extractAtsFromJobUrl('https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers/job/Denver/Sr_R04195');
      if (eq(wd, { ats: 'workday', ats_id: 'cohesity', careersUrl: 'https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers' })) {
        pass('a Workday posting yields tenant + an explicit board root');
      } else {
        fail(`Workday extraction gave ${JSON.stringify(wd)}`);
      }

      // The locale segment is PART of the board root — dropping it produces a URL
      // providers/workday.mjs' own tenant pattern will not match.
      const wdLocale = extractAtsFromJobUrl('https://23andme.wd5.myworkdayjobs.com/en-US/23andme/job/x/y');
      if (wdLocale?.careersUrl === 'https://23andme.wd5.myworkdayjobs.com/en-US/23andme') {
        pass('a Workday locale segment (en-US) is kept in the board root');
      } else {
        fail(`Workday locale handling gave ${JSON.stringify(wdLocale)}`);
      }

      const rip = extractAtsFromJobUrl('https://ats.rippling.com/acme-inc/jobs/abc-123');
      if (eq(rip, { ats: 'rippling', ats_id: 'acme-inc', careersUrl: 'https://ats.rippling.com/acme-inc' })) {
        pass('a Rippling posting yields its board root');
      } else {
        fail(`Rippling extraction gave ${JSON.stringify(rip)}`);
      }

      // toPortalEntry must PREFER the explicit URL over anything it could build.
      const wdEntry = toPortalEntry({
        name: 'Cohesity', slug: 'cohesity', url: 'https://cohesity.com', source: 'sequoia',
        ats: 'workday', ats_id: 'cohesity', careersUrl: 'https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers',
      });
      if (wdEntry.careers_url === 'https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers') {
        pass('toPortalEntry prefers an explicit careersUrl over the slug-derived guess');
      } else {
        fail(`toPortalEntry gave ${wdEntry.careers_url}`);
      }

      // A non-https careersUrl must not be trusted straight through.
      const badUrl = toPortalEntry({ name: 'X', slug: 'x', url: '', source: 'sequoia', careersUrl: 'javascript:alert(1)' });
      if (badUrl.careers_url !== 'javascript:alert(1)') {
        pass('a non-https careersUrl is rejected rather than passed through');
      } else {
        fail('a javascript: careersUrl was passed straight through');
      }

      // A custom-domain Greenhouse link proves the vendor via gh_jid but does
      // NOT contain the board token — returning the path segment there would
      // invent a token like "careers".
      const rejected = [
        ['custom-domain Greenhouse (gh_jid but no board token)', 'https://hex.tech/careers/6139389004/?gh_jid=6139389004'],
        ['Comeet (no provider path from a posting URL)', 'https://www.comeet.com/jobs-x/acme/12.345'],
        ['BambooHR', 'https://alkira.bamboohr.com/careers/42'],
        ['not a URL', 'not a url at all'],
        ['empty string', ''],
        ['null', null],
        ['undefined', undefined],
        ['host with no path', 'https://jobs.ashbyhq.com/'],
      ];
      let rejOk = true;
      for (const [label, input] of rejected) {
        let got;
        try { got = extractAtsFromJobUrl(input); } catch (e) { rejOk = false; fail(`extractAtsFromJobUrl(${label}) threw: ${e.message}`); continue; }
        if (got !== null) { rejOk = false; fail(`extractAtsFromJobUrl(${label}) returned ${JSON.stringify(got)}, expected null`); }
      }
      if (rejOk) pass('unsupported hosts, custom domains and malformed input all return null rather than inventing a token');
    }

    // ── considerId / considerSlug are carried for the resolver ──────────────
    // The jobs endpoint filters on Consider's company *id* and echoes back
    // Consider's *slug*. Both differ from the name-derived slug, and losing
    // either breaks the resolver silently.
    const idFixture = parseSequoiaPayload({
      companies: [{ id: 'Gong', name: 'Gong', slug: 'gong-consider-slug', domain: 'gong.io', jobSources: [] }],
    })[0];
    if (idFixture?.considerId === 'Gong' && idFixture?.considerSlug === 'gong-consider-slug') {
      pass("Consider's own id and slug are carried through, distinct from the name-derived slug");
    } else {
      fail(`considerId/considerSlug were ${idFixture?.considerId}/${idFixture?.considerSlug}`);
    }

    if (typeof mod.resolveSequoiaAtsTokens === 'function') {
      pass('resolveSequoiaAtsTokens is exported');
    } else {
      fail('seeds/vc-portfolios.mjs does not export resolveSequoiaAtsTokens');
    }
} catch (e) {
  fail(`Sequoia seed tests crashed: ${e.message}`);
}
