#!/usr/bin/env node

/**
 * deadline-sweep.mjs — retire closed postings without spending a request.
 *
 * A posting's application deadline is printed in the JD, read once at
 * evaluation time, and then thrown away. Nothing in this pipeline recorded it,
 * so the only way to learn a job had closed was to fetch it again — and on
 * 2026-08-31 that cost ~115 HTTP round trips to discover five closures a date
 * comparison would have caught for free.
 *
 * This sweep re-derives urgency from values already on disk. No network, no
 * tokens, no browser. It reads `deadline:` out of each report's Machine Summary
 * and joins it to the tracker row that links that report.
 *
 * Adopted from the ai-job-search framework's /rank Step 3 rule 6
 * (github.com/MadsLorentzen/ai-job-search, MIT), including the two rules that
 * make an automated status change acceptable at all:
 *
 *   - A row with NO recorded deadline is left alone, never guessed at.
 *     Inferring one from the evaluation date would retire jobs on a date
 *     nobody set.
 *   - A stored value that is not YYYY-MM-DD is treated exactly like an absent
 *     one — never compared, never guessed — and reported once with its report
 *     number, so the bad value gets traced to its source instead of silently
 *     steering the sweep. Postings really do state "ASAP", "laufend",
 *     "31.12.2026" and free text.
 *
 * Writing is opt-in (`--apply`) and goes through set-status.mjs, the canonical
 * locked writer. Default output is a report.
 *
 * Usage:
 *   node deadline-sweep.mjs [--soon N] [--apply] [--json]
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER = join(ROOT, 'data', 'applications.md');

/** Statuses a deadline can still act on. A closed row is nobody's business. */
const OPEN_STATES = new Set(['Evaluated', 'Applied', 'Responded']);

/**
 * Strictly YYYY-MM-DD, and a real calendar date.
 *
 * Deliberately not `new Date(value)`: that accepts "31.12.2026" as an Invalid
 * Date on some inputs and silently reinterprets others, which is precisely the
 * failure this function exists to refuse.
 */
export function parseIsoDate(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Whole days from `today` to `deadline`. Negative means already past. */
export function daysUntil(deadline, today) {
  return Math.round((deadline.getTime() - today.getTime()) / 86_400_000);
}

/** Pull `deadline:` out of a report's Machine Summary block. */
export function extractDeadline(content) {
  const fence = String(content ?? '').match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i);
  if (!fence) return undefined;
  const line = fence[1].match(/^deadline:\s*(.+?)\s*$/m);
  if (!line) return undefined;
  const raw = line[1].trim().replace(/^["']|["']$/g, '');
  if (!raw || /^(null|~|none)$/i.test(raw)) return null; // stated: no deadline
  return raw;
}

/**
 * Classify every tracker row that links a report carrying a deadline.
 * Pure over its inputs so the whole decision is unit-testable offline.
 *
 * @returns {{expired: object[], soon: object[], ok: object[], unparseable: object[]}}
 */
export function sweep({ rows, deadlinesByReport, today, soonDays = 7 }) {
  const out = { expired: [], soon: [], ok: [], unparseable: [] };
  for (const row of rows) {
    if (!OPEN_STATES.has(row.status)) continue;
    if (row.report == null) continue;
    const raw = deadlinesByReport.get(String(row.report));
    // undefined = no `deadline:` key at all (report predates this field);
    // null = the posting states no deadline. Both are "leave it alone".
    if (raw === undefined || raw === null) continue;

    const parsed = parseIsoDate(raw);
    if (!parsed) {
      out.unparseable.push({ ...row, deadline: raw });
      continue;
    }
    const days = daysUntil(parsed, today);
    const entry = { ...row, deadline: raw, days };
    if (days < 0) out.expired.push(entry);
    else if (days <= soonDays) out.soon.push(entry);
    else out.ok.push(entry);
  }
  out.expired.sort((a, b) => a.days - b.days);
  out.soon.sort((a, b) => a.days - b.days);
  return out;
}

function loadTrackerRows() {
  if (!existsSync(TRACKER)) return [];
  const rows = [];
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').map((s) => s.trim());
    if (c.length < 11 || !/^\d+$/.test(c[1])) continue;
    const reportLink = c[9].match(/\[(\d+)\]/);
    rows.push({
      num: Number(c[1]), company: c[3], role: c[5], score: c[6], status: c[7],
      report: reportLink ? reportLink[1].replace(/^0+/, '') || '0' : null,
    });
  }
  return rows;
}

function loadDeadlines() {
  const map = new Map();
  if (!existsSync(REPORTS_DIR)) return map;
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('.md')) continue;
    const num = name.match(/^(\d+)-/);
    if (!num) continue;
    const value = extractDeadline(readFileSync(join(REPORTS_DIR, name), 'utf-8'));
    if (value !== undefined) map.set(String(Number(num[1])), value);
  }
  return map;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        soon: { type: 'string', default: '7' },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`deadline-sweep: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log('Usage: node deadline-sweep.mjs [--soon N] [--apply] [--json]\n'
      + '  --soon N   days ahead to flag as closing soon (default 7)\n'
      + '  --apply    write past-deadline rows to Discarded via set-status.mjs\n'
      + '  --json     machine-readable output');
    return;
  }

  const today = parseIsoDate(new Date().toISOString().slice(0, 10));
  const result = sweep({
    rows: loadTrackerRows(),
    deadlinesByReport: loadDeadlines(),
    today,
    soonDays: Number(values.soon),
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const total = result.expired.length + result.soon.length + result.ok.length;
    console.log(`Deadline sweep — ${total} open row(s) carry a recorded deadline. No requests were made.\n`);
    if (result.expired.length) {
      console.log(`❌ Past deadline (${result.expired.length}):`);
      for (const r of result.expired) {
        console.log(`   #${r.num} ${r.company} — ${r.role}`);
        console.log(`       closed ${r.deadline} (${-r.days}d ago), status ${r.status}`);
      }
      console.log('');
    }
    if (result.soon.length) {
      console.log(`🔥 Closing soon (${result.soon.length}):`);
      for (const r of result.soon) {
        console.log(`   #${r.num} ${r.company} — ${r.role} — ${r.deadline} (${r.days}d left)`);
      }
      console.log('');
    }
    if (result.unparseable.length) {
      console.log(`⚠️  Unusable deadline values (${result.unparseable.length}) — left alone, never guessed:`);
      for (const r of result.unparseable) {
        console.log(`   report ${r.report} (#${r.num}): ${JSON.stringify(r.deadline)}`);
      }
      console.log('');
    }
    if (!result.expired.length && !result.soon.length) console.log('Nothing due or overdue.');
  }

  if (values.apply && result.expired.length) {
    // set-status.mjs is the canonical locked, validated, atomic writer
    // (AGENTS.md, Pipeline Integrity). Never write the tracker directly here.
    const rowsArg = result.expired.map((r) => r.num).join(',');
    const note = `Posting CLOSED by its own stated deadline (deadline-sweep, no request made): `
      + result.expired.map((r) => `#${r.num} ${r.deadline}`).join('; ');
    const res = spawnSync(process.execPath,
      [join(ROOT, 'set-status.mjs'), '--row', rowsArg, 'Discarded', '--note', note],
      { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) process.exitCode = 1;
  } else if (result.expired.length) {
    console.log('Re-run with --apply to move these to Discarded via set-status.mjs.');
  }

  // Non-zero when something needs attention, so a scheduler can act on it.
  if (!values.apply && (result.expired.length || result.soon.length)) process.exitCode = 10;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
