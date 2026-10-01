#!/usr/bin/env node

/**
 * scan-loop.mjs — the driver for the career-ops scan loop.
 *
 * `loop-core.mjs` decides what happens next; this file performs it and persists
 * the result. Together they implement the loop-engineering pattern
 * (github.com/cobusgreyling/loop-engineering) over career-ops' existing
 * zero-token scanners: durable state outside the conversation, an escalation
 * ladder, explicit budgets and a circuit breaker, and a human review gate that
 * the loop can never step past.
 *
 * The agent drives it by calling `next` and doing what it says:
 *
 *   node scan-loop.mjs start                # begin a run (target/min-score from config)
 *   node scan-loop.mjs next                 # {action: scan|score|finish|halt} + payload
 *   node scan-loop.mjs wave                 # run the next scan rung (action: scan)
 *   node scan-loop.mjs ingest --file o.json # hand-scanned offers in (agent-web rung)
 *   node scan-loop.mjs record --file s.json # feed triage scores back (action: score)
 *   node scan-loop.mjs finish               # promote to shortlist + tracker
 *   node scan-loop.mjs status [--summary]
 *   node scan-loop.mjs abort --note "..."   # end a stuck run without promoting
 *
 * Zero Claude tokens on its own — every token the loop spends is spent by the
 * agent inside a `score` step, which is why `loop.maxScored` is the budget that
 * actually matters.
 *
 * State: data/loop-state.json · Review gate: data/loop-shortlist.md
 * Audit trail: data/loop-run-log.md · Loop definition: LOOP.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, appendFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import {
  DEFAULT_LOOP_CONFIG,
  resolveLoopConfig, newState, normalizeState, ingestOffers, recordScores,
  parseTriageOutput, decideNextAction, summarize, qualifiedCandidates,
  renderShortlist, renderRunLogEntry, toHumanUrl, inboxVerdictRows, inboxQualifierRows,
  effectiveStrategies, aggregatorNote, aggregatorHost, candidateKey,
  HALT_BUDGET,
  HALT_ABORTED,
  classifyHaltReason,
} from './loop-core.mjs';
import { parsePipeline, rankEntry, writeVerdictRowsToInbox } from './triage-prefilter.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { appendToPipeline, appendToScanHistory, SCAN_HISTORY_PATH } from './scan.mjs';
import {
  DEFAULT_AGGREGATOR_HOSTS, isAggregatorUrl, resolveAggregatorLeads,
  rewriteResolvedLine, rewriteUnresolvedLine, applyPipelineChanges,
} from './resolve-aggregator-leads.mjs';
import { normalizeUrl } from './url-key.mjs';
import { localToday } from './lib/local-today.mjs';
import { assessLatestRun, degradedWarning } from './scan-run-health.mjs';
import { loadCheckpoint, checkpointCompatible, parseArgs as parseScanAtsFullArgs, SOURCES as ATS_SOURCES } from './scan-ats-full.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// Every artifact the driver writes is redirectable, following the one-env-var-
// per-artifact convention the rest of the repo uses (CAREER_OPS_TRACKER,
// CAREER_OPS_FOLLOWUPS, CAREER_OPS_ADDITIONS, ...). Only the state file was
// overridable before, which left the audit trail, the shortlist and the tracker
// TSVs pinned to the real repo: any test of `start`/`ingest`/`finish` appended
// to the user's own data/loop-run-log.md and dropped rows into their tracker
// queue. An untestable write path is an untested one, and this is the path that
// promotes candidates. CAREER_OPS_ADDITIONS is deliberately the same variable
// merge-tracker.mjs reads, so redirecting it moves both ends of the handoff.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const STATE_PATH = process.env.CAREER_OPS_LOOP_STATE || join(CAREER_OPS, 'data', 'loop-state.json');
const SHORTLIST_PATH = process.env.CAREER_OPS_LOOP_SHORTLIST || join(CAREER_OPS, 'data', 'loop-shortlist.md');
const RUN_LOG_PATH = process.env.CAREER_OPS_LOOP_RUN_LOG || join(CAREER_OPS, 'data', 'loop-run-log.md');
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(CAREER_OPS, 'data', 'pipeline.md');
const DISCARD_LOG_PATH = process.env.CAREER_OPS_DISCARD_LOG || join(CAREER_OPS, 'data', 'discard.log');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(CAREER_OPS, 'config', 'profile.yml');
const TSV_DIR = process.env.CAREER_OPS_ADDITIONS || join(CAREER_OPS, 'batch', 'tracker-additions');
// The same file merge-tracker.mjs reads for its aggregator-URL guard (it honours
// CAREER_OPS_PORTALS too), so `finish` resolves aggregator leads against exactly
// the boards the merge will later check them against.
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(CAREER_OPS, 'portals.yml');

// The authoritative ATS source ids, passed into resolveLoopConfig so
// `loop.ats_sources` is validated against scan-ats-full.mjs's real SOURCES
// table rather than a hand-copied duplicate (loop-core.mjs stays
// dependency-free and falls back to its own copy when called without this).
const KNOWN_ATS_SOURCES = Object.keys(ATS_SOURCES);

// ── State I/O ───────────────────────────────────────────────────────────────

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch (err) {
    console.error(`scan-loop: could not parse ${PROFILE_PATH} — ${err.message}`);
    return {};
  }
}

/** portals.yml, or `{}` when it is absent or unreadable — resolution then simply
 * finds no tracked board, the same degradation merge-tracker.mjs applies. */
function loadPortals() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    return yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch (err) {
    console.error(`scan-loop: could not parse ${PORTALS_PATH} — ${err.message}`);
    return {};
  }
}

/** resolveLoopConfig, wired to the real SOURCES table so `loop.ats_sources` is
 * validated against it. Throws (config error) on an unknown skip/ats id — left
 * to propagate to main()'s catch, same as every other scan-loop error. */
function loadLoopConfig() {
  return resolveLoopConfig(loadProfile(), { knownAtsSources: KNOWN_ATS_SOURCES });
}

function loadState() {
  const config = loadLoopConfig();
  if (!existsSync(STATE_PATH)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_PATH, 'utf-8')), config);
  } catch (err) {
    throw new Error(`loop state at ${STATE_PATH} is unreadable (${err.message}). `
      + 'Inspect it, or start a fresh run with `node scan-loop.mjs start --reset`.');
  }
}

/** Write-then-rename: an interrupted write must never leave a half-run on disk. */
function saveState(state) {
  state.updated_at = new Date().toISOString();
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_PATH);
}

function log(state, event, detail = '') {
  mkdirSync(dirname(RUN_LOG_PATH), { recursive: true });
  if (!existsSync(RUN_LOG_PATH)) {
    writeFileSync(RUN_LOG_PATH, '# Loop run log\n\nAppend-only. Written by `scan-loop.mjs`.\n\n', 'utf-8');
  }
  appendFileSync(RUN_LOG_PATH, `${renderRunLogEntry(state, event, detail)}\n`, 'utf-8');
}

function requireState() {
  const state = loadState();
  if (!state) {
    throw new Error('no loop run in progress — start one with `node scan-loop.mjs start`.');
  }
  return state;
}

// ── Pipeline snapshot ───────────────────────────────────────────────────────

/**
 * Read the scanner's own output surface rather than parsing each scanner's
 * stdout. `scan.mjs` and `scan-ats-full.mjs` print different summaries and only
 * one of them speaks `--json`, but both write the same `data/pipeline.md` rows —
 * so diffing the inbox is the one snapshot that works for every rung, including
 * rungs added later.
 */
function pipelineSnapshot() {
  if (!existsSync(PIPELINE_PATH)) return [];
  return parsePipeline(readFileSync(PIPELINE_PATH, 'utf-8')).pending;
}

function diffPipeline(before) {
  const seen = new Set(before.map((e) => e.url));
  return pipelineSnapshot().filter((e) => !seen.has(e.url));
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdStart(flags) {
  const config = loadLoopConfig();
  if (Number.isFinite(flags.target)) config.target = flags.target;
  if (Number.isFinite(flags['min-score'])) config.minScore = flags['min-score'];

  const existing = existsSync(STATE_PATH) ? loadState() : null;
  if (existing && existing.phase !== 'done' && !flags.reset) {
    const stats = summarize(existing);
    throw new Error(`a run is already in progress (${stats.qualified}/${stats.target} qualified, `
      + `${stats.waves} wave(s)). Continue it with \`next\`, or discard it with \`start --reset\`.`);
  }

  const state = newState(config);
  saveState(state);
  // Recorded here too (not just in state.config), so a run's audit trail says
  // up front what was deliberately left out of the ladder — a pass report
  // reading only the run log must not mistake "skipped by config" for "ran
  // and found nothing" on a rung that never appears in the wave list at all.
  const skipNote = config.skipStrategies.length ? ` skip=${config.skipStrategies.join(',')}` : '';
  const atsNote = config.atsSources ? ` ats=${config.atsSources.join(',')}` : '';
  log(state, 'start', `target=${config.target} minScore=${config.minScore}${skipNote}${atsNote}`);
  return { started: true, config, next: decideNextAction(state) };
}

function cmdNext() {
  const state = requireState();
  const decision = decideNextAction(state);
  // A halt is a real outcome, not a transient view — record it so `status` and
  // the shortlist both explain why the run stopped short.
  if (decision.action === 'halt' && !state.halted_reason) {
    state.halted_reason = decision.reason;
    // Every reason decideNextAction can halt on is a bound the loop was given,
    // so this is the loop finishing its ladder — not failing. Recorded
    // structurally because run-all.mjs has to tell it apart from an abort, and
    // matching on the message text is not a contract.
    state.halted_kind = HALT_BUDGET;
    saveState(state);
    log(state, 'halt', decision.reason);
  }
  // Say which COMMAND advances the loop, not just which strategy is due.
  //
  // A scan decision carries `strategy.command`/`strategy.args`, and an agent
  // reading that naturally runs it directly — but only `wave` snapshots the
  // inbox, records the rung and advances the state. Running the strategy by
  // hand scans for real, adds postings, and leaves the loop exactly where it
  // was, so the next `next` returns the identical wave: a loop that never
  // terminates while looking like it is working. Observed on a wave-2
  // reverse-ATS sweep that added 311 postings and moved the counters zero.
  if (decision.action === 'scan') {
    decision.instructions = decision.strategy?.kind === 'agent'
      ? 'Run `node scan-loop.mjs wave` — it will hand this rung back to you with an ingest contract.'
      : 'Run `node scan-loop.mjs wave` (NOT strategy.command directly — only `wave` records the rung '
        + 'and advances the loop). `strategy` is shown so you know what it will run.';
  }
  return decision;
}

/**
 * Zero-token pre-triage: reject what the title and location already settle.
 *
 * `triage-prefilter.mjs` has ranked postings on title + location since it was
 * written, and NOTHING in the loop ever called it — scan-loop and run-all both
 * import only its `parsePipeline` parser. Every posting therefore reached the
 * agent, which is the single most expensive step in the pass.
 *
 * Measured on the 113 postings triaged on 2026-08-31: the prefilter buckets
 * them look=4, maybe=33, skip=76. Scoring only look+maybe is a 67% cut in agent
 * triage, and BOTH rows that went on to qualify land in `maybe` — neither would
 * have been lost.
 *
 * Only the `skip` bucket is auto-rejected, never `maybe`. The prefilter's own
 * doctrine is that an ambiguous posting is cheap to surface and expensive to
 * drop, so anything it is unsure about still costs a model call. Each
 * auto-rejection records the prefilter's reason verbatim, so the audit trail
 * says what decided it and no posting disappears unexplained.
 */
function prefilterReject(state) {
  let rejected = 0;
  for (const c of Object.values(state.candidates ?? {})) {
    if (c.verdict !== 'pending') continue;
    let r;
    try {
      r = rankEntry({ title: c.title || '', location: c.location || '', url: c.url || '', company: c.company || '' });
    } catch { continue; }          // never let a ranking error drop a posting
    if (r.bucket !== 'skip') continue;
    c.score = Number.isFinite(r.score) ? r.score : 1.0;
    c.verdict = 'rejected';
    c.reason = `zero-token prefilter (title + location only): ${r.reason}`;
    c.prefiltered = true;
    rejected++;
  }
  return rejected;
}

/**
 * The scanner's argv for this rung, with `--resume` added when a compatible
 * checkpoint from an interrupted sweep is sitting on disk.
 *
 * Only ever ADDS the flag — never removes a caller's, never resumes a
 * checkpoint the compatibility test rejects, and never touches a dry run.
 */
export function buildWaveArgs(strategy, flags) {
  const base = flags['dry-run'] ? [...strategy.args, '--dry-run'] : [...strategy.args];
  if (flags['dry-run']) return base;
  if (!/scan-ats-full\.mjs/.test(String(strategy.args?.[0] ?? ''))) return base;
  if (base.includes('--resume')) return base;
  try {
    const cp = loadCheckpoint();
    if (!cp) return base;
    // Derive opts with the SAME parser scan-ats-full.mjs uses on itself, so
    // compatibility is judged against identical defaults. The old hand-rolled
    // since/ats extraction only ever produced a partial opts object — no
    // `limit`/`includeUndated`/`shuffle` keys at all — so checkpointCompatible
    // compared the scanner's real defaults (limit: null, includeUndated: false)
    // against `undefined` and never matched, even for a checkpoint written by
    // this exact rung with no flags overridden. That's why the default
    // ats-recent rung (`--since 7`) could never resume.
    //
    // parseArgs takes a process.argv-shaped array and slices off the first
    // two elements itself, so prepend a dummy argv[0]/argv[1] pair — base[0]
    // is already the script name scan-ats-full.mjs runs as.
    //
    // parseArgs calls process.exit(1) on an invalid flag or value (bad
    // --since, unknown --ats source, ...). strategy.args comes only from the
    // hardcoded WAVE_STRATEGIES table, never from user input, so that can't
    // fire today — but neutralize process.exit for the call anyway, so a
    // future rung with a typo'd flag degrades to "no --resume" instead of
    // taking the whole loop process down.
    const realExit = process.exit;
    let opts;
    try {
      process.exit = (code) => { throw new Error(`scan-ats-full argv parse exited(${code})`); };
      opts = parseScanAtsFullArgs(['node', ...base]);
    } finally {
      process.exit = realExit;
    }
    if (!checkpointCompatible(cp, opts)) return base;
    const held = Array.isArray(cp.offers) ? cp.offers.length : 0;
    console.error(`  resuming an interrupted sweep: ${cp.completedSources?.join(', ') || 'none'} complete, `
      + `${cp.current?.name ?? '?'} at ${cp.current?.resumeAt ?? '?'}/${cp.current?.datasetLen ?? '?'}, ${held} offer(s) held.`);
    return [...base, '--resume'];
  } catch {
    return base;   // a checkpoint we cannot read, or rung args we cannot parse, is not a reason to skip the wave
  }
}

function cmdWave(flags) {
  const state = requireState();
  const decision = decideNextAction(state);
  if (decision.action !== 'scan') {
    throw new Error(`next action is "${decision.action}", not "scan" — ${decision.reason}`);
  }

  const { strategy, wave } = decision;
  if (strategy.kind === 'agent') {
    // No script exists for open-ended web discovery. Hand the rung back to the
    // agent with an explicit contract instead of pretending it ran.
    return {
      action: 'agent-scan',
      wave,
      strategy: strategy.id,
      instructions: `Run ${strategy.describe}. Collect {url, company, title, location} for every `
        + 'hit that passes portals.yml title_filter/location_filter, write them as a JSON array, '
        + 'then run `node scan-loop.mjs ingest --file <that file>`.',
    };
  }

  const before = pipelineSnapshot();
  const started = new Date().toISOString();
  // Continue an interrupted sweep instead of silently restarting it.
  //
  // scan-ats-full.mjs persists only when every requested source has finished,
  // so a sweep killed part-way discards every match it holds — and the loop
  // then re-invokes it with no --resume, which walks the same companies from
  // company 0 and, if it is interrupted again at the same point, can never make
  // progress. Observed 2026-08-31: the ats-recent wave was SIGTERMed after ~24
  // minutes holding 55 matched offers (54 of them new), greenhouse complete and
  // lever at 969/4368. All of it was dropped, and the five -full portals showed
  // as producing nothing for 13 days.
  //
  // The checkpoint and its compatibility test already existed and were already
  // exported; nothing ever consulted them. Now the loop does, and says so —
  // a resumed sweep is a fact the run log should carry, not a silent detail.
  const args = buildWaveArgs(strategy, flags);
  // The scanner's progress goes to OUR stderr, not our stdout: a rung runs for
  // minutes so its output has to stream live, but this command's contract is a
  // single JSON object on stdout and an agent piping it to a parser must not
  // get the scanner's summary mixed into it. `2` maps the child's stdout onto
  // fd 2 — still live, just on the other stream.
  const result = spawnSync(strategy.command, args, { cwd: ROOT, stdio: ['ignore', 2, 'inherit'] });

  if (result.error) {
    throw new Error(`wave ${wave} (${strategy.id}) could not start: ${result.error.message}`);
  }
  // A scanner exiting non-zero is a partial wave, not a dead loop — record it
  // and let the ladder widen rather than stranding the run.
  const found = diffPipeline(before);
  const { added, duplicate } = ingestOffers(state, found, wave);
  const prefiltered = prefilterReject(state);
  if (prefiltered) console.error(`  pre-triage: ${prefiltered} posting(s) rejected on title + location alone (zero tokens).`);

  // Was that a real look at the market, or a starved one?
  //
  // On 2026-08-31 a pass concluded "0 applications worth making" from a scan
  // that recorded found=2307/errors=19 against a ~7,800/0 baseline; the same
  // command 100 minutes later returned 7785/0. The machine had rate-limited
  // itself with ~115 liveness requests minutes earlier. Nothing noticed: the
  // loop counted the thin result as an ordinary wave, called the next two
  // barren, and tripped its circuit breaker on a third of the market.
  //
  // A degraded wave is recorded as such and does NOT count toward the barren
  // streak — an empty market and an unseen market are different facts, and only
  // one of them should end a run.
  const health = strategy.id === 'portals' ? assessLatestRun() : { verdict: 'unknown', reasons: [], found: 0, baseline: 0, errors: 0 };
  const degraded = health.verdict === 'degraded';
  if (degraded) console.error(`
${degradedWarning(health)}
`);

  state.waves.push({
    n: wave,
    strategy: strategy.id,
    started_at: started,
    finished_at: new Date().toISOString(),
    exit_code: result.status ?? null,
    found: found.length,
    added,
    duplicate,
    degraded,
    ...(degraded ? { degraded_reasons: health.reasons } : {}),
  });
  saveState(state);
  log(state, 'wave', `${strategy.id} exit=${result.status} found=${found.length} new=${added}`
    + (degraded ? ` DEGRADED(${health.found} vs baseline ${health.baseline}, ${health.errors} errors)` : ''));

  return { wave, strategy: strategy.id, exitCode: result.status, found: found.length, added, duplicate, prefiltered,
    degraded, ...(degraded ? { degradedReasons: health.reasons } : {}), next: decideNextAction(state) };
}

/**
 * Give agent-ingested offers the attribution a scanner wave's postings get for
 * free. A wave's rows land in data/scan-history.tsv with the provider's
 * `<id>-api` label in the `portal` column, and run-retro.mjs joins everything
 * downstream (discards, reports, kits, tracker status) back to that column by
 * URL. `ingest` wrote only loop state, so every agent-sourced lead — Indeed,
 * Apify LinkedIn/Xing/StepStone/HiringCafe — surfaced as "(unattributed)".
 *
 * Only offers that carry a `source` are written (an offer without one stays
 * unattributed, as before), and only for a URL scan-history has no row for yet:
 * run-retro keeps the FIRST row per URL, and a second would double-count the
 * sighting in that source's found/new totals. Never throws — the loop state
 * already holds the offers, and a failed history append must not undo an ingest.
 *
 * @param {Array<{url:string, company?:string, title?:string, location?:string, postedAt?:string|null, source?:string}>} candidates
 * @returns {Promise<number>} rows appended
 */
async function recordSourcesInScanHistory(candidates) {
  try {
    const withSource = candidates.filter((c) => c?.source && c.url);
    if (withSource.length === 0) return 0;
    const known = new Set();
    if (existsSync(SCAN_HISTORY_PATH)) {
      for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split(/\r?\n/)) {
        const key = normalizeUrl(line.split('\t')[0] ?? '');
        if (key) known.add(key);
      }
    }
    const rows = [];
    for (const c of withSource) {
      const key = normalizeUrl(c.url);
      if (!key || known.has(key)) continue;
      known.add(key);
      const posted = Date.parse(c.postedAt ?? '');
      rows.push({
        url: c.url, title: c.title, company: c.company, location: c.location, source: c.source,
        postedAt: Number.isFinite(posted) ? posted : undefined,
      });
    }
    if (rows.length === 0) return 0;
    // The LOCAL day, like every other scan-history writer (tests/local-today-gates).
    const today = localToday();
    await appendToScanHistory(rows, today, 'added');
    return rows.length;
  } catch (err) {
    console.error(`  scan-history: could not record the source of the ingested offers — ${err.message}`);
    return 0;
  }
}

export async function cmdIngest(flags) {
  const state = requireState();
  if (!flags.file) throw new Error('ingest needs `--file <offers.json>` (a JSON array of {url, company, title, location, source?}).');
  const offers = JSON.parse(readFileSync(flags.file, 'utf-8'));
  if (!Array.isArray(offers)) throw new Error(`${flags.file} must contain a JSON array of offers.`);

  const wave = state.waves.length + 1;
  // effectiveStrategies(), not raw WAVE_STRATEGIES: with a rung skipped by
  // config, the strategy actually due at this wave index shifts, and this
  // must label the ingested wave the same way decideNextAction would have.
  const strategy = effectiveStrategies(state.config)[state.waves.length];
  const knownBefore = new Set(Object.keys(state.candidates));
  const counts = ingestOffers(state, offers, wave);
  const attributed = await recordSourcesInScanHistory(
    Object.values(state.candidates).filter((c) => !knownBefore.has(c.key)));
  const prefiltered = prefilterReject(state);
  if (prefiltered) console.error(`  pre-triage: ${prefiltered} posting(s) rejected on title + location alone (zero tokens).`);
  state.waves.push({
    n: wave,
    strategy: strategy ? strategy.id : 'manual',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    exit_code: 0,
    found: offers.length,
    added: counts.added,
    duplicate: counts.duplicate,
  });
  saveState(state);
  log(state, 'ingest', `wave=${wave} found=${offers.length} new=${counts.added}${attributed ? ` sourced=${attributed}` : ''}`);
  return { wave, ...counts, ...(attributed ? { sourced: attributed } : {}), next: decideNextAction(state) };
}

/**
 * Accept scores in either shape the agent can produce:
 *   - a JSON array of `{key, score, verdict?, reason?}` (preferred, unambiguous)
 *   - raw text containing `key<TAB>TRIAGE: ...` lines straight from triage mode
 *
 * The TSV form exists because asking a subagent for strict JSON and getting
 * prose-wrapped JSON back is the most common failure in this loop; a tab and a
 * TRIAGE line survive that.
 *
 * Returns `{results, unparsed}`. `unparsed` lists the TSV lines that carried a
 * key but no parseable TRIAGE verdict — dropping those silently is how a posting
 * whose title held a `|` stayed pending with nothing said (see parseTriageLine).
 */
function parseScoreFile(text) {
  // PowerShell/Notepad on Windows write CRLF (and Set-Content -Encoding utf8
  // in PowerShell 5.1 adds a leading UTF-8 BOM) -- strip the BOM before
  // trimming so the first key matches, and split on /\r?\n/ below so every
  // line, not just the last, survives.
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('score file JSON must be an array.');
    return { results: parsed, unparsed: [] };
  }
  const results = [];
  const unparsed = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const key = line.slice(0, tab).trim();
    const [verdict] = parseTriageOutput(line.slice(tab + 1));
    if (verdict) results.push({ key, ...verdict });
    else if (key) unparsed.push({ key, line: line.slice(tab + 1).trim().slice(0, 160) });
  }
  return { results, unparsed };
}

function cmdRecord(flags) {
  const state = requireState();
  if (!flags.file) throw new Error('record needs `--file <scores.json>` (JSON array, or key<TAB>TRIAGE lines).');
  const { results, unparsed } = parseScoreFile(readFileSync(flags.file, 'utf-8'));
  const { unknown: unknownKeys, ...counts } = recordScores(state, results);
  saveState(state);
  log(state, 'score', `scored=${counts.scored} qualified=${counts.qualified} unmatched=${unknownKeys.length} unparsed=${unparsed.length}`);

  // A line or key that lands nowhere used to vanish, leaving its posting pending
  // with no sign of why. Say so on both streams: stderr for a human, the JSON for
  // the agent driving this.
  if (unparsed.length) {
    console.error(`  record: ${unparsed.length} line(s) had a key but no parseable TRIAGE verdict — `
      + `${unparsed.map((u) => u.key).join(', ')}. Expected \`key<TAB>TRIAGE: VERDICT | Company | Title | X.X/5 | reason\`.`);
  }
  if (unknownKeys.length) {
    console.error(`  record: ${unknownKeys.length} key(s) matched no candidate in this run — ${unknownKeys.join(', ')}.`);
  }
  const result = { ...counts, unparsed, unknownKeys };

  if (counts.scored === 0) {
    // Silently recording nothing would look like a barren wave and trip the
    // circuit breaker for the wrong reason. Non-zero exit, but with the JSON
    // still printed so the caller can see WHICH lines and keys failed.
    console.error(`scan-loop: no score in ${flags.file} matched a candidate in this run `
      + `(${unknownKeys.length} unmatched key(s), ${unparsed.length} unparseable line(s)). `
      + 'Re-run `next` and use the exact `key` values it returned.');
    process.exitCode = 1;
    return result;
  }
  return { ...result, next: decideNextAction(state) };
}

function cmdStatus() {
  const state = loadState();
  if (!state) return { running: false };
  return {
    running: state.phase !== 'done',
    run_id: state.run_id,
    phase: state.phase,
    halted_reason: state.halted_reason,
    // Falls back to classifying the message for states written before the field
    // existed; unrecognised text stays 'aborted', the cautious reading.
    halted_kind: state.halted_kind ?? classifyHaltReason(state.halted_reason),
    ...summarize(state),
    waves: state.waves,
    next: decideNextAction(state),
  };
}

// ── finish: promote to the review gate and the dashboard ────────────────────

/** `reserve-report-num.mjs` refuses a `--count` above this, in one call or one release. */
const RESERVE_CHUNK = 50;

/**
 * Claim tracker numbers for the rows about to be written.
 *
 * Returns the reservation ranges alongside the numbers instead of releasing
 * them here: the sentinels are what stops a second process taking the same
 * numbers, and the tracker rows only start holding them once `merge-tracker.mjs`
 * has run. `cmdFinish` releases after the merge — see `releaseNumbers`.
 */
function reserveNumbers(count) {
  const numbers = [];
  const ranges = [];
  for (let claimed = 0; claimed < count; claimed += RESERVE_CHUNK) {
    const size = Math.min(RESERVE_CHUNK, count - claimed);
    const args = size === 1 ? [] : ['--count', String(size)];
    const res = spawnSync('node', ['reserve-report-num.mjs', ...args], { cwd: ROOT, encoding: 'utf-8' });
    if (res.error || res.status !== 0) {
      // Hand back whatever was already claimed — an abandoned sentinel would sit
      // there for 4h blocking those numbers for no reason.
      releaseNumbers(ranges);
      throw new Error(`could not reserve tracker numbers: ${(res.stderr || res.error?.message || '').trim()}`);
    }
    const out = res.stdout.trim();
    ranges.push(out);
    const [first, last] = out.split('-');
    const start = parseInt(first, 10);
    const end = last ? parseInt(last, 10) : start;
    for (let n = start; n <= end; n++) numbers.push(n);
  }
  return { numbers, ranges };
}

/**
 * Drop the reservation sentinels. Best-effort by design: the numbers are held by
 * the tracker rows themselves from here on, and a leftover sentinel is
 * garbage-collected after 4h anyway, so a failure here must not fail the run.
 */
function releaseNumbers(ranges) {
  for (const range of ranges) {
    spawnSync('node', ['reserve-report-num.mjs', '--release', range], { cwd: ROOT, encoding: 'utf-8' });
  }
}

/**
 * One TSV per row, merged by `merge-tracker.mjs` — never edit the tracker directly.
 *
 * The posting URL is appended as the optional trailing field, and that is
 * load-bearing rather than decorative: merge-tracker matches on URL FIRST and
 * treats a confirmed mismatch on both sides as proof two rows are NOT
 * duplicates. Without it the only signal left is fuzzy company+role, which
 * collapses distinct postings whenever the board publishes no employer.
 *
 * Observed 2026-08-19: stellenwerk lists postings without a company, so two
 * different Nuremberg HiWi roles ("Prototype Engineer" and "Test Engineer")
 * arrived as company `?` with near-identical titles, fuzzy-matched, and the
 * second overwrote the first as a "downgrade" — nine promoted candidates became
 * eight tracker rows and one real posting vanished silently. The loop held both
 * URLs the whole time and was discarding them here.
 */
function writeTrackerAdditions(candidates, date) {
  mkdirSync(TSV_DIR, { recursive: true });
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  /** @type {string[]} the TSV file names written, so `finish` can ask the merge about each one */
  const written = [];
  for (const c of candidates) {
    if (!c.reportNum) continue;
    const slug = (cell(c.company) || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // An aggregator-sourced qualifier carries its provenance (resolved from, or
    // still aggregator-only) into the tracker's notes, same wording as the inbox.
    const provenance = aggregatorNote(c);
    const note = `triage-only from loop wave ${c.wave} — full evaluation pending${provenance ? `; ${provenance}` : ''}`;
    // Canonicalised on the way in: the tracker's URL column is what the user
    // clicks, and a provider's stored href is not always clickable.
    const url = toHumanUrl(cell(c.url));
    const row = [
      c.reportNum, date, cell(c.company) || '?', cell(c.title) || 'Unknown role',
      'Evaluated', `${c.score.toFixed(1)}/5`, '❌', '—', note,
      // Detected by its http(s):// prefix, so it stays order-independent with
      // the optional location/via fields. Omitted entirely when absent rather
      // than written empty, which would read as a confirmed-blank URL.
      ...(/^https?:\/\//i.test(url) ? [url] : []),
    ].join('\t');
    const file = `${String(c.reportNum).padStart(3, '0')}-${slug}.tsv`;
    writeFileSync(join(TSV_DIR, file), `${row}\n`, 'utf-8');
    written.push(file);
  }
  return written;
}

// ── aggregator leads: resolve before anything is written ────────────────────

/**
 * Point every aggregator-sourced qualifier at the employer's own posting, when
 * the zero-network tiers can find it.
 *
 * An agent-ingested offer arrives with whatever URL the agent saw — often a
 * `to.indeed.com`/`indeed.com`/`stepstone.de` listing. merge-tracker.mjs refuses
 * to write such a URL for a company whose own board is already in portals.yml
 * ("resolve it to the employer's posting first"), and `finish` used to write the
 * TSV, run the merge, and report the row as merged without ever resolving it
 * (pass run-20261001T142311, Siemens: no tracker row 202). The resolution
 * `resolve-aggregator-leads.mjs` performs on the inbox now happens here first, by
 * calling the same code: lib/resolve-employer-posting.mjs's tiers, zero-network
 * by default (`probe` stays off — a live discover-ats probe is something the user
 * opts into with that script's `--probe`, not something `finish` does).
 *
 * Mutates the candidates in place and returns the tally:
 *   resolved   `url` becomes the employer's posting; `resolvedFrom` keeps the
 *              aggregator URL as provenance (the inbox/tracker note reads it)
 *   unresolved `aggregatorUnresolved` is set; the URL is left alone, and the
 *              inbox line carries `note: aggregator-only, unresolved` so a later
 *              `resolve-aggregator-leads.mjs --write` can finish the job
 * A candidate whose `resolvedFrom` is already set was handled by an earlier
 * `finish` and is not looked at again; an unresolved one is retried every time.
 *
 * @param {Array<object>} candidates qualified loop candidates
 * @param {{resolveFn?: Function, portals?: any, aggregatorHosts?: string[]}} [opts]
 * @returns {Promise<{resolved: number, unresolved: number, details: Array<{company:string, from:string, to?:string}>}>}
 */
export async function resolveAggregatorQualifiers(candidates, {
  resolveFn, portals, aggregatorHosts = DEFAULT_AGGREGATOR_HOSTS,
} = {}) {
  const leads = candidates.filter((c) => c && !c.resolvedFrom && isAggregatorUrl(c.url, aggregatorHosts));
  if (leads.length === 0) return { resolved: 0, unresolved: 0, details: [] };
  const { results } = await resolveAggregatorLeads(
    leads.map((c) => ({ company: c.company, title: c.title, location: c.location, url: c.url, raw: null, candidate: c })),
    { ...(resolveFn ? { resolveFn } : {}), aggregatorHosts, probe: false, portals: portals ?? loadPortals() },
  );
  const details = [];
  let resolved = 0;
  for (const r of results) {
    const c = r.entry.candidate;
    if (r.resolved && r.employerUrl) {
      details.push({ company: c.company, from: c.url, to: r.employerUrl });
      c.resolvedFrom = c.url;
      c.url = r.employerUrl;
      delete c.aggregatorUnresolved;
      resolved += 1;
    } else {
      details.push({ company: c.company, from: c.url });
      c.aggregatorUnresolved = true;
    }
  }
  return { resolved, unresolved: results.length - resolved, details };
}

/**
 * Bring inbox lines for aggregator-sourced qualifiers in line with the
 * resolution: a pending line still carrying the aggregator URL is rewritten to the
 * employer's posting (aggregator URL kept in `note:`) when it resolved, or marked
 * `aggregator-only, unresolved` when it did not — the exact rewrites
 * `resolve-aggregator-leads.mjs --write` applies. Matched by `candidateKey`, so an
 * inbox spelling that differs from the candidate's (`http`, `www.`, tracking
 * params) is still found. Idempotent. Never throws, like the rest of the inbox
 * work: the candidates are already promoted.
 *
 * @returns {Promise<{rewritten: number, error?: string}>}
 */
async function rewriteAggregatorInbox(state) {
  const qualifiers = qualifiedCandidates(state).filter((c) => c.resolvedFrom || c.aggregatorUnresolved);
  if (qualifiers.length === 0 || !existsSync(PIPELINE_PATH)) return { rewritten: 0 };
  try {
    return await withPipelineLock(PIPELINE_PATH, () => {
      const md = readFileSync(PIPELINE_PATH, 'utf-8');
      const transforms = new Map();
      for (const entry of parsePipeline(md).pending) {
        const entryKey = candidateKey(entry.url);
        const c = qualifiers.find((q) => candidateKey(q.resolvedFrom || q.url || q.key) === entryKey);
        if (!c) continue;
        if (c.resolvedFrom) {
          transforms.set(entry.url, (line) => rewriteResolvedLine(line, {
            employerUrl: c.url, aggregatorUrl: entry.url, host: aggregatorHost(entry.url) || 'aggregator',
          }));
        } else {
          transforms.set(entry.url, (line) => rewriteUnresolvedLine(line));
        }
      }
      const { text, applied } = applyPipelineChanges(md, transforms);
      if (applied > 0) writeFileSync(PIPELINE_PATH, text, 'utf-8');
      return { rewritten: applied };
    });
  } catch (err) {
    return { rewritten: 0, error: err.message };
  }
}

// ── merge: say what the merge actually did ──────────────────────────────────

/**
 * Run merge-tracker.mjs and read back what it did to each TSV `finish` wrote.
 *
 * merge-tracker's exit code says only that it did not crash: it exits 0 after
 * SKIPPING a TSV (an aggregator URL to resolve first, a malformed row, a
 * batch-failed report). `finish` read that as "merged" and reported a tracker row
 * for every TSV written. The merge now writes a per-TSV outcome file
 * (CAREER_OPS_MERGE_RESULT) and refused TSVs stay in the additions dir; this reads
 * it and answers per TSV `finish` wrote — added/updated count as tracker rows,
 * anything else (skipped, failed, or not mentioned at all) is reported with its
 * reason rather than assumed.
 *
 * @param {string[]} files TSV names `finish` wrote
 * @returns {{merged: boolean, mergeStatus: 'complete'|'partial'|'failed', trackerRows: number,
 *   trackerSkipped: Array<{tsv: string, reason: string}>, exitCode: number|null}}
 */
function runMergeTracker(files) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-merge-'));
  const resultPath = join(dir, 'merge-result.json');
  let outcome = null;
  let merge;
  try {
    // Same split as `wave`: merge-tracker's report stays visible, but on stderr,
    // so `finish` keeps emitting exactly one JSON object on stdout.
    merge = spawnSync('node', ['merge-tracker.mjs'], {
      cwd: ROOT, stdio: ['ignore', 2, 'inherit'], env: { ...process.env, CAREER_OPS_MERGE_RESULT: resultPath },
    });
    try { outcome = JSON.parse(readFileSync(resultPath, 'utf-8')); } catch { outcome = null; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const exitedClean = !merge.error && merge.status === 0;
  const byFile = new Map((outcome?.results ?? []).map((r) => [r.file, r]));
  let trackerRows = 0;
  const trackerSkipped = [];
  for (const file of files) {
    const r = byFile.get(file);
    if (r && (r.outcome === 'added' || r.outcome === 'updated')) { trackerRows += 1; continue; }
    trackerSkipped.push({
      tsv: file,
      reason: r?.reason || (r ? `merge-tracker ${r.outcome} it` : (exitedClean
        ? 'merge-tracker reported no outcome for this TSV'
        : `merge-tracker did not complete (${merge.error ? merge.error.message : `exit ${merge.status}`})`)),
    });
  }
  const merged = exitedClean && trackerSkipped.length === 0;
  return {
    merged,
    mergeStatus: merged ? 'complete' : (trackerRows > 0 ? 'partial' : 'failed'),
    trackerRows, trackerSkipped, exitCode: merge.status ?? null,
  };
}

/**
 * Apply the loop's verdicts to data/pipeline.md through the same code path as
 * `triage-prefilter.mjs --mark-file`: rejected -> `- [x]` with the triage
 * reason (and a data/discard.log line), unreachable -> `- [!]`; qualified and
 * unscored candidates stay pending, and a qualifier the inbox has no line for
 * (an `ingest`ed one) is queued pending by `queueQualifiers`. Idempotent — a second `finish` finds every
 * row already marked and changes nothing.
 *
 * Never throws: a missing or unwritable inbox must not undo a finish that has
 * already promoted its candidates, so the failure is returned and logged.
 */
async function reconcileInbox(state) {
  // Queue first — it may create the inbox — but say the inbox was absent when
  // `finish` started: with none, there were no verdict rows to apply either.
  const hadInbox = existsSync(PIPELINE_PATH);
  // Bring any aggregator line already in the inbox in line with the resolution
  // before queuing, so a resolved candidate is recognised as already queued
  // instead of being added a second time under its employer URL.
  const aggregator = await rewriteAggregatorInbox(state);
  const queued = { ...(await queueQualifiers(state)), ...(aggregator.rewritten ? { aggregatorRewritten: aggregator.rewritten } : {}),
    ...(aggregator.error ? { aggregatorError: aggregator.error } : {}) };
  if (!hadInbox) return { skipped: 'no inbox file', discarded: 0, unreachable: 0, logged: 0, ...queued };
  try {
    return await withPipelineLock(PIPELINE_PATH, () => {
      const pending = parsePipeline(readFileSync(PIPELINE_PATH, 'utf-8')).pending.map((e) => e.url);
      const rows = inboxVerdictRows(state, pending);
      if (rows.length === 0) return { discarded: 0, unreachable: 0, logged: 0, ...queued };
      const done = writeVerdictRowsToInbox(rows, { pipelinePath: PIPELINE_PATH, discardLogPath: DISCARD_LOG_PATH });
      return { discarded: done.discardsMarked, unreachable: done.unreachableMarked, logged: done.logLines.length, ...queued };
    });
  } catch (err) {
    return { error: err.message, discarded: 0, unreachable: 0, logged: 0, ...queued };
  }
}

/**
 * Put every promoted qualifier that is not in the inbox into it, pending.
 *
 * `finish` writes each qualifier a tracker row that says "full evaluation
 * pending", and the only thing that ever performs that evaluation is the
 * pipeline stage draining `- [ ]` rows from data/pipeline.md. A candidate that
 * arrived through a scanner wave is already such a row; one that arrived through
 * `ingest` (the agent-sourced rung: Indeed/Apify, WebSearch) never was, so it got
 * the promise and not the queue entry — run-all then saw an empty inbox and
 * completed the stage over it. Written through scan.mjs's own `appendToPipeline`
 * (locked, same line shape as a scanned row), and only for a URL the inbox has no
 * line for at all, so a re-run or an already-processed `- [x]` row is left alone.
 *
 * Never throws, for the same reason `reconcileInbox` does not: the candidates are
 * already promoted, and a failure here is reported, not fatal.
 */
async function queueQualifiers(state) {
  try {
    const md = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
    const missing = inboxQualifierRows(state, md);
    if (missing.length === 0) return { queued: 0 };
    await appendToPipeline(missing, { pipelinePath: PIPELINE_PATH });
    return { queued: missing.length };
  } catch (err) {
    return { queued: 0, queueError: err.message };
  }
}

/** One line of a skipped TSV for the run log: file name plus a bounded reason. */
function describeSkips(skipped) {
  return skipped.map((s) => `${s.tsv} (${String(s.reason).replace(/\s+/g, ' ').slice(0, 140)})`).join('; ');
}

/**
 * @param {object} flags
 * @param {{resolveFn?: Function, portals?: any}} [deps] injection point for tests:
 *   a fake resolver keeps the aggregator step off the network.
 */
export async function cmdFinish(flags, deps = {}) {
  const state = requireState();
  const decision = decideNextAction(state);
  if (decision.action === 'score' && !flags.force) {
    throw new Error(`${decision.stats.unscored} candidate(s) are still unscored — finish them first, `
      + 'or pass `--force` to promote only what has been scored.');
  }

  const rows = qualifiedCandidates(state);
  // Resolve aggregator URLs BEFORE any TSV is written or qualifier queued, so the
  // tracker row and the inbox line both carry the employer's posting.
  const aggregators = await resolveAggregatorQualifiers(rows, { resolveFn: deps.resolveFn, portals: deps.portals });
  const unnumbered = rows.filter((c) => !c.reportNum);
  // Destructure: reserveNumbers returns {numbers, ranges}, and indexing the
  // object itself handed every candidate `undefined ?? null`, so
  // writeTrackerAdditions skipped all of them on its `!c.reportNum` guard —
  // `finish` promoted to the shortlist and silently wrote zero tracker rows.
  const { numbers, ranges } = reserveNumbers(unnumbered.length);
  unnumbered.forEach((c, i) => { c.reportNum = numbers[i] ?? null; });

  const date = new Date().toISOString().slice(0, 10);
  const tsvFiles = writeTrackerAdditions(rows, date);
  const tsvCount = tsvFiles.length;

  // merge-tracker is the only sanctioned writer of data/applications.md, and
  // data/applications.md is what the dashboard reads. Its exit code is not an
  // answer to "did every row land": it exits 0 after skipping a TSV, so `finish`
  // reads the per-TSV outcome instead and reports only the rows that exist.
  const { merged, mergeStatus, trackerRows, trackerSkipped } = runMergeTracker(tsvFiles);
  if (trackerSkipped.length > 0) {
    console.error(`  finish: ${trackerSkipped.length} of ${tsvCount} tracker TSV(s) were NOT merged and stay in ${TSV_DIR} `
      + `for a later \`node merge-tracker.mjs\`: ${describeSkips(trackerSkipped)}`);
  }
  // Candidates that now point at the employer's posting need the same URL in the
  // scan-history, or run-retro cannot attribute their reports and kits to a source.
  await recordSourcesInScanHistory(rows.filter((c) => c.resolvedFrom));
  // The tracker rows hold the numbers from here on, so the sentinels have done
  // their job. reserveNumbers' own docblock says the release happens after the
  // merge; it never did, and every finished run left its reservations sitting
  // for the full 4h GC window, pushing the next run's numbers up for nothing.
  releaseNumbers(ranges);

  writeFileSync(SHORTLIST_PATH, renderShortlist(state), 'utf-8');
  const inbox = await reconcileInbox(state);
  state.phase = 'done';
  saveState(state);
  log(state, 'finish', `promoted=${rows.length} tsv=${tsvCount} trackerRows=${trackerRows} merged=${merged} mergeStatus=${mergeStatus} `
    + `${aggregators.details.length ? `aggregators=resolved:${aggregators.resolved},unresolved:${aggregators.unresolved} ` : ''}`
    + `inbox=discarded:${inbox.discarded},unreachable:${inbox.unreachable},queued:${inbox.queued}`
    + `${inbox.error ? ` (inbox error: ${inbox.error})` : ''}${inbox.queueError ? ` (queue error: ${inbox.queueError})` : ''}`
    + `${trackerSkipped.length ? ` trackerSkipped=${trackerSkipped.length}: ${describeSkips(trackerSkipped)}` : ''}`);

  return {
    promoted: rows.length,
    // Rows that actually landed in data/applications.md (added or updated) — not
    // the number of TSVs written. A skipped TSV is listed in trackerSkipped.
    trackerRows,
    trackerSkipped,
    merged,
    mergeStatus,
    ...(aggregators.details.length ? { aggregators } : {}),
    inbox,
    shortlist: 'data/loop-shortlist.md',
    haltedReason: state.halted_reason,
    reviewGate: 'Review data/loop-shortlist.md, then run `/career-ops pipeline`.',
  };
}

function cmdAbort(flags) {
  const state = requireState();
  state.phase = 'done';
  state.halted_reason = flags.note || 'aborted by the user';
  state.halted_kind = HALT_ABORTED;
  saveState(state);
  log(state, 'abort', state.halted_reason);
  return { aborted: true, reason: state.halted_reason };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `scan-loop.mjs — loop controller for /career-ops scan

  start [--target N] [--min-score X] [--reset]   begin a run
  next                                            what to do next (JSON)
  wave [--dry-run]                                run the next scan rung
  ingest --file <offers.json>                     hand-scanned offers in
  record --file <scores.json>                     feed triage scores back
  finish [--force]                                promote to shortlist + tracker
  status [--summary]                              current run state
  abort [--note "..."]                            end a run without promoting

Config lives in config/profile.yml -> loop:. Defaults: ${JSON.stringify(DEFAULT_LOOP_CONFIG)}
The loop definition, budgets and gates are documented in LOOP.md.`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[name] = true; continue; }
    const num = Number(next);
    flags[name] = Number.isFinite(num) && next.trim() !== '' ? num : next;
    i++;
  }
  return flags;
}

function printSummary(result) {
  if (result.running === false) { console.log('No loop run in progress. Start one: node scan-loop.mjs start'); return; }
  const s = result;
  console.log(`Loop run ${s.run_id ?? ''}`.trim());
  console.log(`  waves       ${s.waves?.length ?? s.waves ?? 0}`);
  console.log(`  discovered  ${s.discovered}`);
  console.log(`  triaged     ${s.scored}  (${s.unscored} pending)`);
  console.log(`  llm-scored  ${s.llmScored}  (loop.maxScored budget) · ${s.freeRejected} free — zero-token prefilter`);
  console.log(`  qualified   ${s.qualified}/${s.target} at or above ${s.minScore}`);
  if (s.skippedStrategies?.length) console.log(`  skipped     ${s.skippedStrategies.join(', ')} (by config, not run)`);
  if (s.halted_reason) console.log(`  halted      ${s.halted_reason}`);
  if (s.next) console.log(`  next        ${s.next.action} — ${s.next.reason}`);
}

const COMMANDS = {
  start: cmdStart, next: cmdNext, wave: cmdWave, ingest: cmdIngest,
  record: cmdRecord, finish: cmdFinish, status: cmdStatus, abort: cmdAbort,
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`scan-loop: unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }

  const flags = parseFlags(argv.slice(1));
  try {
    const result = await handler(flags);
    if (flags.summary) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`scan-loop: ${err.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
