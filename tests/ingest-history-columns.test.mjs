// tests/ingest-history-columns.test.mjs
//
// ingest-jobs.mjs used to append only four columns to scan-history — url,
// first_seen, portal, title — while holding company, location and postedAt on
// the very same offer object.
//
// The cost was invisible and real: data/blacklist.md matching and
// providers/_trust-validator.mjs's company-vs-hostname check BOTH key on
// company, so every agent-ingested row silently bypassed both filters, and a
// dropped posted_at removes the staleness signal that stops a two-year-old
// listing reading as fresh. provider-health.mjs caught it on its first real
// run: indeed-mcp, empty_company on 5/5 rows.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ningest-jobs — an ingested row carries every column it has a value for');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
let tmp = '';
try {
  tmp = mkdtempSync(join(tmpdir(), 'ingest-cols-'));
  const history = join(tmp, 'history.tsv');
  const pipeline = join(tmp, 'pipeline.md');
  const offers = join(tmp, 'offers.json');
  writeFileSync(history, `${HEADER}\n`, 'utf-8');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n\n## Processed\n', 'utf-8');
  writeFileSync(offers, JSON.stringify([{
    url: 'https://example.com/jobs/1', company: 'Acme GmbH',
    title: 'Werkstudent Data Science', location: 'Erlangen', postedAt: '2026-08-30',
  }]), 'utf-8');

  execFileSync(NODE, [join(ROOT, 'ingest-jobs.mjs'), '--file', offers, '--source', 'test-src'], {
    cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CAREER_OPS_SCAN_HISTORY: history, CAREER_OPS_PIPELINE_FILE: pipeline },
  });

  const cols = HEADER.split('\t');
  const row = readFileSync(history, 'utf-8').trim().split('\n').pop().split('\t');
  const at = (name) => row[cols.indexOf(name)];

  at('company') === 'Acme GmbH'
    ? pass('company is written — blacklist matching and trust scoring both key on it')
    : fail(`company = ${JSON.stringify(at('company'))}`);
  at('location') === 'Erlangen'
    ? pass('location is written') : fail(`location = ${JSON.stringify(at('location'))}`);
  at('posted_at') === '2026-08-30'
    ? pass('posted_at is written — the staleness signal survives ingestion')
    : fail(`posted_at = ${JSON.stringify(at('posted_at'))}`);
  at('normalized_company') === 'acme gmbh'
    ? pass('normalized_company is written for dedup') : fail(`normalized_company = ${JSON.stringify(at('normalized_company'))}`);
  at('title') === 'Werkstudent Data Science' && at('portal') === 'test-src'
    ? pass('the original four columns still land where they did') : fail('legacy columns moved');
  row.length === cols.length
    ? pass('the row has exactly as many fields as the header')
    : fail(`row has ${row.length} fields, header has ${cols.length}`);
  // A fabricated trust score would be worse than an absent one: those columns
  // are the scanner's to compute from a real fetch.
  at('trust_score') === '' && at('trust_flags') === ''
    ? pass('trust columns are left empty rather than invented')
    : fail(`trust columns were filled: ${JSON.stringify([at('trust_score'), at('trust_flags')])}`);
} finally {
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
