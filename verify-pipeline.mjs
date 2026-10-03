#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks:
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores match format X.XX/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. states.yml canonical IDs for cross-system consistency
 * 8. Stale report-number reservation sentinels are garbage-collected
 * 9. No two report files cover the same company+role (warning — see #1425)
 * 10. Every report file has a tracker row referencing it (warning — see #1425)
 * 11. Via channel consistency (see #1596)
 * 12. No # value reused across 2+ tracker rows (error — see #1704)
 * 13. applications.md <-> active-interviews.md status sync (see #1504)
 * 14. data/follow-ups.md table schema (see #2971)
 * 15. portals.yml entries no provider claims (see #3251)
 * 16. No invisible control characters in tracker cells (error — see #3892)
 * 17. Every report carries a parseable Machine Summary with a score: field (warning)
 * 18. Duplicate reports hidden behind an employer-name variant, a shared req/job/
 *     posting ID, or an identical posting URL (warning — see the ZEISS 012/043 gap)
 * 19. Duplicate tracker rows in the window before a report exists (warning)
 * 20. Open tracker rows (status still Evaluated) pointing at a blocked
 *     job-board host, e.g. stepstone.de (warning)
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import {
  looksLikeScoreCell, isSeparatorRow, isHeaderRow, resolveColumns,
  normalizeTextKey, normalizeVia,
} from './tracker-parse.mjs';
import { REQ_NUMBER_RE } from './tracker-parse.mjs';
import { CONTROL_CHARS } from './tracker-utils.mjs';
import { checkTrackerSync, loadLifecycle, normalizeStatus } from './tracker-sync-check.mjs';
import { checkFollowupsSchema } from './stats.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
// CAREER_OPS_REPORTS overrides the reports dir (used by tests, mirrors CAREER_OPS_TRACKER).
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS
  ? resolve(CAREER_OPS, process.env.CAREER_OPS_REPORTS)
  : join(CAREER_OPS, 'reports');
const STATES_FILE = existsSync(join(CODE_ROOT, 'templates/states.yml'))
  ? join(CODE_ROOT, 'templates/states.yml')
  : join(CODE_ROOT, 'states.yml');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip', 'hired',
];

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated', 'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied', 'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded', 'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
  'contratado': 'hired', 'contratada': 'hired', 'hired': 'hired', 'accepted': 'hired', 'accept': 'hired',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Map columns by header name so the checks work whether the tracker uses the
// original 9-column layout or a customized one with an extra column (e.g. a
// Location column after Role). Fixed-position indexing would otherwise read
// Location where Score is expected and flag false errors. Falls back to the
// legacy fixed layout when no recognizable header row is found.
//
// Sourced from tracker-parse.mjs rather than re-declared here: this file used
// to carry its own copy of LEGACY_COLMAP, HEADER_ALIASES and detectColumns, so
// a fix to the shared module left verify-pipeline reading a different layout
// than merge-tracker wrote — the drift tracker-parse.mjs exists to prevent, and
// the same half-application #1291 was filed for.
const COLMAP = resolveColumns(lines);
const MAX_IDX = Math.max(...Object.values(COLMAP));

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= MAX_IDX) continue;
  const num = parseInt(parts[COLMAP.num]);
  if (isNaN(num)) continue;
  entries.push({
    num,
    date: parts[COLMAP.date],
    company: parts[COLMAP.company],
    via: COLMAP.via != null ? parts[COLMAP.via] : '',
    role: parts[COLMAP.role],
    location: COLMAP.location != null ? parts[COLMAP.location] : '',
    score: parts[COLMAP.score],
    status: parts[COLMAP.status],
    pdf: parts[COLMAP.pdf],
    report: parts[COLMAP.report],
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
    url: COLMAP.url != null ? (parts[COLMAP.url] || '') : '',
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  // Unicode-aware (#2393): an [a-z0-9] strip erases non-Latin scripts outright,
  // so every Japanese company and every Japanese role keyed to '' and unrelated
  // rows were reported as "possible duplicates".
  const key = normalizeTextKey(e.company) + '::' + normalizeTextKey(e.role);
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
// A row that has been Discarded or SKIPped is a duplicate that has ALREADY been
// resolved — discarding one of the pair is exactly how it gets fixed here, and
// there is no other way to fix it, because the rows themselves are the audit
// trail. Counting resolved rows made the warning outlive its own fix and fire
// forever, which is how a health check teaches its reader to skim. The same
// rule already governs the report-level duplicate check and the unreported-row
// check further down; this was the third and last place missing it.
//
// Filtering happens per GROUP rather than per pair: three rows for one posting
// with one Discarded still leave two live ones, and that is still a real
// duplicate worth reporting.
const RESOLVED = new Set(['Discarded', 'SKIP']);
for (const [key, group] of companyRoleMap) {
  const live = group.filter((e) => !RESOLVED.has(String(e.status || '').trim()));
  if (live.length > 1) {
    warn(`Possible duplicates: ${live.map(e => `#${e.num}`).join(', ')} (${live[0].company} — ${live[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
// Markdown links resolve relative to the file that contains them, so report
// links must resolve against the tracker's own directory (see #760). For the
// transition we also accept legacy root-relative links: try the tracker dir
// first, then fall back to the repo root before flagging a link broken.
const TRACKER_DIR = dirname(APPS_FILE);
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const link = match[1];
  if (!existsSync(join(TRACKER_DIR, link)) && !existsSync(join(CAREER_OPS, link))) {
    error(`#${e.num}: Report not found: ${link}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 3b: `Evaluated` without a report ---
// templates/states.yml defines Evaluated as "Report completed, pending
// decision". A row can reach that status WITHOUT a report: the scan loop's
// `finish` promotes triage-qualified candidates straight into the tracker with
// a score and no evaluation behind it. The notes say "triage-only", but the
// STATUS claims a report exists, and check 3 above only validates links that
// are present — an absent link passes silently.
//
// Reported as a warning, not an error: promoting is legitimate and the row is
// a real lead. What is not acceptable is the tracker asserting a completed
// evaluation that nothing has to back up, which is how a score with no
// reasoning behind it ends up driving a kit build.
let evaluatedWithoutReport = 0;
for (const e of entries) {
  if (!/^evaluated$/i.test(String(e.status || '').trim())) continue;
  const hasLink = /\]\(([^)]+)\)/.test(e.report || '');
  if (!hasLink) {
    warn(`#${e.num}: status "Evaluated" but no report link — triage score only, evaluation still owed`);
    evaluatedWithoutReport++;
  }
}
if (evaluatedWithoutReport === 0) ok('Every Evaluated row has a report behind it');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  if (!looksLikeScoreCell(e.score)) {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (isSeparatorRow(line) || isHeaderRow(line)) continue;
  const parts = line.split('|');
  if (parts.length <= MAX_IDX) {
    error(`Row with too few columns (need ${MAX_IDX} data cols): ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Check 8: Stale report-number sentinels (GC) ---
// reserve-report-num.mjs drops NNN-RESERVED.md files in reports/ when a
// number is claimed.  If the process crashed before writing the real report
// and deleting the sentinel it will linger.  Sentinels older than 4 h are
// stale; remove them here so they don't skew the next slot allocation.
const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
let staleSentinels = 0;
if (existsSync(REPORTS_DIR)) {
  const now = Date.now();
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > SENTINEL_MAX_AGE_MS) {
        unlinkSync(full);
        warn(`Removed stale reservation sentinel: ${name}`);
        staleSentinels++;
      }
    } catch {
      // Already gone between readdir and stat — fine.
    }
  }
}
if (staleSentinels === 0) ok('No stale reservation sentinels');

// --- Check 9: Duplicate reports for the same company+role (#1425) ---
// Two concurrent evaluators can each write a report for the same role.
// merge-tracker dedups the TRACKER, but nothing watched reports/ itself.
// Warning-level, not error: duplicates can be legitimate (re-evaluation
// after a JD change).
const REPORT_FILE_RE = /^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/;
// Shares normalizeTextKey with Check 2 so a report pair and a tracker pair
// can never disagree about whether two roles are the same (#2393).

// Machine Summary YAML fence matcher, shared by extractRole() below and
// Check 13 further down so the two can never quietly drift on what counts
// as "the fence" — the same shape analyze-patterns.mjs's parseMachineSummary()
// uses. Returns the regex match (group 1 is the raw fence body) or null.
function matchMachineSummaryFence(reportContent) {
  return reportContent.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
}

// Shares normalizeTextKey with Check 2 so the two checks fold text the same
// way (#2393). That is where the guarantee ends: this check keys off the
// FILENAME slug, already ASCII by the time a report is written, while Check 2
// keys off the tracker's Company column with the original spelling intact. So
// the two can and do disagree — `İstanbul Tekstil` vs `Istanbul Tekstil` is
// flagged here and not there, because the dotted I survives in one input and
// not the other. Sharing a normalizer is not sharing a contract when the
// callers feed it different things. Pinned in test-all.mjs.
const normalizeKey = normalizeTextKey;

// Role comes from the report body: the Machine Summary YAML fence when
// present (field names are exact by contract), else the title line
// "# Evaluación: {Company} — {Role}". Reports where neither parses are
// skipped rather than grouped by company alone, which would false-positive
// on two different roles at the same company.
function extractRole(reportContent) {
  const fence = matchMachineSummaryFence(reportContent);
  if (fence) {
    const m = fence[1].match(/^role:\s*["']?(.+?)["']?\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  const title = reportContent.split('\n').find(l => l.startsWith('# '));
  if (title) {
    const parts = title.split(/[—–]/);
    if (parts.length >= 2 && parts[parts.length - 1].trim()) return parts[parts.length - 1].trim();
  }
  return null;
}

// Company, mirroring extractRole() above: Machine Summary `company:` field
// first (exact by contract), else the title line's lead segment before the
// em/en dash, with the "# Evaluación: " / "# Evaluation: " style prefix
// stripped. Used by Check 14 below, which needs the company text as WRITTEN
// (legal-form suffixes and parenthetical qualifiers intact) so its own
// normalizer can strip them — collapsing here would hide the very variation
// Check 14 exists to catch.
function extractCompany(reportContent) {
  const fence = matchMachineSummaryFence(reportContent);
  if (fence) {
    const m = fence[1].match(/^company:\s*["']?(.+?)["']?\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  const title = reportContent.split('\n').find(l => l.startsWith('# '));
  if (title) {
    const parts = title.split(/[—–]/);
    if (parts.length >= 2 && parts[0].trim()) {
      return parts[0].replace(/^#\s*[^:]*:\s*/, '').trim();
    }
  }
  return null;
}

const reportFiles = existsSync(REPORTS_DIR)
  ? readdirSync(REPORTS_DIR).filter(f => REPORT_FILE_RE.test(f))
  : [];

let dupReports = 0;
const reportsByRole = new Map();
for (const name of reportFiles) {
  const companySlug = name.match(REPORT_FILE_RE)[2];
  let role = null;
  try {
    role = extractRole(readFileSync(join(REPORTS_DIR, name), 'utf-8'));
  } catch {
    // Unreadable report — the orphan check below still sees it.
  }
  if (!role) continue;
  const key = normalizeKey(companySlug) + '::' + normalizeKey(role);
  if (!reportsByRole.has(key)) reportsByRole.set(key, []);
  reportsByRole.get(key).push(name);
}
for (const group of reportsByRole.values()) {
  if (group.length > 1) {
    warn(`Duplicate reports for same company+role: ${group.join(', ')}`);
    dupReports++;
  }
}
if (dupReports === 0) ok('No duplicate reports for the same company+role');

// --- Check 10: Orphan reports with no tracker row (#1425) ---
// Every reports/NNN-*.md should be referenced by a tracker row — by the
// [NNN] link text(s), the NNN- prefix of the linked filename(s), or (only when
// the cell carries no markdown link at all) the row's own number.
//
// The row's own number is a LAST RESORT, not a standing signal. Tracker row
// numbers and report numbers are independent counters that diverge in normal
// operation — #1733 established that a reserved report number is discarded
// when it is <= the tracker max, permanently desynchronising the two. Treating
// a row's number as a reference whenever it merely coexists with an unrelated
// link therefore masks real orphans: a row numbered 950 that legitimately
// links to report 955 also silently "references" an unrelated orphaned
// report 950. Only when the cell has no link is the row number the only signal
// available, and only then is it used.
//
// Links are matched GLOBALLY. A cell can carry more than one — "[901](…) /
// [902](…)" is the documented form for a re-evaluation that keeps both reports
// on record — and a single .match() sees only the first, so every later link
// in the cell false-positives as an orphan.
const referencedNums = new Set();
for (const e of entries) {
  const linkTexts = [...e.report.matchAll(/\[(\d+)\]/g)];
  const linkTargets = [...e.report.matchAll(/\]\(([^)]+)\)/g)];
  if (linkTexts.length === 0 && linkTargets.length === 0) {
    referencedNums.add(e.num);
    continue;
  }
  for (const lt of linkTexts) referencedNums.add(parseInt(lt[1], 10));
  for (const lt of linkTargets) {
    const m = lt[1].split(/[\\/]/).pop().match(/^(\d+)-/);
    if (m) referencedNums.add(parseInt(m[1], 10));
  }
}

let orphanReports = 0;
for (const name of reportFiles) {
  const num = parseInt(name.match(REPORT_FILE_RE)[1], 10);
  if (!referencedNums.has(num)) {
    warn(`Orphan report — no tracker row references #${num}: reports/${name}`);
    orphanReports++;
  }
}
if (orphanReports === 0) ok('No orphan reports');

// --- Check 11: Via channel consistency (#1596) ---
// The Via column records the intermediary (agency/recruiter firm; `—` when the
// application was direct). Unknown employers use the structural marker `?` in
// Company — never a word like "Confidential", which is locale-dependent and can
// collide with a real firm name.
let viaIssues = 0;
const CONFIDENTIAL_WORD_RE = /^(confidential|vertraulich|confidentiel|confidencial|riservato|gizli|機密|سري)$/i;
for (const e of entries) {
  const company = String(e.company || '').trim();
  const via = String(e.via || '').trim();
  if (company === '?') {
    // `?` carries two different meanings, and only one of them is this check's
    // business. An AGENCY-mediated row hides the end employer permanently, and
    // that is a real double-submission hazard worth an error. A TRIAGE-ONLY row
    // has an unknown employer only because nothing has fetched the posting yet:
    // boards like stellenwerk are harvested from a sitemap, which carries URLs
    // and no employer, and stage 2 of the pass fills the name in when it writes
    // the report. Nothing has been sent, so there is no submission to duplicate.
    //
    // The pending work is already tracked — Check 12 warns about exactly these
    // rows ("status Evaluated but no report link") — so skipping here hides
    // nothing; it stops a mid-pass state from reading as a data-integrity fault.
    // "Nothing produced yet" is the test: no report link AND no CV. A row with
    // either one has been worked on and could reach an employer, so the blind-
    // employer hazard is live and stays an error.
    const hasReport = /\]\(([^)]+)\)/.test(String(e.report || ''));
    const hasPdf = String(e.pdf || '').includes('✅');
    // `Evaluated` is still awaiting its evaluation; `Discarded`/`SKIP` were
    // resolved without one. None of the three represents an application, so
    // none can duplicate a submission through an unnamed agency.
    const preApplication = new Set(['Evaluated', 'Discarded', 'SKIP']);
    if (!hasReport && !hasPdf && preApplication.has(String(e.status || '').trim())) continue;
    if (COLMAP.via == null) {
      warn(`#${e.num}: unknown employer (?) but the tracker has no Via column — add it with: node merge-tracker.mjs --migrate-via`);
      viaIssues++;
    } else if (!via || via === '—') {
      error(`#${e.num}: unknown employer (?) with no Via channel — record the agency/recruiter firm`);
      viaIssues++;
    }
  }
  if (CONFIDENTIAL_WORD_RE.test(company)) {
    warn(`#${e.num}: company "${company}" looks like a confidentiality placeholder — use the structural marker ? (locale-invariant, can't collide with a real firm)`);
    viaIssues++;
  }
}
// Same company+role reached through different channels: both submissions are
// real, so this is a warning to the human (double-submission risk), never an
// auto-merge. Channel identity uses the shared normalizeVia() that merge-tracker
// and dedup-tracker key agencies with (#2397), so "Hays" and "HAYS " read as one
// channel while リクルート and パーソル stay two; the raw spelling is kept for
// the message. Before this, both non-Latin agencies normalized to '' and fell
// back to 'direct', hiding exactly the double-submission this check exists for.
const normalizeChannel = (v) => normalizeVia(v ?? '') || 'direct';
const channelsByRole = new Map();
for (const e of entries) {
  const company = String(e.company || '').trim();
  if (!company || company === '?') continue;
  const key = `${company.toLowerCase()}::${String(e.role || '').trim().toLowerCase()}`;
  if (!channelsByRole.has(key)) channelsByRole.set(key, new Map());
  const channels = channelsByRole.get(key);
  const norm = normalizeChannel(e.via);
  if (!channels.has(norm)) channels.set(norm, { raw: String(e.via || '').trim() || '—', num: e.num });
}
for (const [key, vias] of channelsByRole) {
  if (vias.size > 1) {
    const list = [...vias.values()];
    warn(`Cross-channel duplicate — ${key.replace('::', ' / ')} reached via ${list.map(v => v.raw).join(' AND ')} (rows ${list.map(v => `#${v.num}`).join(', ')}) — double-submission risk, resolve by hand`);
    viaIssues++;
  }
}
if (viaIssues === 0) ok('Via channels consistent');
// --- Check 12: Duplicate tracker numbers (#1704) ---
// The # column is a row id and must be unique. Unlike Check 2 (company+role
// dedup, which can false-positive on a legitimate re-application), the SAME
// number appearing on 2+ rows is never legitimate: it means set-status.mjs
// can't tell the rows apart, and any external reference to "application #N"
// (interview-prep notes, memory, cross-links) becomes ambiguous. Pure
// addition, no existing check covers this — see #1704 for the 124-row sweep
// that found this in the wild (merge-tracker.mjs trusted a stale TSV number
// as-is whenever it exceeded that run's max, without checking it wasn't
// already used by an unrelated row merged in a separate, earlier invocation).
const numGroups = new Map();
for (const e of entries) {
  if (!numGroups.has(e.num)) numGroups.set(e.num, []);
  numGroups.get(e.num).push(e);
}
let dupeNums = 0;
for (const [num, group] of numGroups) {
  if (group.length > 1) {
    error(`Duplicate tracker number #${num} used by ${group.length} rows: ${group.map(e => `${e.company} — ${e.role}`).join(' | ')}`);
    dupeNums++;
  }
}
if (dupeNums === 0) ok('No duplicate tracker numbers');

// --- Check 17: Every report has a parseable Machine Summary with score: ---
// analyze-patterns.mjs, upskill.mjs and salary-gap.mjs all read fields out of
// the '## Machine Summary' YAML fence. A report missing the block — or
// carrying an empty/unparseable fence, or one with no score: field — doesn't
// error in any of those tools; it just contributes nothing, so the analysis
// comes back quietly smaller instead of complaining. That is the failure
// mode this codebase keeps getting bitten by (a missing input producing a
// quieter answer, not a louder one), so this check names the file plainly.
//
// Warning, not error: reports/*-RESERVED.md sentinels don't match
// REPORT_FILE_RE (no trailing date), so reportFiles already excludes them —
// nothing extra needed to skip reservation placeholders. The remaining
// offenders are historical, pre-convention reports whose tracker rows are
// already terminal; failing the whole health check for them would just
// train the user to ignore it.
let missingSummary = 0;
let unscoredStubs = 0;
for (const name of reportFiles) {
  let reportContent;
  try {
    reportContent = readFileSync(join(REPORTS_DIR, name), 'utf-8');
  } catch {
    continue; // Unreadable — Check 10's orphan scan already surfaces this file.
  }
  const fence = matchMachineSummaryFence(reportContent);
  let parsed = null;
  if (fence) {
    const raw = fence[1].trim();
    if (raw) {
      try {
        const loaded = yamlLoad(raw);
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) parsed = loaded;
      } catch {
        // Unparseable fence — parsed stays null, reported below.
      }
    }
  }
  const hasScore = parsed && parsed.score !== undefined && parsed.score !== null && String(parsed.score).trim() !== '';
  // A liveness-gate stub (posting dead before Block A) declares itself:
  // `score: null` written on purpose, plus legitimacy_tier "not_evaluated".
  // There is no score to recover, so warning on it every run is noise (three
  // Allianz stubs from 2026-09-02 were the only warnings for a month).
  if (!hasScore && parsed && parsed.score === null && parsed.legitimacy_tier === 'not_evaluated') {
    unscoredStubs++;
    continue;
  }
  if (!hasScore) {
    warn(`No usable Machine Summary (score: missing/unparseable) — invisible to analyze-patterns.mjs, upskill.mjs and salary-gap.mjs: reports/${name}`);
    missingSummary++;
  }
}
if (missingSummary === 0) {
  ok(`Every report has a parseable Machine Summary with a score${unscoredStubs ? ` (${unscoredStubs} dead-posting stub(s) deliberately unscored)` : ''}`);
}

// --- Check 18: employer-name variants, shared req IDs, shared URLs ---
// Check 9 above catches two reports for the same company+role only when the
// company text is written IDENTICALLY (normalizeTextKey collapses case,
// whitespace and punctuation but nothing else). It went green on a repo that
// had exactly this: report 012's company was "ZEISS (Carl Zeiss Microscopy
// GmbH)", report 043's was "ZEISS" — same employer, same requisition
// (Workday req JR_1047706, mirrored as a StepStone syndication), two
// different-looking rows. That cost two CVs and two cover letters for one
// job, and the two cover letters silently overwrote each other because both
// resolved to the same output filename.
//
// Three independent signals, checked in descending confidence order so a
// pair flagged by a strong signal is never ALSO reported under a weaker one:
//   1. Shared req/job/posting ID (definitive — same opening regardless of
//      how company or role is written).
//   2. Shared posting URL, compared canonically (definitive).
//   3. Employer-name variant + identical role (heuristic — suppressed when
//      both sides carry a req ID and the IDs differ, since AGENTS.md treats
//      a confirmed req mismatch as proof the rows are NOT duplicates: two
//      genuinely different requisitions can share a title, e.g. a leveled
//      variant and its bare title).
//
// Warning-level, like Check 9: a name-variant or shared-URL match can still
// be a legitimate re-evaluation the human wants to keep.

// Recognized req/job/posting ID forms, per AGENTS.md ("Req/posting ID in
// notes disambiguates same-title postings") — `job id` / `posting id` /
// `requisition` / `req` / `jr` / `job` / `posting` / `ref` / `r_` followed by
// an alphanumeric ID containing at least one digit. Imported from
// merge-tracker.mjs (the same pattern, used there for Notes-cell req
// disambiguation) so the two components can't drift apart from a hand-synced
// duplicate — see the import above.

/**
 * The report's structured header — everything before the first `---` rule
 * that separates the metadata block (Date/URL/Legitimacy/etc.) from the
 * prose body, per the report format every mode in this repo writes. Falls
 * back to the whole content when no such rule is found (defensive, for
 * report shapes that don't use one).
 *
 * extractReqId() below scans ONLY this block, not the full report. A report
 * that recommends against a duplicate application routinely NAMES the other
 * report's req ID in its own prose, by design — AGENTS.md's own
 * disambiguation guidance produces exactly this text (e.g. report 054/SAP
 * quotes report 011's requisition 456991 while explaining they are
 * DIFFERENT postings; report 029/Schaeffler cites report 020's Req 40922 the
 * same way). Scanning the whole document would grab that cross-referenced
 * ID — belonging to the OTHER report — as if it were this report's own,
 * producing exactly the kind of false "duplicate" this check exists to
 * avoid creating. Confining the scan to the header, where a report's own
 * req ID always lives (the URL/Legitimacy/Req ID lines this repo's report
 * template puts there), sidesteps that without needing to parse intent.
 */
function reportHeaderBlock(reportContent) {
  const content = String(reportContent || '');
  const m = content.match(/^---+\s*$/m);
  return m ? content.slice(0, m.index) : content;
}

/**
 * First req/job/posting ID found in a report's header block, or null.
 * Returns both the normalized comparison key (uppercased captured ID, same
 * shape merge-tracker's extractReqNumber() produces) and the raw matched
 * text (kept for a human-readable warning, e.g. "JR_1047706" rather than the
 * bare "1047706" the key strips down to).
 */
function extractReqId(reportContent) {
  const m = reportHeaderBlock(reportContent).match(REQ_NUMBER_RE);
  if (!m) return null;
  return { key: m[1].toUpperCase(), display: m[0] };
}

/** First `**URL:**` header value in a report, or null. */
function extractReportUrl(reportContent) {
  const m = String(reportContent || '').match(/^\*\*URL:\*\*\s*(\S+)/m);
  return m ? m[1].trim() : null;
}

// Tracking params stripped before URL comparison — utm_* (any suffix) plus
// the common click-id params that vary per click/campaign without changing
// what posting the link points at.
const TRACKING_PARAM_RE = /^utm_|^(?:fbclid|gclid|msclkid|igshid|mc_cid|mc_eid)$/i;

/**
 * Canonicalize a posting URL for equality comparison: lowercase host, strip
 * a trailing slash, strip tracking query params. Falls back to a trimmed,
 * lowercased, trailing-slash-stripped string for a value that doesn't parse
 * as an absolute URL, so a malformed `**URL:**` cell still gets SOME
 * comparison instead of silently opting the report out of this signal.
 */
function canonicalizeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    const search = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${pathname}${search ? '?' + search : ''}`;
  } catch {
    return String(raw).trim().toLowerCase().replace(/\/+$/, '');
  }
}

// Legal-form suffixes stripped from a company name before comparison, longest
// first so a compound form ("GmbH & Co. KG") is consumed whole rather than
// leaving a dangling "& Co. KG" behind after a bare "GmbH" match wins first.
const LEGAL_FORMS = [
  'GmbH & Co\\.? KG', 'GmbH', 'mbH', 'AG', 'SE', 'KGaA', 'KG',
  'e\\.V\\.', 'eG',
  'Ltd\\.', 'Ltd', 'Limited',
  'Inc\\.', 'Inc',
  'B\\.V\\.', 'N\\.V\\.', 'S\\.A\\.', 'S\\.r\\.l\\.',
  'Co\\.', '& Co',
].sort((a, b) => b.length - a.length);
const LEGAL_FORM_RE = new RegExp(`,?\\s*(?:${LEGAL_FORMS.join('|')})\\.?\\s*$`, 'i');

function stripLegalForm(s) {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(LEGAL_FORM_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

// A trailing ", <place> Branch" qualifier, or a bare trailing country name —
// both examples straight from the spec that motivated this check ("ZEISS
// (Carl Zeiss Microscopy GmbH)" needs the parenthetical gone; "Primetals
// Technologies Germany GmbH" needs "Germany" gone too, not just "GmbH").
// Deliberately a short, explicit list rather than a general gazetteer: a
// false strip here (turning a real company-name word into noise) is worse
// than missing an exotic branch qualifier this check was never asked to know.
const BRANCH_SUFFIX_RE = /,\s*\p{L}[\p{L}\s]*\bBranch\s*$/iu;
const COUNTRY_SUFFIX_RE = /\b(?:Germany|Deutschland|Austria|Switzerland|USA|U\.S\.A?\.?|United States|UK|United Kingdom|France|Spain|Italy|Netherlands|Japan|China|India|Canada|Australia|Poland|Belgium|Ireland|Sweden|Norway|Denmark|Finland)\s*$/i;

function stripBranchSuffix(s) {
  return s.replace(BRANCH_SUFFIX_RE, '').replace(COUNTRY_SUFFIX_RE, '').trim().replace(/,\s*$/, '');
}

/**
 * Company name -> space-joined token string, normalized for both exact-key
 * equality and whole-token prefix comparison. Order matters: parenthetical
 * qualifiers are dropped whole ("ZEISS (Carl Zeiss Microscopy GmbH)" ->
 * "ZEISS" before anything else runs), then the legal form ("GmbH"), then a
 * trailing branch/country qualifier that the legal form may have been
 * masking ("...Germany GmbH" only exposes "...Germany" as trailing text
 * once "GmbH" is gone) — then Unicode-aware case/punctuation folding shared
 * with normalizeTextKey (NFKC, letters+marks+digits only) but keeping single
 * spaces between words instead of collapsing them, since Check 14's
 * containment rule needs word boundaries normalizeTextKey throws away.
 */
function normalizeCompanyTokens(raw) {
  let s = String(raw ?? '');
  s = s.replace(/\([^)]*\)/g, ' ');
  s = stripBranchSuffix(s);
  s = stripLegalForm(s);
  s = stripBranchSuffix(s);
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  // "Gruppe" and "Group" are the same word, and German job boards disagree
  // about which to use for the same employer within a single scan: Arbeitsagentur
  // listed the Erlangen publisher as "Thieme Group / Thieme Compliance GmbH"
  // while StepStone listed the identical posting as "Thieme Gruppe", and the
  // token-prefix test below rejected the pair on that one word. This is not a
  // legal form (stripLegalForm handles GmbH, AG, SE and friends) but a
  // translated collective noun, so it is folded rather than stripped — dropping
  // it entirely would make "Thieme" match any other Thieme entity.
  s = s.replace(/\bgruppe\b/g, 'group');
  return s;
}

/**
 * Whether two company names are the same employer once legal-form suffixes,
 * parenthetical qualifiers and branch/country suffixes are normalized away.
 * Equal normalized keys always match; otherwise one must be a WHOLE-TOKEN
 * prefix of the other ("zeiss" vs "zeiss carl zeiss microscopy") so
 * "siemens" can't accidentally match "siemensenergy", and normalized keys
 * under 3 characters never participate in the prefix comparison (too short
 * to carry signal either way).
 */
function companyKeysMatch(a, b) {
  const ta = normalizeCompanyTokens(a);
  const tb = normalizeCompanyTokens(b);
  const ka = ta.replace(/\s+/g, '');
  const kb = tb.replace(/\s+/g, '');
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length < 3 || kb.length < 3) return false;
  const tokensA = ta.split(' ').filter(Boolean);
  const tokensB = tb.split(' ').filter(Boolean);
  const isPrefix = (short, long) =>
    short.length > 0 && short.length <= long.length && short.every((tok, i) => tok === long[i]);
  return isPrefix(tokensA, tokensB) || isPrefix(tokensB, tokensA);
}

const reportMeta = [];
for (const name of reportFiles) {
  let reportContent;
  try {
    reportContent = readFileSync(join(REPORTS_DIR, name), 'utf-8');
  } catch {
    continue; // Unreadable — Check 10's orphan scan already surfaces this file.
  }
  const companySlug = name.match(REPORT_FILE_RE)[2];
  reportMeta.push({
    name,
    company: extractCompany(reportContent) || companySlug.replace(/-/g, ' '),
    role: extractRole(reportContent),
    reqId: extractReqId(reportContent),
    url: canonicalizeUrl(extractReportUrl(reportContent)),
  });
}

let strongDupes = 0;
const flaggedPairs = new Set();
function pairKey(a, b) { return a < b ? `${a} ${b}` : `${b} ${a}`; }

// Report filename -> the status of the tracker row that links to it. Built from
// the report LINK rather than the report number so a row whose link and number
// disagree resolves to the file actually cited.
const statusByReportFile = new Map();
for (const e of entries) {
  const linked = (e.report || '').match(/\]\(([^)]+)\)/);
  if (!linked) continue;
  const file = linked[1].split('/').pop();
  if (file) statusByReportFile.set(file, e.status);
}

// Two reports for one requisition stop being a problem once the tracker has
// reconciled them — one row Discarded, the other carrying the application. That
// IS the fix, so continuing to warn makes the warning outlive it and re-fire
// forever; the same rule already governs the tracker-row duplicate check below.
// A pair with no tracker row on either side is still flagged: nothing has
// resolved it yet.
function pairIsReconciled(a, b) {
  return statusByReportFile.get(a) === 'Discarded' || statusByReportFile.get(b) === 'Discarded';
}

function flagPair(a, b, reason) {
  const key = pairKey(a, b);
  if (flaggedPairs.has(key)) return;
  flaggedPairs.add(key);
  if (pairIsReconciled(a, b)) return;
  warn(`Likely duplicate reports (${reason}): ${a}, ${b}`);
  strongDupes++;
}

// Signal 1 (highest confidence): shared req/job/posting ID.
const byReqId = new Map();
for (const m of reportMeta) {
  if (!m.reqId) continue;
  if (!byReqId.has(m.reqId.key)) byReqId.set(m.reqId.key, []);
  byReqId.get(m.reqId.key).push(m);
}
for (const group of byReqId.values()) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      flagPair(group[i].name, group[j].name, `same req ID ${group[i].reqId.display}`);
    }
  }
}

// Signal 2: identical posting URL, compared canonically.
const byUrl = new Map();
for (const m of reportMeta) {
  if (!m.url) continue;
  if (!byUrl.has(m.url)) byUrl.set(m.url, []);
  byUrl.get(m.url).push(m);
}
for (const group of byUrl.values()) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      flagPair(group[i].name, group[j].name, 'same URL');
    }
  }
}

// Signal 3: employer-name variant + identical role. Suppressed when both
// sides name a req ID and the IDs disagree — AGENTS.md documents that case
// (two distinct requisitions sharing a title) as proof the rows are NOT
// duplicates, and this heuristic must defer to that confirmed signal.
for (let i = 0; i < reportMeta.length; i++) {
  for (let j = i + 1; j < reportMeta.length; j++) {
    const a = reportMeta[i], b = reportMeta[j];
    if (!a.role || !b.role) continue;
    if (normalizeKey(a.role) !== normalizeKey(b.role)) continue;
    if (a.reqId && b.reqId && a.reqId.key !== b.reqId.key) continue;
    if (!companyKeysMatch(a.company, b.company)) continue;
    flagPair(a.name, b.name, 'company variant + identical role');
  }
}
if (strongDupes === 0) ok('No employer-variant/req-ID/URL duplicates found');

// --- Check 19: Duplicate tracker rows that have no report yet ---
//
// Every duplicate check above this line reads REPORTS. That leaves the exact
// window in which duplicates arrive in bulk completely unwatched: a scan loop
// promotes its qualifiers straight to the tracker as triage-only rows with no
// report at all, and the same requisition routinely reaches it from three
// boards at once. Observed live 2026-08-18: one loop wave promoted 16 rows, of
// which five were duplicates of another row in the same batch — the Thieme
// Erlangen posting from Arbeitsagentur and StepStone, the Siemens/FAPS Fuerth
// posting from two Indeed listings, and the Siemens Healthineers Erlangen
// posting in both its German and English Indeed forms. `verify-pipeline`
// reported "No exact duplicates found" and "No employer-variant/req-ID/URL
// duplicates found" for all five, because Check 2 demands an exact
// company+role match and Checks 14-15 had no report to read.
//
// Two normalizations do the work, because they are exactly what differs
// between boards syndicating one job:
//   1. the employer name (`companyKeysMatch`, reused from Check 15), and
//   2. the role's boilerplate — the gender marker `(m/w/d)` in any letter
//      order, the `*in`/`:in` inclusive suffixes, and the Werkstudent /
//      Working Student / Werkstudent*in family, which is the same word in two
//      languages and is never the distinguishing part of a title.
//
// What survives that strip is compared as a TOKEN SET, not a string: one board
// writes "Werkstudent (w/m/d) im SQM-Daten-Management / Siemens AG" and another
// "Siemens AG (Fuerth): Werkstudent (w/m/d) im SQM-Daten-Management" — same
// tokens, different order, neither a prefix of the other.
//
// Warning-level and deliberately conservative: a company posting two genuinely
// different roles whose titles differ only by an added word is rare but real,
// so this reports the pair and lets the user decide. It never writes anything.

/** Strip the boilerplate two job boards disagree about, keep the meaning. */
function roleTokenSet(role) {
  const stripped = String(role || '')
    .toLowerCase()
    // Gender markers in every order and separator the market uses.
    .replace(/\(\s*[mwfdxsg](?:\s*[\/,]\s*[mwfdxsg])+\s*\)/g, ' ')
    .replace(/\((?:all genders|any gender|divers)\)/g, ' ')
    // Inclusive suffixes: Werkstudent*in, Werkstudent:in, Werkstudent_in.
    .replace(/[*:_]in\b/g, ' ')
    // The same contract type in two languages, plus its abbreviations.
    .replace(/\bwerkstudent(?:en)?\b/g, ' ')
    .replace(/\bworking\s+student\b/g, ' ')
    .replace(/\bstudent\s+assistant\b/g, ' ');
  // Split FIRST, normalize each token after. normalizeTextKey strips every
  // non-alphanumeric character INCLUDING whitespace, so normalizing the whole
  // string first collapses "climate data analytics" into the single token
  // "climatedataanalytics" — every role becomes one token, the two-token floor
  // below rejects it, and the check silently matches nothing at all.
  // Fold German umlauts to their standard transliteration BEFORE the noise
  // list is applied. The two spellings of one word reach this function from
  // different sources: a board that serves the real title gives "für", while a
  // title deslugged from a URL gives "fuer" (URLs cannot carry umlauts). The
  // NOISE list below already anticipates "fuer" and "fur" — but normalizeTextKey
  // keeps ü as a letter, so the umlaut spelling arrives as "für", matches
  // neither, and survives as a distinguishing token. That one word was enough
  // to hide #125 ("Werkstudent Fuer It Devops Iot") as a duplicate of #36
  // ("Werkstudent für IT DevOps / IoT") — the same posting, already Discarded.
  const foldGerman = (t) => t
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  const tokens = stripped.split(/[\s\/,&()·|-]+/).map((t) => foldGerman(normalizeTextKey(t))).filter(Boolean);
  // Positional noise that carries no role meaning on its own.
  const NOISE = new Set(['im', 'in', 'der', 'die', 'das', 'und', 'fuer', 'fur', 'the', 'and', 'for', 'at', 'of', 'bereich']);
  return new Set(tokens.filter((t) => t.length > 1 && !NOISE.has(t)));
}

const isSubset = (small, large) => [...small].every((t) => large.has(t));

// Compare every not-yet-evaluated row against EVERY row, not just against the
// other unevaluated ones. The pair that actually bites is one triage-only row
// against one fully evaluated row: the loop promotes a posting from a board as
// "Trench — Werkstudent AI Engineering", the evaluation later files it under the
// legal name "Trench Germany GmbH", and merge-tracker adds a second row because
// the company strings differ. Neither Check 15 (both rows need reports) nor a
// symmetric unreported-only scan (neither row may have one) can see that shape.
// Observed live 2026-08-18: four such pairs in a single merge.
const hasReport = (e) => /\]\(([^)]+)\)/.test(e.report || '');
const unreported = entries.filter((e) => !hasReport(e));
let unreportedDupes = 0;
for (let i = 0; i < unreported.length; i++) {
  for (let j = 0; j < entries.length; j++) {
    const a = unreported[i], b = entries[j];
    if (a === b) continue;
    // A pair stops being a problem once one side is Discarded — that IS how a
    // duplicate gets resolved here. Without this the warning survives its own
    // fix and re-fires on every run forever, which is how a health check trains
    // its reader to skim past warnings. Only SKIP and the live states still
    // represent work that could be spent twice.
    if (a.status === 'Discarded' || b.status === 'Discarded') continue;
    // When both sides are unevaluated, only compare each pair once.
    if (!hasReport(b) && unreported.indexOf(b) < i) continue;
    if (!companyKeysMatch(a.company, b.company)) continue;
    const ta = roleTokenSet(a.role), tb = roleTokenSet(b.role);
    // Two tokens is the floor: a single shared word ("Data", "AI") is the
    // domain, not the job, and pairing on it would flag every row at a company.
    if (Math.min(ta.size, tb.size) < 2) continue;
    if (!isSubset(ta, tb) && !isSubset(tb, ta)) continue;
    warn(`Likely duplicate tracker rows: #${a.num} (not evaluated) and #${b.num}${hasReport(b) ? ' (evaluated)' : ' (not evaluated)'} `
      + `(${a.company} — "${a.role}" / "${b.role}") — one posting reached the tracker from two boards; `
      + 'resolve before evaluating so two evaluations are not spent on one job');
    unreportedDupes++;
  }
}
// Second pass: an unknown employer (`?`) has an EMPTY company key, and
// companyKeysMatch() rejects an empty key on both sides — correctly, since two
// unidentified employers are not evidence of the same employer. That leaves a
// blind spot the pass above cannot see, and it cost a real duplicate:
//
//   #3   Mitsubishi Heavy Industries EMEA — "Werkstudent Software Development
//        Edge AI (m/w/d)" — applied, then REJECTED on 2026-08-18.
//   #70  same employer, same role, caught as a duplicate because the company
//        was named.
//   #122 the same posting a third time, harvested from stellenwerk — whose
//        sitemap publishes no employer — so it arrived as `?`, matched nothing,
//        and was promoted at 4.3 as a fresh lead for a job already refused.
//
// So when one side's employer is unknown, fall back to the role alone — but
// demand an EXACT token match rather than the subset test used above, because
// the company is no longer carrying any of the evidence. Warning-level: an
// identical title at two different employers is possible, and the reader
// decides.
for (const a of unreported) {
  if (String(a.company || '').trim() !== '?') continue;
  if (a.status === 'Discarded' || a.status === 'SKIP') continue;
  const ta = roleTokenSet(a.role);
  if (ta.size < 2) continue;
  const key = [...ta].sort().join(' ');
  for (const b of entries) {
    if (a === b) continue;
    if (String(b.company || '').trim() === '?') continue; // handled by the pass above
    // The counterpart is deliberately NOT filtered by status. A Rejected,
    // Discarded or SKIP row is the most valuable match this check can find:
    // it means the posting has already been decided, and the new copy is about
    // to spend an evaluation — or an application — re-deciding it. Observed
    // twice in one pass: #122 duplicated #3 (Rejected) and #125 duplicated #36
    // (Discarded). Only resolving the NEW row silences this, which is the
    // termination condition the loop above already applies to `a`.
    const tb = roleTokenSet(b.role);
    if (tb.size < 2 || [...tb].sort().join(' ') !== key) continue;
    warn(`Likely duplicate tracker rows: #${a.num} (unknown employer) and #${b.num} (${b.company}, ${b.status}) `
      + `— identical role "${a.role}"; the board that supplied #${a.num} publishes no employer, so the company `
      + 'columns cannot be compared. Confirm before evaluating — #' + b.num + ' may already be decided');
    unreportedDupes++;
  }
}

if (unreportedDupes === 0) ok('No duplicate rows among the not-yet-evaluated entries');

// --- Check 13: applications.md <-> active-interviews.md status sync (#1504) ---
// Delegates to tracker-sync-check.mjs's exported checkTrackerSync() rather than
// re-implementing the matching/two-tier resolution logic here or shelling out
// to a second process. Read-only: this only surfaces drift, it does not write
// a fix (tracker-sync-check.mjs is intentionally reporting-only for now — see
// its module header).
let syncResult;
try {
  syncResult = checkTrackerSync({ appsFile: APPS_FILE });
} catch (err) {
  // A check that could not RUN is a failed check, not a warning. warn() does not affect the exit
  // code, so a throw here made verify-pipeline print a notice and still exit 0 — and to anything
  // reading the exit status (CI, a cron wrapper, a pre-push hook) that is indistinguishable from
  // the invariant holding. We do not know whether the tracker is in sync; we know we failed to
  // look. The honest report is failure.
  error(`Sync check could not run — the tracker was NOT verified: ${err.message}`);
}

if (syncResult) {
  const tier1Mismatches = syncResult.mismatches.filter(m => m.resolution === 'auto-tier1');
  const tier2Mismatches = syncResult.mismatches.filter(m => m.resolution === 'needs-review-tier2');
  const unmatchedRows = syncResult.mismatches.filter(m => m.resolution === 'unmatched');

  for (const m of tier1Mismatches) {
    warn(`Sync drift (auto-resolvable): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" vs active-interviews.md="${m.activeInterviewsStatus}" -> suggest "${m.suggestedStatus}" in ${m.staleIn} (run node tracker-sync-check.mjs for details)`);
  }
  for (const m of tier2Mismatches) {
    warn(`Sync drift (needs human review): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" (${m.applicationsLastModified || 'no blame info'}) vs active-interviews.md="${m.activeInterviewsStatus}" (${m.activeInterviewsLastModified || 'no blame info'})`);
  }
  for (const m of unmatchedRows) {
    warn(`Sync check: active-interviews.md row for "${m.company}" — "${m.role}" could not be matched to a tracker row (${m.note})`);
  }
  if (tier1Mismatches.length === 0 && tier2Mismatches.length === 0 && unmatchedRows.length === 0) {
    ok(syncResult.summary.total > 0
      ? 'applications.md and active-interviews.md are in sync'
      : 'No active-interviews.md rows to sync-check');
  }
}

// --- Check 14: data/follow-ups.md table schema (#2971) ---
// stats.mjs (computeFollowupStats) and followup-cadence.mjs both read this table
// positionally, in the shape modes/followup.md documents, and both skip any row
// whose num/appNum cells don't parse as integers. A table written with a
// different column order therefore reports as ZERO follow-ups in both tools,
// silently — indistinguishable from a file where nothing has been logged yet.
// Follow-up compliance is exactly the number a user consults to decide whether
// their follow-ups are working, so a silent zero is actively misleading. This is
// the only place that difference is visible.
//
// Path resolution deliberately matches the two consumers (CAREER_OPS/data/...)
// rather than APPS_FILE's directory: the check exists to predict what they will
// do, so it has to read the same file they read.
const FOLLOWUPS_FILE = join(CAREER_OPS, 'data', 'follow-ups.md');
const FOLLOWUPS_COLUMNS = '| num | appNum | date | company | role | channel | contact | notes |';
if (!existsSync(FOLLOWUPS_FILE)) {
  ok('No follow-ups.md yet — nothing to schema-check');
} else {
  const fups = checkFollowupsSchema(readFileSync(FOLLOWUPS_FILE, 'utf-8'));
  if (fups.pipeLines === 0) {
    ok('follow-ups.md has no table rows yet');
  } else if (!fups.sawSeparator) {
    error(`follow-ups.md has table rows but no header delimiter row, so every row is skipped — expected ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.dataRows === 0) {
    ok('follow-ups.md has no logged follow-ups yet');
  } else if (fups.parsed === 0) {
    error(`follow-ups.md: none of its ${fups.dataRows} row(s) parse, so stats.mjs and followup-cadence.mjs will both report zero follow-ups — expected column order ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.unparsedLines.length > 0) {
    warn(`follow-ups.md: ${fups.unparsedLines.length} of ${fups.dataRows} rows will be skipped by stats.mjs and followup-cadence.mjs (line${fups.unparsedLines.length === 1 ? '' : 's'} ${fups.unparsedLines.join(', ')}) — expected ${FOLLOWUPS_COLUMNS}`);
  } else {
    ok(`follow-ups.md schema valid (${fups.parsed} logged follow-up${fups.parsed === 1 ? '' : 's'})`);
  }
}

// --- Check 15: portals.yml entries no provider claims (#3251) ---
// Coverage rot is invisible from every other check here: an entry with
// `enabled: true` and a careers_url nothing matches reads as a tracked company
// in the config and contributes zero postings on every scan. Twelve of those
// were live on 2026-08-26, one of them a company whose real board existed and
// was one character off the slug in the file.
//
// Only the OFFLINE half of audit-portals.mjs runs here — provider resolution is
// pure config matching, so this check stays as fast and network-free as the rest
// of verify-pipeline. The live half (does the board answer, and with whose
// jobs?) needs 170 fetches and stays a separate command: `node audit-portals.mjs`.
//
// portals.yml is user-layer and gitignored, so its absence is not a finding.
const PORTALS_FILE = process.env.CAREER_OPS_PORTALS || join(CAREER_OPS, 'portals.yml');
if (!existsSync(PORTALS_FILE)) {
  ok('No portals.yml yet — nothing to coverage-check');
} else {
  try {
    const { findUnclaimedEntries } = await import('./audit-portals.mjs');
    const { loadProviders } = await import('./providers/_registry.mjs');
    const yaml = await import('js-yaml');

    const cfg = yaml.load(readFileSync(PORTALS_FILE, 'utf-8')) || {};
    // Both sections, because scan.mjs resolves both through the same registry:
    // an unclaimed aggregator board is exactly as dead as an unclaimed company.
    const entries = [
      ...(Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : []),
      ...(Array.isArray(cfg.job_boards) ? cfg.job_boards : []),
    ];
    const providers = await loadProviders(join(CAREER_OPS, 'providers'));
    const { silent, handoff, unknownProvider } = findUnclaimedEntries(entries, providers);

    // findUnclaimedEntries silently skips an entry with no (or blank) `name` —
    // it can't report what it can't label. Without this, that entry vanishes
    // from silent/handoff/unknownProvider entirely, and the enabled count
    // below (which doesn't share the same eligibility rule) would still
    // include it — so a malformed entry never gets a provider check AND the
    // "All N entries resolve" success line claims it as resolved anyway.
    const malformed = entries.filter(e => e && e.enabled !== false && (typeof e.name !== 'string' || !e.name.trim()));
    for (const e of malformed) {
      warn(`portals.yml: an enabled entry has no name (careers_url: ${e.careers_url || 'none'}) — it cannot be provider-checked; give it a name`);
    }

    for (const e of unknownProvider) {
      error(`portals.yml: "${e.name}" sets an unknown provider — ${e.error}. The entry never scans (see providers/ for valid ids)`);
    }
    for (const e of silent) {
      warn(`portals.yml: "${e.name}" is enabled but no provider claims ${e.careers_url || 'its careers_url'} — scan.mjs skips it on every run without naming it (run node audit-portals.mjs)`);
    }
    if (silent.length === 0 && unknownProvider.length === 0 && malformed.length === 0) {
      const enabled = entries.filter(e => e && e.enabled !== false).length;
      ok(handoff.length > 0
        ? `All ${enabled - handoff.length} scannable portals.yml entries resolve to a provider (${handoff.length} on websearch handoff)`
        : `All ${enabled} enabled portals.yml entries resolve to a provider`);
    }
  } catch (err) {
    warn(`Portal coverage check could not run: ${err.message}`);
  }
}

// --- Check 16: invisible control bytes already in tracker cells (#3892) ---
// cell() in tracker-utils.mjs strips these on the way in, which stops new ones
// entering but can do nothing about the ones already written. This is the only
// place such a byte is visible at all: it shifts or truncates the positional
// `split('|')` parse, so a row silently reads as a different row or drops out
// of a count entirely, while every renderer of the table — markdown, GitHub,
// the web dashboard — shows the cell as correct. The corruption surfaces much
// later as an unrelated arithmetic discrepancy with no trail back to the cause.
//
// Read off the RAW lines rather than the parsed `entries`, so a byte in a
// column this file has no field for is caught too, and reported with the file
// line number: a shifted parse is exactly the situation where the row's own #
// cell is the thing not to trust.
//
// CONTROL_CHARS is imported, never re-declared — a second copy of the range
// would let the write path and this detector disagree about what counts.
let controlByteRows = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  // .match() with a /g regex resets lastIndex; .test() would not, and would
  // then skip every other offending row.
  const found = lines[i].match(CONTROL_CHARS);
  if (!found) continue;
  const points = [...new Set(found.map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
  error(`applications.md line ${i + 1}: tracker row contains invisible control character(s) ${points.join(', ')} — delete them; they render as nothing in every view but shift the positional column parse`);
  controlByteRows++;
}
if (controlByteRows === 0) ok('No control characters in tracker cells');

// --- Check 20: open tracker rows pointing at a blocked job-board host ---
// StepStone began answering HTTP 403 to both the user's own browser and this
// machine on 2026-09-23; the portals.yml StepStone board and search_queries
// were disabled 2026-09-24 so no new StepStone requests go out. This check is
// the other half: a StepStone URL already sitting in a tracker row that the
// user cannot open. A dated exported list (below) rather than a bare literal
// so a future blocked board is one line, not a new check.
//
// Only rows still "Evaluated" are flagged. Per templates/states.yml's
// lifecycle order (LIFECYCLE_ORDER, non-terminal states in file order) and
// `terminal` flags, that is every non-terminal state EXCEPT "applied" and
// whatever comes after it (Applied/Responded/Interview) — those rows already
// moved past the posting URL being actionable, the same way the row itself
// records that the user acted through some other channel before the 403
// started. A terminal row (Offer/Hired/Rejected/Discarded/SKIP) is already
// resolved and flagging it would just be noise the user can never clear.
export const BLOCKED_JOB_BOARD_HOSTS = ['stepstone.de'];

/** @param {string} rawUrl @returns {boolean} whether rawUrl's host is blocked. */
function isBlockedJobBoardUrl(rawUrl) {
  let hostname;
  try {
    hostname = new URL(String(rawUrl || '').trim()).hostname.toLowerCase();
  } catch {
    return false; // blank/unparseable — not this check's problem to report.
  }
  return BLOCKED_JOB_BOARD_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

const { order: LIFECYCLE_ORDER } = loadLifecycle(STATES_FILE);
const appliedIdx = LIFECYCLE_ORDER.indexOf('applied');
// Non-terminal AND strictly before "applied" in the lifecycle order. Derived
// from states.yml rather than hardcoded to "evaluated" so a states.yml
// reorder or a new pre-Applied state can't silently desync this check.
const OPEN_STATUSES = new Set(appliedIdx === -1 ? LIFECYCLE_ORDER : LIFECYCLE_ORDER.slice(0, appliedIdx));

let blockedBoardRows = 0;
for (const e of entries) {
  if (!OPEN_STATUSES.has(normalizeStatus(e.status))) continue;
  if (!isBlockedJobBoardUrl(e.url)) continue;
  warn(`#${e.num} ${e.company}: URL is a StepStone listing (blocked for the user) — repoint to the employer's own posting or close the row`);
  blockedBoardRows++;
}
if (blockedBoardRows === 0) ok('No open tracker rows point at a blocked job-board host');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
