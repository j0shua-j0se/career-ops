// tests/followup-applied-date.test.mjs — parseAppliedDate segment anchoring.
//
// A tracker Notes cell is free text that accumulates by append. It can easily
// mention a date belonging to ANOTHER row: row 16's notes said "distinct
// requisition from row #5 (same employer, applied 2026-08-05 at 4.6)" while
// row 16's own application went out on 2026-08-18. First-match-wins picked the
// parenthetical, and followup-seed pinned a follow-up six days in the past —
// which followup-cadence then rendered as OVERDUE the moment it was written.
//
// The fix anchors matches to segment starts without reversing match order,
// because first-match-wins is load-bearing elsewhere (merge-tracker.mjs keeps
// existing notes first so a re-evaluation cannot take over an apply date).
//
// NOTE: no process.exit() — test-all.mjs runs discovered suites in-process.
import { pass, fail } from './helpers.mjs';
import { parseAppliedDate } from '../followup-cadence.mjs';

console.log('\nUtility - parseAppliedDate (segment anchoring)');

const cases = [
  ['the row-16 regression: a parenthetical about another row loses to the real date',
   'Job ID 7716 - distinct requisition from row #5 (same employer, applied 2026-08-05 at 4.6). Best logistics; Applied 2026-08-18 by email',
   '2026-08-18'],
  ['a leading "Applied YYYY-MM-DD" still wins',
   'Applied 2026-06-09 via Personio; raised part-time', '2026-06-09'],
  ['case-insensitive', 'APPLIED 2026-06-17 (German CV; jobId=104170)', '2026-06-17'],
  ['first-match-wins is preserved: a later discard date does not take over',
   'Applied 2026-06-09. No response; discarded 2026-06-18.', '2026-06-09'],
  ['a purely mid-prose mention still parses when nothing is anchored',
   'see below applied 2026-05-01 per recruiter', '2026-05-01'],
  ['a segment opened after a semicolon counts',
   'Evaluated 4.2; Applied 2026-07-04 by email', '2026-07-04'],
  ['no date at all returns null', 'no dates here', null],
  ['empty notes return null', '', null],
];

for (const [label, notes, want] of cases) {
  const got = parseAppliedDate(notes);
  if (got === want) pass(label);
  else fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// An impossible calendar date must still be rejected under validation.
const bad = parseAppliedDate('Applied 2026-02-31 by email', { requireValidCalendarDate: true });
if (bad === null) pass('an impossible calendar date is rejected under requireValidCalendarDate');
else fail(`impossible date returned ${JSON.stringify(bad)}`);

// ── cross-reference clauses are stripped, matching extractReqNumber ──────────
// A Notes cell that names another row must not donate its dates. merge-tracker
// hit this first (row 5 inheriting row 16's req number); the same stripper is
// now shared via tracker-parse.mjs so the two scanners cannot drift.
for (const [label, notes, want] of [
  ['a parenthesised row reference does not donate its date',
   'Row 5 (applied 2026-08-05). Applied 2026-08-18 by email', '2026-08-18'],
  ['a cross-reference opening a segment is still stripped',
   '. row 16 (Applied 2026-08-05); Applied 2026-08-18', '2026-08-18'],
]) {
  const got = parseAppliedDate(notes);
  if (got === want) pass(label);
  else fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
