// tests/ingest-jobs.test.mjs — non-postings must never reach the inbox, and
// every rejection must be reported, never dropped.
//
// On 2026-08-15 ingest-jobs.mjs took 56 rows from a WebSearch run. Roughly
// half were not job postings — LinkedIn/XING/wellfound listing-search pages,
// career-advice blog content, and four LinkedIn URLs sharing one job ID under
// four different (fabricated) companies — and every one of them landed in the
// inbox, where the liveness sweep then rubber-stamped it "active" because a
// search-results page returns HTTP 200 with content, same as a real posting.
//
// classifyIngestUrl() is the gate; planIngest() wires it in plus a
// duplicate-posting-ID guard. Both are pure, so these are almost entirely
// unit tests — the CLI is only exercised at the end to confirm the plumbing
// (JSON summary + human-readable listing) actually reports what got rejected.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - ingest-jobs (reject listing pages, not just real postings)');

const SCRIPT = join(ROOT, 'ingest-jobs.mjs');

function cli(args, env = {}) {
  try {
    const stdout = execFileSync(NODE, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e?.status ?? null,
      stdout: e?.stdout == null ? '' : String(e.stdout),
      stderr: e?.stderr == null ? '' : String(e.stderr),
    };
  }
}

// The CLI prints one pretty-printed JSON.stringify(obj, null, 2) block, then
// human-readable follow-up lines (rejection listings, the final "Queued
// only..." notice). The JSON block's top-level closing brace is the only
// unindented "}" line, so that is where the machine-readable part ends.
function extractJson(stdout) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l === '{');
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return null;
  try {
    return JSON.parse(lines.slice(start, end + 1).join('\n'));
  } catch {
    return null;
  }
}

let tmp = '';
try {
  tmp = mkdtempSync(join(tmpdir(), 'ingest-jobs-'));

  const mod = await import(pathToFileURL(SCRIPT).href);
  const { classifyIngestUrl, planIngest, extractPostingId, canonicalUrl } = mod;

  if (typeof classifyIngestUrl !== 'function' || typeof planIngest !== 'function') {
    fail('ingest-jobs.mjs does not export classifyIngestUrl and planIngest');
  } else {
    // ── Reject: search-results / listing pages ──────────────────────────────
    const REJECT_LISTINGS = [
      ['LinkedIn search results with facet params', 'https://www.linkedin.com/jobs/search/?location=Bavaria&keywords=Data+Scientist&f_E=1'],
      ['LinkedIn "jobs near X" browse slug', 'https://www.linkedin.com/jobs/working-student-jobs-erlangen'],
      ['LinkedIn "student jobs near X" browse slug', 'https://www.linkedin.com/jobs/student-jobs-nuremberg'],
      ['LinkedIn DE "-stellen-{place}" browse slug', 'https://de.linkedin.com/jobs/data-science-stellen-altdorf-bei-n%C3%BCrnberg'],
      ['LinkedIn DE "-stellen" browse slug', 'https://de.linkedin.com/jobs/data-science-intern-stellen'],
      ['LinkedIn "jobs-{place}" browse slug', 'https://www.linkedin.com/jobs/data-scientist-jobs-berlin'],
      ['XING "jobs-in-{place}" browse slug', 'https://www.xing.com/jobs/junior-data-scientist-jobs-in-k%C3%B6ln'],
      ['XING "/jobs/t-{slug}" tag-browse path', 'https://www.xing.com/jobs/t-junior-data-scientist'],
      ['XING "/jobs/k-student/t-{slug}" tag-browse path', 'https://www.xing.com/jobs/k-student/t-machine-learning'],
      ['wellfound "/role/l/{slug}/{place}" listing path', 'https://wellfound.com/role/l/artificial-intelligence-engineer/germany'],
    ];
    for (const [label, url] of REJECT_LISTINGS) {
      const v = classifyIngestUrl(url, { company: 'Some Employer GmbH' });
      if (v.ok === false && typeof v.reason === 'string' && v.reason.length > 0) {
        pass(`rejects ${label} with a reason`);
      } else {
        fail(`${label} (${url}) should be rejected with a reason, got ${JSON.stringify(v)}`);
      }
    }

    // ── Accept: genuine single postings on the same hosts ───────────────────
    const ACCEPT_POSTINGS = [
      ['LinkedIn /jobs/view/{slug}-{id}', 'https://www.linkedin.com/jobs/view/intern-artificial-intelligence-m-f-d-at-munich-re-4378331224', 'Munich Re'],
      ['LinkedIn /jobs/view/{id}', 'https://www.linkedin.com/jobs/view/4378331224', 'Munich Re'],
      ['wellfound /jobs/{id}-{slug}', 'https://wellfound.com/jobs/4015386-machine-learning-intern', 'Some Startup Inc'],
      ['Bosch ATS job page', 'https://jobs.bosch.com/de/job/REF293424B-praktikum-im-bereich-data-science-in-der-fertigung-w-m-div', 'Bosch'],
      ['Allianz careers job page', 'https://careers.allianz.com/us/en/job/103849/Working-Student-Data-Science-m-f-d', 'Allianz'],
      ['Welcome to the Jungle job page', 'https://www.welcometothejungle.com/en/companies/taxfix/jobs/automation-engineer-working-student_fr_mysircll', 'Taxfix'],
    ];
    for (const [label, url, company] of ACCEPT_POSTINGS) {
      const v = classifyIngestUrl(url, { company });
      if (v.ok === true) pass(`accepts ${label}`);
      else fail(`${label} (${url}) should be accepted, got ${JSON.stringify(v)}`);
    }

    // ── Reject: placeholder company ──────────────────────────────────────────
    for (const bad of ['Various', 'Verschiedene', 'N/A', '-', '', '  ']) {
      const v = classifyIngestUrl('https://www.linkedin.com/jobs/view/4378331224', { company: bad });
      if (v.ok === false && /placeholder company/i.test(v.reason)) {
        pass(`rejects a "${bad}" company as a placeholder, even on an otherwise-genuine posting URL`);
      } else {
        fail(`company ${JSON.stringify(bad)} should be rejected as a placeholder, got ${JSON.stringify(v)}`);
      }
    }
    const realCompany = classifyIngestUrl('https://www.linkedin.com/jobs/view/4378331224', { company: 'Munich Re' });
    if (realCompany.ok === true) pass('a real company name is not treated as a placeholder');
    else fail(`a real company name was rejected: ${JSON.stringify(realCompany)}`);

    // ── Reject: career-advice / aggregator content, on any host ─────────────
    const AGGREGATOR_PATHS = [
      ['founditgulf career-advice article', 'https://founditgulf.com/career-advice/how-to-write-a-cv', 'Found It Gulf'],
      ['a /blog/ path on an arbitrary host', 'https://opportunitiesnexus.com/blog/top-10-data-science-jobs-2026', 'Opportunities Nexus'],
      ['a /news/ path on an arbitrary host', 'https://example.com/news/hiring-trends-2026', 'Example News'],
      ['a /guide/ path on an arbitrary host', 'https://example.com/guide/how-to-apply', 'Example Guide'],
    ];
    for (const [label, url, company] of AGGREGATOR_PATHS) {
      const v = classifyIngestUrl(url, { company });
      if (v.ok === false && /non-posting content path/i.test(v.reason)) {
        pass(`rejects ${label}`);
      } else {
        fail(`${label} (${url}) should be rejected as aggregator content, got ${JSON.stringify(v)}`);
      }
    }
    // A genuine posting path must not trip on the word "news" or "blog"
    // appearing somewhere unrelated in the path.
    const notAggregator = classifyIngestUrl('https://jobs.bosch.com/de/job/REF1-praktikum-w-m-div', { company: 'Bosch' });
    if (notAggregator.ok === true) pass('a genuine posting path with no career-advice/blog/news/guide segment is unaffected');
    else fail(`a genuine posting path was wrongly rejected: ${JSON.stringify(notAggregator)}`);

    // ── --allow-listing escape hatch ─────────────────────────────────────────
    const blocked = classifyIngestUrl('https://www.linkedin.com/jobs/data-scientist-jobs-berlin', { company: 'Some Employer GmbH' });
    const allowed = classifyIngestUrl('https://www.linkedin.com/jobs/data-scientist-jobs-berlin', { company: 'Some Employer GmbH' }, { allowListing: true });
    if (blocked.ok === false && allowed.ok === true) {
      pass('--allow-listing (allowListing option) lets a listing URL through that is otherwise rejected');
    } else {
      fail(`allowListing did not flip the verdict: blocked=${JSON.stringify(blocked)} allowed=${JSON.stringify(allowed)}`);
    }
    // The escape hatch is scoped: it must not also launder a placeholder
    // company or aggregator content through the same flag.
    const stillBlockedCompany = classifyIngestUrl('https://www.linkedin.com/jobs/view/4378331224', { company: 'Various' }, { allowListing: true });
    if (stillBlockedCompany.ok === false) {
      pass('--allow-listing does not also excuse a placeholder company');
    } else {
      fail('--allow-listing incorrectly let a placeholder-company row through');
    }
    const stillBlockedAggregator = classifyIngestUrl('https://founditgulf.com/career-advice/x', { company: 'Acme' }, { allowListing: true });
    if (stillBlockedAggregator.ok === false) {
      pass('--allow-listing does not also excuse career-advice/aggregator content');
    } else {
      fail('--allow-listing incorrectly let aggregator content through');
    }

    // ── extractPostingId ──────────────────────────────────────────────────────
    if (typeof extractPostingId === 'function') {
      const id1 = extractPostingId('https://www.linkedin.com/jobs/view/4378331224');
      const id2 = extractPostingId('https://www.linkedin.com/jobs/view/intern-artificial-intelligence-m-f-d-at-munich-re-4378331224');
      if (id1 === '4378331224' && id2 === '4378331224') {
        pass('extractPostingId reads the trailing numeric ID off both bare and slugged /jobs/view/ URLs');
      } else {
        fail(`extractPostingId returned ${JSON.stringify({ id1, id2 })}`);
      }
      const noId = extractPostingId('https://wellfound.com/jobs/4015386-machine-learning-intern');
      if (noId === '') pass('extractPostingId returns empty for a URL whose ID is not at the trailing position');
      else fail(`expected '', got ${JSON.stringify(noId)}`);
    } else {
      fail('ingest-jobs.mjs does not export extractPostingId');
    }

    // ── Duplicate-job-id guard (planIngest) ──────────────────────────────────
    // The reported bug: LinkedIn job ID 4384875844 arrived under four
    // different companies. One ID cannot be four jobs.
    const fabricated = [
      { url: 'https://www.linkedin.com/jobs/view/data-scientist-at-avelios-medical-4384875844', company: 'avelios medical', title: 'Data Scientist' },
      { url: 'https://www.linkedin.com/jobs/view/data-scientist-at-temedica-4384875844', company: 'Temedica', title: 'Data Scientist' },
      { url: 'https://www.linkedin.com/jobs/view/data-scientist-at-limehome-4384875844', company: 'limehome', title: 'Data Scientist' },
      { url: 'https://www.linkedin.com/jobs/view/data-scientist-at-mitsui-chemicals-4384875844', company: 'Mitsui Chemicals', title: 'Data Scientist' },
    ];
    const dupPlan = planIngest(fabricated, new Set());
    if (dupPlan.queued.length === 0 && dupPlan.duplicateIds.length === 4) {
      pass('four rows sharing one posting ID under four different companies are ALL rejected, none queued');
    } else {
      fail(`expected 0 queued / 4 duplicateIds, got ${dupPlan.queued.length} queued / ${dupPlan.duplicateIds.length} duplicateIds`);
    }
    if (dupPlan.duplicateIds.every((r) => typeof r.reason === 'string' && /4384875844/.test(r.reason))) {
      pass('each duplicate-ID rejection carries a reason naming the shared posting ID');
    } else {
      fail(`duplicate-ID reasons missing the posting ID: ${JSON.stringify(dupPlan.duplicateIds.map((r) => r.reason))}`);
    }
    // Reported distinctly from ordinary rejections/duplicates/invalid.
    if (dupPlan.rejected.length === 0 && dupPlan.invalid.length === 0 && dupPlan.duplicates.length === 0) {
      pass('the fabricated-ID rows are counted under duplicateIds, not folded into rejected/invalid/duplicates');
    } else {
      fail(`fabricated-ID rows leaked into other buckets: ${JSON.stringify({ rejected: dupPlan.rejected.length, invalid: dupPlan.invalid.length, duplicates: dupPlan.duplicates.length })}`);
    }

    // The same posting ID under exactly one company must still be queued —
    // the guard is about *ambiguity*, not about the ID pattern itself.
    const single = planIngest([fabricated[0]], new Set());
    if (single.queued.length === 1 && single.duplicateIds.length === 0) {
      pass('a single company holding that same posting ID is queued normally');
    } else {
      fail(`a lone same-ID row should queue cleanly, got ${JSON.stringify({ queued: single.queued.length, duplicateIds: single.duplicateIds.length })}`);
    }

    // A batch mixing an ambiguous ID with an unrelated clean posting must not
    // let the ambiguous rows contaminate the clean one.
    const mixedBatch = planIngest([
      ...fabricated,
      { url: 'https://jobs.bosch.com/de/job/REF999-clean-posting', company: 'Bosch', title: 'Clean Posting' },
    ], new Set());
    if (mixedBatch.queued.length === 1 && mixedBatch.queued[0].company === 'Bosch' && mixedBatch.duplicateIds.length === 4) {
      pass('an unrelated clean posting in the same batch is queued while the ambiguous ID rows are rejected');
    } else {
      fail(`mixed batch did not isolate the clean row: ${JSON.stringify({ queued: mixedBatch.queued.map((o) => o.company), duplicateIds: mixedBatch.duplicateIds.length })}`);
    }

    // ── planIngest: listing/aggregator rows are rejected, reported, and counted ──
    const batch = [
      { url: 'https://www.linkedin.com/jobs/view/4378331224', company: 'Munich Re', title: 'AI Intern' }, // genuine
      { url: 'https://www.linkedin.com/jobs/search/?keywords=Data+Scientist', company: 'LinkedIn', title: 'Data Scientist' }, // listing
      { url: 'https://founditgulf.com/career-advice/how-to-write-a-cv', company: 'Found It Gulf', title: 'How to write a CV' }, // aggregator
      { url: 'https://www.xing.com/jobs/junior-data-scientist-jobs-in-k%C3%B6ln', company: 'Various', title: 'Junior Data Scientist' }, // listing + placeholder company
      { url: 'not a url at all', company: 'Acme', title: 'Broken' }, // invalid
    ];
    const planned = planIngest(batch, new Set());
    if (planned.queued.length === 1 && planned.queued[0].company === 'Munich Re') {
      pass('planIngest queues only the genuine posting out of a mixed batch');
    } else {
      fail(`expected exactly the Munich Re row queued, got ${JSON.stringify(planned.queued.map((o) => o.company))}`);
    }
    if (planned.rejected.length === 3) {
      pass('planIngest rejects all three non-postings (listing, aggregator, listing+placeholder)');
    } else {
      fail(`expected 3 rejected rows, got ${planned.rejected.length}: ${JSON.stringify(planned.rejected.map((r) => r.reason))}`);
    }
    if (planned.invalid.length === 1) {
      pass('the unparseable URL is still caught by the pre-existing invalid check');
    } else {
      fail(`expected 1 invalid row, got ${planned.invalid.length}`);
    }
    if (planned.rejected.every((r) => typeof r.reason === 'string' && r.reason.length > 0 && typeof r.url === 'string')) {
      pass('every rejected row carries both a reason and the URL it was rejected for — nothing is dropped silently');
    } else {
      fail(`a rejected row is missing its reason or url: ${JSON.stringify(planned.rejected)}`);
    }

    // canonicalUrl must still be applied before classification, so tracking
    // params on an otherwise-genuine posting don't confuse the classifier.
    if (typeof canonicalUrl === 'function') {
      const withTracking = planIngest([
        { url: 'https://www.linkedin.com/jobs/view/4378331224?utm_source=newsletter', company: 'Munich Re', title: 'AI Intern' },
      ], new Set());
      if (withTracking.queued.length === 1) pass('a genuine posting with tracking params is still queued after canonicalization');
      else fail(`tracking-param posting was not queued: ${JSON.stringify(withTracking)}`);
    }
  }

  // ── CLI: rejections are reported on stdout, never silently dropped ────────
  const pipelinePath = join(tmp, 'pipeline.md');
  const historyPath = join(tmp, 'scan-history.tsv');
  writeFileSync(pipelinePath, '# Pipeline\n\n## Pending\n\n## Processed\n', 'utf-8');
  writeFileSync(historyPath, '', 'utf-8');

  const offersPath = join(tmp, 'offers.json');
  writeFileSync(offersPath, JSON.stringify([
    { url: 'https://www.linkedin.com/jobs/view/4378331224', company: 'Munich Re', title: 'AI Intern' },
    { url: 'https://www.linkedin.com/jobs/search/?keywords=Data+Scientist', company: 'LinkedIn', title: 'Data Scientist' },
    { url: 'https://founditgulf.com/career-advice/how-to-write-a-cv', company: 'Found It Gulf', title: 'How to write a CV' },
  ]), 'utf-8');

  const env = { CAREER_OPS_PIPELINE_FILE: pipelinePath, CAREER_OPS_SCAN_HISTORY: historyPath };
  const run1 = cli(['--file', offersPath, '--source', 'test-suite', '--dry-run'], env);
  if (run1.code === 0) pass('a CLI dry-run with a mixed batch exits 0');
  else fail(`CLI dry-run exited ${run1.code} with stderr ${JSON.stringify(run1.stderr.slice(0, 300))}`);

  const parsed = extractJson(run1.stdout);
  if (parsed && parsed.queued === 1 && parsed.rejected === 2) {
    pass('the CLI JSON summary counts queued and rejected correctly');
  } else {
    fail(`CLI JSON summary did not match: ${JSON.stringify(parsed)}`);
  }
  if (parsed && Array.isArray(parsed.rejectedReasons) && parsed.rejectedReasons.length === 2) {
    pass('the CLI JSON summary lists rejection reasons, not just a count');
  } else {
    fail(`rejectedReasons missing or wrong length: ${JSON.stringify(parsed?.rejectedReasons)}`);
  }
  if (/rejected as non-postings/.test(run1.stdout) && /founditgulf\.com/.test(run1.stdout)) {
    pass('the human-readable section names the rejected URLs, not just a summary count');
  } else {
    fail('the CLI did not print a human-readable rejection listing');
  }
  if (/--allow-listing/.test(run1.stdout)) {
    pass('the CLI mentions --allow-listing as the override for listing-page rejections');
  } else {
    fail('the CLI output does not mention --allow-listing');
  }

  // --allow-listing must let the listing URL through on the CLI too.
  const run2 = cli(['--file', offersPath, '--source', 'test-suite', '--dry-run', '--allow-listing'], env);
  const parsed2 = extractJson(run2.stdout);
  if (parsed2 && parsed2.queued === 2 && parsed2.rejected === 1) {
    pass('--allow-listing on the CLI queues the listing-page row while the aggregator row is still rejected');
  } else {
    fail(`--allow-listing CLI run did not match expectations: ${JSON.stringify(parsed2)}`);
  }

  // --dry-run must still mean nothing was written, even with rejections present.
  const pipelineAfter = readFileSync(pipelinePath, 'utf-8');
  if (!/linkedin\.com/.test(pipelineAfter) && !/founditgulf/.test(pipelineAfter)) {
    pass('--dry-run wrote nothing to the pipeline file, queued or rejected alike');
  } else {
    fail('the pipeline file was modified despite --dry-run');
  }
} catch (e) {
  fail(`ingest-jobs tests crashed: ${e.message}`);
} finally {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Opaque redirect tokens ──────────────────────────────────────────
//
// `to.indeed.com/aammllw8xckm` is nothing but a tracking token: no posting id,
// no slug, no employer. Indeed mints a fresh one for the same job seen from a
// different search, so one live sweep returned 29 rows that were 25 jobs — the
// same Siemens Werkstudent posting arrived three times under three tokens.
//
// canonicalUrl() cannot help (the token IS the path) and extractPostingId()
// finds no digits to compare, so both existing guards passed them through to be
// evaluated two and three times over. Behind a pure redirector, company+title
// is the only identity left.
{
  // Re-imported: the block above closes its own scope, so this section stands
  // on its own rather than depending on where it happens to sit in the file.
  const { planIngest } = await import(pathToFileURL(SCRIPT).href);

  const collapse = planIngest([
    { url: 'https://to.indeed.com/aammllw8xckm', company: 'Siemens', title: 'Werkstudent (w/m/d) Factory Digitalization Data Analytics' },
    { url: 'https://to.indeed.com/aavbtrqwfvbj', company: 'siemens', title: 'Werkstudent (w/m/d)  Factory Digitalization Data Analytics ' },
    { url: 'https://to.indeed.com/aakkq6j476c9', company: 'Siemens', title: 'Werkstudent (w/m/d) Logistik für Business Analytics' },
  ], new Set());

  if (collapse.queued.length === 2) {
    pass('planIngest collapses opaque-redirect rows that share a company and title');
  } else {
    fail(`expected 2 queued, got ${collapse.queued.length}: ${JSON.stringify(collapse.queued.map((o) => o.url))}`);
  }
  if (collapse.duplicates.length === 1 && /opaque redirect/.test(collapse.duplicates[0].reason || '')) {
    pass('the collapsed row is reported as a duplicate with its reason, not silently dropped');
  } else {
    fail(`collapse should report one reasoned duplicate: ${JSON.stringify(collapse.duplicates)}`);
  }

  // Case and whitespace must not defeat it, but a DIFFERENT title must survive
  // — two real openings at one employer are not the same job.
  const distinct = planIngest([
    { url: 'https://to.indeed.com/aaa1', company: 'Siemens', title: 'Werkstudent Data Analytics' },
    { url: 'https://to.indeed.com/aaa2', company: 'Siemens', title: 'Werkstudent Machine Learning' },
  ], new Set());
  if (distinct.queued.length === 2) {
    pass('two different titles at the same employer both survive');
  } else {
    fail(`distinct titles were collapsed: ${JSON.stringify(distinct.queued.map((o) => o.title))}`);
  }

  // The collapse must NOT apply to real URLs. A normal board encodes identity
  // in the path, so two same-titled postings there are two requisitions and
  // both must be kept — the tracker's req-ID rule exists for exactly that.
  const realUrls = planIngest([
    { url: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/111111', company: 'Siemens', title: 'Werkstudent Data Analytics' },
    { url: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/222222', company: 'Siemens', title: 'Werkstudent Data Analytics' },
  ], new Set());
  if (realUrls.queued.length === 2) {
    pass('same title on two real posting URLs stays two rows — the collapse is redirector-only');
  } else {
    fail(`real URLs were wrongly collapsed: ${JSON.stringify(realUrls.queued.map((o) => o.url))}`);
  }
}
