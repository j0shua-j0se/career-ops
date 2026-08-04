// tests/loop-core.test.mjs — the scan loop's control law.
//
// loop-core.mjs is pure by design (no fs, no network, no Playwright) precisely
// so that every budget boundary and every stop condition is a unit test instead
// of a live scan that costs money and half an hour to observe once.
//
// Auto-discovered by test-all.mjs: runs in-process, shares its counters, and
// must never terminate the process.

import { pass, fail } from './helpers.mjs';
import {
  DEFAULT_LOOP_CONFIG, WAVE_STRATEGIES, LOOP_STATE_VERSION,
  strategyById, resolveLoopConfig, candidateKey,
  newState, normalizeState, ingestOffers,
  parseTriageLine, parseTriageOutput, recordScores,
  allCandidates, qualifiedCandidates, barrenWaveStreak, summarize, pendingBatch,
  decideNextAction, renderShortlist, renderRunLogEntry,
} from '../loop-core.mjs';

console.log('\n🔁 loop-core.mjs — scan loop control law');

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
const eq = (actual, expected, msg) => check(
  Object.is(actual, expected),
  Object.is(actual, expected) ? msg : `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
);

/** A state with a scenario-specific config, so a test never depends on defaults it isn't about. */
function stateWith(config = {}, waveCount = 0) {
  const s = newState({ ...DEFAULT_LOOP_CONFIG, ...config }, '2026-08-03T00:00:00.000Z');
  for (let i = 1; i <= waveCount; i++) s.waves.push({ wave: i, strategy: WAVE_STRATEGIES[i - 1]?.id ?? 'x', added: 0 });
  return s;
}

/** Ingest + score in one step, for tests about what the loop does afterwards. */
function seed(state, wave, entries) {
  ingestOffers(state, entries.map((e, i) => ({ url: e.url ?? `https://jobs.example.com/w${wave}/${i}`, company: e.company ?? 'Acme', title: e.title ?? 'Engineer' })), wave);
  const keys = allCandidates(state).filter((c) => c.wave === wave).map((c) => c.key);
  recordScores(state, entries.map((e, i) => ({ key: keys[i], score: e.score, verdict: e.verdict })).filter((r) => r.score !== undefined));
}

// ── Config resolution ───────────────────────────────────────────────────────

eq(DEFAULT_LOOP_CONFIG.target, 10, 'default target is 10 new qualified jobs');
eq(DEFAULT_LOOP_CONFIG.minScore, 3.8, 'default minScore is 3.8');
eq(LOOP_STATE_VERSION, 1, 'state version is pinned');

{
  const cfg = resolveLoopConfig({ loop: { target: 4, min_score: 4.2, max_waves: 3 } });
  eq(cfg.target, 4, 'profile loop.target overrides the default');
  eq(cfg.minScore, 4.2, 'snake_case min_score maps onto minScore');
  eq(cfg.maxWaves, 3, 'snake_case max_waves maps onto maxWaves');
  eq(cfg.scoreBatch, DEFAULT_LOOP_CONFIG.scoreBatch, 'unset keys keep their default');
}
{
  const cfg = resolveLoopConfig({ loop: { minScore: 4.5 } });
  eq(cfg.minScore, 4.5, 'camelCase minScore is accepted too');
}
{
  // The point of the guard: a typo must not uncap a budget.
  const cfg = resolveLoopConfig({ loop: { target: 'ten', maxScored: 0, maxWaves: -1, minScore: null } });
  eq(cfg.target, DEFAULT_LOOP_CONFIG.target, 'non-numeric target is ignored, not NaN');
  eq(cfg.maxScored, DEFAULT_LOOP_CONFIG.maxScored, 'zero budget is ignored rather than disabling the budget');
  eq(cfg.maxWaves, DEFAULT_LOOP_CONFIG.maxWaves, 'negative budget is ignored');
  eq(cfg.minScore, DEFAULT_LOOP_CONFIG.minScore, 'null minScore is ignored — the bar never drops by accident');
}
eq(resolveLoopConfig(undefined).target, 10, 'a missing profile yields defaults');
eq(resolveLoopConfig({ loop: 'nope' }).target, 10, 'a non-object loop block yields defaults');

// ── Escalation ladder ───────────────────────────────────────────────────────

check(WAVE_STRATEGIES.length >= 5, 'the ladder has at least five rungs');
eq(WAVE_STRATEGIES[0].id, 'portals', 'wave 1 is the cheapest rung (configured portals)');
eq(WAVE_STRATEGIES[WAVE_STRATEGIES.length - 1].id, 'agent-web', 'the agent is the last rung, not the first');
eq(strategyById('ats-wide')?.kind, 'script', 'ats-wide is a script rung');
eq(strategyById('agent-web').kind, 'agent', 'agent-web is an agent rung');
eq(strategyById('nope'), null, 'an unknown strategy id resolves to null');
check(
  WAVE_STRATEGIES.filter((s) => s.kind === 'script').every((s) => s.command === 'node' && Array.isArray(s.args)),
  'every script rung is an argv vector for node — nothing is shell-interpolated',
);

// ── Dedup key ───────────────────────────────────────────────────────────────

eq(
  candidateKey('https://boards.greenhouse.io/acme/jobs/4567?gh_src=abcd&utm_source=x'),
  candidateKey('https://boards.greenhouse.io/acme/jobs/4567'),
  'tracking params do not create a second candidate',
);
eq(
  candidateKey('https://WWW.Example.com/jobs/9/'),
  candidateKey('https://example.com/jobs/9'),
  'host case, www., and a trailing slash all normalize away',
);
eq(
  candidateKey('https://jobs.lever.co/x/1#apply'),
  candidateKey('https://jobs.lever.co/x/1'),
  'a fragment does not create a second candidate',
);
check(
  candidateKey('https://example.com/jobs?id=1') !== candidateKey('https://example.com/jobs?id=2'),
  'a meaningful query param is preserved — two postings stay two candidates',
);
eq(candidateKey('local:jds/acme-pm.md'), 'local:jds/acme-pm.md', 'a non-URL entry falls back to its lowercased raw form');
eq(candidateKey(''), '', 'an empty URL yields an empty key');
eq(candidateKey(null), '', 'a null URL yields an empty key');

// ── Ingest + dedup across waves ─────────────────────────────────────────────

{
  const s = stateWith();
  const first = ingestOffers(s, [
    { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'AI Engineer', location: 'Berlin' },
    { url: 'https://boards.greenhouse.io/acme/jobs/2', company: 'Acme', title: 'PM' },
    { url: '', company: 'Broken' },
  ], 1);
  eq(first.added, 2, 'two valid offers ingested');
  eq(first.invalid, 1, 'an offer with no URL is counted invalid, not ingested');

  recordScores(s, [{ key: candidateKey('https://boards.greenhouse.io/acme/jobs/1'), score: 4.4 }]);

  // The same posting, re-found on a wider rung with different tracking params.
  const second = ingestOffers(s, [
    { url: 'https://boards.greenhouse.io/acme/jobs/1?utm_campaign=ats', company: 'Acme', title: 'AI Engineer' },
    { url: 'https://jobs.ashbyhq.com/other/9', company: 'Other', title: 'MLE' },
  ], 2);
  eq(second.added, 1, 'only the genuinely new posting is added on wave 2');
  eq(second.duplicate, 1, 'the re-found posting is counted as a duplicate');
  eq(allCandidates(s).length, 3, 'dedup keeps the candidate set at three');

  const refound = s.candidates[candidateKey('https://boards.greenhouse.io/acme/jobs/1')];
  eq(refound.wave, 1, 'a re-found posting keeps its original wave');
  eq(refound.score, 4.4, 'a re-found posting keeps its score and is never re-triaged');
}

// ── Triage line contract ────────────────────────────────────────────────────

{
  const p = parseTriageLine('TRIAGE: PASS | Acme GmbH | AI Engineer | 4.2/5 | strong archetype and comp match');
  eq(p.verdict, 'PASS', 'verdict parsed');
  eq(p.company, 'Acme GmbH', 'company parsed');
  eq(p.role, 'AI Engineer', 'role parsed');
  eq(p.score, 4.2, 'score parsed as a number');
  eq(p.reason, 'strong archetype and comp match', 'reason parsed');
}
eq(parseTriageLine('TRIAGE: SKIP | X | Y | 0/5 | posting unreachable').verdict, 'SKIP', 'SKIP is a recognized verdict');
eq(parseTriageLine('TRIAGE: MARGINAL | X | Y | 3/5 | a | b').reason, 'a | b', 'a reason containing a pipe is preserved whole');
eq(parseTriageLine('TRIAGE: PASS | X | Y | 4.2 | no denominator'), null, 'a score without /5 is rejected rather than guessed');
eq(parseTriageLine('TRIAGE: MAYBE | X | Y | 4.2/5 | bad verdict'), null, 'an off-contract verdict is rejected');
eq(parseTriageLine('this role looks like a 4.5/5 to me'), null, 'prose is not mistaken for a verdict line');
eq(parseTriageLine(''), null, 'an empty line parses to null');

{
  // Subagents wrap the verdict in prose no matter what the mode file says.
  const out = parseTriageOutput([
    'Here are my assessments:',
    'TRIAGE: PASS | Acme | AI Engineer | 4.1/5 | fits',
    '',
    'and the second one:',
    'TRIAGE: FAIL | BigCo | Sales | 1.5/5 | wrong archetype',
    'Hope that helps!',
  ].join('\n'));
  eq(out.length, 2, 'both verdicts are recovered from prose-wrapped output');
  eq(out[1].score, 1.5, 'the second verdict keeps its own score');
}

// ── Scoring ─────────────────────────────────────────────────────────────────

{
  const s = stateWith({ minScore: 3.8 });
  ingestOffers(s, [
    { url: 'https://e.com/1' }, { url: 'https://e.com/2' },
    { url: 'https://e.com/3' }, { url: 'https://e.com/4' },
  ], 1);
  const r = recordScores(s, [
    { key: candidateKey('https://e.com/1'), score: 3.8 },
    { key: candidateKey('https://e.com/2'), score: 3.7 },
    { key: candidateKey('https://e.com/3'), score: 0, verdict: 'SKIP' },
    { key: candidateKey('https://e.com/4'), score: 4.9 },
    { key: 'https://nowhere.example/0', score: 5 },
  ]);
  eq(r.scored, 4, 'four known candidates were scored');
  eq(r.qualified, 2, 'exactly the two at or above the bar qualified');
  eq(r.unknown.length, 1, 'a score for an unknown key is reported, not silently applied');
  eq(s.candidates[candidateKey('https://e.com/1')].verdict, 'qualified', 'a score exactly at minScore qualifies');
  eq(s.candidates[candidateKey('https://e.com/2')].verdict, 'rejected', '0.1 below the bar is rejected — the bar does not flex');
  eq(s.candidates[candidateKey('https://e.com/3')].verdict, 'unreachable', 'SKIP means unreachable, not a score of zero');
  eq(summarize(s).unreachable, 1, 'unreachable is counted separately from rejected');
}

// ── Counting and batching ───────────────────────────────────────────────────

{
  const s = stateWith({ scoreBatch: 2 }, 1);
  seed(s, 1, [{ score: 4.5 }, { score: 4.1 }, {}, {}, {}]);
  const stats = summarize(s);
  eq(stats.discovered, 5, 'five discovered');
  eq(stats.scored, 2, 'two scored');
  eq(stats.unscored, 3, 'three still pending');
  eq(stats.qualified, 2, 'two qualified');
  eq(stats.remaining, 8, 'remaining counts down from the target');
  eq(pendingBatch(s, 2).length, 2, 'pendingBatch respects the batch size');
  check(pendingBatch(s, 2).every((c) => c.verdict === 'pending'), 'pendingBatch returns only unscored candidates');
  eq(qualifiedCandidates(s)[0].score, 4.5, 'the shortlist is ordered best-first');
}

// ── Barren-wave circuit breaker ─────────────────────────────────────────────

{
  const s = stateWith({}, 2);
  seed(s, 1, [{ score: 2.0 }, { score: 1.5 }]);
  seed(s, 2, [{ score: 3.0 }]);
  eq(barrenWaveStreak(s), 2, 'two fully-scored waves with no qualifier is a streak of two');
}
{
  const s = stateWith({}, 2);
  seed(s, 1, [{ score: 2.0 }]);
  seed(s, 2, [{ score: 3.0 }, {}]);
  eq(barrenWaveStreak(s), 0, 'a wave with unscored candidates is unfinished, not barren');
}
{
  const s = stateWith({}, 2);
  seed(s, 1, [{ score: 2.0 }]);
  seed(s, 2, [{ score: 4.5 }]);
  eq(barrenWaveStreak(s), 0, 'a wave that produced a qualifier resets the streak');
}

// ── The control law ─────────────────────────────────────────────────────────

{
  const s = stateWith({ target: 2 }, 1);
  seed(s, 1, [{ score: 4.5 }, {}]);
  const d = decideNextAction(s);
  eq(d.action, 'score', 'unscored candidates are triaged before another wave is run');
  eq(d.batch.length, 1, 'the scoring batch carries the pending candidate');
}
{
  const s = stateWith({ target: 2 }, 1);
  seed(s, 1, [{ score: 4.5 }, { score: 2.0 }]);
  const d = decideNextAction(s);
  eq(d.action, 'scan', 'everything scored and still short → widen the search');
  eq(d.wave, 2, 'the next wave number follows the wave count');
  eq(d.strategy.id, WAVE_STRATEGIES[1].id, 'the next wave escalates to the next rung, not a repeat of the last');
}
{
  const s = stateWith({ target: 2 }, 1);
  seed(s, 1, [{ score: 4.5 }, { score: 3.9 }]);
  eq(decideNextAction(s).action, 'finish', 'target met → finish');
}
{
  const s = stateWith({ target: 10, maxBarrenWaves: 2, maxScored: 999, maxWaves: 9 }, 2);
  seed(s, 1, [{ score: 2.0 }]);
  seed(s, 2, [{ score: 3.0 }]);
  const d = decideNextAction(s);
  eq(d.action, 'halt', 'the circuit breaker halts a loop that keeps finding nothing');
  check(/circuit breaker/.test(d.reason), 'the halt reason names the circuit breaker');
  eq(d.stats.qualified, 0, 'halting reports the honest qualified count');
}
{
  const s = stateWith({ target: 10, maxScored: 2, maxBarrenWaves: 9, maxWaves: 9 }, 1);
  seed(s, 1, [{ score: 2.0 }, { score: 3.0 }]);
  const d = decideNextAction(s);
  eq(d.action, 'halt', 'the scoring budget halts the loop');
  check(/scoring budget/.test(d.reason), 'the halt reason names the scoring budget');
}
{
  const s = stateWith({ target: 10, maxWaves: 2, maxBarrenWaves: 9, maxScored: 999 }, 2);
  seed(s, 1, [{ score: 4.5 }]);
  seed(s, 2, [{ score: 4.6 }]);
  const d = decideNextAction(s);
  eq(d.action, 'halt', 'the wave budget halts the loop even while it is still finding qualifiers');
  check(/wave budget/.test(d.reason), 'the halt reason names the wave budget');
}
{
  const s = stateWith({ target: 10, maxWaves: 99, maxBarrenWaves: 99, maxScored: 999 }, WAVE_STRATEGIES.length);
  seed(s, WAVE_STRATEGIES.length, [{ score: 4.5 }]);
  const d = decideNextAction(s);
  eq(d.action, 'halt', 'the loop halts once every rung has been run');
  check(/ladder exhausted/.test(d.reason), 'the halt reason names the exhausted ladder');
}
{
  const s = stateWith({ target: 10 }, 1);
  s.phase = 'done';
  eq(decideNextAction(s).action, 'done', 'a finished run stays finished');
}
{
  // The behaviour the whole design exists to guarantee: ending short is correct,
  // reaching target by moving the bar is not. Nothing in the control law writes
  // to config.minScore, so a halted run reports what it actually found.
  const s = stateWith({ target: 10, minScore: 3.8, maxWaves: 1, maxBarrenWaves: 9, maxScored: 999 }, 1);
  seed(s, 1, [{ score: 3.7 }, { score: 3.5 }]);
  const d = decideNextAction(s);
  eq(d.action, 'halt', 'a run that cannot reach target halts');
  eq(d.stats.qualified, 0, 'sub-threshold candidates never count toward target');
  eq(s.config.minScore, 3.8, 'the bar is unchanged after a failed run');
}

// ── State hygiene ───────────────────────────────────────────────────────────

{
  const n = normalizeState(null);
  eq(n.version, LOOP_STATE_VERSION, 'a missing state file yields a fresh state');
  eq(n.waves.length, 0, 'a fresh state has no waves');
}
{
  const n = normalizeState({ candidates: 'corrupt', waves: 'corrupt', phase: 'scanning' });
  check(typeof n.candidates === 'object' && !Array.isArray(n.candidates), 'a corrupt candidates field is replaced, not trusted');
  check(Array.isArray(n.waves), 'a corrupt waves field is replaced with an array');
}

// ── Rendering ───────────────────────────────────────────────────────────────

{
  const s = stateWith({ target: 3, minScore: 3.8 }, 1);
  ingestOffers(s, [
    { url: 'https://e.com/a', company: 'Acme | Evil\nCorp', title: 'AI Engineer', location: 'Berlin' },
    { url: 'https://e.com/b', company: 'Good Co', title: 'MLE', location: 'Remote' },
  ], 1);
  recordScores(s, [
    { key: candidateKey('https://e.com/a'), score: 3.9 },
    { key: candidateKey('https://e.com/b'), score: 4.6 },
  ]);
  s.halted_reason = 'wave budget spent';
  const md = renderShortlist(s, { now: new Date('2026-08-03T12:00:00Z') });

  check(md.includes('4.6/5'), 'the shortlist shows scores');
  check(md.indexOf('4.6/5') < md.indexOf('3.9/5'), 'shortlist rows are ordered best-first');
  check(md.includes('triage'), 'the shortlist says the scores are triage scores, not evaluations');
  check(md.includes('1 of these score below 4.0'), 'sub-4.0 rows carry the Ethical Use advisory');
  check(md.includes('halted'), 'a halted run says so on the review gate');
  check(md.includes('Acme \\| Evil Corp'), 'a pipe in posting text is escaped and the newline stripped');
  check(!md.split('\n').some((l) => l.startsWith('| ') && l.includes('Evil') && !l.includes('Acme')), 'untrusted text cannot forge an extra table row');
  check(/pipeline/.test(md), 'the review gate points at the next command rather than running it');
}
{
  const md = renderShortlist(stateWith({}, 1));
  check(md.includes('No candidate cleared the bar'), 'an empty shortlist says so plainly');
}
{
  const s = stateWith({ target: 5 }, 1);
  seed(s, 1, [{ score: 4.2 }]);
  const line = renderRunLogEntry(s, 'wave', 'portals');
  check(line.startsWith('- '), 'the run log entry is a markdown list item');
  check(line.includes('qualified=1/5'), 'the run log records progress against target');
  check(line.includes('portals'), 'the run log records the detail it was given');
}
