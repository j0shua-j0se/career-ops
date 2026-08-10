#!/usr/bin/env node

/**
 * sync-pdf-flags.mjs — Reconciles the tracker PDF column against data/pdf-index.tsv,
 * and audits the `**PDF:**` header line of every report against the filesystem.
 *
 * When a PDF is generated AFTER the initial evaluation, the tracker's PDF column
 * might still show ❌ (or '—'). This script reads the canonical pdf manifest and
 * upgrades matching tracker rows to ✅ using reportNum as the join key.
 *
 * Runs under the shared tracker lock and replaces the file atomically.
 *
 * Report headers are AUDITED, NEVER REWRITTEN. Two reasons, and the second is
 * the binding one:
 *   1. reports/ is user layer — the system does not edit it (see DATA_CONTRACT).
 *   2. The correct value is not derivable anyway. pdf-index.tsv keeps ONE row
 *      per report, last write wins, and it does not distinguish a CV from a
 *      cover letter — generating a cover overwrites the CV's manifest row. So
 *      "the manifest path for report N" is not "the CV for report N", and
 *      writing it into the header would replace a correct CV path with a cover
 *      path. Existence on disk is the only fact this script can check, so
 *      checking it is all it does.
 *
 * Exit stays 0 on drift by default — merge-tracker.mjs shells out to this
 * script with execFileSync, where a non-zero exit throws. Pass --strict to opt
 * into exit 3 when a report header claims a PDF that is not on disk.
 *
 * Usage:
 *   node sync-pdf-flags.mjs [--dry-run] [--json] [--strict] [--skip-reports]
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { extractTrackerReportNumbers, resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { rebuildRow, resolveTrackerPath, openTrackerTransaction } from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = resolveTrackerPath(CAREER_OPS);
const PDF_MANIFEST = process.env.CAREER_OPS_PDF_INDEX || join(CAREER_OPS, 'data', 'pdf-index.tsv');
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS_DIR || join(CAREER_OPS, 'reports');

const flags = { dryRun: false, json: false, strict: false, skipReports: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') flags.dryRun = true;
  else if (arg === '--json') flags.json = true;
  else if (arg === '--strict') flags.strict = true;
  else if (arg === '--skip-reports') flags.skipReports = true;
}

/**
 * Audit each report's `**PDF:**` header line against the filesystem.
 *
 * A report header is a claim about an artifact that was supposed to be
 * produced. Nothing re-checked that claim after the fact, so a header could
 * name a PDF that was never generated, or that was deleted with the rest of
 * gitignored output/, and the report kept asserting it indefinitely.
 *
 * Read-only by construction — see the header comment for why a correct value
 * cannot be derived from the manifest.
 *
 * @param {Set<number>} manifestNums - Report numbers with at least one PDF in the manifest.
 * @returns {{report: number, file: string, status: string, claimed: string|null}[]}
 */
function auditReportHeaders(manifestNums) {
  if (!existsSync(REPORTS_DIR)) return [];
  const findings = [];
  for (const name of readdirSync(REPORTS_DIR).sort()) {
    if (!name.endsWith('.md')) continue;
    const numMatch = name.match(/^(\d+)-/);
    if (!numMatch) continue;
    const report = parseInt(numMatch[1], 10);

    let text;
    try {
      text = readFileSync(join(REPORTS_DIR, name), 'utf-8');
    } catch {
      findings.push({ report, file: name, status: 'unreadable', claimed: null });
      continue;
    }

    const claimed = text.match(/^\*\*PDF:\*\*\s*(\S.*?)\s*$/m)?.[1] ?? null;
    if (!claimed) {
      // Only interesting when something else says a PDF exists — most reports
      // legitimately have no PDF because the role was never applied to.
      if (manifestNums.has(report)) findings.push({ report, file: name, status: 'header-missing', claimed: null });
      continue;
    }
    // A header may carry a note rather than a path ("pending", "—"); only a
    // path-shaped claim is checkable.
    if (!/[/\\]|\.pdf$/i.test(claimed)) {
      findings.push({ report, file: name, status: 'not-a-path', claimed });
      continue;
    }
    // Headers normally carry a project-relative "output/..." path, but an
    // absolute one is a legitimate claim too and must not be re-rooted.
    const abs = isAbsolute(claimed) ? claimed : join(CAREER_OPS, claimed);
    findings.push({ report, file: name, status: existsSync(abs) ? 'ok' : 'file-missing', claimed });
  }
  return findings;
}

if (!existsSync(APPS_FILE)) {
  if (flags.json) console.log(JSON.stringify({ error: `No tracker found at ${APPS_FILE}`, code: 'no-tracker' }));
  else console.error(`❌ No tracker found at ${APPS_FILE}`);
  process.exit(2);
}

const manifestReports = new Set();
if (existsSync(PDF_MANIFEST)) {
  const content = readFileSync(PDF_MANIFEST, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    const reportVal = parts[0]?.trim();
    if (reportVal) {
      const norm = parseInt(reportVal, 10);
      if (!isNaN(norm) && norm > 0) manifestReports.add(norm);
    }
  }
}

let transaction;
try {
  transaction = await openTrackerTransaction(APPS_FILE);
} catch (err) {
  if (err?.code === 'LOCK_TIMEOUT') {
    if (flags.json) console.log(JSON.stringify({ error: err.message, code: 'lock-timeout' }));
    else console.error(`❌ ${err.message}`);
    process.exit(4);
  }
  if (flags.json) console.log(JSON.stringify({ error: `Cannot acquire tracker lock: ${err.message}`, code: 'lock-error' }));
  else console.error(`❌ Cannot acquire tracker lock: ${err.message}`);
  process.exit(1);
}

let content;
try {
  content = transaction.read();
} catch (err) {
  transaction.close();
  if (flags.json) console.log(JSON.stringify({ error: `Cannot read tracker: ${err.message}`, code: 'read-failure' }));
  else console.error(`❌ Cannot read tracker: ${err.message}`);
  process.exit(2);
}

const lines = content.split('\n');
const colmap = resolveColumns(lines);

let updated = 0;
let unchanged = 0;

for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (!row) continue;
  
  const reportNums = extractTrackerReportNumbers(row.report);
  const hasPdf = reportNums.some(num => manifestReports.has(num));
  
  if (hasPdf) {
    if (row.pdf !== '✅') {
      const parts = lines[i].split('|').map(s => s.trim());
      // parts includes leading empty string, so its length is at least colmap max + 1
      while (parts.length <= colmap.pdf) parts.push('');
      parts[colmap.pdf] = '✅';
      lines[i] = rebuildRow(parts);
      updated++;
      if (!flags.json && !flags.dryRun) {
        console.log(`✅ #${row.num} ${row.company} — ${row.role}: PDF flag updated to ✅`);
      } else if (!flags.json && flags.dryRun) {
        console.log(`🔎 #${row.num} ${row.company} — ${row.role}: would update PDF flag to ✅`);
      }
    } else {
      unchanged++;
    }
  }
}

if (updated > 0 && !flags.dryRun) {
  try {
    transaction.replace(lines.join('\n'));
  } catch (err) {
    transaction.close();
    if (flags.json) console.log(JSON.stringify({ error: `Cannot write tracker: ${err.message}`, code: 'write-failure' }));
    else console.error(`❌ Cannot write tracker: ${err.message}`);
    process.exit(1);
  }
}

transaction.close();

// Outside the lock: the audit reads reports/ and output/, neither of which the
// tracker lock covers, and it writes nothing.
const reportFindings = flags.skipReports ? [] : auditReportHeaders(manifestReports);
const drift = reportFindings.filter(f => f.status !== 'ok');

const result = { updated, unchanged, dryRun: flags.dryRun, reports: reportFindings };
if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n📊 Summary: ${updated} PDF flags synced, ${unchanged} unchanged`);
  if (flags.dryRun) console.log('(dry-run — no changes written)');

  if (drift.length > 0) {
    const LABELS = {
      'file-missing': 'header names a PDF that is not on disk',
      'header-missing': 'PDF exists for this report but the header has no **PDF:** line',
      'not-a-path': '**PDF:** line is not a path',
      unreadable: 'report could not be read',
    };
    console.log(`\n⚠️  ${drift.length} report header(s) disagree with the filesystem:`);
    for (const f of drift) {
      console.log(`   ${f.file}: ${LABELS[f.status] ?? f.status}${f.claimed ? ` — "${f.claimed}"` : ''}`);
    }
    console.log('   reports/ is user layer and is never rewritten here — fix the header or rebuild the PDF.');
  }
}

// Advisory by default so merge-tracker.mjs's execFileSync call does not throw
// on drift it did not cause and cannot fix.
process.exit(flags.strict && drift.length > 0 ? 3 : 0);
