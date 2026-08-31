// tests/deadline-sweep.test.mjs
//
// The sweep retires postings by a date already on disk, so it costs nothing.
// That is only acceptable if it can never retire a job on a date nobody set:
// a missing deadline and an unparseable one must both mean "leave it alone".
import { pass, fail } from './helpers.mjs';
import { sweep, parseIsoDate, daysUntil, extractDeadline } from '../deadline-sweep.mjs';

console.log('\ndeadline-sweep — retire on a recorded date, never on a guess');

const TODAY = parseIsoDate('2026-08-31');

// ── Date parsing is strict on purpose ───────────────────────────────────────
parseIsoDate('2026-08-31') ? pass('a real ISO date parses') : fail('ISO date rejected');
for (const bad of ['ASAP', 'laufend', '31.12.2026', '2026-13-01', '2026-02-30', '', null, 'fortlaufend']) {
  parseIsoDate(bad) === null
    ? pass(`${JSON.stringify(bad)} is refused, not reinterpreted`)
    : fail(`${JSON.stringify(bad)} parsed to a date`);
}

daysUntil(parseIsoDate('2026-09-07'), TODAY) === 7 ? pass('daysUntil counts forward') : fail('daysUntil forward wrong');
daysUntil(parseIsoDate('2026-08-24'), TODAY) === -7 ? pass('daysUntil goes negative once past') : fail('daysUntil past wrong');

// ── Extraction from a Machine Summary ───────────────────────────────────────
const summary = (body) => `# R\n\n## Machine Summary\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
extractDeadline(summary('score: 4.2\ndeadline: "2026-09-15"')) === '2026-09-15'
  ? pass('a quoted deadline is extracted') : fail('quoted deadline missed');
extractDeadline(summary('deadline: 2026-09-15')) === '2026-09-15'
  ? pass('an unquoted deadline is extracted') : fail('unquoted deadline missed');
extractDeadline(summary('deadline: null')) === null
  ? pass('an explicit null means "the posting states no deadline"') : fail('null deadline mishandled');
extractDeadline(summary('score: 4.2')) === undefined
  ? pass('a report with no deadline key returns undefined, distinct from null') : fail('missing key not undefined');
extractDeadline('no machine summary here') === undefined
  ? pass('a report with no Machine Summary returns undefined') : fail('missing summary not undefined');

// ── The sweep itself ────────────────────────────────────────────────────────
const rows = [
  { num: 1, company: 'Past', role: 'r', status: 'Applied', report: '1' },
  { num: 2, company: 'Soon', role: 'r', status: 'Evaluated', report: '2' },
  { num: 3, company: 'Later', role: 'r', status: 'Applied', report: '3' },
  { num: 4, company: 'NoKey', role: 'r', status: 'Applied', report: '4' },
  { num: 5, company: 'StatedNone', role: 'r', status: 'Applied', report: '5' },
  { num: 6, company: 'Junk', role: 'r', status: 'Applied', report: '6' },
  { num: 7, company: 'AlreadyClosed', role: 'r', status: 'Rejected', report: '7' },
];
const deadlines = new Map([
  ['1', '2026-08-20'], ['2', '2026-09-03'], ['3', '2026-12-01'],
  ['5', null], ['6', 'ASAP'], ['7', '2026-08-01'],
]);
const r = sweep({ rows, deadlinesByReport: deadlines, today: TODAY, soonDays: 7 });

r.expired.length === 1 && r.expired[0].num === 1
  ? pass('a past deadline on an open row is flagged expired')
  : fail(`expired = ${JSON.stringify(r.expired.map((x) => x.num))}`);

r.soon.length === 1 && r.soon[0].num === 2
  ? pass('a deadline inside the window is flagged closing soon')
  : fail(`soon = ${JSON.stringify(r.soon.map((x) => x.num))}`);

r.ok.length === 1 && r.ok[0].num === 3
  ? pass('a distant deadline is left alone') : fail(`ok = ${JSON.stringify(r.ok.map((x) => x.num))}`);

// The two rules that make automating this acceptable at all.
!r.expired.some((x) => x.num === 4) && !r.soon.some((x) => x.num === 4)
  ? pass('a row whose report records NO deadline is never retired')
  : fail('a row with no recorded deadline was acted on');

!r.expired.some((x) => x.num === 5)
  ? pass('a posting that states it has no deadline is never retired')
  : fail('an explicit null deadline was acted on');

r.unparseable.length === 1 && r.unparseable[0].num === 6
  ? pass('an unusable value ("ASAP") is reported with its report number, never compared')
  : fail(`unparseable = ${JSON.stringify(r.unparseable)}`);
!r.expired.some((x) => x.num === 6)
  ? pass('and it is not retired on the strength of a value nobody could read')
  : fail('unparseable deadline retired a row');

!r.expired.some((x) => x.num === 7)
  ? pass('a row already in a closed state is not this sweep\'s business')
  : fail('a terminal row was swept');
