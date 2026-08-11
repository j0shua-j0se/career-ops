#!/usr/bin/env node

/**
 * ingest-jobs.mjs — land agent-discovered jobs in the inbox, with dedup.
 *
 * `scan.mjs` covers every source that has a zero-token HTTP provider. Several
 * of the sources that matter most for this search have none, and never will:
 *
 *   - Indeed, reached through an MCP tool the agent calls, not an HTTP endpoint
 *     a Node provider could hit
 *   - BMW, StepStone and friends, which are bot-protected and need a stealth
 *     fetcher driven by the agent
 *   - anything found by WebSearch on the `search_queries` rungs
 *
 * Those all produced the same dead end: the agent finds real postings and then
 * has nowhere to put them. `portals.yml` has carried enabled LinkedIn,
 * StepStone, XING, Indeed and BMW queries for months that have delivered
 * exactly zero jobs, because the handoff step had no landing pad and nobody
 * ran it by hand. This is the landing pad.
 *
 *   node ingest-jobs.mjs --file offers.json --source indeed-mcp
 *   node ingest-jobs.mjs --file offers.json --source stepstone-scrapling --dry-run
 *
 * `offers.json` is a JSON array of `{url, company, title, location?, postedAt?}`.
 *
 * Dedup is checked against BOTH `data/scan-history.tsv` (every URL ever seen by
 * any scanner) and the current inbox, so re-running an ingest is safe and a job
 * already surfaced by the ATS sweep is never queued twice. Writes go through
 * the same append-to-Pending shape `scan.mjs` uses, so `triage-prefilter`,
 * `check-liveness --file` and the `pipeline` mode all read them unchanged.
 *
 * Never submits anything, and never evaluates: it only queues.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(ROOT, 'data', 'pipeline.md');
const HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || join(ROOT, 'data', 'scan-history.tsv');

/** Strip tracking noise so the same posting is not queued under two URLs. */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  // Campaign/attribution parameters identify the *click*, not the posting. A
  // DLR link arrived carrying refid/eid/utm_*/fbclid and would otherwise never
  // match the same posting seen from another source.
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|msclkid|refid|eid|src|source|from|trk|ref)$/i.test(key) || /^utm/i.test(key)) {
      u.searchParams.delete(key);
    }
  }
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

/** Every URL any scanner has already seen. */
export function knownUrls(historyText = '', pipelineText = '') {
  const seen = new Set();
  for (const line of String(historyText).split('\n')) {
    const url = line.split('\t')[0];
    const c = canonicalUrl(url);
    if (c) seen.add(c);
  }
  // The inbox holds both pending and processed rows; both count as known.
  for (const m of String(pipelineText).matchAll(/https?:\/\/\S+/g)) {
    const c = canonicalUrl(m[0].replace(/[)>\]]+$/, ''));
    if (c) seen.add(c);
  }
  return seen;
}

/** One `- [ ]` inbox row in the shape scan.mjs writes. */
export function renderRow(offer, source, today) {
  const cell = (v) => String(v ?? '').replace(/[|\t\r\n]+/g, ' ').trim();
  const parts = [
    canonicalUrl(offer.url),
    cell(offer.company) || '?',
    cell(offer.title) || 'Unknown role',
  ];
  if (cell(offer.location)) parts.push(cell(offer.location));
  parts.push(`posted: ${cell(offer.postedAt) || today}`);
  parts.push(`via: ${cell(source)}`);
  return `- [ ] ${parts.join(' | ')}`;
}

/**
 * Decide what to queue. Pure — the caller does the I/O.
 *
 * @returns {{queued: object[], duplicates: object[], invalid: object[]}}
 */
export function planIngest(offers, seen) {
  const queued = [];
  const duplicates = [];
  const invalid = [];
  const batch = new Set();

  for (const offer of Array.isArray(offers) ? offers : []) {
    if (!offer || typeof offer !== 'object') { invalid.push({ offer, reason: 'not an object' }); continue; }
    const url = canonicalUrl(offer.url);
    if (!url) { invalid.push({ offer, reason: 'missing or unusable url' }); continue; }
    if (seen.has(url)) { duplicates.push({ ...offer, url }); continue; }
    // Guard the batch against itself: one MCP call can return the same posting
    // twice across paginated pages.
    if (batch.has(url)) { duplicates.push({ ...offer, url }); continue; }
    batch.add(url);
    queued.push({ ...offer, url });
  }
  return { queued, duplicates, invalid };
}

/** Insert rows directly under the `## Pending` heading. */
export function insertPending(markdown, rows) {
  if (!rows.length) return markdown;
  const block = rows.join('\n');
  const idx = markdown.indexOf('## Pending');
  if (idx === -1) return `${markdown.replace(/\s*$/, '')}\n\n## Pending\n\n${block}\n`;
  const eol = markdown.indexOf('\n', idx);
  if (eol === -1) return `${markdown}\n${block}\n`;
  return `${markdown.slice(0, eol + 1)}\n${block}${markdown.slice(eol)}`;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        file: { type: 'string' },
        source: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`ingest-jobs: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.help || !values.file) {
    console.log(`Usage: node ingest-jobs.mjs --file <offers.json> --source <label> [--dry-run]

  --file    JSON array of {url, company, title, location?, postedAt?}
  --source  where these came from, recorded on each row (e.g. indeed-mcp)
  --dry-run print what would be queued, write nothing

Dedups against data/scan-history.tsv and the inbox. Queues only; never evaluates
or submits.`);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (!existsSync(values.file)) {
    console.error(`ingest-jobs: file not found: ${values.file}`);
    process.exitCode = 1;
    return;
  }

  const source = values.source || 'agent';
  let offers;
  try {
    offers = JSON.parse(readFileSync(values.file, 'utf-8'));
  } catch (err) {
    console.error(`ingest-jobs: ${values.file} is not valid JSON — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const pipelineText = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '# Pipeline\n\n## Pending\n\n## Processed\n';
  const historyText = existsSync(HISTORY_PATH) ? readFileSync(HISTORY_PATH, 'utf-8') : '';
  const { queued, duplicates, invalid } = planIngest(offers, knownUrls(historyText, pipelineText));

  const today = new Date().toISOString().slice(0, 10);
  const rows = queued.map((o) => renderRow(o, source, today));

  if (!values['dry-run'] && rows.length) {
    mkdirSync(dirname(PIPELINE_PATH), { recursive: true });
    const tmp = `${PIPELINE_PATH}.tmp`;
    writeFileSync(tmp, insertPending(pipelineText, rows), 'utf-8');
    renameSync(tmp, PIPELINE_PATH);
    // Record in scan-history so the next scan of ANY source dedups against these.
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    appendFileSync(HISTORY_PATH, queued.map((o) => `${o.url}\t${today}\t${source}\t${String(o.title ?? '').replace(/[\t\r\n]+/g, ' ')}\n`).join(''), 'utf-8');
  }

  console.log(JSON.stringify({
    source,
    in: Array.isArray(offers) ? offers.length : 0,
    queued: rows.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    dryRun: Boolean(values['dry-run']),
    rows: rows.slice(0, 20),
    invalidReasons: invalid.slice(0, 5).map((i) => i.reason),
  }, null, 2));
  console.log('\nQueued only — nothing evaluated, nothing submitted. Next: /career-ops pipeline');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/file:\/\/([A-Za-z]:)/, 'file:///$1')) {
  main();
} else if (process.argv[1] && process.argv[1].endsWith('ingest-jobs.mjs')) {
  main();
}
