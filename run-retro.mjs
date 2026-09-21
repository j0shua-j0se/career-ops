#!/usr/bin/env node
/**
 * run-retro.mjs — zero-token post-pass review for `/career-ops run`.
 *
 * After every pass the orchestrator was hand-assembling "where did this
 * pass's effort go" from run-state.json, run-log.md, loop-state.json,
 * loop-run-log.md, scan-history.tsv, discard.log, reports/, pdf-index.tsv and
 * the tracker. This script computes the same thing automatically, reading
 * only files already on disk (zero LLM calls, zero network).
 *
 * A "pass" is identified by its run_id (data/run-state.json / data/run-log.md
 * — see run-all.mjs / run-core.mjs). For the LATEST pass, per-candidate
 * detail (score, prefiltered-vs-LLM-scored, wave) comes straight from
 * data/loop-state.json. That file is overwritten every loop run, so for an
 * OLDER pass (`--run <run_id>` or `--all`) the same per-source breakdown of
 * free_rejected/llm_triaged/qualified candidates is NOT recoverable — only
 * pass/wave-level aggregates survive, in data/loop-run-log.md. Rather than
 * guess, those columns are left blank for backfilled passes and the gap is
 * named in the row's notes.
 *
 * Sources are attributed by normalized posting URL (url-key.mjs
 * normalizeUrl), joining loop-state candidates / discard.log entries /
 * report headers / tracker rows back to the scan-history.tsv row that first
 * saw that URL (whose `portal` column is the source).
 *
 * Output: appends/replaces rows for one run_id in data/run-retro.tsv (header
 * written once; re-running for the same run_id replaces its rows rather than
 * duplicating them — never write anywhere else under data/).
 *
 * Run:
 *   node run-retro.mjs                  # latest pass from run-state.json
 *   node run-retro.mjs --run <run_id>   # a specific older pass
 *   node run-retro.mjs --all            # backfill every pass in run-log.md
 *   node run-retro.mjs --summary        # + compact human table
 *   node run-retro.mjs --json           # machine JSON instead of the TSV write
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { normalizeUrl } from './url-key.mjs';
import { parseTrackerRow, resolveColumns, extractTrackerReportNumbers } from './tracker-parse.mjs';
import { parseDiscardLog } from './discard-analytics.mjs';

// ── token-estimate constants (ORCHESTRATOR-MEASURED, 2026-09-15/16) ────────
// A PROXY, not a metered count: career-ops makes no LLM calls of its own, so
// nothing here can be counted directly. These are per-unit averages the
// orchestrator observed while running passes by hand. Any `est_tokens` value
// this file emits is built ONLY from this object, so the assumption is named
// in exactly one place.
export const TOKEN_ESTIMATES = Object.freeze({
  // scan-loop's score step, JD pre-fetched via fetch-jds.mjs and triaged from
  // a local compacted batch file (the normal path — see AGENTS.md's
  // fetch-jds.mjs entry).
  triagePrefetchedPerPosting: 1000,
  // A wave whose loop-state.json `degraded: true` flag says the pre-fetch
  // step failed and the worker fell back to fetching each posting itself.
  triageFetchedPerPosting: 8000,
  // A full A-G evaluation report.
  fullEvaluationPerReport: 60000,
  // A CV + cover-letter kit for one report (build-application.mjs), counted
  // once per distinct report number that gained a pdf-index.tsv row in the
  // window — a kit can write 2 rows (CV + cover), never 2 kits.
  kitPerReport: 130000,
});

// ── run-log.md parsing ───────────────────────────────────────────────────

const RUN_LOG_LINE_RE = /^- (\S+) · (\S+) · (\S+) · stage=(\S+)(?: · (.*))?$/;

/**
 * Parse data/run-log.md into structured entries.
 *
 * @param {string} text
 * @returns {Array<{time: Date, iso: string, runId: string, event: string, stage: string, detail: string}>}
 */
export function parseRunLogText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = RUN_LOG_LINE_RE.exec(line);
    if (!m) continue;
    const [, iso, runId, event, stage, detail = ''] = m;
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) continue;
    out.push({ time, iso, runId, event, stage, detail });
  }
  return out;
}

/**
 * Every run_id that has a 'start' line, in chronological order — the
 * passes `--all` can attempt to backfill.
 *
 * @param {Array} entries - from parseRunLogText.
 * @returns {string[]}
 */
export function listRecoverableRunIds(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (e.event === 'start' && !seen.has(e.runId)) {
      seen.add(e.runId);
      out.push(e.runId);
    }
  }
  return out;
}

/**
 * Recover one pass's window and per-stage wall-clock timing from run-log.md.
 *
 * Stage durations are computed structurally from the fixed stage order
 * (scan -> pipeline -> kits -> sync, see run-core.mjs STAGES), not by parsing
 * the free-text note: each 'advance'/'stage-complete' line's `stage=` field
 * is the run's CURRENT stage right after the transition (renderRunLogEntry
 * computes it post-mutation), so the time since the previous boundary is the
 * PRIOR stage's duration. A repeated 'sync · stage=done' line (re-running
 * `sync` after the pass already finished) is real in the log but must not
 * extend the sync duration, so parsing stops at the first one.
 *
 * @param {Array} entries - from parseRunLogText.
 * @param {string} runId
 * @returns {null|{runId:string, startTime:Date, endTime:Date, completed:boolean,
 *   aborted:boolean, haltedReason:string|null, stageWindows:Object}}
 */
export function computePassWindow(entries, runId) {
  const rows = entries.filter((e) => e.runId === runId).sort((a, b) => a.time - b.time);
  const startRow = rows.find((e) => e.event === 'start');
  if (!startRow) return null;

  const stageWindows = {};
  let boundaryTime = startRow.time;
  let currentStage = startRow.stage;
  let completed = false;
  let aborted = false;
  let haltedReason = null;
  let endTime = startRow.time;

  for (const row of rows) {
    if (row === startRow) continue;
    if (row.event === 'advance' || row.event === 'stage-complete') {
      stageWindows[currentStage] = { start: boundaryTime, end: row.time, ms: row.time - boundaryTime };
      boundaryTime = row.time;
      currentStage = row.stage;
      endTime = row.time;
    } else if (row.event === 'sync' && row.stage === 'done') {
      stageWindows[currentStage] = { start: boundaryTime, end: row.time, ms: row.time - boundaryTime };
      boundaryTime = row.time;
      completed = true;
      endTime = row.time;
      break;
    } else if (row.event === 'abort') {
      stageWindows[currentStage] = { start: boundaryTime, end: row.time, ms: row.time - boundaryTime };
      haltedReason = row.detail || null;
      aborted = true;
      endTime = row.time;
      break;
    } else {
      // A mid-pass 'sync' that did not consume the stage (run early to
      // refresh the dashboard) — extends the window's end but is not a
      // stage boundary.
      if (row.time > endTime) endTime = row.time;
    }
  }

  return { runId, startTime: startRow.time, endTime, completed, aborted, haltedReason, stageWindows };
}

// ── loop-run-log.md parsing (backfill path only) ────────────────────────

const LOOP_LOG_LINE_RE = /^- (\S+) · (\S+) · (\S+) · wave=(\d+) · discovered=(\d+) · scored=(\d+) · qualified=(\d+)\/(\d+) · (.*)$/;

/**
 * Parse data/loop-run-log.md.
 *
 * @param {string} text
 * @returns {Array<{time:Date, loopRunId:string, event:string, wave:number,
 *   discovered:number, scored:number, qualified:number, target:number, detail:string}>}
 */
export function parseLoopRunLogText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = LOOP_LOG_LINE_RE.exec(line);
    if (!m) continue;
    const [, iso, loopRunId, event, wave, discovered, scored, qualified, target, detail] = m;
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) continue;
    out.push({
      time, loopRunId, event,
      wave: Number(wave), discovered: Number(discovered), scored: Number(scored),
      qualified: Number(qualified), target: Number(target), detail,
    });
  }
  return out;
}

/**
 * Find the loop run (if any) whose 'start' line falls inside this pass's
 * scan-stage window (or, if the scan stage never closed, inside the whole
 * pass window recovered so far).
 *
 * @param {Array} loopEntries - from parseLoopRunLogText.
 * @param {{startTime:Date, endTime:Date, stageWindows:Object}} window - from computePassWindow.
 * @returns {string|null} loopRunId, or null if none matches.
 */
export function findLoopRunId(loopEntries, window) {
  const scanEnd = window.stageWindows.scan?.end ?? window.endTime;
  const hit = loopEntries.find(
    (e) => e.event === 'start' && e.time >= window.startTime && e.time <= scanEnd,
  );
  return hit ? hit.loopRunId : null;
}

/**
 * Per-wave strategy + found/new + duration for one loop run, parsed from
 * loop-run-log.md text (used only when loop-state.json does not cover this
 * pass — see the module header).
 *
 * @param {Array} loopEntries
 * @param {string} loopRunId
 * @returns {{waves: Array<{n:number, strategy:string, found:number, new:number, durationMs:number}>,
 *   finalQualified: number|null, target: number|null, minScore: number|null, haltedReason: string|null}}
 */
export function computeLoopWavesFromLog(loopEntries, loopRunId) {
  const rows = loopEntries.filter((e) => e.loopRunId === loopRunId).sort((a, b) => a.time - b.time);
  const waves = [];
  let boundaryTime = rows[0]?.time ?? null;
  let minScore = null;
  let target = null;
  let finalQualified = null;
  let haltedReason = null;
  const byWave = new Map();

  for (const row of rows) {
    if (row.event === 'start') {
      const m = /target=(\d+)\s+minScore=([\d.]+)/.exec(row.detail);
      if (m) { target = Number(m[1]); minScore = Number(m[2]); }
      continue;
    }
    if (row.event === 'wave' || row.event === 'ingest') {
      // Newer logs: "portals exit=0 found=39 new=39" (strategy is the first
      // token). Older logs instead used 'ingest' with no leading strategy
      // word, e.g. "wave=1 found=3 new=3" — a leading `wave=N` token there is
      // NOT a strategy name, so it is treated as unrecorded rather than
      // guessed.
      const strategyMatch = /^(\S+)/.exec(row.detail);
      const foundMatch = /found=(\d+)/.exec(row.detail);
      const newMatch = /new=(\d+)/.exec(row.detail);
      const strategy = strategyMatch && !/^wave=\d/.test(strategyMatch[1]) ? strategyMatch[1] : null;
      byWave.set(row.wave, {
        n: row.wave,
        strategy: strategy || `wave${row.wave}`,
        found: foundMatch ? Number(foundMatch[1]) : null,
        new: newMatch ? Number(newMatch[1]) : null,
        durationMs: boundaryTime != null ? row.time - boundaryTime : null,
      });
      boundaryTime = row.time;
    } else if (row.event === 'score') {
      // Scoring lines close out the wave's duration but carry no new
      // strategy/found/new of their own beyond what 'wave'/'ingest' recorded.
      if (byWave.has(row.wave)) {
        const w = byWave.get(row.wave);
        w.durationMs = (w.durationMs ?? 0) + (boundaryTime != null ? row.time - boundaryTime : 0);
      }
      boundaryTime = row.time;
    } else if (row.event === 'halt') {
      haltedReason = row.detail || null;
      boundaryTime = row.time;
    } else if (row.event === 'abort') {
      haltedReason = row.detail || null;
      boundaryTime = row.time;
    } else if (row.event === 'finish') {
      finalQualified = row.qualified;
      boundaryTime = row.time;
    }
  }

  return { waves: [...byWave.values()].sort((a, b) => a.n - b.n), finalQualified, target, minScore, haltedReason };
}

// ── scan-history.tsv ────────────────────────────────────────────────────

/**
 * Parse a header-driven TSV into an array of row objects. Tolerant of a
 * missing/short file — returns [] rather than throwing, so a caller can
 * degrade the metrics that depend on it instead of failing the whole pass.
 *
 * @param {string} text
 * @returns {Array<Object<string,string>>}
 */
export function parseTsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length < 1) return [];
  const header = lines[0].split('\t');
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    out.push(row);
  }
  return out;
}

/**
 * Build a lookup from normalized posting URL -> {portal, firstSeen, status}
 * using the FIRST scan-history row for each URL (a URL's portal/first_seen
 * never legitimately changes across re-sightings).
 *
 * @param {Array<Object>} scanHistoryRows - from parseTsv(scan-history.tsv).
 * @returns {Map<string, {portal:string, firstSeen:string, status:string}>}
 */
export function buildScanHistoryIndex(scanHistoryRows) {
  const index = new Map();
  for (const row of scanHistoryRows) {
    const key = normalizeUrl(row.url);
    if (!key || index.has(key)) continue;
    index.set(key, { portal: row.portal || '', firstSeen: row.first_seen || '', status: row.status || '' });
  }
  return index;
}

/**
 * Per-source found/new counts for postings first seen within the pass's
 * date range (INCLUSIVE, date-only — scan-history.tsv's `first_seen` has no
 * time-of-day, so a source's numbers for a pass that shares a calendar day
 * with another pass are a date-window approximation, not an exact-timestamp
 * count; flagged via `dateOnlyGranularity` on the result).
 *
 * @param {Array<Object>} scanHistoryRows
 * @param {{startTime:Date, endTime:Date}} window
 * @returns {Map<string, {found:number, new:number}>}
 */
export function sourceScanCounts(scanHistoryRows, window) {
  const startDate = window.startTime.toISOString().slice(0, 10);
  const endDate = window.endTime.toISOString().slice(0, 10);
  const counts = new Map();
  for (const row of scanHistoryRows) {
    const fs = row.first_seen || '';
    if (!fs || fs < startDate || fs > endDate) continue;
    const source = row.portal || '(unknown portal)';
    if (!counts.has(source)) counts.set(source, { found: 0, new: 0 });
    const c = counts.get(source);
    c.found += 1;
    if (row.status === 'added') c.new += 1;
  }
  return counts;
}

// ── pdf-index.tsv (kits) ────────────────────────────────────────────────

const PDF_INDEX_COLUMNS = ['report', 'pdf', 'html', 'format', 'date'];

/**
 * Parse data/pdf-index.tsv. NOT the generic parseTsv: pdf-index's header is
 * a `#`-prefixed comment ("# report\tpdf\thtml\tformat\tdate — written by
 * generate-pdf.mjs, do not edit"), so there is no ordinary header row to read
 * column names from — every non-comment line is a data row, in the file's
 * fixed 5-column order.
 *
 * @param {string} text
 * @returns {Array<{report:string, pdf:string, html:string, format:string, date:string}>}
 */
export function parsePdfIndexTsv(text) {
  const out = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const row = {};
    PDF_INDEX_COLUMNS.forEach((c, i) => { row[c] = cells[i] ?? ''; });
    out.push(row);
  }
  return out;
}

/**
 * Distinct report numbers that gained a pdf-index.tsv row dated within the
 * window — one "kit" per report, even though build-application.mjs can
 * write 2 rows (CV + cover) for the same report.
 *
 * @param {Array<Object>} pdfIndexRows - from parseTsv(pdf-index.tsv).
 * @param {{startTime:Date, endTime:Date}} window
 * @returns {Map<string, {rowCount:number}>} keyed by report number (or '' for
 *   an unattributed row, e.g. a non-report PDF like a job-fair CV).
 */
export function kitsInWindow(pdfIndexRows, window) {
  const startDate = window.startTime.toISOString().slice(0, 10);
  const endDate = window.endTime.toISOString().slice(0, 10);
  const kits = new Map();
  for (const row of pdfIndexRows) {
    const d = row.date || '';
    if (!d || d < startDate || d > endDate) continue;
    const key = (row.report || '').trim();
    if (!kits.has(key)) kits.set(key, { rowCount: 0 });
    kits.get(key).rowCount += 1;
  }
  return kits;
}

// ── reports/ ─────────────────────────────────────────────────────────────

const REPORT_FILENAME_RE = /^(\d+)-.*-(\d{4}-\d{2}-\d{2})\.md$/;
const REPORT_URL_RE = /^\*\*URL:\*\*\s*(\S+)/m;
const REPORT_SCORE_RE = /^\*\*Score:\*\*\s*([\d.]+)/m;

/**
 * Parse a reports/ directory listing (filenames only) into report metadata.
 * Filename date is the report's authoritative date for windowing — it is
 * written once at creation and matches the tracker's Date column.
 *
 * @param {string[]} filenames
 * @returns {Array<{file:string, reportNum:string, date:string}>}
 */
export function parseReportFilenames(filenames) {
  const out = [];
  for (const file of filenames) {
    const m = REPORT_FILENAME_RE.exec(file);
    if (!m) continue;
    out.push({ file, reportNum: m[1], date: m[2] });
  }
  return out;
}

/**
 * Extract the `**URL:**` / `**Score:**` header fields a report needs for
 * source-joining and scoring.
 *
 * @param {string} text - Report file contents.
 * @returns {{url:string|null, score:number|null}}
 */
export function parseReportHeader(text) {
  const urlMatch = REPORT_URL_RE.exec(text);
  const scoreMatch = REPORT_SCORE_RE.exec(text);
  return {
    url: urlMatch ? urlMatch[1] : null,
    score: scoreMatch ? Number(scoreMatch[1]) : null,
  };
}

/**
 * Reports dated within the pass window (inclusive, by filename date).
 *
 * @param {Array<{file:string, reportNum:string, date:string}>} reports
 * @param {{startTime:Date, endTime:Date}} window
 * @returns {Array<{file:string, reportNum:string, date:string}>}
 */
export function reportsInWindow(reports, window) {
  const startDate = window.startTime.toISOString().slice(0, 10);
  const endDate = window.endTime.toISOString().slice(0, 10);
  return reports.filter((r) => r.date >= startDate && r.date <= endDate);
}

// ── tracker (data/applications.md) ──────────────────────────────────────

/**
 * Parse tracker lines into rows carrying a `url` field, which
 * tracker-parse.mjs's parseTrackerRow deliberately omits (it only guarantees
 * the LEGACY_COLMAP fields). Reuses resolveColumns/parseTrackerRow for
 * everything else so this file never re-implements markdown-table parsing.
 *
 * @param {string[]} lines - data/applications.md split into lines.
 * @returns {Array<Object>} parseTrackerRow() rows, each with an added `url`.
 */
export function readTrackerRowsWithUrl(lines) {
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    let url = '';
    if (colmap.url != null) {
      const parts = line.split('|').map((s) => s.trim());
      url = parts[colmap.url] ?? '';
    }
    rows.push({ ...row, url });
  }
  return rows;
}

// ── source attribution ───────────────────────────────────────────────────

/**
 * Resolve a posting URL to its scan-history source (portal), or null when
 * the URL is unusable (normalizeUrl returns '') or was never seen by a
 * tracked scan.
 *
 * @param {string} url
 * @param {Map} scanHistoryIndex - from buildScanHistoryIndex.
 * @returns {string|null}
 */
export function attributeSource(url, scanHistoryIndex) {
  const key = normalizeUrl(url);
  if (!key) return null;
  const hit = scanHistoryIndex.get(key);
  return hit ? hit.portal : null;
}

// ── per-source table assembly ────────────────────────────────────────────

// Only the four states run-retro.mjs is asked to report downstream (Offer and
// Hired are rarer, later-stage outcomes analyze-patterns.mjs / stats.mjs
// already track in full).
const TRACKER_STATUS_BUCKETS = ['Applied', 'Responded', 'Interview', 'Rejected'];

/**
 * Assemble the full per-source + pass-level retro for one pass.
 *
 * Every metric that cannot be reliably computed for this pass is OMITTED
 * (left `null`, never coerced to 0) and named in `omitted`. The most common
 * reason: `loopStateCoversThisPass` is false, meaning loop-state.json (which
 * only ever holds the LATEST loop run) does not cover this pass, so
 * per-source free_rejected/llm_triaged/qualified cannot be recovered — only
 * the pass-level loop-run-log.md wave aggregates can.
 *
 * @param {object} inputs
 * @param {{runId:string, startTime:Date, endTime:Date, completed:boolean,
 *   aborted:boolean, haltedReason:string|null, stageWindows:Object}} inputs.window
 * @param {Array<Object>} inputs.scanHistoryRows
 * @param {Array<{timestamp:string, url:string, reason:string}>} inputs.discardEntries - whole file
 * @param {Array<{file:string, reportNum:string, date:string}>} inputs.reportFiles - whole reports/ dir
 * @param {(reportNum:string) => string} inputs.readReportText
 * @param {Array<Object>} inputs.pdfIndexRows
 * @param {Array<Object>} inputs.trackerRows - from readTrackerRowsWithUrl, whole tracker
 * @param {object|null} inputs.loopState - data/loop-state.json parsed, or null
 * @param {string} inputs.loopRunLogText - data/loop-run-log.md raw text
 * @returns {object}
 */
export function buildPassRetro(inputs) {
  const { window, scanHistoryRows, discardEntries, reportFiles, readReportText, pdfIndexRows, trackerRows, loopState, loopRunLogText } = inputs;
  const omitted = [];
  const scanHistoryIndex = buildScanHistoryIndex(scanHistoryRows);
  const scanCounts = sourceScanCounts(scanHistoryRows, window);
  if (scanHistoryRows.length === 0) omitted.push('found/new: data/scan-history.tsv is missing or empty');

  // ── loop coverage: latest pass (loop-state.json) vs backfilled pass (loop-run-log.md) ──
  let loopStateCoversThisPass = false;
  let minScore = null;
  const perSourceLoop = new Map(); // source -> {freeRejected, llmTriaged, qualified}
  const bump = (source, field) => {
    const s = source || '(unattributed)';
    if (!perSourceLoop.has(s)) perSourceLoop.set(s, { freeRejected: 0, llmTriaged: 0, qualified: 0 });
    perSourceLoop.get(s)[field] += 1;
  };

  if (loopState && loopState.run_id) {
    const loopStart = new Date(loopState.run_id);
    const scanEnd = window.stageWindows.scan?.end ?? window.endTime;
    if (!Number.isNaN(loopStart.getTime()) && loopStart >= window.startTime && loopStart <= scanEnd) {
      loopStateCoversThisPass = true;
      minScore = loopState.config?.minScore ?? null;
      for (const cand of Object.values(loopState.candidates || {})) {
        const source = attributeSource(cand.url, scanHistoryIndex);
        if (cand.prefiltered) bump(source, 'freeRejected');
        else bump(source, 'llmTriaged');
        if (minScore != null && typeof cand.score === 'number' && cand.score >= minScore) bump(source, 'qualified');
      }
    }
  }

  let waveInfo = null;
  if (!loopStateCoversThisPass) {
    const loopEntries = parseLoopRunLogText(loopRunLogText);
    const loopRunId = findLoopRunId(loopEntries, window);
    if (loopRunId) {
      waveInfo = computeLoopWavesFromLog(loopEntries, loopRunId);
      if (minScore == null) minScore = waveInfo.minScore;
    }
    omitted.push(
      'free_rejected/llm_triaged/qualified per source: loop-state.json only holds the LATEST loop run and does not cover this pass'
      + (loopRunId ? ' (pass-level wave totals recovered from loop-run-log.md instead)' : ' (no matching loop run found in loop-run-log.md either)'),
    );
  } else {
    waveInfo = { waves: (loopState.waves || []).map((w) => ({
      n: w.n, strategy: w.strategy, found: w.found, new: w.added,
      durationMs: (w.finished_at && w.started_at) ? (new Date(w.finished_at) - new Date(w.started_at)) : null,
      degraded: Boolean(w.degraded),
    })), finalQualified: null, target: loopState.config?.target ?? null, minScore, haltedReason: loopState.halted_reason ?? null };
  }

  // ── pre-screen discards, attributed by URL ──
  const discardStart = window.startTime.toISOString();
  const discardEnd = window.endTime.toISOString();
  const perSourceDiscards = new Map();
  let discardsUnattributed = 0;
  for (const entry of discardEntries) {
    if (entry.timestamp < discardStart || entry.timestamp > discardEnd) continue;
    const source = attributeSource(entry.url, scanHistoryIndex);
    const key = source || '(unattributed)';
    perSourceDiscards.set(key, (perSourceDiscards.get(key) || 0) + 1);
    if (!source) discardsUnattributed += 1;
  }

  // ── evaluated reports, attributed by header URL ──
  const windowReports = reportsInWindow(reportFiles, window);
  const perSourceEvaluated = new Map();
  let evaluatedUnattributed = 0;
  for (const r of windowReports) {
    let text = '';
    try { text = readReportText(r.file); } catch { text = ''; }
    const { url } = parseReportHeader(text);
    const source = url ? attributeSource(url, scanHistoryIndex) : null;
    const key = source || '(unattributed)';
    perSourceEvaluated.set(key, (perSourceEvaluated.get(key) || 0) + 1);
    if (!source) evaluatedUnattributed += 1;
  }
  if (reportFiles.length === 0) omitted.push('evaluated: reports/ directory listing was empty');

  // ── kits, attributed via report -> tracker URL -> source ──
  // Keyed by NUMBER (not the zero-padded string pdf-index.tsv uses), via the
  // same extractTrackerReportNumbers tracker-sync-check.mjs/merge-tracker.mjs
  // use to read a Report cell — avoids re-deriving the bracket-number regex
  // and its edge cases (multiple refs, local-filename-only cells) here.
  const trackerByReportNum = new Map();
  for (const row of trackerRows) {
    for (const num of extractTrackerReportNumbers(row.report, row.notes)) {
      trackerByReportNum.set(num, row);
    }
  }
  const windowKits = kitsInWindow(pdfIndexRows, window);
  const perSourceKits = new Map();
  let kitsUnattributed = 0;
  for (const [reportNum] of windowKits) {
    const trackerRow = trackerByReportNum.get(Number(reportNum));
    const source = trackerRow ? attributeSource(trackerRow.url, scanHistoryIndex) : null;
    const key = source || '(unattributed)';
    perSourceKits.set(key, (perSourceKits.get(key) || 0) + 1);
    if (!source) kitsUnattributed += 1;
  }

  // ── tracker downstream state, per source, via scan-history URLs found in this window ──
  const trackerByUrlKey = new Map();
  for (const row of trackerRows) {
    const key = normalizeUrl(row.url);
    if (key) trackerByUrlKey.set(key, row);
  }
  const perSourceStatus = new Map(); // source -> {Applied, Responded, Interview, Offer, Hired, Rejected}
  const startDate = window.startTime.toISOString().slice(0, 10);
  const endDate = window.endTime.toISOString().slice(0, 10);
  for (const row of scanHistoryRows) {
    const fs = row.first_seen || '';
    if (!fs || fs < startDate || fs > endDate) continue;
    const key = normalizeUrl(row.url);
    const trackerRow = key ? trackerByUrlKey.get(key) : null;
    if (!trackerRow) continue;
    const source = row.portal || '(unknown portal)';
    if (!perSourceStatus.has(source)) {
      perSourceStatus.set(source, Object.fromEntries(TRACKER_STATUS_BUCKETS.map((b) => [b, 0])));
    }
    if (TRACKER_STATUS_BUCKETS.includes(trackerRow.status)) {
      perSourceStatus.get(source)[trackerRow.status] += 1;
    }
  }

  // ── assemble per-source rows ──
  const sources = new Set([
    ...scanCounts.keys(), ...perSourceLoop.keys(), ...perSourceDiscards.keys(),
    ...perSourceEvaluated.keys(), ...perSourceKits.keys(), ...perSourceStatus.keys(),
  ]);
  const sourceRows = [...sources].sort().map((source) => {
    const scan = scanCounts.get(source) || { found: 0, new: 0 };
    // When loop-state.json covers this pass, a source with NO loop
    // candidates is a verified zero (that source's postings never entered
    // the loop's own candidate set — e.g. an agent-driven Stage 1b sweep
    // source like `websearch`, vetted outside the loop entirely), not an
    // unknown — so it renders as 0, unlike the true omission case below.
    const loop = perSourceLoop.get(source) || (loopStateCoversThisPass ? { freeRejected: 0, llmTriaged: 0, qualified: 0 } : null);
    const status = perSourceStatus.get(source) || Object.fromEntries(TRACKER_STATUS_BUCKETS.map((b) => [b, 0]));
    const evaluatedCount = perSourceEvaluated.get(source) || 0;
    const kitCount = perSourceKits.get(source) || 0;
    let estTokens = 0;
    if (loop) {
      // Only the LATEST pass has per-candidate wave detail to pick between
      // the prefetched/fetched triage rate; the wave's own `degraded` flag
      // is the non-guessy signal for which one applied.
      estTokens += loop.llmTriaged * TOKEN_ESTIMATES.triagePrefetchedPerPosting;
    }
    estTokens += evaluatedCount * TOKEN_ESTIMATES.fullEvaluationPerReport;
    estTokens += kitCount * TOKEN_ESTIMATES.kitPerReport;
    return {
      source,
      found: scan.found,
      new: scan.new,
      freeRejected: loop ? loop.freeRejected : null,
      llmTriaged: loop ? loop.llmTriaged : null,
      qualified: loop ? loop.qualified : null,
      prescreenDiscards: perSourceDiscards.get(source) || 0,
      evaluated: evaluatedCount,
      kits: kitCount,
      ...status,
      estTokens,
    };
  });

  return {
    runId: window.runId,
    window,
    minScore,
    sourceRows,
    waveInfo,
    unattributed: {
      discards: discardsUnattributed,
      evaluated: evaluatedUnattributed,
      kits: kitsUnattributed,
    },
    loopStateCoversThisPass,
    omitted,
  };
}

// ── TSV rendering / idempotent merge ─────────────────────────────────────

export const RETRO_TSV_COLUMNS = [
  'run_id', 'row_type', 'key',
  'found', 'new', 'free_rejected', 'llm_triaged', 'qualified', 'prescreen_discards',
  'evaluated', 'kits', 'applied', 'responded', 'interview', 'rejected', 'est_tokens',
  'duration_ms', 'min_score', 'halted_reason', 'notes',
];

const tsvCell = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim());

function renderRow(fields) {
  return RETRO_TSV_COLUMNS.map((c) => tsvCell(fields[c])).join('\t');
}

/**
 * Turn one buildPassRetro() result into the flat TSV rows this file appends.
 * row_type: 'source' (per-source metrics), 'stage' (per pass-stage wall
 * clock), 'wave' (per loop wave), 'pass' (one summary row: halted reason,
 * minScore, completeness, and any omitted-metric notes).
 *
 * @param {object} passRetro - from buildPassRetro.
 * @returns {string[]} TSV lines (no header, no trailing newline join needed by caller).
 */
export function renderPassRetroRows(passRetro) {
  const { runId, window, minScore, sourceRows, waveInfo, omitted } = passRetro;
  const lines = [];

  for (const row of sourceRows) {
    lines.push(renderRow({
      run_id: runId, row_type: 'source', key: row.source,
      found: row.found, new: row.new,
      free_rejected: row.freeRejected, llm_triaged: row.llmTriaged, qualified: row.qualified,
      prescreen_discards: row.prescreenDiscards, evaluated: row.evaluated, kits: row.kits,
      applied: row.Applied, responded: row.Responded, interview: row.Interview, rejected: row.Rejected,
      est_tokens: row.estTokens,
    }));
  }

  for (const [stage, w] of Object.entries(window.stageWindows)) {
    lines.push(renderRow({ run_id: runId, row_type: 'stage', key: stage, duration_ms: w.ms }));
  }

  if (waveInfo) {
    for (const w of waveInfo.waves) {
      lines.push(renderRow({
        run_id: runId, row_type: 'wave', key: `wave${w.n}:${w.strategy}`,
        found: w.found, new: w.new, duration_ms: w.durationMs,
        notes: w.degraded ? 'degraded: fetch pre-fetch fell back mid-wave' : '',
      }));
    }
  }

  lines.push(renderRow({
    run_id: runId, row_type: 'pass', key: 'pass',
    min_score: minScore,
    halted_reason: passRetro.window.haltedReason || (waveInfo && waveInfo.haltedReason) || '',
    notes: [
      window.completed ? 'completed' : (window.aborted ? 'aborted' : 'window recovered without a done/abort marker'),
      ...omitted,
    ].join(' | '),
  }));

  return lines;
}

const RETRO_HEADER = RETRO_TSV_COLUMNS.join('\t');

/**
 * Idempotently merge one run's rows into data/run-retro.tsv's text: any
 * existing rows for the same run_id are dropped first, so re-running for the
 * same pass replaces rather than duplicates. Writes the header once.
 *
 * @param {string} existingText - current file contents, or '' if absent.
 * @param {string} runId
 * @param {string[]} newLines - from renderPassRetroRows.
 * @returns {string} the full new file contents.
 */
export function mergeRetroTsv(existingText, runId, newLines) {
  const lines = String(existingText || '').split(/\r?\n/).filter((l) => l.length > 0);
  let header = RETRO_HEADER;
  let body = [];
  if (lines.length > 0 && lines[0].startsWith('run_id\t')) {
    header = lines[0];
    body = lines.slice(1);
  } else {
    body = lines;
  }
  const kept = body.filter((l) => {
    const tab = l.indexOf('\t');
    const rid = tab === -1 ? l : l.slice(0, tab);
    return rid !== runId;
  });
  return [header, ...kept, ...newLines].join('\n') + '\n';
}

// ── human --summary rendering ─────────────────────────────────────────────

/**
 * @param {object} passRetro - from buildPassRetro.
 * @returns {string}
 */
export function renderSummary(passRetro) {
  const { runId, window, minScore, sourceRows, omitted } = passRetro;
  const lines = [];
  lines.push(`Pass ${runId} — ${window.startTime.toISOString()} to ${window.endTime.toISOString()}${window.completed ? '' : window.aborted ? ' (ABORTED)' : ' (incomplete)'}`);
  if (minScore != null) lines.push(`minScore=${minScore}`);
  lines.push('');
  lines.push('source                  found   new  free-rej  triaged  qual  evaluated  kit  applied');
  const sorted = [...sourceRows].sort((a, b) => b.found - a.found);
  for (const row of sorted) {
    lines.push([
      row.source.padEnd(22).slice(0, 22),
      String(row.found).padStart(6),
      String(row.new).padStart(5),
      String(row.freeRejected ?? '—').padStart(9),
      String(row.llmTriaged ?? '—').padStart(8),
      String(row.qualified ?? '—').padStart(5),
      String(row.evaluated).padStart(10),
      String(row.kits).padStart(4),
      String(row.Applied).padStart(8),
    ].join(' '));
  }
  lines.push('');
  for (const [stage, w] of Object.entries(window.stageWindows)) {
    lines.push(`stage ${stage}: ${(w.ms / 60000).toFixed(1)} min`);
  }
  if (window.haltedReason) lines.push(`halted: ${window.haltedReason}`);

  const worst = sorted.filter((r) => r.found > 0 && r.evaluated === 0 && r.kits === 0).sort((a, b) => b.found - a.found)[0];
  if (worst) lines.push(`\nBiggest cost with no downstream output: ${worst.source}: ${worst.found} scanned, ${worst.qualified ?? 0} qualified.`);

  if (omitted.length > 0) {
    lines.push('');
    lines.push('Omitted (could not be computed reliably for this pass):');
    for (const o of omitted) lines.push(`  - ${o}`);
  }
  return lines.join('\n');
}

// ── I/O edge ────────────────────────────────────────────────────────────

function readTextSafe(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf-8') : ''; } catch { return ''; }
}

function readJsonSafe(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}

/**
 * Gather every file this script reads, once, and build one pass's retro.
 * Kept as its own function (rather than inline in main) so `--all` can call
 * it once per run_id without re-parsing argv or re-resolving the root.
 *
 * @param {string} root - career-ops data root.
 * @param {Array} runLogEntries - parsed once for the whole invocation.
 * @param {string} runId
 * @returns {object|null} buildPassRetro() result, or null if the run_id has no 'start' line.
 */
export function buildPassRetroForRoot(root, runLogEntries, runId) {
  const window = computePassWindow(runLogEntries, runId);
  if (!window) return null;

  const scanHistoryRows = parseTsv(readTextSafe(join(root, 'data', 'scan-history.tsv')));
  const discardEntries = parseDiscardLog(readTextSafe(join(root, 'data', 'discard.log')));
  const pdfIndexRows = parsePdfIndexTsv(readTextSafe(join(root, 'data', 'pdf-index.tsv')));
  const trackerPath = resolveTrackerPath(root);
  const trackerLines = readTextSafe(trackerPath).split(/\r?\n/);
  const trackerRows = readTrackerRowsWithUrl(trackerLines);

  const reportsDir = join(root, 'reports');
  let reportFilenames = [];
  try { reportFilenames = readdirSync(reportsDir); } catch { reportFilenames = []; }
  const reportFiles = parseReportFilenames(reportFilenames);
  const readReportText = (file) => readFileSync(join(reportsDir, file), 'utf-8');

  const loopState = readJsonSafe(join(root, 'data', 'loop-state.json'));
  const loopRunLogText = readTextSafe(join(root, 'data', 'loop-run-log.md'));

  return buildPassRetro({
    window, scanHistoryRows, discardEntries, reportFiles, readReportText,
    pdfIndexRows, trackerRows, loopState, loopRunLogText,
  });
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('-h') || argv.includes('--help')) {
      console.log('Usage: node run-retro.mjs [--run <run_id> | --all] [--summary] [--json]');
      console.log('  Zero-token post-pass review over run-log.md, loop-state.json,');
      console.log('  loop-run-log.md, scan-history.tsv, discard.log, reports/, pdf-index.tsv');
      console.log('  and the tracker. Appends/replaces rows in data/run-retro.tsv.');
      process.exit(0);
    }

    const root = getCareerOpsRoot();
    const runLogPath = process.env.CAREER_OPS_RUN_LOG || join(root, 'data', 'run-log.md');
    const runLogEntries = parseRunLogText(readTextSafe(runLogPath));

    const argValue = (flag) => {
      const i = argv.indexOf(flag);
      return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
    };

    let targetRunIds;
    if (argv.includes('--all')) {
      targetRunIds = listRecoverableRunIds(runLogEntries);
    } else if (argValue('--run')) {
      targetRunIds = [argValue('--run')];
    } else {
      const statePath = process.env.CAREER_OPS_RUN_STATE || join(root, 'data', 'run-state.json');
      const state = readJsonSafe(statePath);
      if (!state?.run_id) {
        console.log('run-retro: no run-state.json and no --run/--all given — nothing to do.');
        process.exit(0);
      }
      targetRunIds = [state.run_id];
    }

    const results = [];
    for (const runId of targetRunIds) {
      const passRetro = buildPassRetroForRoot(root, runLogEntries, runId);
      if (!passRetro) {
        console.error(`run-retro: run_id ${runId} has no 'start' line in run-log.md — skipped.`);
        continue;
      }
      results.push(passRetro);
    }

    if (results.length === 0) {
      console.log('run-retro: no recoverable pass found.');
      process.exit(0);
    }

    const retroPath = join(root, 'data', 'run-retro.tsv');
    let text = readTextSafe(retroPath);
    for (const passRetro of results) {
      const rows = renderPassRetroRows(passRetro);
      text = mergeRetroTsv(text, passRetro.runId, rows);
    }
    writeFileSync(retroPath, text, 'utf-8');

    if (argv.includes('--json')) {
      console.log(JSON.stringify(results.map((r) => ({
        runId: r.runId,
        minScore: r.minScore,
        completed: r.window.completed,
        aborted: r.window.aborted,
        haltedReason: r.window.haltedReason,
        sources: r.sourceRows,
        omitted: r.omitted,
      })), null, 2));
    } else if (argv.includes('--summary')) {
      for (const passRetro of results) {
        console.log(renderSummary(passRetro));
        console.log('');
      }
    } else {
      console.log(`run-retro: wrote ${results.reduce((n, r) => n + renderPassRetroRows(r).length, 0)} row(s) for ${results.length} pass(es) -> ${retroPath}`);
    }
  } catch (err) {
    // Wired into `run-all.mjs sync` as a non-fatal step (see SYNC_STEPS
    // there): report loudly, never throw a non-zero exit that would read as
    // the pass itself failing.
    console.error(`run-retro: ${err?.stack || err?.message || err}`);
    process.exit(1);
  }
}
