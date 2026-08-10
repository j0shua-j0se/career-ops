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
} catch (e) {
  fail(`Sequoia seed tests crashed: ${e.message}`);
}
