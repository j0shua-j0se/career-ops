// tests/language-loss.test.mjs
//
// The first version of this classifier scraped report PROSE for phrases like
// "sehr gute Deutschkenntnisse". Every match it produced was a false positive,
// because an evaluation quotes sibling postings — and the profile rule itself —
// as often as it states its own requirement.
//
// It condemned report #134, whose own gate is OPEN ("Deutschkenntnisse sind von
// Vorteil"), on a sentence describing DIFFERENT requisitions. A build gate wired
// to it blocked the highest-scoring role in the pipeline (4.5).
//
// The lesson is pinned here: prose is not a field.
import { pass, fail } from './helpers.mjs';
import { classifyLanguage, reportScore, analyse } from '../language-loss.mjs';

console.log('\nlanguage-loss — read the field, never the prose');

const withSummary = (body) => `# Evaluation\n\n## Machine Summary\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;

// ── The structured field is the only signal ─────────────────────────────────
classifyLanguage(withSummary('score: 4.2\nlanguage_gate: "FAIL"\nlanguage_note: "sehr gute Deutschkenntnisse"')).tier === 'hard_stop'
  ? pass('language_gate: FAIL reads as a hard stop') : fail('FAIL not read as hard stop');
classifyLanguage(withSummary('language_gate: FLAG')).tier === 'penalty'
  ? pass('language_gate: FLAG reads as the penalty tier') : fail('FLAG not read as penalty');
classifyLanguage(withSummary('language_gate: PASS')).tier === 'none'
  ? pass('language_gate: PASS reads as clear') : fail('PASS not read as clear');

// ── Absence is UNKNOWN, never "clear" ───────────────────────────────────────
classifyLanguage(withSummary('score: 4.2')).tier === 'unknown'
  ? pass('a report without the field is unknown, not clear')
  : fail('missing field was treated as clear');
classifyLanguage('no machine summary at all').tier === 'unknown'
  ? pass('a report with no Machine Summary is unknown') : fail('missing summary mishandled');
classifyLanguage('').tier === 'unknown' && classifyLanguage(null).tier === 'unknown'
  ? pass('empty and nullish input are unknown') : fail('empty input mishandled');

// ── The false positives that caused the rewrite ─────────────────────────────
// Each of these is real report text. None may produce a hard stop.
const REAL_PROSE = [
  ['#134 quotes its own OPEN gate, then a sibling that demands the opposite',
   "'Du bringst sehr gute Englischkenntnisse mit, Deutschkenntnisse sind von Vorteil.' This is the exact inverse of sibling postings at Siemens Mobility, which demand sehr gute Deutschkenntnisse."],
  ['#90 contrasts itself AGAINST requisitions that demand it',
   'But against the four Siemens requisitions in the same scan wave that all demand "sehr gute Deutschkenntnisse", this is the difference between a live application and a dead one.'],
  ['#43 quotes the profile.yml RULE, not the posting',
   'Per config/profile.yml (A2 cannot carry a "verhandlungssicheres Deutsch"/C1/C2 requirement), this posting does not state one.'],
  ['#64 states explicitly that it is the penalty tier',
   "roughly B2, not the hard_stop tier reserved for 'sehr gute Deutschkenntnisse' / 'verhandlungssicher' / C1-C2."],
  ['#8 lists OTHER companies that demand C1',
   'Screen: Schaeffler, Finanztip and Siemens Healthineers all demand C1 or "sehr gute Deutschkenntnisse".'],
];
for (const [label, prose] of REAL_PROSE) {
  classifyLanguage(prose).tier === 'unknown'
    ? pass(`no verdict from prose — ${label}`)
    : fail(`PROSE PRODUCED A VERDICT: ${label}`);
}

// Even inside a Machine Summary, prose fields must not trigger it: only the
// language_gate key counts.
classifyLanguage(withSummary('top_strengths:\n  - "siblings demand sehr gute Deutschkenntnisse"')).tier === 'unknown'
  ? pass('a German phrase in another summary field is still not a verdict')
  : fail('a non-language_gate field produced a verdict');

// ── Score extraction ────────────────────────────────────────────────────────
reportScore(withSummary('score: 4.5')) === 4.5 ? pass('score reads from the Machine Summary') : fail('score not read');
reportScore('**Score:** 3.8/5') === 3.8 ? pass('score falls back to the header') : fail('header score not read');
reportScore('nothing here') === null ? pass('an absent score is null, never zero') : fail('absent score not null');

// ── The roll-up separates unknown from clear ────────────────────────────────
{
  const r = analyse([
    { num: '1', text: withSummary('score: 4.2\nlanguage_gate: FAIL'), status: 'SKIP', company: 'A' },
    { num: '2', text: withSummary('score: 4.0'), status: 'Applied', company: 'B' },
    { num: '3', text: withSummary('score: 4.1\nlanguage_gate: PASS'), status: 'Applied', company: 'C' },
  ]);
  r.hardStop.length === 1 && r.clear === 1 && r.unknown === 1
    ? pass('the roll-up counts unknown separately from clear')
    : fail(`roll-up wrong: ${JSON.stringify({ h: r.hardStop.length, c: r.clear, u: r.unknown })}`);
  r.lostAbovePursueFloor.length === 1
    ? pass('a hard stop above the pursue floor is surfaced as a real loss')
    : fail('pursue-floor loss not surfaced');
}
