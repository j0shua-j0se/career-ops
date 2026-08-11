// tests/blocker-classification.test.mjs — blockerAnalysis must classify the
// blockers this pipeline actually records.
//
// Two defects made the analysis useless rather than merely imprecise:
//
//  1. Machine Summaries write `blockers:`/`gaps:`, but the field allowlist and
//     the readers only knew `hard_stops:`/`soft_gaps:` — so 30 of 32 reports
//     contributed nothing and blockerAnalysis, techStackGaps and the whole
//     `upskill` gap map came back EMPTY. An empty array reads as "no blockers
//     found", which is indistinguishable from "nothing was ever parsed".
//
//  2. Once the data flowed, `other` took 51 of 58 entries, because follow-up
//     actions ("ask-…", "confirm-…") were counted as blockers and the market's
//     dominant blocker — a German-language requirement — had no category at all.
import { pass, fail } from './helpers.mjs';
import { extractBlockerType } from '../analyze-patterns.mjs';

console.log('\nBlocker classification');

const hard = (description) => extractBlockerType({ description, severity: 'hard stop' });

// --- Language. The single most common reason a technically-strong candidate is
// closed out of this market, and it used to land in `other`.
for (const [desc, label] of [
  ['business-fluent-german-at-a2', 'German at A2'],
  ['fliessend-deutsch-und-englisch-at-a2', 'fließend Deutsch'],
  ['verhandlungssicher-deutsch-required', 'verhandlungssicher'],
  ['sehr-gute-deutschkenntnisse', 'sehr gute Deutschkenntnisse'],
  ['team-working-language-is-german-only', 'working language'],
]) {
  hard(desc) === 'language-requirement'
    ? pass(`${label} -> language-requirement`)
    : fail(`"${desc}" classified ${hard(desc)}, expected language-requirement`);
}

// --- Distance is written with a km figure and a city, matching none of the
// original geo vocabulary.
hard('berlin-430km-not-full-remote') === 'distance'
  ? pass('"berlin-430km-not-full-remote" -> distance')
  : fail(`distance misclassified as ${hard('berlin-430km-not-full-remote')}`);

// --- Hours and contract shape: a 20 h/week cap against a full-time contract is
// a hard stop for a working student and recurs across the tracker.
hard('full-time-40h-contract-against-20h-student-cap') === 'hours-or-contract'
  ? pass('full-time contract against the student cap -> hours-or-contract')
  : fail(`hours/contract misclassified as ${hard('full-time-40h-contract-against-20h-student-cap')}`);

// "clarify-werkstudent-vs-fulltime-…" reads as an hours blocker but is prefixed
// with an action verb, so it is a to-do. The action guard is checked first and
// must win — otherwise every "confirm the hours" note inflates a blocker count.
hard('clarify-werkstudent-vs-fulltime-permanent-contradiction') === null
  ? pass('an action-prefixed hours note is a to-do, not an hours blocker')
  : fail('the action-item guard lost to the hours-or-contract rule');

hard('five-years-frontend-professional-experience') === 'seniority-mismatch'
  ? pass('"five years professional experience" -> seniority-mismatch')
  : fail(`seniority misclassified as ${hard('five-years-frontend-professional-experience')}`);

hard('us-residency-required') === 'geo-restriction'
  ? pass('"us-residency-required" -> geo-restriction')
  : fail('geo-restriction regressed');

hard('five-onsite-days-in-freiburg-office') === 'onsite-requirement'
  ? pass('onsite requirement still classified')
  : fail('onsite-requirement regressed');

// --- Follow-up actions are NOT blockers. They are things for the user to do,
// and counting them made `other` the largest category by far.
for (const desc of [
  'ask-weekly-hours',
  'confirm-hourly-rate-at-or-above-14-eur',
  'clarify-german-requirement-via-applicant-hotline',
  'check-row-5-status-before-opening-a-parallel-application',
  'assemble-transcript-enrolment-certificate-and-references',
  'do-not-mention-the-shared-parent-company',
  'correct-tracker-row-5-note',
]) {
  hard(desc) === null
    ? pass(`"${desc.slice(0, 34)}…" is a to-do, not a blocker`)
    : fail(`action item "${desc}" counted as blocker ${hard(desc)}`);
}

// A real blocker whose text merely CONTAINS an action word must still count —
// the guard is anchored to the start, so it cannot swallow these.
hard('german-b2-required-confirm-nothing') === 'language-requirement'
  ? pass('the action-item guard is anchored and does not swallow real blockers')
  : fail('anchoring failed: a real blocker was dropped as an action item');

// --- Soft gaps stay excluded from blocker analysis.
extractBlockerType({ description: 'business-fluent-german-at-a2', severity: 'soft gap' }) === null
  ? pass('soft gaps are excluded from blocker analysis')
  : fail('a soft gap was counted as a blocker');

// --- Unrecognized text still falls through to `other` rather than vanishing.
hard('discipline-entirely-absent-from-cv') === 'other'
  ? pass('an unrecognized blocker falls through to "other" rather than being dropped')
  : fail('unrecognized blocker was dropped instead of bucketed as other');
