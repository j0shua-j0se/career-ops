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

// Hosts whose /jobs/ URL space mixes real single-posting pages with
// listing/search pages that return HTTP 200 and a plausible-looking body —
// the liveness sweep cannot tell them apart, so ingest has to.
const LISTING_HOSTS = ['linkedin.com', 'xing.com', 'wellfound.com'];

// Query-string keys that only appear on a search-results URL, never on a
// single posting: `keywords`/`f_E`/`f_TPR` come off LinkedIn's job-search
// facets, `currentJobId` off the split-pane search view.
const SEARCH_QUERY_KEYS = new Set(['keywords', 'f_e', 'f_tpr', 'currentjobid']);

// The offer's `company` reads as a placeholder rather than an employer name.
// A listing/aggregator page has no single employer to report, so a scraper or
// search agent fills this in with one of these instead of leaving it blank.
const PLACEHOLDER_COMPANIES = new Set(['various', 'verschiedene', 'n/a', '-', '']);

// Hosts whose URL is nothing but an opaque redirect token.
//
// `to.indeed.com/aammllw8xckm` carries no posting id, no slug, no employer —
// the token IS the tracking parameter, and Indeed mints a different one for the
// same job in a different search. One sweep returned 29 rows that were 25 jobs:
// the same Siemens Werkstudent posting arrived three times under three tokens.
// URL canonicalisation structurally cannot collapse those, and
// extractPostingId() finds nothing to compare, so both existing guards pass
// them straight through to be evaluated two and three times over.
const OPAQUE_REDIRECT_HOSTS = ['to.indeed.com'];

function isOpaqueRedirect(url) {
  try {
    return OPAQUE_REDIRECT_HOSTS.some((h) => hostMatches(new URL(url).hostname, h));
  } catch {
    return false;
  }
}

/** Company + title, normalised — the only identity an opaque URL leaves us. */
function identityKey(offer) {
  const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(offer.company)}|${norm(offer.title)}`;
}

function hostMatches(hostname, needle) {
  const h = String(hostname || '').toLowerCase();
  return h === needle || h.endsWith(`.${needle}`);
}

function isListingHost(hostname) {
  return LISTING_HOSTS.some((h) => hostMatches(hostname, h));
}

/**
 * Extract a trailing numeric posting ID from a URL's path, e.g. the
 * `4378331224` in `/jobs/view/…-4378331224` or `/jobs/view/4378331224`.
 * Returns '' when the path does not end in a run of digits — most job boards
 * do not encode an ID this way, and that is fine: the duplicate-ID guard that
 * consumes this only needs to catch the case where it does.
 */
export function extractPostingId(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const m = path.match(/(\d{6,})$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Decide whether a single offer's URL is a real posting worth queuing, or a
 * listing/search/aggregator page that merely looks like one. Pure — does not
 * consult the batch or the dedup history, so it composes cleanly with both.
 *
 * @param {string} url - already-canonicalised URL
 * @param {object} offer - the offer this URL came from (reads `company`)
 * @param {{allowListing?: boolean}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function classifyIngestUrl(url, offer = {}, opts = {}) {
  const allowListing = Boolean(opts.allowListing);
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'unusable url' };
  }

  // Signal 2: a listing page has no single employer, so it gets stamped with
  // a placeholder company instead of a real one.
  const company = String(offer?.company ?? '').trim().toLowerCase();
  if (PLACEHOLDER_COMPANIES.has(company)) {
    return { ok: false, reason: `placeholder company ${JSON.stringify(offer?.company ?? '')} — a listing/aggregator page, not an employer posting` };
  }

  // Signal 3: career-advice/aggregator content on any host, not just the
  // listing hosts above.
  const path = u.pathname;
  if (/\/(career-advice|blog|news|guide)\//i.test(`${path}/`)) {
    return { ok: false, reason: `non-posting content path (${path})` };
  }

  // Signal 1: a listing/search path on a host known to mix the two.
  if (isListingHost(u.hostname) && !allowListing) {
    // `/jobs/view/{slug-}{id}` and `/jobs/view/{id}` are LinkedIn's genuine
    // single-posting shape — never swallow these.
    const isLinkedinPosting = hostMatches(u.hostname, 'linkedin.com') && /^\/jobs\/view\//i.test(path);
    if (!isLinkedinPosting) {
      if (/^\/jobs\/search\b/i.test(path)) {
        return { ok: false, reason: `listing/search path (${path}) — pass --allow-listing to override` };
      }
      for (const key of u.searchParams.keys()) {
        if (SEARCH_QUERY_KEYS.has(key.toLowerCase())) {
          return { ok: false, reason: `search query parameter "${key}" — pass --allow-listing to override` };
        }
      }
      // `{slug}-jobs-{place}` / `{slug}-jobs-in-{place}` and `{slug}-stellen`
      // are LinkedIn/XING's "browse jobs near X" slugs, not a posting slug.
      if (/-jobs-[^/]+$/i.test(path) || /(^|[/-])stellen(-|$)/i.test(path)) {
        return { ok: false, reason: `listing-page slug pattern (${path}) — pass --allow-listing to override` };
      }
      // wellfound's role-listing path.
      if (/^\/role\/l\//i.test(path)) {
        return { ok: false, reason: `wellfound role-listing path (${path}) — pass --allow-listing to override` };
      }
      // XING's tag-browse paths: `/jobs/t-{slug}` and `/jobs/k-student/…`.
      if (/^\/jobs\/t-/i.test(path) || /^\/jobs\/k-student\//i.test(path)) {
        return { ok: false, reason: `xing listing-page path (${path}) — pass --allow-listing to override` };
      }
    }
  }

  return { ok: true };
}

/**
 * Decide what to queue. Pure — the caller does the I/O.
 *
 * Every rejected row is reported, never dropped: `rejected` holds
 * classifyIngestUrl() failures (listing pages, placeholder companies,
 * aggregator content), `duplicateIds` holds rows caught by the same-posting-
 * ID-under-different-companies guard, both distinct from `invalid`
 * (malformed input) and `duplicates` (already-seen URLs).
 *
 * @param {object[]} offers
 * @param {Set<string>} seen
 * @param {{allowListing?: boolean}} [opts]
 * @returns {{queued: object[], duplicates: object[], invalid: object[], rejected: object[], duplicateIds: object[]}}
 */
export function planIngest(offers, seen, opts = {}) {
  const allowListing = Boolean(opts.allowListing);
  const queued = [];
  const duplicates = [];
  const invalid = [];
  const rejected = [];
  const duplicateIds = [];
  const batch = new Set();
  const candidates = [];

  for (const offer of Array.isArray(offers) ? offers : []) {
    if (!offer || typeof offer !== 'object') { invalid.push({ offer, reason: 'not an object' }); continue; }
    const url = canonicalUrl(offer.url);
    if (!url) { invalid.push({ offer, reason: 'missing or unusable url' }); continue; }
    if (seen.has(url)) { duplicates.push({ ...offer, url }); continue; }
    // Guard the batch against itself: one MCP call can return the same posting
    // twice across paginated pages.
    if (batch.has(url)) { duplicates.push({ ...offer, url }); continue; }

    const verdict = classifyIngestUrl(url, offer, { allowListing });
    if (!verdict.ok) { rejected.push({ ...offer, url, reason: verdict.reason }); continue; }

    batch.add(url);
    candidates.push({ ...offer, url });
  }

  // Opaque-redirect collapse: behind a pure tracking token, two rows with the
  // same employer AND the same title are indistinguishable to us — there is no
  // id, slug or path left to tell them apart. Keeping both means paying to
  // evaluate one job twice; collapsing risks missing a genuinely separate
  // requisition that shares a title. The tracker already has the answer for
  // that rare case (a req/posting ID in the notes column overrides fuzzy title
  // matching, see AGENTS.md), and nothing here can see a req ID, so the cheaper
  // mistake is the right one. Deliberately narrow: exact match, same batch,
  // and only for hosts that are pure redirectors.
  const seenIdentities = new Map();
  const afterCollapse = [];
  for (const o of candidates) {
    if (!isOpaqueRedirect(o.url)) { afterCollapse.push(o); continue; }
    const key = identityKey(o);
    if (seenIdentities.has(key)) {
      duplicates.push({ ...o, reason: `same company and title as ${seenIdentities.get(key)} behind an opaque redirect token` });
      continue;
    }
    seenIdentities.set(key, o.url);
    afterCollapse.push(o);
  }
  candidates.length = 0;
  candidates.push(...afterCollapse);

  // Duplicate-posting-ID guard: one extracted posting ID appearing under more
  // than one distinct company within this batch cannot be more than one real
  // job. Rather than guess which (if any) company is real, reject all of
  // them as unverifiable — this is what four LinkedIn URLs sharing job ID
  // 4384875844 under four different companies looked like.
  const companiesById = new Map();
  for (const o of candidates) {
    const id = extractPostingId(o.url);
    if (!id) continue;
    if (!companiesById.has(id)) companiesById.set(id, new Map());
    const companies = companiesById.get(id);
    const key = String(o.company ?? '').trim().toLowerCase();
    if (!companies.has(key)) companies.set(key, o.company ?? '');
  }
  const ambiguousIds = new Set(
    [...companiesById.entries()].filter(([, companies]) => companies.size > 1).map(([id]) => id)
  );

  for (const o of candidates) {
    const id = extractPostingId(o.url);
    if (id && ambiguousIds.has(id)) {
      const companies = [...companiesById.get(id).values()];
      duplicateIds.push({
        ...o,
        reason: `posting id ${id} claimed by ${companies.length} different companies in this batch (${companies.join(', ')}) — unverifiable, rejected`,
      });
    } else {
      queued.push(o);
    }
  }

  return { queued, duplicates, invalid, rejected, duplicateIds };
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
        'allow-listing': { type: 'boolean', default: false },
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
    console.log(`Usage: node ingest-jobs.mjs --file <offers.json> --source <label> [--dry-run] [--allow-listing]

  --file           JSON array of {url, company, title, location?, postedAt?}
  --source         where these came from, recorded on each row (e.g. indeed-mcp)
  --dry-run        print what would be queued, write nothing
  --allow-listing  don't reject LinkedIn/XING/wellfound listing-page URLs
                   (search paths, browse-jobs-near-X slugs); everything else
                   this script rejects (placeholder company, blog/career-advice
                   content, ambiguous duplicate posting IDs) still is

Dedups against data/scan-history.tsv and the inbox. Rejects listing/search
pages, aggregator content, placeholder companies, and same-ID-different-company
rows so a search-results page never lands in the inbox as if it were a
posting — every rejection is counted and reported below, never dropped
silently. Queues only; never evaluates or submits.`);
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
  const allowListing = Boolean(values['allow-listing']);
  const { queued, duplicates, invalid, rejected, duplicateIds } = planIngest(
    offers,
    knownUrls(historyText, pipelineText),
    { allowListing }
  );

  const today = new Date().toISOString().slice(0, 10);
  const rows = queued.map((o) => renderRow(o, source, today));

  if (!values['dry-run'] && rows.length) {
    mkdirSync(dirname(PIPELINE_PATH), { recursive: true });
    const tmp = `${PIPELINE_PATH}.tmp`;
    writeFileSync(tmp, insertPending(pipelineText, rows), 'utf-8');
    renameSync(tmp, PIPELINE_PATH);
    // Record in scan-history so the next scan of ANY source dedups against these.
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    // Write the columns scan-history actually has, not just the first four.
    //
    // This used to stop after `title`, dropping company, location and posted_at
    // even though every one of them is sitting on the offer object. The cost is
    // not cosmetic and it is invisible: `data/blacklist.md` matching and
    // `providers/_trust-validator.mjs`'s company-vs-hostname check both key on
    // company, so every agent-ingested row silently bypassed both, and losing
    // posted_at removes the staleness signal that stops a two-year-old listing
    // being read as fresh. Caught by provider-health.mjs on its first real run:
    // indeed-mcp showed empty_company on 5/5 rows.
    //
    // Column order is scan.mjs's header: url, first_seen, portal, title,
    // company, status, location, fingerprint, posted_at, trust_score,
    // trust_flags, normalized_company. The trailing scoring columns are left
    // empty — they are the scanner's to compute, and a fabricated trust score
    // would be worse than an absent one.
    const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
    appendFileSync(HISTORY_PATH, queued.map((o) => [
      o.url, today, source, cell(o.title), cell(o.company), 'added',
      cell(o.location), '', cell(o.postedAt), '', '', cell(o.company).toLowerCase(),
    ].join('\t') + '\n').join(''), 'utf-8');
  }

  console.log(JSON.stringify({
    source,
    in: Array.isArray(offers) ? offers.length : 0,
    queued: rows.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    rejected: rejected.length,
    duplicateIds: duplicateIds.length,
    allowListing,
    dryRun: Boolean(values['dry-run']),
    rows: rows.slice(0, 20),
    invalidReasons: invalid.slice(0, 5).map((i) => i.reason),
    rejectedReasons: rejected.map((r) => `${r.company || '?'} — ${r.url} — ${r.reason}`),
    duplicateIdReasons: duplicateIds.map((r) => `${r.company || '?'} — ${r.url} — ${r.reason}`),
  }, null, 2));

  if (rejected.length) {
    console.log(`\n${rejected.length} row(s) rejected as non-postings (listing/search pages, placeholder companies, aggregator content):`);
    for (const r of rejected) console.log(`  - ${r.company || '?'} | ${r.url} | ${r.reason}`);
    if (!allowListing) console.log('  Pass --allow-listing to let listing-page URLs through deliberately.');
  }
  if (duplicateIds.length) {
    console.log(`\n${duplicateIds.length} row(s) rejected as an ambiguous duplicate posting ID (same ID, different companies, unverifiable):`);
    for (const r of duplicateIds) console.log(`  - ${r.company || '?'} | ${r.url} | ${r.reason}`);
  }

  console.log('\nQueued only — nothing evaluated, nothing submitted. Next: /career-ops pipeline');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/file:\/\/([A-Za-z]:)/, 'file:///$1')) {
  main();
} else if (process.argv[1] && process.argv[1].endsWith('ingest-jobs.mjs')) {
  main();
}
