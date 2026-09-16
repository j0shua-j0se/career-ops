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
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractReqNumber, REQ_NUMBER_RE } from './tracker-parse.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { stripStepstoneInlineSuffix } from './url-key.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(CAREER_OPS, 'data', 'pipeline.md');
const HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || join(CAREER_OPS, 'data', 'scan-history.tsv');
// Per-query yield log consumed by websearch-plan.mjs's rotation/retirement.
// Additive: an offer with no `query` field never touches this file.
const YIELD_PATH = process.env.CAREER_OPS_WEBSEARCH_YIELD || join(CAREER_OPS, 'data', 'websearch-yield.tsv');
// Same resolver verify-pipeline.mjs/merge-tracker.mjs use, so CAREER_OPS_TRACKER
// and the data/applications.md-vs-applications.md fallback behave identically here.
const APPLICATIONS_PATH = resolveTrackerPath(CAREER_OPS);
// A scan-history sighting older than this is stale enough that a repost is a
// legitimate new listing, not evidence of the same still-open requisition.
const TITLE_DUP_HISTORY_MAX_AGE_DAYS = 90;

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
  // A StepStone repost can arrive re-scraped under the -inline (embedded/
  // iframe) rendering of a posting already queued or in scan-history under
  // its plain URL — same numeric posting id, so collapse them before the
  // dedup check runs. See url-key.mjs's stripStepstoneInlineSuffix doc.
  stripStepstoneInlineSuffix(u);
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
function identityKeyOf(company, title) {
  const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(company)}|${norm(title)}`;
}

function identityKey(offer) {
  return identityKeyOf(offer.company, offer.title);
}

/**
 * Company+title of everything already seen that arrived behind an opaque
 * redirect, so a LATER sweep cannot re-queue the same job under a fresh token.
 *
 * Indeed mints a new token per search, which makes the URL guard useless across
 * runs: tomorrow's sweep of the same board yields different URLs for the same
 * postings, every one of them unseen. Without this the inbox grows a fresh copy
 * on every pass. Observed immediately — running the same sweep file through
 * ingest twice queued three jobs that were already in the inbox, because the
 * rows dropped as URL-duplicates never registered their identity and their
 * sibling tokens then looked new.
 *
 * Only redirector rows are indexed. A real board's URL carries identity, and
 * indexing those by company+title would refuse a genuinely separate
 * requisition that happens to share a title.
 */
export function knownRedirectIdentities(historyText = '', pipelineText = '') {
  const seen = new Set();
  for (const line of String(historyText).split('\n')) {
    const col = line.split('\t');
    // scan-history.tsv: url, first_seen, portal, title, company, ...
    if (col.length < 5 || !isOpaqueRedirect(col[0])) continue;
    seen.add(identityKeyOf(col[4], col[3]));
  }
  // Inbox rows are `- [ ] {url} | {company} | {title} | ...`.
  for (const line of String(pipelineText).split('\n')) {
    const m = line.match(/^- \[[ x]\]\s+(\S+)\s*\|\s*([^|]*)\|\s*([^|]*)/);
    if (!m || !isOpaqueRedirect(m[1])) continue;
    seen.add(identityKeyOf(m[2], m[3]));
  }
  return seen;
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

// ── Company + title duplicate guard ──────────────────────────────────────
//
// The opaque-redirect collapse above only catches a repost that ALSO landed
// behind an opaque token last time. On 2026-09-14 three already-decided roles
// came back through Indeed anyway: Primetals "Werkstudent (m/w/d) im Bereich
// Künstliche Intelligenz" (tracker #5, Rejected), SUXXEED "Werkstudent (m/w/d)
// AI Engineering" (triaged FAIL the day before) and CHECK24 "(Junior) Data
// Scientist (m/f/d) Search / AI Forge" (triaged FAIL two days before) — none
// of their EXISTING rows were themselves behind an opaque redirect, so
// knownRedirectIdentities() never indexed them and a fresh Indeed token read
// as new. Two gaps, not one: applications.md (the actual decision record) was
// never consulted at all, and the identity index required BOTH sides to be
// opaque.
//
// This is a second, independent guard: company+title match against
// applications.md (every row, pending AND decided), pipeline.md (pending AND
// processed) and scan-history.tsv (sightings within the last
// TITLE_DUP_HISTORY_MAX_AGE_DAYS days), gated to avoid the false positive
// AGENTS.md itself warns about — two genuinely different requisitions at one
// employer sharing a title (see the Primetals #5/#16 KI vs DevOps-MLOps
// pair). A req/job ID recognized by REQ_NUMBER_RE (tracker-parse.mjs) on BOTH
// sides that disagrees is proof the rows are distinct and always wins.

// Legal-entity suffixes stripped from a company name before duplicate
// comparison, longest-first so a compound form is consumed whole. Mirrors
// verify-pipeline.mjs's own LEGAL_FORMS list (kept local rather than
// imported: verify-pipeline.mjs runs its health-check scan as an import-time
// side effect, which would make every ingest run re-scan the reports
// directory). "Group"/"Gruppe" are included per this guard's own spec, not
// because they are a legal form.
const COMPANY_DUP_LEGAL_FORMS = [
  'GmbH & Co\\.? KG', 'GmbH', 'mbH', 'AG', 'SE', 'KGaA', 'KG',
  'e\\.V\\.', 'eG', 'Gruppe', 'Group',
  'Ltd\\.', 'Ltd', 'Limited', 'Inc\\.', 'Inc',
].sort((a, b) => b.length - a.length);
const COMPANY_DUP_LEGAL_FORM_RE = new RegExp(`,?\\s*(?:${COMPANY_DUP_LEGAL_FORMS.join('|')})\\.?\\s*$`, 'i');

function stripCompanyDupLegalForm(s) {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(COMPANY_DUP_LEGAL_FORM_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** ä/ö/ü/ß -> ae/oe/ue/ss — the transliteration verify-pipeline.mjs's
 * roleTokenSet() already uses so "Künstliche" and "Kuenstliche" (one from a
 * board that serves umlauts, one deslugged from a URL that can't) key alike. */
function foldGermanDiacritics(s) {
  return String(s ?? '')
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

/** Company name -> normalised space-joined token string for duplicate matching. */
export function normalizeCompanyForDup(raw) {
  let s = String(raw ?? '').replace(/\([^)]*\)/g, ' '); // drop parentheticals
  s = stripCompanyDupLegalForm(s);
  s = foldGermanDiacritics(s);
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return s;
}

/**
 * Same-employer test for the duplicate guard: equal normalised keys always
 * match; otherwise one side's tokens must be a whole-token prefix of the
 * other's (min 3 characters), so "CHECK24" matches "CHECK24 Services
 * Personal GmbH" and "SUXXEED" matches "SUXXEED Sales for your Success
 * GmbH" without a bare "Co" or "AI" matching everything. Same convention as
 * verify-pipeline.mjs's companyKeysMatch (Check 15) — kept local for the same
 * import-time-side-effect reason as the legal-forms list above.
 */
export function companyDupMatch(a, b) {
  const ta = normalizeCompanyForDup(a).split(' ').filter(Boolean);
  const tb = normalizeCompanyForDup(b).split(' ').filter(Boolean);
  const ka = ta.join('');
  const kb = tb.join('');
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length < 3 || kb.length < 3) return false;
  const isPrefix = (short, long) =>
    short.length > 0 && short.length <= long.length && short.every((t, i) => t === long[i]);
  return isPrefix(ta, tb) || isPrefix(tb, ta);
}

const GENDER_MARKER_RE = /\(\s*[mwfdxsg](?:\s*[/,]\s*[mwfdxsg]){1,}\s*\)/gi;
const GENDER_PHRASE_RE = /\((?:all genders?|any gender|divers)\)/gi;
// Matched globally so an inline req/job ID (a title occasionally carries one
// straight from the board, e.g. "Senior Engineer (Job ID 44444)") does not
// make two otherwise-identical titles key differently — the ID is compared
// separately (findTitleDuplicate reads it via extractReqNumber on the RAW
// title, before this strip runs) and is exactly what should decide same vs.
// different, not an accident of whether the digits happen to differ.
const TITLE_REQ_ID_RE = new RegExp(REQ_NUMBER_RE.source, 'gi');

/** Title -> normalised string for duplicate matching: gender markers in every
 * order/letter-set the market uses gone, an inline req/job ID gone, umlauts
 * folded, punctuation and case folded, whitespace collapsed. */
export function normalizeTitleForDup(raw) {
  let s = String(raw ?? '').replace(GENDER_MARKER_RE, ' ').replace(GENDER_PHRASE_RE, ' ').replace(TITLE_REQ_ID_RE, ' ');
  s = foldGermanDiacritics(s);
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return s;
}

/**
 * Whether `url` is the kind of aggregator/tracking link that mints a fresh
 * URL for the same posting on every search — Indeed's `to.indeed.com` token
 * and `indeed.com/viewjob` results page, or a LinkedIn/XING/wellfound listing
 * (reuses OPAQUE_REDIRECT_HOSTS and LISTING_HOSTS above rather than a new
 * list). A direct employer career-site URL never counts, even when it also
 * happens to duplicate a title — that is the false-positive AGENTS.md warns
 * about, and the req-ID veto below is what actually settles those.
 */
export function isAggregatorTrackingUrl(url) {
  if (isOpaqueRedirect(url)) return true;
  try {
    const u = new URL(url);
    if (hostMatches(u.hostname, 'indeed.com') && /^\/viewjob\/?$/i.test(u.pathname)) return true;
    if (isListingHost(u.hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Build the company+title duplicate index from every source AGENTS.md treats
 * as a record of a posting already seen: applications.md (the tracker — full
 * table, pending AND decided rows), pipeline.md (pending AND processed inbox
 * rows) and scan-history.tsv (scanner sightings within the last
 * TITLE_DUP_HISTORY_MAX_AGE_DAYS days). Ordered tracker-first: it is the most
 * authoritative source (an actual decision, not just a sighting), so it wins
 * the reported reference when a row appears in more than one place.
 *
 * @param {string} historyText
 * @param {string} pipelineText
 * @param {string} applicationsText
 * @param {{today?: string|Date}} [opts]
 * @returns {Array<{company: string, title: string, reqId: string|null, reference: string}>}
 */
export function buildTitleDupIndex(historyText = '', pipelineText = '', applicationsText = '', opts = {}) {
  const entries = [];

  const appLines = String(applicationsText).split(/\r?\n/);
  const colmap = resolveColumns(appLines);
  for (const line of appLines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || !row.company?.trim() || !row.role?.trim()) continue;
    const status = String(row.status ?? '').replace(/\*\*/g, '').trim();
    entries.push({
      company: row.company,
      title: row.role,
      reqId: extractReqNumber(row.notes),
      reference: `tracker #${row.num}${status ? ` (${status})` : ''}`,
    });
  }

  // Inbox rows: `- [ ]`/`- [x]`/`- [!]` {url} | {company} | {title} | ...
  for (const line of String(pipelineText).split(/\r?\n/)) {
    const m = line.match(/^-\s*\[([ x!])\]\s+(\S+)\s*\|\s*([^|]*)\|\s*([^|]*)\|?(.*)$/);
    if (!m) continue;
    const [, box, , company, title, rest] = m;
    if (!company.trim() || !title.trim()) continue;
    entries.push({
      company: company.trim(),
      title: title.trim(),
      reqId: extractReqNumber(`${title} ${rest}`),
      reference: box === ' ' ? 'pipeline pending row' : 'pipeline processed row',
    });
  }

  const today = opts.today ? new Date(opts.today) : new Date();
  const cutoff = new Date(today.getTime() - TITLE_DUP_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  for (const line of String(historyText).split(/\r?\n/)) {
    const col = line.split('\t');
    // url, first_seen, portal, title, company, ...
    if (col.length < 5) continue;
    const [, firstSeen, , title, company] = col;
    if (!company?.trim() || !title?.trim()) continue;
    const seenDate = new Date(firstSeen);
    if (isNaN(seenDate.getTime()) || seenDate < cutoff) continue;
    entries.push({
      company: company.trim(),
      title: title.trim(),
      reqId: extractReqNumber(title),
      reference: `scan-history ${firstSeen}`,
    });
  }

  return entries;
}

/**
 * Check one offer against the duplicate index built by buildTitleDupIndex().
 * Pure. Returns the first confident match, or null.
 *
 * @param {object} offer - reads `company`, `title`, `url`
 * @param {Array<{company:string, title:string, reqId:string|null, reference:string}>} entries
 * @returns {{entry: object, reason: string}|null}
 */
export function findTitleDuplicate(offer, entries) {
  const titleKey = normalizeTitleForDup(offer.title);
  if (!titleKey) return null;
  const reqIncoming = extractReqNumber(offer.title);
  const aggregator = isAggregatorTrackingUrl(offer.url);
  for (const entry of entries) {
    if (!companyDupMatch(offer.company, entry.company)) continue;
    if (normalizeTitleForDup(entry.title) !== titleKey) continue;
    // Both sides carry a recognizable req/job ID and they disagree: proof of
    // two distinct requisitions (the Primetals #5/#16 case) — never a dup.
    if (reqIncoming && entry.reqId && reqIncoming !== entry.reqId) continue;
    if (aggregator) {
      return { entry, reason: `same company and title as ${entry.reference} behind an aggregator/tracking URL` };
    }
    if (!entry.reqId) {
      return { entry, reason: `same company and title as ${entry.reference} (no distinguishing req/job ID on the existing row)` };
    }
    // Existing row DOES carry a req ID and the incoming offer names none, and
    // the URL is a direct employer link — not confident enough to collapse;
    // keep looking in case a later entry is.
  }
  return null;
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
 * @param {{allowListing?: boolean, titleDupIndex?: object[], allowTitleDups?: boolean}} [opts]
 * @returns {{queued: object[], duplicates: object[], invalid: object[], rejected: object[], duplicateIds: object[], duplicateTitle: object[]}}
 */
export function planIngest(offers, seen, opts = {}) {
  const allowListing = Boolean(opts.allowListing);
  const allowTitleDups = Boolean(opts.allowTitleDups);
  const queued = [];
  const duplicates = [];
  const invalid = [];
  const rejected = [];
  const duplicateIds = [];
  const duplicateTitle = [];
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
  // Seeded from three places, because a token that looks new is not evidence
  // the job is:
  //   1. identities already in history/inbox behind a redirector (opts.seenIdentities),
  //      so tomorrow's freshly-minted tokens do not re-queue today's jobs;
  //   2. rows just dropped as URL duplicates — their identity is spoken for even
  //      though they are not in `candidates`. Missing this is what let a
  //      re-run of the same sweep file queue three jobs already in the inbox;
  //   3. the surviving candidates themselves, in order.
  const seenIdentities = new Map();
  for (const key of opts.seenIdentities ?? []) seenIdentities.set(key, 'a previously seen posting');
  for (const d of duplicates) {
    if (isOpaqueRedirect(d.url)) seenIdentities.set(identityKey(d), d.url);
  }
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

  // Company+title duplicate guard: catches a repost the opaque-redirect
  // collapse above cannot, because the EXISTING sighting was never itself
  // behind an opaque token (a tracker row, or a plain-URL scan/pipeline row).
  // See findTitleDuplicate()'s header for the exact matching rule and the
  // false positive it is built to avoid. `--allow-title-dups` bypasses this
  // guard entirely; everything else in planIngest is unaffected by it.
  if (!allowTitleDups && Array.isArray(opts.titleDupIndex) && opts.titleDupIndex.length) {
    const survivors = [];
    for (const o of candidates) {
      const match = findTitleDuplicate(o, opts.titleDupIndex);
      if (match) duplicateTitle.push({ ...o, reason: match.reason });
      else survivors.push(o);
    }
    candidates.length = 0;
    candidates.push(...survivors);
  }

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

  return { queued, duplicates, invalid, rejected, duplicateIds, duplicateTitle };
}

/**
 * Per-query yield breakdown for a planIngest() result — the record
 * websearch-plan.mjs needs to tell a productive `site:`/Indeed query from a
 * dead one instead of rotating purely by staleness.
 *
 * Entries without a `query` field (the vast majority of historical offers,
 * and anything from a source that doesn't tag one) are silently excluded —
 * additive only, never a behavior change for callers that don't set it.
 *
 * @param {object[]} offers - the raw input array, read for `.query`
 * @param {{queued: object[], duplicates: object[], duplicateTitle: object[]}} result
 * @returns {Array<{query:string, leads:number, queuedNew:number, dupUrl:number, dupTitle:number}>}
 */
export function computeQueryYield(offers, result) {
  const queryOf = (o) => (typeof o?.query === 'string' ? o.query.trim() : '');
  const countBy = (arr) => {
    const m = new Map();
    for (const o of Array.isArray(arr) ? arr : []) {
      const q = queryOf(o);
      if (!q) continue;
      m.set(q, (m.get(q) ?? 0) + 1);
    }
    return m;
  };
  const leadsByQuery = countBy(offers);
  const queuedByQuery = countBy(result?.queued);
  const dupUrlByQuery = countBy(result?.duplicates);
  const dupTitleByQuery = countBy(result?.duplicateTitle);

  return [...leadsByQuery.keys()].sort().map((query) => ({
    query,
    leads: leadsByQuery.get(query) ?? 0,
    queuedNew: queuedByQuery.get(query) ?? 0,
    dupUrl: dupUrlByQuery.get(query) ?? 0,
    dupTitle: dupTitleByQuery.get(query) ?? 0,
  }));
}

/**
 * Append one TSV row per query to data/websearch-yield.tsv:
 * date, query, source, leads, queued_new, dup_url, dup_title.
 *
 * @param {Array<{query:string, leads:number, queuedNew:number, dupUrl:number, dupTitle:number}>} rows
 * @param {{source:string, today:string, path?:string}} opts
 */
export function appendYieldLog(rows, { source, today, path = YIELD_PATH } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  mkdirSync(dirname(path), { recursive: true });
  const lines = rows.map((r) => [
    today, cell(r.query), cell(source), r.leads, r.queuedNew, r.dupUrl, r.dupTitle,
  ].join('\t') + '\n').join('');
  appendFileSync(path, lines, 'utf-8');
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
        'allow-title-dups': { type: 'boolean', default: false },
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
    console.log(`Usage: node ingest-jobs.mjs --file <offers.json> --source <label> [--dry-run] [--allow-listing] [--allow-title-dups]

  --file              JSON array of {url, company, title, location?, postedAt?}
  --source            where these came from, recorded on each row (e.g. indeed-mcp)
  --dry-run           print what would be queued, write nothing
  --allow-listing     don't reject LinkedIn/XING/wellfound listing-page URLs
                      (search paths, browse-jobs-near-X slugs); everything else
                      this script rejects (placeholder company, blog/career-advice
                      content, ambiguous duplicate posting IDs) still is
  --allow-title-dups  don't reject rows matching an existing company+title
                      (applications.md, pipeline.md, recent scan-history.tsv)
                      behind an aggregator/tracking URL or with no distinguishing
                      req ID; everything else this script rejects still is

Dedups against data/scan-history.tsv and the inbox by URL, PLUS company+title
against applications.md/pipeline.md/scan-history.tsv so a fresh Indeed tracking
token on an already-decided posting doesn't read as new. Rejects listing/search
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
  const applicationsText = existsSync(APPLICATIONS_PATH) ? readFileSync(APPLICATIONS_PATH, 'utf-8') : '';
  const allowListing = Boolean(values['allow-listing']);
  const allowTitleDups = Boolean(values['allow-title-dups']);
  const { queued, duplicates, invalid, rejected, duplicateIds, duplicateTitle } = planIngest(
    offers,
    knownUrls(historyText, pipelineText),
    {
      allowListing,
      allowTitleDups,
      seenIdentities: knownRedirectIdentities(historyText, pipelineText),
      titleDupIndex: buildTitleDupIndex(historyText, pipelineText, applicationsText),
    },
  );

  const today = new Date().toISOString().slice(0, 10);
  const rows = queued.map((o) => renderRow(o, source, today));
  const queryYield = computeQueryYield(offers, { queued, duplicates, duplicateTitle });

  if (!values['dry-run'] && queryYield.length) {
    appendYieldLog(queryYield, { source, today });
  }

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
    duplicateTitle: duplicateTitle.length,
    queryYield,
    allowListing,
    allowTitleDups,
    dryRun: Boolean(values['dry-run']),
    rows: rows.slice(0, 20),
    invalidReasons: invalid.slice(0, 5).map((i) => i.reason),
    rejectedReasons: rejected.map((r) => `${r.company || '?'} — ${r.url} — ${r.reason}`),
    duplicateIdReasons: duplicateIds.map((r) => `${r.company || '?'} — ${r.url} — ${r.reason}`),
    duplicateTitleReasons: duplicateTitle.map((r) => `${r.company || '?'} | ${r.title || '?'} — ${r.reason}`),
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
  if (duplicateTitle.length) {
    console.log(`\n${duplicateTitle.length} row(s) skipped as a company+title duplicate of an existing tracker/pipeline/scan-history row:`);
    for (const r of duplicateTitle) console.log(`  - ${r.company || '?'} | ${r.title || '?'} | ${r.url} | ${r.reason}`);
    if (!allowTitleDups) console.log('  Pass --allow-title-dups to queue these anyway.');
  }

  console.log('\nQueued only — nothing evaluated, nothing submitted. Next: /career-ops pipeline');
}

if (isMainModule(import.meta.url)) {
  main();
}
