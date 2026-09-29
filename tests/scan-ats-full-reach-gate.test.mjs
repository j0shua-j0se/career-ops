// tests/scan-ats-full-reach-gate.test.mjs — the reverse-ATS sweep's reach gate.
//
// On 2026-09-29 a Workday+Ashby sweep added 52 postings and none was useful:
// US tenants ("Remote MO", /job/Remote-US/) and bare "Remote" roles from US and
// Indian employers. The sweep judged each posting only with portals.yml's
// `location_filter`, which is lenient by design (an empty location passes;
// "Remote"/"Hybrid" are in its `allow` list), and never asked classifyReach.
// `reachGateVerdict` is the per-job gate now applied after location_filter.
//
// Offline: the rows below are synthetic, shaped like the ones that were added.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan-ats-full.mjs — reach gate');

const check = (desc, cond, details = '') => (cond ? pass(desc) : fail(`${desc}${details ? ` — ${details}` : ''}`));

try {
  const { reachGateVerdict, parseArgs } = await import(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href);
  const { buildLocationFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const wd = (tenant, seg, title = 'Data-Analyst') => `https://${tenant}.wd5.myworkdayjobs.com/en-US/Ext/job/${seg}/${title}_R1`;
  const job = (company, location, url, title = 'Data Analyst') => ({ company, location, url, title });

  // The 2026-09-29 offenders, by employer named in the report.
  const offenders = [
    job('veteransunited', 'Remote MO', wd('veteransunited', 'Remote-MO')),
    job('synchronyfinancial', 'Other Remote NY', wd('synchronyfinancial', 'Other-Remote-NY')),
    job('connexuscu', 'Remote', wd('connexuscu', 'Remote')),
    job('legalshieldcorp', 'Remote Job Posting', wd('legalshieldcorp', 'Remote-Job-Posting')),
    job('caci', '3 Locations', wd('caci', '999-REMOTE')),
    job('cni', 'Remote', wd('cni', 'Remote')),
    job('gehc', 'Remote', wd('gehc', 'Remote')),
    job('nvidia', '2 Locations', wd('nvidia', 'US-CA-Remote')),
    job('liberty', 'Remote Location', wd('liberty', 'Remote-Location')),
    job('lilt', 'Taiwan (Remote)', 'https://jobs.ashbyhq.com/lilt-production/702c040a'),
    job('lilt', 'United Arab Emirates (remote)', 'https://jobs.ashbyhq.com/lilt-production/536a4430'),
    job('supabase', 'Remote, Global', 'https://jobs.ashbyhq.com/supabase/6c9de03c'),
  ];
  for (const j of offenders) {
    const v = reachGateVerdict(j, {});
    check(`the gate drops ${j.company} "${j.location}"`, v.keep === false, `${v.reason}`);
  }

  // What the sweep is FOR must survive.
  const keepers = [
    job('yougov', '3 Locations', wd('yougov', 'Nuremberg-Germany'), 'Werkstudent (m/w/d)'),
    job('openai', 'Munich, Germany', 'https://jobs.ashbyhq.com/openai/e522c734'),
    job('bjakcareer', 'Germany · Remote', 'https://jobs.ashbyhq.com/bjakcareer/17790e04'),
    job('europcar', 'Muenchen', wd('europcar', 'Muenchen')),
    job('siemens', 'Erlangen', 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/523078'),
    job('camunda', 'Remote (EU)', 'https://jobs.ashbyhq.com/camunda/ec368e68'),
  ];
  for (const j of keepers) {
    const v = reachGateVerdict(j, {});
    check(`the gate keeps ${j.company} "${j.location}"`, v.keep === true, `${v.reason}`);
  }

  // Each of those offenders sailed through the lenient location_filter — that
  // is the gap being closed, so pin it with a portals-shaped config.
  const lenient = buildLocationFilter({
    always_allow: ['Erlangen', 'Nürnberg', 'München', 'Munich', 'Bayern'],
    block: ['United States', 'USA', 'California', 'India', 'Canada'],
    allow: ['Remote', 'Hybrid', 'Europe', 'EMEA', 'DACH'],
  });
  const passedFilter = offenders.filter((j) => lenient(j.location, j.url, j.title));
  check('the lenient location_filter alone passes most of the offenders (the gap the gate closes)',
    passedFilter.length >= 8, `${passedFilter.length}/${offenders.length} passed`);
  check('after the gate, none of the filter-passing offenders survive',
    passedFilter.every((j) => reachGateVerdict(j, {}).keep === false));

  // Options.
  check('--no-reach-gate turns the gate off',
    reachGateVerdict(offenders[0], { reachGate: false }).keep === true);
  check('a row with no location cell is not judged here (the no-location rule and --keep-unlocated own it)',
    reachGateVerdict(job('x', '', wd('x', 'Remote-MO')), {}).keep === true
    && reachGateVerdict(job('x', '   ', 'https://ex.com/1'), {}).keep === true);
  check('always_allow rescues an unrecognised town in a region the user named',
    reachGateVerdict(job('x', 'Bubenreuth, Bayern', 'https://ex.com/1'), { alwaysAllow: ['Bayern'] }).keep === true
    && reachGateVerdict(job('x', 'Bubenreuth, Bayern', 'https://ex.com/1'), {}).keep === false);

  // CLI wiring.
  const on = parseArgs(['node', 'scan-ats-full.mjs']);
  const off = parseArgs(['node', 'scan-ats-full.mjs', '--no-reach-gate']);
  check('the gate is on by default', on.reachGate === true, JSON.stringify(on.reachGate));
  check('--no-reach-gate is a known flag and switches it off', off.reachGate === false, JSON.stringify(off.reachGate));
} catch (err) {
  fail(`scan-ats-full reach-gate suite crashed: ${err.message}`);
}
