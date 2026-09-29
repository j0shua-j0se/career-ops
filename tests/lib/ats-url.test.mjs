// tests/lib/ats-url.test.mjs — exhaustive coverage for lib/ats-url.mjs's
// atsBoardFromUrl(): every supported vendor's positive shape, negative/
// look-alike hosts, and the SSRF-relevant edge cases (non-https, malformed
// URL, path-spoofed host, suffix-spoofed host).
import { pass, fail } from '../helpers.mjs';
import { atsBoardFromUrl, ATS_VENDORS } from '../../lib/ats-url.mjs';

console.log('\nlib — ats-url');

function expectMatch(url, expected, label) {
  const hit = atsBoardFromUrl(url);
  if (hit && hit.vendor === expected.vendor && hit.slug === expected.slug && hit.boardUrl === expected.boardUrl) {
    pass(label);
  } else {
    fail(`${label} — got ${JSON.stringify(hit)}, expected ${JSON.stringify(expected)}`);
  }
}

function expectNull(url, label) {
  const hit = atsBoardFromUrl(url);
  if (hit === null) pass(label);
  else fail(`${label} — expected null, got ${JSON.stringify(hit)}`);
}

// ── greenhouse ──────────────────────────────────────────────────────────
expectMatch(
  'https://job-boards.greenhouse.io/acme',
  { vendor: 'greenhouse', slug: 'acme', boardUrl: 'https://job-boards.greenhouse.io/acme' },
  'greenhouse: job-boards.greenhouse.io/<slug>',
);
expectMatch(
  'https://job-boards.eu.greenhouse.io/acme/jobs/12345',
  { vendor: 'greenhouse', slug: 'acme', boardUrl: 'https://job-boards.eu.greenhouse.io/acme' },
  'greenhouse: job-boards.eu.greenhouse.io/<slug> (extra path dropped)',
);
expectMatch(
  'https://boards.greenhouse.io/acme',
  { vendor: 'greenhouse', slug: 'acme', boardUrl: 'https://job-boards.greenhouse.io/acme' },
  'greenhouse: legacy boards.greenhouse.io/<slug> normalizes to job-boards host',
);
expectNull('https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'greenhouse: the API host itself is not a board URL');

// ── lever ───────────────────────────────────────────────────────────────
expectMatch(
  'https://jobs.lever.co/acme',
  { vendor: 'lever', slug: 'acme', boardUrl: 'https://jobs.lever.co/acme' },
  'lever: jobs.lever.co/<slug>',
);
expectMatch(
  'https://jobs.eu.lever.co/acme',
  { vendor: 'lever', slug: 'acme', boardUrl: 'https://jobs.eu.lever.co/acme' },
  'lever: jobs.eu.lever.co/<slug>',
);

// ── ashby ───────────────────────────────────────────────────────────────
expectMatch(
  'https://jobs.ashbyhq.com/AlephAlpha',
  { vendor: 'ashby', slug: 'AlephAlpha', boardUrl: 'https://jobs.ashbyhq.com/AlephAlpha' },
  'ashby: preserves mixed-case slug',
);

// ── personio ────────────────────────────────────────────────────────────
expectMatch(
  'https://acme-gmbh.jobs.personio.de/job/123',
  { vendor: 'personio', slug: 'acme-gmbh', boardUrl: 'https://acme-gmbh.jobs.personio.de' },
  'personio: <slug>.jobs.personio.de',
);
expectMatch(
  'https://acme.jobs.personio.com/',
  { vendor: 'personio', slug: 'acme', boardUrl: 'https://acme.jobs.personio.com' },
  'personio: .com TLD variant',
);

// ── workday ─────────────────────────────────────────────────────────────
expectMatch(
  'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
  { vendor: 'workday', slug: 'nvidia', boardUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' },
  'workday: <tenant>.<instance>.myworkdayjobs.com/<site>',
);
expectMatch(
  'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/foo-bar_R12345',
  { vendor: 'workday', slug: 'acme', boardUrl: 'https://acme.wd3.myworkdayjobs.com/Careers' },
  'workday: strips locale prefix and trailing job path',
);

// ── smartrecruiters ─────────────────────────────────────────────────────
expectMatch(
  'https://careers.smartrecruiters.com/Acme',
  { vendor: 'smartrecruiters', slug: 'Acme', boardUrl: 'https://careers.smartrecruiters.com/Acme' },
  'smartrecruiters: careers.smartrecruiters.com/<slug>',
);
expectMatch(
  'https://jobs.smartrecruiters.com/Acme/12345-title',
  { vendor: 'smartrecruiters', slug: 'Acme', boardUrl: 'https://careers.smartrecruiters.com/Acme' },
  'smartrecruiters: jobs.smartrecruiters.com host normalizes to careers.',
);

// ── recruitee ───────────────────────────────────────────────────────────
expectMatch(
  'https://acme.recruitee.com/o/some-job',
  { vendor: 'recruitee', slug: 'acme', boardUrl: 'https://acme.recruitee.com' },
  'recruitee: <slug>.recruitee.com',
);

// ── join.com ────────────────────────────────────────────────────────────
expectMatch(
  'https://join.com/companies/acme',
  { vendor: 'join', slug: 'acme', boardUrl: 'https://join.com/companies/acme' },
  'join: join.com/companies/<slug>',
);
expectMatch(
  'https://join.com/companies/acme/jobs/12345',
  { vendor: 'join', slug: 'acme', boardUrl: 'https://join.com/companies/acme' },
  'join: extra job path dropped',
);
expectNull('https://join.com/about', 'join: a non-/companies/ path is not a board URL');

// ── softgarden ──────────────────────────────────────────────────────────
expectMatch(
  'https://renk-group.softgarden.io/de/widgets/jobs',
  { vendor: 'softgarden', slug: 'renk-group', boardUrl: 'https://renk-group.softgarden.io/de/widgets/jobs' },
  'softgarden: <slug>.softgarden.io',
);
expectNull('https://softgarden.io/', 'softgarden: bare host (no tenant) has no slug');

// ── successfactors ──────────────────────────────────────────────────────
expectMatch(
  'https://career5.successfactors.eu/career?company=AcmeCorp',
  { vendor: 'successfactors', slug: 'AcmeCorp', boardUrl: 'https://career5.successfactors.eu/career?company=AcmeCorp' },
  'successfactors: career<N>.successfactors.eu?company=<slug>',
);
expectMatch(
  'https://career.successfactors.com/career?company=AcmeCorp&career_ns=job_listing',
  { vendor: 'successfactors', slug: 'AcmeCorp', boardUrl: 'https://career.successfactors.com/career?company=AcmeCorp&career_ns=job_listing' },
  'successfactors: bare career.successfactors.com (no digit) still matches',
);
expectNull('https://career5.successfactors.eu/career', 'successfactors: missing company= param cannot resolve a slug');
expectNull('https://jobs.zf.com/search/', 'successfactors: a branded RMK host carries no successfactors marker in the hostname');

// ── workable ────────────────────────────────────────────────────────────
expectMatch(
  'https://apply.workable.com/acme/',
  { vendor: 'workable', slug: 'acme', boardUrl: 'https://apply.workable.com/acme' },
  'workable: apply.workable.com/<slug>',
);

// ── teamtailor ──────────────────────────────────────────────────────────
expectMatch(
  'https://acme.teamtailor.com/jobs/12345',
  { vendor: 'teamtailor', slug: 'acme', boardUrl: 'https://acme.teamtailor.com' },
  'teamtailor: <slug>.teamtailor.com',
);

// ── bamboohr ────────────────────────────────────────────────────────────
expectMatch(
  'https://acme.bamboohr.com/careers/123',
  { vendor: 'bamboohr', slug: 'acme', boardUrl: 'https://acme.bamboohr.com' },
  'bamboohr: <tenant>.bamboohr.com',
);

// ── breezy ──────────────────────────────────────────────────────────────
expectMatch(
  'https://acme.breezy.hr/p/some-job',
  { vendor: 'breezy', slug: 'acme', boardUrl: 'https://acme.breezy.hr' },
  'breezy: <tenant>.breezy.hr',
);

// ── pinpoint ────────────────────────────────────────────────────────────
expectMatch(
  'https://acme.pinpointhq.com/postings/some-job',
  { vendor: 'pinpoint', slug: 'acme', boardUrl: 'https://acme.pinpointhq.com' },
  'pinpoint: <slug>.pinpointhq.com',
);

// ── rippling ────────────────────────────────────────────────────────────
expectMatch(
  'https://ats.rippling.com/acme/jobs',
  { vendor: 'rippling', slug: 'acme', boardUrl: 'https://ats.rippling.com/acme/jobs' },
  'rippling: ats.rippling.com/<slug>/jobs',
);
expectMatch(
  'https://ats.rippling.com/acme',
  { vendor: 'rippling', slug: 'acme', boardUrl: 'https://ats.rippling.com/acme/jobs' },
  'rippling: bare tenant path (no /jobs) still resolves',
);

// ── unrecognized / negative cases ──────────────────────────────────────
expectNull('https://example.com/careers', 'unrecognized host returns null');
expectNull('', 'empty string returns null');
expectNull(null, 'null input returns null');
expectNull(undefined, 'undefined input returns null');
expectNull(42, 'non-string input returns null');
expectNull('not a url at all', 'unparseable string returns null');
expectNull('http://jobs.lever.co/acme', 'non-https URL is rejected even on a real vendor host');

// ── SSRF: path-spoofed and suffix-spoofed look-alike hosts ─────────────
expectNull('https://evil.example/jobs.lever.co/acme', 'lever: path-spoofed host is not matched (host check, not substring)');
expectNull('https://jobs.lever.co.evil.com/acme', 'lever: suffix-spoofed look-alike host is rejected');
expectNull('https://evil.example/acme.jobs.personio.de/xml', 'personio: path-spoofed host is not matched');
expectNull('https://acme.jobs.personio.de.evil.com/xml', 'personio: suffix-spoofed look-alike host is rejected');
expectNull('https://acme.bamboohr.com.evil.com/careers', 'bamboohr: suffix-spoofed look-alike host is rejected');

// ── vendor id coverage — ATS_VENDORS lists exactly the ids this module
// can produce, and every one of them matches a real providers/*.mjs id ──
{
  const expected = [
    'greenhouse', 'lever', 'ashby', 'personio', 'workday', 'smartrecruiters',
    'recruitee', 'join', 'softgarden', 'successfactors', 'workable',
    'teamtailor', 'bamboohr', 'breezy', 'pinpoint', 'rippling',
  ];
  if (JSON.stringify([...ATS_VENDORS].sort()) === JSON.stringify([...expected].sort()) && ATS_VENDORS.length === 16) {
    pass('ATS_VENDORS lists exactly the 16 required vendor ids');
  } else {
    fail(`ATS_VENDORS mismatch: ${JSON.stringify(ATS_VENDORS)}`);
  }
}

// Every vendor this module recognizes actually has a corresponding
// providers/{vendor}.mjs file whose exported `id` matches — the contract
// resolve-employer-posting.mjs and harvest-companies.mjs both depend on
// (atsBoardFromUrl's vendor plugs straight into providers/_registry.mjs with
// no translation).
{
  const { existsSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath, pathToFileURL } = await import('url');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PROVIDERS_DIR = join(HERE, '..', '..', 'providers');
  for (const vendor of ATS_VENDORS) {
    const file = join(PROVIDERS_DIR, `${vendor}.mjs`);
    if (!existsSync(file)) {
      fail(`providers/${vendor}.mjs does not exist`);
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    if (mod.default?.id === vendor) pass(`providers/${vendor}.mjs exports id "${vendor}"`);
    else fail(`providers/${vendor}.mjs exports id ${JSON.stringify(mod.default?.id)}, expected "${vendor}"`);
  }
}
