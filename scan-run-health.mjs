#!/usr/bin/env node

/**
 * scan-run-health.mjs — was that scan a real look at the market, or a starved one?
 *
 * On 2026-08-31 a `/career-ops run` pass concluded "0 applications worth making"
 * from 94 postings. The scan behind it had recorded `found=2307, errors=19`
 * against a steady baseline of ~7,800 found and 0 errors. Re-running the
 * identical command 100 minutes later returned `found=7785, errors=0`.
 *
 * Nothing was broken. The run was rate-limited — roughly 115 liveness requests
 * and a burst of StepStone/Siemens/Indeed/robots fetches had gone out minutes
 * earlier — so a third of the providers refused and the scan harvested a third
 * of the market.
 *
 * The bug is not the throttling. It is that NOTHING NOTICED. `scan-runs.tsv`
 * faithfully recorded 19 errors, the loop consumed the result as ordinary
 * evidence, escalated through two "barren" waves, tripped its circuit breaker,
 * and reported an empty market. A degraded run and an empty market are
 * indistinguishable downstream, and only one of them is a fact about jobs.
 *
 * This makes them distinguishable. It reads `data/scan-runs.tsv`, which every
 * scan already writes, and compares the newest run against the median of the
 * runs before it. No network, no tokens.
 *
 * The comparison is a MEDIAN, not a mean: one starved run in the history must
 * not drag the baseline down far enough to make the next starved run look
 * normal.
 *
 * Usage: node scan-run-health.mjs [--json] [--strict]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const RUNS = join(CAREER_OPS, 'data', 'scan-runs.tsv');

/** Runs needed before a baseline means anything. */
export const MIN_HISTORY = 3;
/** Below this share of the median `found`, the run did not see the market. */
export const FOUND_FLOOR_RATIO = 0.5;
/** Provider errors at or above this are a degraded run regardless of yield. */
export const ERROR_LIMIT = 5;

export function parseRuns(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const cols = lines[0].split('\t').map((c) => c.trim());
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const num = (f, k) => {
    const v = idx[k] != null ? f[idx[k]] : undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return lines.slice(1).map((line) => {
    const f = line.split('\t');
    return {
      timestamp: idx.timestamp != null ? f[idx.timestamp] : '',
      status: idx.status != null ? f[idx.status] : '',
      found: num(f, 'found'),
      newAdded: num(f, 'new_added'),
      errors: num(f, 'errors'),
    };
  });
}

export function median(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Judge the newest run against the ones before it.
 *
 * Deliberately says `unknown` rather than `healthy` when there is too little
 * history: "we cannot tell" and "it is fine" are different answers, and only
 * one of them should let a pass draw conclusions about an empty market.
 *
 * @returns {{verdict:'healthy'|'degraded'|'unknown', reasons:string[], found:number,
 *            baseline:number, errors:number}}
 */
export function assessRun(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return { verdict: 'unknown', reasons: ['no scan runs recorded'], found: 0, baseline: 0, errors: 0 };

  const latest = list[list.length - 1];
  // A run that errored heavily did not see the market either, so it must not
  // help define what "normal" looks like. Without this the guard erodes itself:
  // each starved run joins the history, drags the baseline down, and makes the
  // next starved run look ordinary. A median tolerates a MINORITY of outliers,
  // not a growing population of them.
  const history = list.slice(0, -1)
    .filter((r) => r.status === 'completed' && r.errors < ERROR_LIMIT);
  const reasons = [];

  if (latest.errors >= ERROR_LIMIT) {
    reasons.push(`${latest.errors} provider error(s) in this run (limit ${ERROR_LIMIT}) — providers refused, so the market was only partly seen`);
  }

  if (history.length < MIN_HISTORY) {
    return {
      verdict: reasons.length ? 'degraded' : 'unknown',
      reasons: reasons.length ? reasons : [`only ${history.length} prior run(s) — no baseline to compare against`],
      found: latest.found, baseline: 0, errors: latest.errors,
    };
  }

  const baseline = median(history.map((r) => r.found));
  if (baseline > 0 && latest.found < baseline * FOUND_FLOOR_RATIO) {
    const pctOf = Math.round((latest.found / baseline) * 100);
    reasons.push(`found ${latest.found} against a median of ${baseline} (${pctOf}% of baseline) — this run did not see the market`);
  }

  return {
    verdict: reasons.length ? 'degraded' : 'healthy',
    reasons,
    found: latest.found,
    baseline,
    errors: latest.errors,
  };
}

/** Read the file and judge. Returns `unknown` when there is nothing to read. */
export function assessLatestRun(path = RUNS) {
  if (!existsSync(path)) return { verdict: 'unknown', reasons: ['no data/scan-runs.tsv yet'], found: 0, baseline: 0, errors: 0 };
  return assessRun(parseRuns(readFileSync(path, 'utf-8')));
}

/** The line a caller should print when a run is degraded. */
export function degradedWarning(result) {
  return [
    '⚠️  DEGRADED SCAN — do not read this wave as evidence about the market.',
    ...result.reasons.map((r) => `    ${r}`),
    '    Most common cause: this machine was rate-limited by its own recent traffic.',
    '    Wait a few minutes and re-run the wave before drawing any conclusion.',
  ].join('\n');
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { json: { type: 'boolean', default: false }, strict: { type: 'boolean', default: false } }, strict: true }));
  } catch (error) {
    console.error(`scan-run-health: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = assessLatestRun();
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.verdict === 'degraded') {
    console.log(degradedWarning(result));
  } else if (result.verdict === 'unknown') {
    console.log(`⚪ scan-run health unknown — ${result.reasons.join('; ')}`);
  } else {
    console.log(`✅ last scan looks healthy — found ${result.found} against a median of ${result.baseline}, ${result.errors} error(s).`);
  }
  if (values.strict && result.verdict === 'degraded') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
