/**
 * run-core.mjs — the control law for `/career-ops run`, the end-to-end pass.
 *
 * `/career-ops run` is one command for the whole arc: deep search -> evaluate
 * the inbox -> build a CV and cover letter for everything that qualifies ->
 * reconcile the data the dashboard reads. Those four stages already existed as
 * separate modes and scripts; what did not exist was anything that remembered
 * where a run had got to. A pass that dies in stage 2 used to be resumed by the
 * user re-deriving, from memory, which of the four things had already happened.
 *
 * This file is the same shape as `loop-core.mjs`: pure functions, no I/O, no
 * spawning, no clock beyond what the caller passes in. `run-all.mjs` is the only
 * thing that touches disk. Keeping the decision logic separable is what makes
 * "which stage is next, and why" a unit-testable question instead of something
 * only observable by running a real scan against real job boards.
 *
 * The stage order is not a preference. Each stage consumes what the one before
 * it produced: scanning fills `data/pipeline.md`, evaluation drains it into
 * reports and tracker rows, kits are built from tracker rows that scored well
 * enough, and the sync stage reconciles the tracker/PDF index the dashboard
 * reads. Running them out of order produces a dashboard describing a state that
 * never existed.
 */

/** Ordered stages of one end-to-end pass. Order is a data dependency, not taste. */
export const STAGES = ['scan', 'pipeline', 'kits', 'sync'];

/**
 * Sources that have no HTTP provider and therefore cannot run inside
 * `scan.mjs` — the agent has to search them and hand the results to
 * `ingest-jobs.mjs`. Listed here so the scan stage can name them rather than
 * relying on the agent remembering that `modes/run.md` → Stage 1b exists.
 *
 * **Anything that CAN be automated must leave this list.** Three already have:
 * StepStone and Indeed became real providers (via the scrapling CLI), and BMW
 * arrives through `arbeitsagentur`. Each was previously recorded as impossible;
 * two of those records were simply wrong. Before adding anything here, try it.
 *
 * What remains is blocked by robots.txt, not by difficulty — which is a
 * different kind of "no" and is not reconsidered by trying harder:
 *   · LinkedIn — `User-agent: * → Disallow: /`, plus an explicit prohibition on
 *     automated access in the robots header itself.
 *   · XING — `Disallow: /jobs/search/` and `/jobs/search?*`.
 * Both stay reachable only through the `site:` WebSearch queries in
 * `portals.yml` → `search_queries`, which no script reads.
 */
export const AGENT_DRIVEN_SOURCES = [
  {
    id: 'linkedin',
    how: 'robots.txt Disallows everything for `*` and prohibits automated access outright. Reach it '
      + 'ONLY via the `site:linkedin.com/jobs` queries in portals.yml → search_queries, run as WebSearch.',
  },
  {
    id: 'xing',
    how: 'robots.txt Disallows /jobs/search/ and /jobs/search?*. Reach it ONLY via the '
      + '`site:xing.com/jobs` queries in portals.yml → search_queries, run as WebSearch.',
  },
];

/**
 * Per-stage metadata. `agent` marks the stages that cost model tokens and
 * therefore cannot be performed by the driver alone — it hands those back with
 * an explicit contract rather than pretending to have run them.
 */
export const STAGE_INFO = {
  scan: {
    action: 'scan',
    agent: false,
    describe: 'deep search — widen until enough new postings clear the score bar',
  },
  pipeline: {
    action: 'evaluate',
    agent: true,
    describe: 'evaluate every pending URL in the inbox into a report + tracker row',
  },
  kits: {
    action: 'build-kits',
    agent: true,
    describe: 'build a tailored CV and cover letter for each qualifying tracker row',
  },
  sync: {
    action: 'sync',
    agent: false,
    describe: 'reconcile tracker, PDF flags, follow-up seeds and the dashboard',
  },
};

export const DEFAULT_RUN_CONFIG = {
  /** New postings the scan stage aims to surface. Mirrors `loop.target`. */
  target: 10,
  /** Score bar for the scan loop. Mirrors `loop.min_score`. */
  minScore: 3.8,
  /**
   * Score at or above which a tracker row earns a full application kit.
   * `modes/pipeline.md` resolves this the same way: `loop.min_score` wins over
   * `auto_pdf_score_threshold`, so a role the loop shortlisted cannot arrive
   * here and be silently skipped for being a fraction below a second bar.
   */
  kitThreshold: 3.8,
  /**
   * Times a single stage may be re-entered before the run halts. Without this a
   * stage whose exit condition never clears — an inbox with one permanently
   * unreachable URL, say — re-emits the same instruction forever, and an agent
   * following `next` in a loop would keep paying for it.
   */
  maxStageAttempts: 4,
};

/** Statuses whose rows are finished with; a kit for them would be waste. */
const CLOSED_STATUSES = new Set(['SKIP', 'Rejected', 'Discarded', 'Hired']);

/**
 * Statuses a kit is still useful for. `Evaluated` is the normal case; `Applied`
 * and later are deliberately excluded — those artifacts were already built and
 * sent, and rebuilding one would silently replace the PDF the user actually
 * submitted with a regenerated near-copy.
 */
const KIT_STATUSES = new Set(['Evaluated']);

/**
 * Resolve run config from a parsed `config/profile.yml`.
 *
 * Reads the same `loop:` block the scan loop uses rather than introducing a
 * parallel set of knobs: a user who raised `loop.min_score` to tighten their
 * scan would not expect the end-to-end command to keep using the old bar.
 *
 * @param {object} profile - Parsed profile.yml (or {}).
 * @returns {typeof DEFAULT_RUN_CONFIG}
 */
export function resolveRunConfig(profile = {}) {
  const loop = (profile && profile.loop) || {};
  const config = { ...DEFAULT_RUN_CONFIG };

  const target = Number(loop.target);
  if (Number.isFinite(target) && target > 0) config.target = target;

  const minScore = Number(loop.min_score);
  if (Number.isFinite(minScore)) config.minScore = minScore;

  // kitThreshold follows loop.min_score, falling back to auto_pdf_score_threshold
  // only when there is no loop: block at all — the precedence modes/pipeline.md
  // documents.
  if (Number.isFinite(minScore)) {
    config.kitThreshold = minScore;
  } else {
    const legacy = Number(profile?.auto_pdf_score_threshold);
    if (Number.isFinite(legacy)) config.kitThreshold = legacy;
  }

  const attempts = Number(loop.max_stage_attempts);
  if (Number.isFinite(attempts) && attempts > 0) config.maxStageAttempts = attempts;

  return config;
}

/**
 * Build a fresh run.
 *
 * @param {typeof DEFAULT_RUN_CONFIG} config
 * @param {object} [options]
 * @param {string[]} [options.skip] - Stage names to skip up front (`--skip-scan`).
 * @param {string} [options.now] - ISO timestamp, injected so tests are deterministic.
 * @returns {object} Run state.
 */
export function newRun(config = DEFAULT_RUN_CONFIG, { skip = [], now = new Date().toISOString() } = {}) {
  const skipped = STAGES.filter((s) => skip.includes(s));
  return {
    run_id: `run-${now.replace(/[-:]/g, '').replace(/\..*$/, '')}`,
    started_at: now,
    updated_at: now,
    config: { ...DEFAULT_RUN_CONFIG, ...config },
    completed: [],
    skipped,
    attempts: {},
    halted_reason: null,
    stats: { discovered: 0, evaluated: 0, kitsBuilt: 0, syncedAt: null },
  };
}

/**
 * Repair a state object read from disk.
 *
 * A run persists across processes and across career-ops upgrades, so a state
 * written by an older version must not crash the newer one — an unreadable run
 * is indistinguishable, to the user, from losing the work it was tracking.
 *
 * @param {object} raw - Parsed JSON from data/run-state.json.
 * @param {typeof DEFAULT_RUN_CONFIG} config
 * @returns {object} Normalized run state.
 */
export function normalizeRun(raw, config = DEFAULT_RUN_CONFIG) {
  const state = raw && typeof raw === 'object' ? { ...raw } : {};
  state.config = { ...DEFAULT_RUN_CONFIG, ...config, ...(state.config || {}) };
  state.completed = Array.isArray(state.completed) ? state.completed.filter((s) => STAGES.includes(s)) : [];
  state.skipped = Array.isArray(state.skipped) ? state.skipped.filter((s) => STAGES.includes(s)) : [];
  state.attempts = state.attempts && typeof state.attempts === 'object' ? { ...state.attempts } : {};
  state.stats = { discovered: 0, evaluated: 0, kitsBuilt: 0, syncedAt: null, ...(state.stats || {}) };
  if (state.halted_reason === undefined) state.halted_reason = null;
  return state;
}

/** True when every stage has been completed or explicitly skipped. */
export function isFinished(state) {
  return STAGES.every((s) => state.completed.includes(s) || state.skipped.includes(s));
}

/** The first stage that is neither completed nor skipped, or null. */
export function currentStage(state) {
  return STAGES.find((s) => !state.completed.includes(s) && !state.skipped.includes(s)) ?? null;
}

/**
 * A row whose own evaluation says not to send it.
 *
 * Reports write a verdict into the tracker notes ("DO NOT APPLY", "do NOT apply
 * as posted", "send a one-question enquiry instead"). Score alone cannot see
 * this: ZEISS and Manex both scored 3.9 — above the kit bar — while their
 * reports said the posting is full-time against a 20 h/week cap, and Munich at
 * ~190 km, and asked for an enquiry rather than an application. Building kits
 * for those spends two PDFs each and, worse, nudges toward sending something
 * the candidate's own analysis advised against.
 *
 * So these are separated, not dropped: they stay visible as `needsDecision` for
 * the user to override deliberately, which is exactly what happened.
 */
export const DO_NOT_APPLY_RE = /\bdo\s*not\s+apply\b|\bdon'?t\s+apply\b|\bnicht\s+bewerben\b/i;

/**
 * Select the tracker rows that still need an application kit.
 *
 * A row qualifies when it scored at or above the kit threshold, is still at
 * `Evaluated`, and has no PDF recorded. The PDF cell is the idempotency key:
 * re-running the command must not rebuild a kit that already exists, or a
 * resumed run would spend a Playwright launch per row for no change.
 *
 * @param {Array<object>} rows - Parsed tracker rows (see tracker-parse.mjs).
 * @param {number} kitThreshold
 * @returns {Array<{num:number, company:string, role:string, score:number, report:string}>}
 */
export function kitCandidates(rows = [], kitThreshold = DEFAULT_RUN_CONFIG.kitThreshold) {
  const out = [];
  for (const row of rows) {
    if (!row || CLOSED_STATUSES.has(row.status)) continue;
    if (!KIT_STATUSES.has(row.status)) continue;
    // A ✅ means the kit is on disk. Anything else — ❌, an em dash, blank —
    // means it is not, and the row is still a candidate.
    if (String(row.pdf ?? '').includes('✅')) continue;
    const score = parseFloat(String(row.score ?? '').replace('/5', ''));
    if (!Number.isFinite(score) || score < kitThreshold) continue;
    out.push({
      num: row.num,
      company: row.company,
      role: row.role,
      score,
      report: row.report ?? '',
      // Surfaced, not silently honoured: the driver splits on this so the user
      // sees the row and decides, rather than the row vanishing.
      doNotApply: DO_NOT_APPLY_RE.test(String(row.notes ?? '')),
    });
  }
  return out;
}

/**
 * Decide what happens next.
 *
 * Pure: every observation the decision depends on arrives in `facts`, so the
 * same state plus the same facts always yields the same instruction. The driver
 * gathers the facts (scan-loop phase, inbox depth, tracker rows) and performs
 * whatever comes back.
 *
 * @param {object} state - Run state.
 * @param {object} facts
 * @param {{done: boolean, phase?: string, qualified?: number}} [facts.loop] - scan-loop status.
 * @param {number} [facts.pendingUrls] - `- [ ]` rows in data/pipeline.md.
 * @param {Array<object>} [facts.kitCandidates] - Output of kitCandidates().
 * @returns {{stage: string|null, action: string, reason: string, agent: boolean, [k: string]: any}}
 */
export function decideNextStage(state, facts = {}) {
  if (state.halted_reason) {
    return { stage: currentStage(state), action: 'halt', agent: false, reason: state.halted_reason };
  }
  if (isFinished(state)) {
    return { stage: null, action: 'done', agent: false, reason: 'every stage is complete' };
  }

  const stage = currentStage(state);
  const info = STAGE_INFO[stage];
  const attempts = state.attempts[stage] ?? 0;

  // Circuit breaker. Checked before the exit conditions so a stage that cannot
  // clear stops the run with a reason, rather than emitting its instruction on
  // every `next` call until someone notices the loop.
  if (attempts >= state.config.maxStageAttempts) {
    return {
      stage,
      action: 'halt',
      agent: false,
      reason: `stage "${stage}" has been attempted ${attempts} time(s) without completing `
        + `(limit ${state.config.maxStageAttempts}) — resolve it by hand, then \`advance\` past it or \`abort\``,
    };
  }

  const base = { stage, action: info.action, agent: info.agent, attempts };

  if (stage === 'scan') {
    const loop = facts.loop ?? {};
    if (loop.done) {
      // The scan loop is not the whole of stage 1. Sources with no HTTP
      // provider — currently Indeed, reachable only through an MCP that the
      // AGENT calls — cannot run inside scan.mjs, so they live in modes/run.md
      // Stage 1b. Completing the stage on `loop.done` alone made skipping them
      // invisible: the pass reported "scan complete" having never touched them,
      // and Indeed contributed 3 rows in the scanner's entire history while
      // producing two of six evaluations in the one pass that used it.
      if (!facts.agentSourcesSwept) {
        return {
          ...base,
          action: 'scan-agent-sources',
          agent: true,
          reason: 'the scan loop finished, but the robots-blocked sources (Stage 1b) have not been swept this pass',
          sources: AGENT_DRIVEN_SOURCES,
          instructions: 'Run the `site:` queries for these sources from `portals.yml` → `search_queries` '
            + 'as WebSearch — NOTHING reads that section automatically, which is why 32 configured '
            + 'queries have never run. Collect {url, company, title, location} for each hit and '
            + '`node ingest-jobs.mjs --file <file> --source websearch`. Do NOT fetch these hosts '
            + 'directly: both Disallow it in robots.txt. Then record it with '
            + '`node run-all.mjs note-sources --note "..."`, which is what lets this stage complete.',
        };
      }
      return {
        ...base,
        action: 'stage-complete',
        agent: false,
        reason: `scan loop finished with ${loop.qualified ?? 0} qualified posting(s); agent-driven sources swept`,
      };
    }
    return {
      ...base,
      reason: loop.phase
        ? `scan loop is mid-run (phase: ${loop.phase})`
        : 'no scan run in progress yet',
      instructions: 'Ask `node scan-loop.mjs next` what is due, then run `node scan-loop.mjs wave` to '
        + 'actually run it — NOT strategy.command directly, which scans for real without recording the '
        + 'rung. Repeat until `next` reports `finish`, then `node scan-loop.mjs finish`. Budgets and the '
        + 'escalation ladder are in LOOP.md.',
    };
  }

  if (stage === 'pipeline') {
    const pending = facts.pendingUrls ?? 0;
    if (pending === 0) {
      return { ...base, action: 'stage-complete', agent: false, reason: 'the URL inbox is empty' };
    }
    return {
      ...base,
      pending,
      reason: `${pending} URL(s) pending in data/pipeline.md`,
      instructions: 'Follow `modes/pipeline.md` end to end: Gmail sweep, liveness sweep, pre-screen '
        + 'gate, then evaluate each surviving URL into a report and a tracker TSV. Do not build CVs '
        + 'here — the kits stage does that once every row has a score.',
    };
  }

  if (stage === 'kits') {
    const all = facts.kitCandidates ?? [];
    // A row its own report advised against is held back for an explicit call.
    const candidates = all.filter((c) => !c.doNotApply);
    const needsDecision = all.filter((c) => c.doNotApply);
    if (all.length === 0) {
      return {
        ...base,
        action: 'stage-complete',
        agent: false,
        reason: `no tracker row is at or above ${state.config.kitThreshold} without a PDF`,
      };
    }
    if (candidates.length === 0) {
      return {
        ...base,
        action: 'stage-complete',
        agent: false,
        needsDecision,
        reason: `every remaining row at or above ${state.config.kitThreshold} carries a "do not apply" verdict `
          + `(${needsDecision.map((c) => `#${c.num}`).join(', ')}) — build one only if the user says so`,
      };
    }
    return {
      ...base,
      candidates,
      needsDecision,
      reason: `${candidates.length} row(s) at or above ${state.config.kitThreshold} have no kit yet`
        + (needsDecision.length ? `; ${needsDecision.length} more held back on a "do not apply" verdict` : ''),
      instructions: 'For each candidate: tailor the CV payload (`modes/pdf.md`) and the cover-letter '
        + 'payload (`modes/cover.md`) from that row\'s report, then run '
        + '`node build-application.mjs --report NNN --cv <cv.json> --cover <cover.json>`. '
        + 'It checks liveness first and aborts on a closed posting. Nothing is submitted.',
    };
  }

  // sync — the driver performs this one itself; there is nothing to hand back.
  return { ...base, reason: 'artifacts are built; reconcile the data the dashboard reads' };
}

/**
 * Roll a run up for `status --summary` and the run log.
 *
 * @param {object} state
 * @returns {object}
 */
export function summarize(state) {
  const stage = currentStage(state);
  return {
    run_id: state.run_id,
    stage,
    stages: STAGES.map((s) => ({
      stage: s,
      state: state.completed.includes(s) ? 'done'
        : state.skipped.includes(s) ? 'skipped'
          : s === stage ? 'active' : 'pending',
      attempts: state.attempts[s] ?? 0,
    })),
    completed: state.completed.length,
    total: STAGES.length,
    halted_reason: state.halted_reason,
    ...state.stats,
  };
}

/**
 * One append-only audit line. Mirrors `renderRunLogEntry` in loop-core.mjs so
 * both logs read the same way.
 *
 * @param {object} state
 * @param {string} event
 * @param {string} [detail]
 * @param {string} [now] - ISO timestamp, injected for deterministic tests.
 * @returns {string}
 */
export function renderRunLogEntry(state, event, detail = '', now = new Date().toISOString()) {
  const stage = currentStage(state) ?? 'done';
  return `- ${now} · ${state.run_id} · ${event} · stage=${stage}${detail ? ` · ${detail}` : ''}`;
}
