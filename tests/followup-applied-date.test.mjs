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

// ── a sentence terminator followed by a segment separator is still a break ───
// `.;` is the single strongest boundary this Notes column produces: a sentence
// ending exactly where set-status.mjs appends the next note segment. The scope
// test required WHITESPACE after the terminator, so the `;` hid it and the
// preceding row reference was judged still in scope.
//
// Live consequence on 2026-08-19: row 16's notes end "...the shared MHI parent
// with row #3.; Applied 2026-08-18, confirmed by...". The row's own apply date
// was discarded, the evaluation date (2026-08-07) was used instead, and the
// cadence reported 12 days since application for a row applied the day before.
// A cadence-driven follow-up would have emailed Primetals hours after their
// acknowledgement arrived.
for (const [label, notes, want] of [
  ['a period followed by a semicolon ends the reference scope',
   'Do not mention the shared MHI parent with row #3.; Applied 2026-08-18, confirmed.', '2026-08-18'],
  ['a period followed by a pipe ends it too',
   'Compare with row #3.| Applied 2026-08-18', '2026-08-18'],
  ['a plain sentence break still works',
   'Check row #3. Applied 2026-08-18 by email.', '2026-08-18'],
  // The guards this must not weaken: without a terminator, a cited row still
  // owns the date that follows it.
  ['a cited row with no terminator still owns the following date',
   '#154 applied 2026-08-04', null],
  ['a semicolon alone does not end an undated citation',
   '#154 is already live; applied 2026-08-04', null],
  ['a citation that already has its own date yields the later own date',
   '#154 Sr PM (applied 2026-08-04); applied 2026-06-15', '2026-06-15'],
]) {
  const got = parseAppliedDate(notes);
  if (got === want) pass(label);
  else fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
