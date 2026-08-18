// tests/req-cross-reference.test.mjs — extractReqNumber ignores cross-references.
//
// The Notes cell is free text, and rows legitimately point at each other:
// "See also row #16 (Job ID 7716), a second Primetals requisition" is exactly
// the disambiguation AGENTS.md asks for. First-match scanning read the cited
// number as the row's OWN req — tracker row 5 (Primetals, Künstliche
// Intelligenz) resolved to 7716, which belongs to row 16 (DevOps/MLOps), while
// row 5 never states its own.
//
// The failure mode is quiet by construction. The sibling-req guard in
// merge-tracker.mjs only fires on DISAGREEMENT, so a wrongly-inherited number
// cannot create a false split; it removes a true one, letting two genuinely
// distinct same-company postings fall back to fuzzy title matching — which is
// the exact collapse the req number exists to prevent (#1524).
//
// Auto-discovered by test-all.mjs — never exit the process here.
import { pass, fail } from './helpers.mjs';
import { extractReqNumber } from '../merge-tracker.mjs';

console.log('\nmerge-tracker.mjs — req number vs. row cross-references');

const cases = [
  ['a row reference plus its parenthetical is ignored',
   'PyTorch may be used freely. See also row #16 (Job ID 7716), a second Primetals requisition.', null],
  ['a cross-reference with no cue phrase is still ignored',
   'Applies to the KI requisition only - row 16 (Job ID 7716, DevOps/MLOps) is a separate req.', null],
  ['the row\'s own req still wins when stated first',
   'Job ID 7716 - distinct requisition from row #5 (same employer, applied 2026-08-05)', '7716'],
  ['the row\'s own req survives a leading cross-reference',
   'row 11 (req 456991) is a separate opening; this one is req 457327', '457327'],
  // Note the expected value is '2291', not 'R_2291': REQ_NUMBER_RE lists `r_`
  // among its label prefixes, so an `R_`-style id is normalized to its numeric
  // part. That is pre-existing behaviour and harmless for comparison (both
  // sides normalize identically) — asserted here so a future change to the
  // shared regex is caught rather than absorbed.
  ['a parenthetical naming a row is ignored',
   'Werkstudent AI (see row #3 for the sibling posting, req 99999); req R_2291', '2291'],
  ['an ordinary note is untouched', 'Req JR-10423, Munich, hybrid', 'JR-10423'],
  ['job id form still parses', 'job id 88214 confirmed by recruiter', '88214'],
  ['no requisition anywhere', 'Great fit. Erlangen. 20h/week.', null],
  ['empty notes', '', null],
];

for (const [label, notes, want] of cases) {
  const got = extractReqNumber(notes);
  if (got === want) pass(label);
  else fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// A parenthetical that merely contains a number must NOT be mistaken for a row
// reference — only an explicit "row N" qualifies.
const keeps = extractReqNumber('Munich office (2026 intake); req 12345');
if (keeps === '12345') pass('a parenthetical without a row reference does not suppress the req');
else fail(`unrelated parenthetical suppressed the req: ${JSON.stringify(keeps)}`);
