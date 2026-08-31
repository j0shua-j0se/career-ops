// tests/run-core.test.mjs — unit tests for the /career-ops run control law.
//
// run-core.mjs decides which of the four end-to-end stages happens next. Its
// whole reason for existing separately from run-all.mjs is that this question
// must be answerable without a live job board, a Playwright launch, or a model
// call — so every observation arrives as a plain `facts` object and every
// decision is a pure function of (state, facts).
//
// What is pinned here is mostly *ordering and refusal*: that stages cannot run
// out of dependency order, that a stage which cannot clear halts instead of
// looping forever, and that kit selection never rebuilds an artifact the user
// has already sent. Those are the properties that go wrong silently.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - run-core (end-to-end run control law)');

/** Deep-equality good enough for the plain JSON these functions return. */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const mod = await import(pathToFileURL(join(ROOT, 'run-core.mjs')).href);
  const {
    STAGES, DEFAULT_RUN_CONFIG, resolveRunConfig, newRun, normalizeRun,
    decideNextStage, currentStage, isFinished, kitCandidates, summarize,
    renderRunLogEntry,
  } = mod;

  // ── Stage order ────────────────────────────────────────────────────────────
  // The order encodes a data dependency: each stage consumes what the previous
  // produced. Reordering it would produce a dashboard describing a state that
  // never existed, so the sequence is asserted literally.
  if (eq(STAGES, ['scan', 'pipeline', 'kits', 'sync'])) {
    pass('the stage order is scan -> pipeline -> kits -> sync');
  } else {
    fail(`unexpected stage order: ${JSON.stringify(STAGES)}`);
  }

  // ── resolveRunConfig ───────────────────────────────────────────────────────
  const defaults = resolveRunConfig({});
  if (defaults.target === 10 && defaults.minScore === 3.8 && defaults.kitThreshold === 3.8) {
    pass('an empty profile yields the documented defaults');
  } else {
    fail(`empty profile yielded ${JSON.stringify(defaults)}`);
  }

  const tuned = resolveRunConfig({ loop: { target: 25, min_score: 4.2 } });
  if (tuned.target === 25 && tuned.minScore === 4.2) {
    pass('loop.target and loop.min_score are read from the profile');
  } else {
    fail(`loop config not read: ${JSON.stringify(tuned)}`);
  }

  // The precedence modes/pipeline.md documents: a role the loop shortlisted must
  // not arrive at the kits stage and be skipped for being below a second bar.
  if (tuned.kitThreshold === 4.2) {
    pass('loop.min_score wins over auto_pdf_score_threshold for the kit threshold');
  } else {
    fail(`kitThreshold was ${tuned.kitThreshold}, expected it to follow loop.min_score`);
  }

  const legacy = resolveRunConfig({ auto_pdf_score_threshold: 3.0 });
  if (legacy.kitThreshold === 3.0) {
    pass('auto_pdf_score_threshold is the fallback when there is no loop: block');
  } else {
    fail(`legacy fallback gave kitThreshold ${legacy.kitThreshold}, expected 3.0`);
  }

  // A profile is user-edited YAML: a garbage value must fall back, not poison
  // the run with NaN (every score comparison against NaN is false, which would
  // silently qualify nothing).
  const junk = resolveRunConfig({ loop: { target: 'lots', min_score: 'high' } });
  if (junk.target === 10 && junk.minScore === 3.8) {
    pass('non-numeric loop values fall back to the defaults instead of becoming NaN');
  } else {
    fail(`non-numeric loop values produced ${JSON.stringify(junk)}`);
  }

  const nonPositive = resolveRunConfig({ loop: { target: 0 } });
  if (nonPositive.target === 10) pass('a target of 0 is rejected in favour of the default');
  else fail(`target 0 produced ${nonPositive.target}`);

  // ── newRun / currentStage / isFinished ─────────────────────────────────────
  const fresh = newRun(DEFAULT_RUN_CONFIG, { now: '2026-08-10T09:00:00.000Z' });
  if (currentStage(fresh) === 'scan') pass('a fresh run starts at the scan stage');
  else fail(`a fresh run started at ${currentStage(fresh)}`);

  if (fresh.run_id === 'run-20260810T090000') pass('the run id is derived from the start timestamp');
  else fail(`unexpected run id ${fresh.run_id}`);

  if (isFinished(fresh) === false) pass('a fresh run is not finished');
  else fail('a fresh run reported itself finished');

  const skipped = newRun(DEFAULT_RUN_CONFIG, { skip: ['scan'], now: '2026-08-10T09:00:00.000Z' });
  if (currentStage(skipped) === 'pipeline') pass('--skip-scan moves the first stage to pipeline');
  else fail(`skipping scan left the stage at ${currentStage(skipped)}`);

  const allSkipped = newRun(DEFAULT_RUN_CONFIG, { skip: [...STAGES], now: '2026-08-10T09:00:00.000Z' });
  if (isFinished(allSkipped) && currentStage(allSkipped) === null) {
    pass('skipping every stage yields a finished run with no current stage');
  } else {
    fail('skipping every stage did not finish the run');
  }

  // An unknown stage name in --skip must not silently become part of the state.
  const bogusSkip = newRun(DEFAULT_RUN_CONFIG, { skip: ['nonsense'], now: '2026-08-10T09:00:00.000Z' });
  if (eq(bogusSkip.skipped, [])) pass('an unrecognised stage name is not accepted as skipped');
  else fail(`unrecognised skip retained: ${JSON.stringify(bogusSkip.skipped)}`);

  // ── normalizeRun ───────────────────────────────────────────────────────────
  // Run state survives across processes and across career-ops upgrades. An
  // unreadable run is indistinguishable, to the user, from losing the work it
  // was tracking, so older/damaged shapes must be repaired rather than rejected.
  const repaired = normalizeRun({ completed: ['pipeline', 'bogus'], skipped: null }, DEFAULT_RUN_CONFIG);
  if (eq(repaired.completed, ['pipeline']) && eq(repaired.skipped, [])) {
    pass('normalizeRun drops unknown stage names and repairs a null skipped list');
  } else {
    fail(`normalizeRun produced ${JSON.stringify({ c: repaired.completed, s: repaired.skipped })}`);
  }

  const fromNothing = normalizeRun(null, DEFAULT_RUN_CONFIG);
  if (eq(fromNothing.completed, []) && fromNothing.stats && fromNothing.halted_reason === null) {
    pass('normalizeRun(null) yields a usable empty run instead of throwing');
  } else {
    fail('normalizeRun(null) did not produce a usable run');
  }

  // ── kitCandidates ──────────────────────────────────────────────────────────
  const rows = [
    { num: 1, company: 'Acme', role: 'AI Eng', score: '4.4/5', status: 'Evaluated', pdf: '❌', report: '[1](r.md)' },
    { num: 2, company: 'Beta', role: 'ML Eng', score: '3.0/5', status: 'Evaluated', pdf: '❌', report: '' },
    { num: 3, company: 'Gamma', role: 'PM', score: '4.9/5', status: 'Evaluated', pdf: '✅', report: '' },
    { num: 4, company: 'Delta', role: 'MLE', score: '4.5/5', status: 'Applied', pdf: '❌', report: '' },
    { num: 5, company: 'Eps', role: 'DS', score: '4.7/5', status: 'Rejected', pdf: '❌', report: '' },
    { num: 6, company: 'Zeta', role: 'RS', score: 'N/A', status: 'Evaluated', pdf: '❌', report: '' },
    { num: 7, company: 'Eta', role: 'AI', score: '3.8/5', status: 'Evaluated', pdf: '—', report: '[7](r.md)' },
  ];
  const picked = kitCandidates(rows, 3.8);
  if (eq(picked.map((c) => c.num), [1, 7])) {
    pass('kitCandidates selects only Evaluated rows at or above the threshold with no PDF');
  } else {
    fail(`kitCandidates picked ${JSON.stringify(picked.map((c) => c.num))}, expected [1, 7]`);
  }

  // The PDF cell is the idempotency key. Without it a resumed pass rebuilds
  // every kit it already built, at a Playwright launch each.
  if (!picked.some((c) => c.num === 3)) pass('a row whose PDF is already ✅ is not a kit candidate');
  else fail('a row with an existing PDF was selected for rebuilding');

  // Rebuilding a kit for a sent application would replace the PDF the user
  // actually submitted with a regenerated near-copy.
  if (!picked.some((c) => c.num === 4)) pass('an Applied row is not a kit candidate');
  else fail('an already-applied row was selected for a kit');

  if (!picked.some((c) => c.num === 5)) pass('a Rejected row is not a kit candidate');
  else fail('a rejected row was selected for a kit');

  if (!picked.some((c) => c.num === 6)) pass('a row with a non-numeric score sentinel is not a kit candidate');
  else fail('an N/A-scored row was selected for a kit');

  // The threshold is inclusive: a role scoring exactly at the bar qualifies, or
  // the loop could shortlist a posting the kits stage then refuses.
  if (picked.some((c) => c.num === 7)) pass('a score exactly at the threshold qualifies (inclusive bar)');
  else fail('a row scoring exactly at the threshold was excluded');

  if (eq(kitCandidates([], 3.8), []) && eq(kitCandidates(undefined, 3.8), [])) {
    pass('kitCandidates handles an empty or absent row list');
  } else {
    fail('kitCandidates did not handle an empty row list');
  }

  // ── "do not apply" verdicts are separated, not silently honoured ──────────
  // Score alone cannot see a report's verdict. ZEISS and Manex both scored 3.9,
  // above the kit bar, while their reports said the posting is full-time
  // against a 20 h/week cap and Munich at ~190 km, and asked for a one-question
  // enquiry rather than an application. Building kits there spends two PDFs
  // each and nudges toward sending what the candidate's own analysis advised
  // against — but dropping the rows silently is worse, so they surface as
  // needsDecision.
  const verdictRows = [
    { num: 1, company: 'Good', role: 'r', score: '4.4/5', status: 'Evaluated', pdf: '❌', notes: 'Recommendation: APPLY.' , report: '[1](r.md)' },
    { num: 12, company: 'ZEISS', role: 'r', score: '3.9/5', status: 'Evaluated', pdf: '❌', notes: 'RECOMMENDED ACTION: do NOT apply as posted; send an enquiry.' , report: '[12](r.md)' },
    { num: 13, company: 'Manex', role: 'r', score: '3.9/5', status: 'Evaluated', pdf: '❌', notes: 'DO NOT APPLY — Munich, not commutable.' , report: '[13](r.md)' },
  ];
  const verdicts = kitCandidates(verdictRows, 3.8);
  if (verdicts.length === 3) pass('a "do not apply" row is still a kit candidate, not dropped from the list');
  else fail(`kitCandidates returned ${verdicts.length} rows, expected all 3`);

  const flagged = verdicts.filter((c) => c.doNotApply).map((c) => c.num);
  if (eq(flagged, [12, 13])) pass('rows whose notes carry a do-not-apply verdict are flagged');
  else fail(`flagged rows were ${JSON.stringify(flagged)}, expected [12, 13]`);

  const atKitsVerdict = normalizeRun({ ...newRun(DEFAULT_RUN_CONFIG, { now: '2026-08-11T09:00:00.000Z' }), completed: ['scan', 'pipeline'] }, DEFAULT_RUN_CONFIG);
  const split = decideNextStage(atKitsVerdict, { kitCandidates: verdicts });
  if (eq(split.candidates.map((c) => c.num), [1]) && eq(split.needsDecision.map((c) => c.num), [12, 13])) {
    pass('the kits stage builds only the un-flagged row and holds the rest for a decision');
  } else {
    fail(`split was build=${JSON.stringify(split.candidates.map((c) => c.num))} held=${JSON.stringify(split.needsDecision?.map((c) => c.num))}`);
  }

  // When EVERY remaining row is flagged there is nothing to build unprompted —
  // the stage completes and names the rows rather than looping on them.
  const allFlagged = decideNextStage(atKitsVerdict, { kitCandidates: verdicts.filter((c) => c.doNotApply) });
  if (allFlagged.action === 'stage-complete' && /do not apply/i.test(allFlagged.reason) && /#12/.test(allFlagged.reason)) {
    pass('a kits stage with only flagged rows completes and names them in the reason');
  } else {
    fail(`all-flagged case gave ${JSON.stringify({ a: allFlagged.action, r: allFlagged.reason })}`);
  }

  // The wording varies across reports; all of these must trip.
  const phrasings = ['DO NOT APPLY', 'do NOT apply as posted', "don't apply", 'Nicht bewerben'];
  const missed = phrasings.filter((n) => !kitCandidates([{ num: 9, company: 'C', role: 'r', score: '4.0/5', status: 'Evaluated', pdf: '❌', report: '[9](r.md)', notes: n }], 3.8)[0]?.doNotApply);
  if (missed.length === 0) pass('every common do-not-apply phrasing is recognised');
  else fail(`these phrasings were missed: ${JSON.stringify(missed)}`);

  // And it must not fire on a row that merely discusses applying.
  const benign = kitCandidates([{ num: 8, company: 'D', role: 'r', score: '4.2/5', status: 'Evaluated', pdf: '❌', report: '[8](r.md)', notes: 'Recommendation: APPLY — assemble documents before you apply.' }], 3.8);
  if (benign[0] && benign[0].doNotApply === false) pass('an ordinary "APPLY" note is not mistaken for a refusal');
  else fail('a positive recommendation was flagged as do-not-apply');

  // ── decideNextStage ────────────────────────────────────────────────────────
  const run = newRun(DEFAULT_RUN_CONFIG, { now: '2026-08-10T09:00:00.000Z' });

  const scanPending = decideNextStage(run, { loop: { done: false, phase: 'scanning' } });
  if (scanPending.stage === 'scan' && scanPending.action === 'scan') {
    pass('an unfinished scan loop keeps the run on the scan stage');
  } else {
    fail(`scan stage decided ${JSON.stringify(scanPending)}`);
  }
  if (scanPending.agent === false) pass('the scan stage is marked zero-token, not an agent stage');
  else fail('the scan stage was marked as an agent stage');

  // A finished loop completes the stage only once the agent-driven sources
  // (modes/run.md → Stage 1b) are recorded as swept. This assertion used to
  // pass `{ loop: { done: true } }` alone and expect `stage-complete`; that is
  // exactly what let a pass report "scan complete" having never touched Indeed,
  // which has no HTTP provider and cannot run inside scan.mjs. The
  // `agentSourcesSwept` fact is asserted in its own block further down.
  const scanDone = decideNextStage(run, { loop: { done: true, qualified: 12 }, agentSourcesSwept: true });
  if (scanDone.action === 'stage-complete' && /12 qualified/.test(scanDone.reason)) {
    pass('a finished scan loop reports the scan stage complete, with the qualified count');
  } else {
    fail(`finished scan loop decided ${JSON.stringify(scanDone)}`);
  }

  // Dependency order: with the scan stage still open, a full inbox must NOT pull
  // the run forward to evaluation.
  const outOfOrder = decideNextStage(run, { loop: { done: false }, pendingUrls: 9, kitCandidates: picked });
  if (outOfOrder.stage === 'scan') {
    pass('a full inbox does not pull the run past an unfinished scan stage');
  } else {
    fail(`stage order violated — decided stage ${outOfOrder.stage} while scan was open`);
  }

  const atPipeline = normalizeRun({ ...run, completed: ['scan'] }, DEFAULT_RUN_CONFIG);
  const evaluate = decideNextStage(atPipeline, { pendingUrls: 3 });
  if (evaluate.stage === 'pipeline' && evaluate.action === 'evaluate' && evaluate.pending === 3) {
    pass('a non-empty inbox puts the run on the pipeline stage with a pending count');
  } else {
    fail(`pipeline stage decided ${JSON.stringify(evaluate)}`);
  }
  if (evaluate.agent === true && typeof evaluate.instructions === 'string' && evaluate.instructions.length > 0) {
    pass('the pipeline stage is an agent stage and carries instructions');
  } else {
    fail('the pipeline stage did not hand back instructions');
  }

  const drained = decideNextStage(atPipeline, { pendingUrls: 0 });
  if (drained.action === 'stage-complete') pass('an empty inbox reports the pipeline stage complete');
  else fail(`empty inbox decided ${JSON.stringify(drained)}`);

  const atKits = normalizeRun({ ...run, completed: ['scan', 'pipeline'] }, DEFAULT_RUN_CONFIG);
  const kits = decideNextStage(atKits, { kitCandidates: picked });
  if (kits.stage === 'kits' && kits.action === 'build-kits' && kits.candidates.length === 2) {
    pass('outstanding kit candidates put the run on the kits stage');
  } else {
    fail(`kits stage decided ${JSON.stringify(kits)}`);
  }
  // The kit instruction must route through build-application.mjs, which runs the
  // liveness check first — going straight to generate-pdf would skip that gate.
  if (/build-application\.mjs/.test(kits.instructions)) {
    pass('the kits instruction routes through build-application.mjs (liveness-first)');
  } else {
    fail('the kits instruction does not name build-application.mjs');
  }

  const noKits = decideNextStage(atKits, { kitCandidates: [] });
  if (noKits.action === 'stage-complete') pass('no candidates reports the kits stage complete');
  else fail(`empty candidate list decided ${JSON.stringify(noKits)}`);

  const atSync = normalizeRun({ ...run, completed: ['scan', 'pipeline', 'kits'] }, DEFAULT_RUN_CONFIG);
  const sync = decideNextStage(atSync, {});
  if (sync.stage === 'sync' && sync.action === 'sync' && sync.agent === false) {
    pass('the last stage is sync, and it is zero-token');
  } else {
    fail(`sync stage decided ${JSON.stringify(sync)}`);
  }

  const finished = normalizeRun({ ...run, completed: [...STAGES] }, DEFAULT_RUN_CONFIG);
  const done = decideNextStage(finished, {});
  if (done.action === 'done' && done.stage === null) pass('a fully completed run decides "done"');
  else fail(`completed run decided ${JSON.stringify(done)}`);

  // ── Circuit breaker ────────────────────────────────────────────────────────
  // Without this a stage whose exit condition never clears re-emits the same
  // instruction on every call, and an agent following `next` in a loop keeps
  // paying for it.
  const stuck = normalizeRun(
    { ...run, completed: ['scan'], attempts: { pipeline: DEFAULT_RUN_CONFIG.maxStageAttempts } },
    DEFAULT_RUN_CONFIG
  );
  const halted = decideNextStage(stuck, { pendingUrls: 5 });
  if (halted.action === 'halt' && /attempted/.test(halted.reason)) {
    pass('a stage that exhausts its attempt budget halts instead of looping');
  } else {
    fail(`exhausted stage decided ${JSON.stringify(halted)}`);
  }
  if (halted.action === 'halt' && /advance|abort/.test(halted.reason)) {
    pass('the halt reason names the way out (advance or abort)');
  } else {
    fail('the halt reason does not tell the user how to recover');
  }

  // One attempt below the limit must still run — an off-by-one here would cut a
  // stage short of its last allowed try.
  const nearlyStuck = normalizeRun(
    { ...run, completed: ['scan'], attempts: { pipeline: DEFAULT_RUN_CONFIG.maxStageAttempts - 1 } },
    DEFAULT_RUN_CONFIG
  );
  if (decideNextStage(nearlyStuck, { pendingUrls: 5 }).action === 'evaluate') {
    pass('a stage one attempt below the limit still runs');
  } else {
    fail('the attempt budget is off by one — the final allowed attempt was refused');
  }

  const explicitlyHalted = normalizeRun({ ...run, halted_reason: 'aborted by the user' }, DEFAULT_RUN_CONFIG);
  const abortDecision = decideNextStage(explicitlyHalted, { loop: { done: false } });
  if (abortDecision.action === 'halt' && abortDecision.reason === 'aborted by the user') {
    pass('a recorded halt reason short-circuits every later decision');
  } else {
    fail(`halted run decided ${JSON.stringify(abortDecision)}`);
  }

  // ── summarize / log rendering ──────────────────────────────────────────────
  const mid = normalizeRun({ ...run, completed: ['scan'], skipped: [], attempts: { pipeline: 2 } }, DEFAULT_RUN_CONFIG);
  const s = summarize(mid);
  if (s.stage === 'pipeline' && s.completed === 1 && s.total === 4) {
    pass('summarize reports the active stage and completion count');
  } else {
    fail(`summarize produced ${JSON.stringify({ stage: s.stage, completed: s.completed, total: s.total })}`);
  }
  const states = s.stages.map((x) => x.state);
  if (eq(states, ['done', 'active', 'pending', 'pending'])) {
    pass('summarize labels each stage done/active/pending');
  } else {
    fail(`stage labels were ${JSON.stringify(states)}`);
  }

  const line = renderRunLogEntry(mid, 'start', 'detail here', '2026-08-10T09:00:00.000Z');
  if (line.startsWith('- 2026-08-10T09:00:00.000Z · ') && /· start ·/.test(line) && /stage=pipeline/.test(line)) {
    pass('the run-log line carries timestamp, event and stage');
  } else {
    fail(`unexpected run-log line: ${line}`);
  }
} catch (e) {
  fail(`run-core tests crashed: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Stage 1 is not only the scan loop.
//
// Sources with no HTTP provider — currently Indeed, reachable only through an
// MCP that the AGENT calls and which therefore can never be a providers/
// module — live in modes/run.md Stage 1b. The stage used to complete on
// `loop.done` alone, so skipping them was invisible: a pass reported "scan
// complete" having never touched them. Indeed contributed 3 rows in the
// scanner's entire history while producing two of six evaluations in the one
// pass that actually used it, so the omission is not cosmetic.
//
// The fact is not derivable from any file: an Indeed sweep that legitimately
// found nothing writes exactly what a sweep that never ran writes. Hence an
// explicit record.
console.log('\nrun-core — the scan stage accounts for agent-driven sources');

{
  const { AGENT_DRIVEN_SOURCES, decideNextStage, newRun, DEFAULT_RUN_CONFIG, isStaleLoop } = await import('../run-core.mjs');

  const withLoopDone = (swept) =>
    decideNextStage(newRun(), { loop: { done: true, qualified: 2 }, agentSourcesSwept: swept });

  const pending = withLoopDone(false);
  pending.action === 'scan-agent-sources'
    ? pass('a finished loop does NOT complete the stage while Stage 1b is unrecorded')
    : fail(`expected scan-agent-sources, got ${pending.action}`);

  pending.agent === true
    ? pass('the Stage 1b action is handed to the agent, not a script')
    : fail('scan-agent-sources should be agent-driven');

  Array.isArray(pending.sources) && pending.sources.some((s) => s.id === 'linkedin')
    ? pass('the action names the sources to sweep rather than assuming the agent recalls them')
    : fail('scan-agent-sources did not list LinkedIn');

  // Anything that CAN be automated must leave the list, or the gate nags about
  // work the scanner already does. Indeed and StepStone both became providers
  // after being recorded as impossible.
  !AGENT_DRIVEN_SOURCES.some((s) => s.id === 'indeed')
    ? pass('Indeed is no longer agent-driven — it is a provider now')
    : fail('Indeed still listed as agent-driven despite having a provider');

  AGENT_DRIVEN_SOURCES.every((s) => /robots/i.test(s.how))
    ? pass('every remaining entry is blocked by robots.txt, not merely by difficulty')
    : fail('an entry remains for a reason other than robots.txt — try automating it instead');

  /note-sources/.test(pending.instructions || '')
    ? pass('the instructions say how to record the sweep')
    : fail('instructions do not mention note-sources');

  withLoopDone(true).action === 'stage-complete'
    ? pass('once recorded, the stage completes')
    : fail('recording the sweep did not complete the stage');

  // Sources that CAN be automated must leave the list, or the gate nags about
  // work the scanner already does. StepStone became a real provider
  // (providers/stepstone.mjs) and BMW arrives via arbeitsagentur.
  !AGENT_DRIVEN_SOURCES.some((s) => s.id === 'stepstone')
    ? pass('StepStone is no longer agent-driven — it is a provider now')
    : fail('StepStone is still listed as agent-driven despite having a provider');

  !AGENT_DRIVEN_SOURCES.some((s) => /bmw/i.test(s.id))
    ? pass('BMW is not agent-driven — it arrives via the arbeitsagentur provider')
    : fail('BMW listed as agent-driven; it comes through arbeitsagentur');

  // A mid-run loop must still point at `wave`, not at strategy.command — running
  // the strategy by hand scans for real without recording the rung, so `next`
  // returns the same wave forever.
  const midRun = decideNextStage(newRun(), { loop: { done: false, phase: 'scanning' } });
  /scan-loop\.mjs wave/.test(midRun.instructions || '')
    ? pass('mid-run instructions name `scan-loop.mjs wave`, the command that records')
    : fail('mid-run instructions do not name `wave`');

  // An ABORTED loop must never satisfy the scan stage.
  //
  // scan-loop's `abort` and `finish` both set phase='done' — byte-identical
  // state apart from halted_reason — so reading the phase alone cannot tell a
  // completed scan from an abandoned one. A run pass started after an abort
  // SKIPPED THE ENTIRE SCAN STAGE, believing discovery had already happened:
  // observed live, a pass jumped straight to Stage 1b and silently missed
  // wave 1 (portals, including newly added providers) and wave 2 (interamt).
  const aborted = decideNextStage(newRun(), {
    loop: { done: false, endedAbnormally: true, haltedReason: 'stale run', phase: 'done' },
  });
  aborted.action === 'scan'
    ? pass('an aborted loop keeps the run on the scan stage instead of completing it')
    : fail(`an aborted loop decided ${aborted.action} — the scan stage would be skipped`);

  /start --reset/.test(aborted.instructions || '')
    ? pass('the aborted path says to start a FRESH loop, not to continue the dead one')
    : fail('aborted instructions do not say to start a fresh loop');

  /ended without completing/.test(aborted.reason || '')
    ? pass('the reason states the previous loop did not complete')
    : fail('the aborted reason does not explain itself');

  // A loop that finished BEFORE this pass started is not this pass's scan.
  //
  // Same shape as the abort case above, one step subtler: the loop completed
  // perfectly well, just for a different run. `phase === 'done'` lives in
  // scan-loop's own state file, which outlives any single pass, so a fresh
  // `start` inherited the previous pass's completion and went straight to
  // Stage 1b having discovered nothing. Observed live: a pass started
  // 2026-08-18 was satisfied by a loop that had finished on 2026-08-11.
  const staleState = newRun(DEFAULT_RUN_CONFIG, { now: '2026-08-18T21:00:00.000Z' });
  const stale = decideNextStage(staleState, {
    loop: { done: true, runId: '2026-08-11T22:38:54.046Z', qualified: 7, phase: 'done' },
    agentSourcesSwept: false,
  });
  stale.action === 'scan'
    ? pass("a loop finished before the pass began does not satisfy the pass's scan stage")
    : fail(`a stale completed loop decided ${stale.action} — the scan stage would be skipped`);

  /start --reset/.test(stale.instructions || '')
    ? pass('the stale path says to start a FRESH loop')
    : fail('stale instructions do not say to start a fresh loop');

  // A loop that started DURING this pass is the pass's own scan, and must roll
  // forward normally — the staleness check must not force an endless re-scan.
  const currentLoop = decideNextStage(staleState, {
    loop: { done: true, runId: '2026-08-18T21:30:00.000Z', qualified: 7, phase: 'done' },
    agentSourcesSwept: true,
  });
  currentLoop.action === 'stage-complete'
    ? pass('a loop started during the pass completes the scan stage as before')
    : fail(`a current loop decided ${currentLoop.action}, expected stage-complete`);

  // Fail OPEN on an unreadable clock: a missing or malformed timestamp must not
  // force a re-scan the user never asked for.
  isStaleLoop(null, '2026-08-18T21:00:00.000Z') === false
    ? pass('a missing loop run_id is not treated as stale')
    : fail('a missing loop run_id was treated as stale');
  isStaleLoop('not-a-date', '2026-08-18T21:00:00.000Z') === false
    ? pass('an unparseable loop run_id is not treated as stale')
    : fail('an unparseable loop run_id was treated as stale');
  isStaleLoop('2026-08-11T00:00:00.000Z', '2026-08-18T00:00:00.000Z') === true
    ? pass('isStaleLoop is true when the loop predates the pass')
    : fail('isStaleLoop missed a loop that predates the pass');
}

{
  const { kitCandidates } = await import(pathToFileURL(join(ROOT, 'run-core.mjs')).href);
  // ── A row with no report is not a kit candidate ─────────────────────────────
  //
  // A CV and cover letter are tailored FROM the evaluation. A row that only ever
  // got a triage score off its title has nothing to tailor from, and building one
  // anyway is fabrication.
  //
  // Observed 2026-08-31: row #147 (Fraunhofer IIS, Erlangen) was promoted at 3.6
  // on title/company/location, its JD could not be retrieved because indeed's
  // robots.txt disallows /viewjob, and the kit stage offered it as a candidate.
  // The score was real; the knowledge behind it was not.
  console.log('\nrun-core — a kit needs a report to tailor from');
  {
    const rows = [
      { num: 1, company: 'A', role: 'r', score: '4.2/5', status: 'Evaluated', pdf: '❌', report: '[1](../reports/001-a.md)', notes: '' },
      { num: 2, company: 'B', role: 'r', score: '4.0/5', status: 'Evaluated', pdf: '❌', report: '—', notes: '' },
      { num: 3, company: 'C', role: 'r', score: '3.9/5', status: 'Evaluated', pdf: '❌', report: '', notes: '' },
    ];
    const got = kitCandidates(rows, 3.5).map((c) => c.num);
    JSON.stringify(got) === JSON.stringify([1])
      ? pass('only the row carrying a report link is offered as a kit candidate')
      : fail(`kitCandidates returned ${JSON.stringify(got)}, expected [1]`);
  }
  {
    // The guard must not swallow a genuine candidate.
    const rows = [{ num: 9, company: 'D', role: 'r', score: '4.6/5', status: 'Evaluated', pdf: '❌', report: '[9](reports/009-d.md)', notes: '' }];
    kitCandidates(rows, 3.5).length === 1
      ? pass('a scored row with a report is still offered, as before')
      : fail('the report guard swallowed a real candidate');
  }
}
