#!/usr/bin/env node

/**
 * loop-core.mjs — pure control logic for the career-ops scan loop.
 *
 * This is the "control law" half of the loop-engineering pattern
 * (github.com/cobusgreyling/loop-engineering): the durable state lives outside
 * any conversation (`data/loop-state.json`), and this file decides what the
 * loop does next given that state. `scan-loop.mjs` is the driver that performs
 * the decided action; `LOOP.md` is the human-readable loop definition.
 *
 * Deliberately dependency-free — no `yaml`, no `playwright`, no `fs`. The whole
 * decision surface is testable without touching disk or the network, which is
 * the only reason a loop that spends real tokens is safe to change.
 *
 * The loop it drives:
 *
 *   scan wave  →  triage-score the new candidates  →  count qualifiers
 *        ↑                                                  │
 *        └────────── still short of target? ─────────────────┘
 *                                    │
 *                            target met / budget spent
 *                                    ↓
 *                          human review gate (shortlist)
 *
 * Scoring is not done here: the agent runs `modes/triage.md` and feeds the
 * `TRIAGE:` lines back in. This file only parses, counts, and decides.
 */

// ── Configuration ───────────────────────────────────────────────────────────

export const LOOP_STATE_VERSION = 1;

/**
 * Defaults for `config/profile.yml` → `loop:`. Every one of these is a budget:
 * a loop with no ceiling is a loop that bills you while you sleep.
 */
export const DEFAULT_LOOP_CONFIG = {
  // Stop scanning once this many NEW candidates have cleared `minScore`.
  target: 10,
  // The qualifying score, on the same 0–5 scale `modes/triage.md` returns.
  minScore: 3.8,
  // Hard ceiling on scan waves, independent of the strategy ladder below.
  maxWaves: 6,
  // Circuit breaker: consecutive fully-scored waves that produced no qualifier.
  maxBarrenWaves: 2,
  // Token budget proxy — each scored candidate is one cheap triage call.
  maxScored: 120,
  // How many candidates to hand the agent per scoring round.
  scoreBatch: 12,
};

/**
 * The escalation ladder. Wave N uses strategy N: each rung searches strictly
 * wider than the one above it, so a loop that comes up short widens instead of
 * re-running the same query and re-discovering the same duplicates.
 *
 * `kind: 'script'` rungs are deterministic and zero-token. The final rung is
 * `kind: 'agent'` — there is no script for open-ended web discovery, so the
 * driver hands that wave back to the agent with instructions from
 * `modes/scan.md` (Levels 1 and 3).
 */
export const WAVE_STRATEGIES = [
  {
    id: 'portals',
    kind: 'script',
    command: 'node',
    args: ['scan.mjs'],
    describe: 'configured companies and providers from portals.yml (zero-token)',
  },
  // Interamt sits at wave 2, ahead of the ATS sweeps, on measured yield.
  //
  // It is the German public-sector portal — universities, Studierendenwerke and
  // Anstalten des öffentlichen Rechts — which is the same institutional
  // neighbourhood as the highest-scoring rows in this tracker. It was NOT in
  // this ladder at all: `portals.yml` documents it as "run separately", so it
  // only ever ran by hand, which in practice meant rarely. That is the same
  // silent gap as the unswept agent sources, except this one is a script and
  // can simply be scheduled.
  //
  // Placed before the ATS waves because those are the expensive, low-yield end:
  // tracing every report to its originating portal shows the full-ATS sweeps
  // produced 5 reports from 717 scanned rows, 2 of which qualified, both at
  // exactly 3.9 — while cheaper German-market sources produced every 4.0+.
  // Escalation should exhaust the cheap, on-target rungs first.
  //
  // It drives a real browser (Interamt is Apache Wicket with no REST API), so
  // it is slower per posting than an API rung but far cheaper than sweeping
  // ~38k companies.
  {
    id: 'interamt',
    kind: 'script',
    command: 'node',
    args: ['scan-interamt.mjs'],
    describe: 'Interamt.de — German public sector: universities, Studierendenwerke, public research (browser-driven)',
  },
  {
    id: 'ats-recent',
    kind: 'script',
    command: 'node',
    args: ['scan-ats-full.mjs', '--since', '7'],
    describe: 'reverse-ATS keyword sweep across full public ATS datasets, last 7 days',
  },
  {
    id: 'ats-wide',
    kind: 'script',
    command: 'node',
    args: ['scan-ats-full.mjs', '--since', '21'],
    describe: 'reverse-ATS sweep widened to the last 21 days',
  },
  {
    id: 'ats-deep',
    kind: 'script',
    command: 'node',
    args: ['scan-ats-full.mjs', '--since', '45', '--include-undated'],
    describe: 'widest reverse-ATS sweep — 45 days, undated postings included',
  },
  {
    id: 'agent-web',
    kind: 'agent',
    describe: 'agent-driven discovery: modes/scan.md Level 1 (Playwright on tracked careers pages) and Level 3 (WebSearch)',
  },
];

/** Look up a strategy by id. Returns null for an unknown id. */
export function strategyById(id) {
  return WAVE_STRATEGIES.find((s) => s.id === id) || null;
}

/** camelCase → the snake_case spelling used everywhere else in profile.yml. */
const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const VALID_STRATEGY_IDS = WAVE_STRATEGIES.map((s) => s.id);

/**
 * `loop.skip_strategies` — rung ids to leave out of the ladder entirely. This
 * is a USER preference about THEIR measured yield (e.g. "Interamt scanned
 * 16,328 postings across 20 passes and produced zero tracker rows for me"),
 * not a system default, so it lives in config/profile.yml and is read here,
 * never hardcoded into WAVE_STRATEGIES itself.
 *
 * An unknown id is a config ERROR, not a silently-ignored typo: swallowing it
 * would leave the exact rung the user meant to skip still running, which is
 * worse than refusing to start.
 *
 * @param {object} raw the resolved `loop:` block (already unwrapped)
 * @returns {string[]}
 */
export function resolveSkipStrategies(raw) {
  const provided = raw?.skip_strategies !== undefined ? raw.skip_strategies : raw?.skipStrategies;
  if (provided === undefined || provided === null) return [];
  if (!Array.isArray(provided)) {
    throw new Error(`config error: loop.skip_strategies must be a list of strategy ids (got ${typeof provided}).`);
  }
  const ids = provided.map((v) => String(v).trim()).filter(Boolean);
  const unknown = ids.filter((id) => !VALID_STRATEGY_IDS.includes(id));
  if (unknown.length) {
    throw new Error(`config error: loop.skip_strategies has unknown strategy id(s): ${unknown.join(', ')}. `
      + `Valid ids: ${VALID_STRATEGY_IDS.join(', ')}.`);
  }
  return ids;
}

// Mirrors scan-ats-full.mjs's `Object.keys(SOURCES)`. Duplicated here (rather
// than imported) so this file stays dependency-free — scan-ats-full.mjs pulls
// in js-yaml, every ATS provider module, and fs/http. scan-loop.mjs, which
// already imports scan-ats-full.mjs for other reasons, passes the AUTHORITATIVE
// list in as `knownAtsSources`; this is the fallback for direct/test callers,
// and must be kept in sync with SOURCES by hand.
const DEFAULT_KNOWN_ATS_SOURCES = ['greenhouse', 'lever', 'ashby', 'workday', 'icims'];

/**
 * `loop.ats_sources` — when set, narrows every `ats-*` rung's
 * `scan-ats-full.mjs` invocation to `--ats <sources>`. Same "user preference,
 * config error on a typo" doctrine as `resolveSkipStrategies`.
 *
 * @param {object} raw the resolved `loop:` block (already unwrapped)
 * @param {string[]} [knownAtsSources] valid source ids — pass scan-ats-full.mjs's
 *   own `Object.keys(SOURCES)` to validate against the real thing.
 * @returns {string[]|null} null means "not configured — use every source"
 */
export function resolveAtsSources(raw, knownAtsSources = DEFAULT_KNOWN_ATS_SOURCES) {
  const provided = raw?.ats_sources !== undefined ? raw.ats_sources : raw?.atsSources;
  if (provided === undefined || provided === null) return null;
  if (!Array.isArray(provided) || provided.length === 0) {
    throw new Error('config error: loop.ats_sources must be a non-empty list of ATS source ids.');
  }
  const ids = provided.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter((id) => !knownAtsSources.includes(id));
  if (unknown.length) {
    throw new Error(`config error: loop.ats_sources has unknown source id(s): ${unknown.join(', ')}. `
      + `Valid ids: ${knownAtsSources.join(', ')}.`);
  }
  return ids;
}

/**
 * Merge a `loop:` block from `config/profile.yml` over the defaults, ignoring
 * anything that isn't a usable number. A typo in the profile must not silently
 * turn a budget into `NaN` and uncap the loop.
 *
 * `min_score` is the documented spelling (profile.yml is snake_case throughout);
 * `minScore` is accepted too, because the same key is camelCase inside the state
 * file and mixing the two up is the obvious mistake to make.
 *
 * `skip_strategies`/`ats_sources` are validated separately (they aren't
 * numbers) — see `resolveSkipStrategies`/`resolveAtsSources`. Absent, both
 * default to today's behaviour exactly: no rung skipped, every ATS source used.
 *
 * @param {object} [profile] parsed config/profile.yml
 * @param {object} [opts]
 * @param {string[]} [opts.knownAtsSources] see `resolveAtsSources`
 * @returns {typeof DEFAULT_LOOP_CONFIG & {skipStrategies: string[], atsSources: string[]|null}}
 */
export function resolveLoopConfig(profile, { knownAtsSources } = {}) {
  const raw = profile && typeof profile.loop === 'object' && profile.loop ? profile.loop : {};
  const out = { ...DEFAULT_LOOP_CONFIG };
  for (const key of Object.keys(DEFAULT_LOOP_CONFIG)) {
    const provided = raw[snake(key)] !== undefined ? raw[snake(key)] : raw[key];
    const value = Number(provided);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  out.skipStrategies = resolveSkipStrategies(raw);
  out.atsSources = resolveAtsSources(raw, knownAtsSources);
  return out;
}

/**
 * The ladder with `config.skipStrategies` rungs removed. WAVE_STRATEGIES
 * itself is NEVER mutated — callers that read the base ladder directly (the
 * `--resume` regression test, `wave --dry-run` before a config exists) must
 * keep seeing the unmodified table.
 *
 * @param {{skipStrategies?: string[]}} [config]
 * @returns {typeof WAVE_STRATEGIES}
 */
export function effectiveStrategies(config) {
  const skip = new Set(config?.skipStrategies || []);
  return WAVE_STRATEGIES.filter((s) => !skip.has(s.id));
}

/**
 * Narrow an `ats-*` rung's `scan-ats-full.mjs` args to `config.atsSources`
 * (`--ats a,b`) when the user has configured one. Returns a NEW object —
 * never mutates the strategy it was given, so the shared WAVE_STRATEGIES
 * entries stay identical across calls (and across a run where the config
 * changes between waves would otherwise leak into a wave already recorded).
 *
 * A no-op for non-script rungs, for a script rung that isn't scan-ats-full.mjs
 * (`portals`, `interamt`), and for a rung whose args already carry `--ats`
 * (never override an explicit override).
 *
 * @param {object} strategy a WAVE_STRATEGIES entry
 * @param {{atsSources?: string[]|null}} config
 */
export function applyAtsSources(strategy, config) {
  if (!strategy || strategy.kind !== 'script') return strategy;
  const sources = config?.atsSources;
  if (!Array.isArray(sources) || sources.length === 0) return strategy;
  if (!/scan-ats-full\.mjs$/.test(String(strategy.args?.[0] ?? ''))) return strategy;
  if (strategy.args.includes('--ats')) return strategy;
  return { ...strategy, args: [...strategy.args, '--ats', sources.join(',')] };
}

// ── Candidate identity ──────────────────────────────────────────────────────

const TRACKING_PARAMS = /^(utm_|gh_src|gh_jid$|src$|source$|ref$|referer$|referrer$|trk$|lever-|ashby_jid$)/i;

/**
 * Stable dedup key for a posting URL.
 *
 * Loop dedup has to be *stricter* than scan.mjs's, because the same posting can
 * legitimately arrive from two different rungs of the ladder (portals.yml and
 * the reverse-ATS sweep both cover Greenhouse) with different tracking params
 * and a different trailing slash. Falls back to the raw string for anything
 * that isn't a parseable URL — `local:jds/...` entries included.
 */
export function candidateKey(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }
  // `new URL()` accepts ANY scheme, so `local:jds/acme-pm.md` parses happily —
  // with an empty host and `jds/acme-pm.md` as the pathname. Normalizing that
  // would drop the scheme and key the entry as a bare path, colliding with any
  // other non-http entry sharing it. Only http(s) gets the host/param
  // treatment; everything else takes the documented raw fallback.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw.toLowerCase();
  for (const name of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(name)) parsed.searchParams.delete(name);
  }
  parsed.hash = '';
  const host = parsed.host.replace(/^www\./i, '').toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');
  const query = parsed.searchParams.toString();
  return `${host}${path}${query ? `?${query}` : ''}`.toLowerCase();
}

// ── State ───────────────────────────────────────────────────────────────────

/**
 * A fresh loop run. `candidates` is an object keyed by `candidateKey` rather
 * than an array so re-entering the loop is O(1) per offer and the file stays
 * diffable.
 */
export function newState(config = DEFAULT_LOOP_CONFIG, nowIso = new Date().toISOString()) {
  return {
    version: LOOP_STATE_VERSION,
    run_id: nowIso,
    started_at: nowIso,
    updated_at: nowIso,
    phase: 'scanning',
    config: { ...DEFAULT_LOOP_CONFIG, ...config },
    waves: [],
    candidates: {},
    halted_reason: null,
  };
}

/**
 * Accept a state loaded from disk, filling in anything a older/partial file is
 * missing. Never throws on a malformed file — a corrupt run log must not be the
 * thing that stops the user scanning.
 */
export function normalizeState(state, config = DEFAULT_LOOP_CONFIG) {
  const base = newState(config, state?.started_at || new Date().toISOString());
  if (!state || typeof state !== 'object') return base;
  return {
    ...base,
    ...state,
    config: { ...base.config, ...(state.config || {}) },
    waves: Array.isArray(state.waves) ? state.waves : [],
    candidates: state.candidates && typeof state.candidates === 'object' ? state.candidates : {},
  };
}

// ── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Fold freshly-scanned offers into the state under a wave number.
 *
 * Offers already known to the loop are counted as duplicates and left alone —
 * including their score, so a posting that arrives again on a wider rung is
 * never re-scored. Returns the split so the wave record can show whether the
 * rung actually widened the search or just re-found what wave 1 had.
 *
 * @param {object} state
 * @param {Array<{url:string, company?:string, title?:string, location?:string, postedAt?:string}>} offers
 * @param {number} wave
 * @returns {{added: number, duplicate: number, invalid: number}}
 */
export function ingestOffers(state, offers, wave) {
  let added = 0, duplicate = 0, invalid = 0;
  for (const offer of Array.isArray(offers) ? offers : []) {
    const key = candidateKey(offer?.url);
    if (!key) { invalid++; continue; }
    if (state.candidates[key]) { duplicate++; continue; }
    state.candidates[key] = {
      key,
      url: String(offer.url).trim(),
      company: String(offer.company ?? '').trim(),
      title: String(offer.title ?? '').trim(),
      location: String(offer.location ?? '').trim(),
      postedAt: offer.postedAt ? String(offer.postedAt).trim() : null,
      wave,
      score: null,
      verdict: 'pending',
      reason: '',
      reportNum: null,
    };
    added++;
  }
  return { added, duplicate, invalid };
}

// ── Triage parsing ──────────────────────────────────────────────────────────

/**
 * The machine-readable contract from `modes/triage.md`:
 *
 *   TRIAGE: {PASS|MARGINAL|FAIL|SKIP} | {Company} | {Role} | {Score}/5 | {reason}
 *
 * Only the verdict keyword and the `{Score}/5` cell are load-bearing here — the
 * loop's own `minScore` decides qualification for MARGINAL/FAIL, not triage's
 * band, because the two thresholds are configured independently (`pipeline
 * .triage_threshold` vs `loop.minScore`). The one exception is PASS: the
 * Priority Override in `modes/triage.md` returns PASS regardless of score, and
 * `recordScores` honours that.
 *
 * @returns {{verdict:string, company:string, role:string, score:number, reason:string}|null}
 */
export function parseTriageLine(line) {
  // Strip a trailing \r so a single CRLF line handed in directly (not just via
  // parseTriageOutput's own split) still parses: `.` excludes \r and `$` (no
  // `m` flag) anchors to end-of-string, so an untouched \r fails the match.
  const m = /TRIAGE:\s*(PASS|MARGINAL|FAIL|SKIP)\s*\|(.*)$/i.exec(String(line ?? '').replace(/\r$/, ''));
  if (!m) return null;
  const cells = m[2].split('|').map((s) => s.trim());
  const scoreCell = cells[2] ?? '';
  const scoreMatch = /^(\d+(?:\.\d+)?)\s*\/\s*5$/.exec(scoreCell);
  if (!scoreMatch) return null;
  return {
    verdict: m[1].toUpperCase(),
    company: cells[0] ?? '',
    role: cells[1] ?? '',
    score: Number(scoreMatch[1]),
    reason: cells.slice(3).join(' | ').trim(),
  };
}

/**
 * Pull every TRIAGE line out of a blob of agent output.
 *
 * Subagents wrap their verdict in prose no matter what the mode file says, and
 * a scoring round that silently returns zero results is indistinguishable from
 * a barren wave — which would trip the circuit breaker for the wrong reason.
 * So: scan every line, keep what parses.
 */
export function parseTriageOutput(text) {
  const out = [];
  // CRLF from a Windows editor leaves a trailing \r on every line but the
  // last; splitting on '\n' alone fed that \r into parseTriageLine's `$`
  // anchor and dropped all but that last line. Split on /\r?\n/ instead.
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parsed = parseTriageLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Apply a batch of scores to the state.
 *
 * Each result must carry the `key` the loop handed out. Matching on
 * company+role instead was tried and is wrong: two postings from one company
 * with near-identical titles are exactly the case `data/applications.md`
 * already needs req IDs to disambiguate, and a mis-attributed score puts the
 * wrong URL on the shortlist.
 *
 * @param {object} state
 * @param {Array<{key:string, score:number, reason?:string, verdict?:string}>} results
 * @returns {{scored:number, qualified:number, unknown:string[]}}
 */
export function recordScores(state, results) {
  const minScore = Number(state?.config?.minScore ?? DEFAULT_LOOP_CONFIG.minScore);
  let scored = 0, qualified = 0;
  const unknown = [];

  for (const result of Array.isArray(results) ? results : []) {
    const key = candidateKey(result?.key || result?.url);
    const candidate = state.candidates[key];
    if (!candidate) { unknown.push(String(result?.key ?? result?.url ?? '')); continue; }

    const score = Number(result.score);
    if (!Number.isFinite(score)) { unknown.push(key); continue; }

    candidate.score = score;
    candidate.reason = String(result.reason ?? '').trim();
    // A SKIP verdict means the posting was unreachable, not that it scored 0 —
    // keep it out of the qualifier count and out of the barren-wave maths.
    //
    // A PASS verdict qualifies regardless of score: modes/triage.md's Priority
    // Override returns PASS for a listed employer whatever the score ("TRIAGE:
    // PASS | ... | 2.8/5 | Priority employer ..."), so the verdict — not the
    // number — is the signal there. Comparing the 2.8 to minScore recorded such
    // a line as rejected, which is exactly the outcome the override exists to
    // prevent. MARGINAL and FAIL (and a result with no verdict at all) keep the
    // plain score rule, so a high-scoring FAIL still qualifies exactly as before.
    const triageVerdict = String(result.verdict ?? '').toUpperCase();
    candidate.verdict = triageVerdict === 'SKIP'
      ? 'unreachable'
      : (triageVerdict === 'PASS' || score >= minScore ? 'qualified' : 'rejected');
    if (candidate.verdict === 'qualified') qualified++;
    scored++;
  }
  return { scored, qualified, unknown };
}

// ── Counting ────────────────────────────────────────────────────────────────

/** All candidates as an array, newest wave last. */
export function allCandidates(state) {
  return Object.values(state?.candidates || {});
}

/** Qualified candidates, best score first — the shortlist order. */
export function qualifiedCandidates(state) {
  return allCandidates(state)
    .filter((c) => c.verdict === 'qualified')
    .sort((a, b) => b.score - a.score || String(a.company).localeCompare(String(b.company)));
}

/**
 * Trailing run of fully-scored waves that produced no qualifier.
 *
 * A wave with unscored candidates left in it is not barren yet — it is
 * unfinished — so the streak stops there rather than counting it.
 */
export function barrenWaveStreak(state) {
  const byWave = new Map();
  for (const c of allCandidates(state)) {
    if (!byWave.has(c.wave)) byWave.set(c.wave, []);
    byWave.get(c.wave).push(c);
  }
  // A wave the scanner could not actually complete is not evidence that the
  // market is empty, so it cannot end the run.
  //
  // Observed 2026-08-31: a scan rate-limited by this machine's own recent
  // traffic recorded found=2307/errors=19 against a ~7,800/0 baseline. The loop
  // counted the thin result as an ordinary wave, found the next two barren, and
  // halted on its circuit breaker — reporting an empty market from a third of
  // it. `scan-run-health.mjs` now marks such a wave `degraded`; here it is
  // skipped rather than counted, so the ladder keeps widening instead of
  // concluding from data that was never gathered.
  const degradedWaves = new Set(
    (state?.waves ?? []).filter((w) => w?.degraded).map((w) => w.n),
  );

  let streak = 0;
  for (let n = (state?.waves?.length ?? 0); n >= 1; n--) {
    const group = byWave.get(n) || [];
    if (group.some((c) => c.verdict === 'pending')) break;
    if (group.some((c) => c.verdict === 'qualified')) break;
    if (degradedWaves.has(n)) continue; // neither barren nor productive — unknown
    streak++;
  }
  return streak;
}

/**
 * A candidate that never cost an LLM triage call: either `prefilterReject()`
 * marked it (`prefiltered === true`), or its recorded reason starts with the
 * same "zero-token prefilter" text that function writes — which is what an
 * older `loop-state.json` (written before the `prefiltered` flag existed) or
 * an agent applying the same zero-token rule by hand through `record` leaves
 * behind instead. Reason-prefix matching is the fallback, not the primary
 * signal, so a state file from before this flag existed still loads and still
 * counts its free rejections as free.
 */
function isFreeTriage(c) {
  return c?.prefiltered === true || /^zero-token prefilter/i.test(String(c?.reason ?? ''));
}

/** Roll-up used by every decision and every status print. */
export function summarize(state) {
  const config = { ...DEFAULT_LOOP_CONFIG, skipStrategies: [], atsSources: null, ...(state?.config || {}) };
  const candidates = allCandidates(state);
  const qualified = candidates.filter((c) => c.verdict === 'qualified').length;
  const unscored = candidates.filter((c) => c.verdict === 'pending').length;
  const scored = candidates.length - unscored;
  // Only candidates scored so far can be free rejections — a pending one has
  // no reason yet, so this can never overcount against `scored`.
  const freeRejected = candidates.filter((c) => c.verdict !== 'pending' && isFreeTriage(c)).length;
  return {
    target: config.target,
    minScore: config.minScore,
    waves: state?.waves?.length ?? 0,
    discovered: candidates.length,
    // `scored`: every candidate with a verdict, free rejections included —
    // kept for backward compatibility with anything reading this field.
    scored,
    // `llmScored`: the subset that actually spent a triage call. This is what
    // `loop.maxScored` budgets — see `haltReason()`.
    llmScored: scored - freeRejected,
    freeRejected,
    unscored,
    qualified,
    rejected: candidates.filter((c) => c.verdict === 'rejected').length,
    unreachable: candidates.filter((c) => c.verdict === 'unreachable').length,
    remaining: Math.max(0, config.target - qualified),
    barrenWaves: barrenWaveStreak(state),
    // Echoed from config, not derived from state.waves — a skipped rung never
    // appears there at all (see `effectiveStrategies`), so this is the only
    // place a status/run-log reader can tell "not run by config" apart from
    // "ran and found nothing".
    skippedStrategies: config.skipStrategies,
  };
}

/** The next slice of unscored candidates to hand the agent. */
export function pendingBatch(state, limit) {
  const size = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LOOP_CONFIG.scoreBatch;
  return allCandidates(state)
    .filter((c) => c.verdict === 'pending')
    .slice(0, size);
}

// ── The control law ─────────────────────────────────────────────────────────

/**
 * Decide what the loop does next. This is the whole point of the file: one
 * function, no I/O, so the loop's behaviour at every budget boundary is a unit
 * test rather than a live scan that costs money to observe.
 *
 * Actions:
 *   `score`  — unscored candidates exist; run triage on `batch`
 *   `scan`   — everything scored and still short; run the next rung
 *   `finish` — target met; promote and hand to the human review gate
 *   `halt`   — a budget or circuit breaker tripped; promote what we have
 *   `done`   — the run already finished
 *
 * `halt` is not a failure. It ends the loop honestly short of target, which is
 * the behaviour the user gets to see instead of an agent quietly lowering the
 * bar to reach ten.
 */
export function decideNextAction(state) {
  const config = { ...DEFAULT_LOOP_CONFIG, skipStrategies: [], atsSources: null, ...(state?.config || {}) };
  const stats = summarize(state);
  // The ladder with any `loop.skip_strategies` rungs removed. Every wave-number
  // decision below reads from THIS, never from raw WAVE_STRATEGIES — a skipped
  // rung must never be selected, counted toward "ladder exhausted", or occupy a
  // wave slot at all.
  const ladder = effectiveStrategies(config);

  if (state?.phase === 'done') {
    return { action: 'done', reason: 'run already finished — start a new one with `--reset`', stats };
  }
  if (stats.qualified >= config.target) {
    return { action: 'finish', reason: `target met — ${stats.qualified}/${config.target} candidates at or above ${config.minScore}`, stats };
  }
  if (stats.unscored > 0) {
    return {
      action: 'score',
      reason: `${stats.unscored} candidate(s) awaiting a triage score; ${stats.remaining} more qualifier(s) needed`,
      batch: pendingBatch(state, config.scoreBatch),
      stats,
    };
  }

  const halt = haltReason(state, config, stats, ladder);
  if (halt) return { action: 'halt', reason: halt, stats };

  const strategy = applyAtsSources(ladder[stats.waves], config);
  return {
    action: 'scan',
    reason: `${stats.qualified}/${config.target} qualified — widening to wave ${stats.waves + 1} (${strategy.id})`,
    strategy,
    wave: stats.waves + 1,
    stats,
  };
}

/**
 * Every reason the loop is allowed to stop short of target, checked in the
 * order that produces the most useful message. Returns null when the loop may
 * keep going.
 */
/**
 * How a halted loop ended.
 *
 * `budget` means the loop ran its ladder and stopped on a bound it was given —
 * every reason haltReason() can return is one of those. That is the loop
 * WORKING: it looked, the cheap sources were barren, and it declined to
 * escalate into a multi-hour sweep to prove it twice.
 *
 * `aborted` means a human or an agent gave up on the run. Only that one
 * genuinely delivered nothing.
 *
 * run-all.mjs conflated the two, because it inferred abnormality from the mere
 * presence of a halted_reason. A pass whose scan honestly found nothing was
 * therefore told to start a FRESH loop, which re-ran the same waves and tripped
 * the same breaker — up to maxStageAttempts times, each one a full portal scan,
 * to relearn what the first had already established.
 */
export const HALT_BUDGET = 'budget';
export const HALT_ABORTED = 'aborted';

/**
 * Classify a halted_reason written before halt_kind existed.
 *
 * A legacy bridge, deliberately narrow: it matches only the four shapes
 * haltReason() produces, and anything unrecognised stays `aborted` so an
 * unknown state keeps the old, cautious behaviour instead of being waved
 * through as a clean finish.
 */
export function classifyHaltReason(reason) {
  const r = String(reason ?? '');
  if (!r) return null;
  // Anchored AND including the em-dash separator every generated reason uses.
  // A prefix alone was not enough: an operator's abort note reading "circuit
  // breakers are fine but I am stopping anyway" starts with those very words
  // and was waved through as a clean finish. The full signature is not
  // something a hand-written note reproduces by accident.
  return /^(scoring budget spent|circuit breaker|wave budget spent|escalation ladder exhausted) — /.test(r)
    ? HALT_BUDGET
    : HALT_ABORTED;
}

function haltReason(state, config, stats, ladder = WAVE_STRATEGIES) {
  // `maxScored` caps PAID triage calls. A candidate the zero-token prefilter
  // rejected for free (`prefilterReject()`, or an agent applying the same
  // rule by hand through `record`) never touched the budget — see
  // `isFreeTriage()`. Measured 2026-09-14: a run halted after one wave with
  // "183 candidate(s) triaged (loop.maxScored = 120)", but 134 of those were
  // free prefilter rejections and only 49 spent an LLM call; the budget was
  // starving later waves for no cost reason.
  if (stats.llmScored >= config.maxScored) {
    return `scoring budget spent — ${stats.llmScored} LLM-triaged candidate(s) (loop.maxScored = ${config.maxScored}); `
      + `${stats.freeRejected} more rejected by the zero-token prefilter`;
  }
  if (stats.barrenWaves >= config.maxBarrenWaves) {
    return `circuit breaker — ${stats.barrenWaves} consecutive wave(s) produced no candidate at or above ${config.minScore}`;
  }
  if (stats.waves >= config.maxWaves) {
    return `wave budget spent — ${stats.waves} wave(s) run (loop.maxWaves = ${config.maxWaves})`;
  }
  if (stats.waves >= ladder.length) {
    const skipNote = config.skipStrategies?.length
      ? `; skipped by config: ${config.skipStrategies.join(', ')}`
      : '';
    return `escalation ladder exhausted — all ${ladder.length} strategies have been run${skipNote}`;
  }
  return null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Company, title and reason are third-party posting text. `docs/AUTOMATION.md`
 * requires treating every pipeline field as untrusted data rather than
 * instructions — a newline in a title would otherwise write extra rows into the
 * review file that the agent reads back as its own output.
 */
function clean(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const cp = ch.codePointAt(0);
    out += (cp < 0x20 || cp === 0x7f) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the human review gate: `data/loop-shortlist.md`.
 *
 * Everything on this list is a triage score from title + JD skim, not a full
 * A–F evaluation, and the file says so — a number that looks like a report
 * score but isn't one is the fastest way to get a bad application sent.
 */
export function renderShortlist(state, { now = new Date() } = {}) {
  const stats = summarize(state);
  const rows = qualifiedCandidates(state);
  const date = now.toISOString().slice(0, 10);
  const lines = [
    '# Loop shortlist — review gate',
    '',
    `> GENERATED by \`node scan-loop.mjs finish\` on ${date}. Do not hand-edit;`,
    '> re-run the command to regenerate. Scores are **triage** scores from',
    '> `modes/triage.md` (title + JD skim), not full A–F evaluations.',
    '',
    `Run ${state?.run_id ?? '?'} · ${stats.waves} wave(s) · ${stats.discovered} discovered · `
      + `${stats.scored} triaged · **${stats.qualified} at or above ${stats.minScore}**`,
    '',
  ];

  if (state?.halted_reason) {
    lines.push(`⚠️  Loop halted short of target (${stats.qualified}/${stats.target}): ${clean(state.halted_reason)}`, '');
  }

  if (rows.length === 0) {
    lines.push('_No candidate cleared the bar this run._', '');
    return lines.join('\n');
  }

  lines.push('| # | Score | Company | Role | Location | Wave | URL |', '|---|-------|---------|------|----------|------|-----|');
  for (const c of rows) {
    const num = c.reportNum ? `#${c.reportNum}` : '—';
    lines.push(`| ${num} | ${c.score.toFixed(1)}/5 | ${clean(c.company) || '—'} | ${clean(c.title) || '—'} `
      + `| ${clean(c.location) || '—'} | ${c.wave} | ${c.url} |`);
  }
  lines.push('');

  const advisory = rows.filter((c) => c.score < 4.0);
  if (advisory.length > 0) {
    lines.push(
      `> **${advisory.length} of these score below 4.0.** \`AGENTS.md\` → Ethical Use recommends against`,
      '> applying below 4.0/5. They are listed because they clear the configured',
      '> `loop.minScore`; treat the 4.0 line as the advice and this list as the inbox.',
      '',
    );
  }

  lines.push(
    '## Next',
    '',
    '1. Strike out or delete any row you do not want pursued.',
    '2. Run `/career-ops pipeline` — it evaluates every surviving row, generates a',
    '   tailored CV and cover letter for each, and sweeps Gmail for status updates.',
    '3. Review the generated artifacts, then apply yourself. Nothing here submits.',
    '',
  );
  return lines.join('\n');
}

/** One append-only line for `data/loop-run-log.md` — the loop's audit trail. */
export function renderRunLogEntry(state, event, detail = '') {
  const stats = summarize(state);
  const when = new Date().toISOString();
  const parts = [
    when,
    state?.run_id ?? '?',
    event,
    `wave=${stats.waves}`,
    `discovered=${stats.discovered}`,
    `scored=${stats.scored}`,
    `qualified=${stats.qualified}/${stats.target}`,
  ];
  if (detail) parts.push(clean(detail));
  return `- ${parts.join(' · ')}`;
}

/**
 * The link a HUMAN should be handed for a posting.
 *
 * Providers store whatever href the source listing exposed, and for StepStone
 * that is the `-inline.html` embed fragment: it answers a probe with HTTP 200
 * but renders only title/company/apply, with NO job description. It is the
 * right URL to fetch and the wrong URL to click, so eight tracker rows carried
 * a link that looked broken to the person who owned them.
 *
 * Canonicalising HERE, on the way into the tracker, keeps the stored link
 * readable. Nothing is lost on the machine side: liveness-browser's
 * `fetchableUrl` puts `-inline` back before probing, and that transform is
 * idempotent, so rows written before this change behave identically.
 *
 * Pure and total: anything unparseable comes back untouched.
 */
export function toHumanUrl(url) {
  const s = String(url ?? '');
  try {
    const u = new URL(s);
    if (!/(^|\.)stepstone\.de$/i.test(u.hostname)) return s;
    if (!/-inline\.html$/i.test(u.pathname)) return s;
    u.pathname = u.pathname.replace(/-inline\.html$/i, '.html');
    return u.toString();
  } catch {
    return s;
  }
}
