// tests/gmail-sweep-req-id.test.mjs
//
// Every ATS rejection quotes the requisition it is about; the tracker row
// carries the same id in its URL and notes. The fuzzy company+role matcher sees
// none of it, so a Siemens rejection for req 516786 matched a DIFFERENT Siemens
// row (#77, Climate Data & Analytics) at "high" confidence while #115 — whose
// notes read "Job ID 516786" — was never considered, and a Siemens Energy
// rejection for 301278 matched nothing at all.
//
// merge-tracker.mjs already treats a req ID as decisive for exactly this reason
// (AGENTS.md, #1524/#2009). These pin the same rule for inbound mail, and the
// tiering that keeps a passing mention from outranking the real owner.
import { pass, fail } from './helpers.mjs';
import { extractReqIds, resolveByReqId } from '../gmail-sweep.mjs';

console.log('\ngmail-sweep — a quoted requisition id outranks the fuzzy guess');

// ── Extraction ──────────────────────────────────────────────────────────────
const has = (t, id) => extractReqIds(t).has(id);

has('apply for the role of Working Student (f/m/d) Simulation for Physical AI (516786) at Siemens', '516786')
  ? pass('a req number in parentheses is extracted')
  : fail('parenthesised req number missed');

has('ZEISS | Your application | Internship Machine Learning | JR_1047706', '1047706')
  ? pass('a JR_-prefixed id is extracted')
  : fail('JR_ id missed');

has('req JR-10423 is open', 'JR10423')
  ? pass('a labelled hyphenated id is normalised')
  : fail(`labelled id missed: ${[...extractReqIds('req JR-10423 is open')]}`);

// German postcodes are five digits and appear in every signature block. A bare
// run must be six or more or Erlangen's 91058 becomes a requisition id.
extractReqIds('Am Weichselgarten 30a, 91058 Erlangen').size === 0
  ? pass('a five-digit postcode is not mistaken for a requisition')
  : fail(`postcode extracted as req id: ${[...extractReqIds('Am Weichselgarten 30a, 91058 Erlangen')]}`);

extractReqIds('').size === 0 && extractReqIds(null).size === 0 && extractReqIds(undefined).size === 0
  ? pass('empty and nullish input yield no ids')
  : fail('empty input produced ids');

// ── Resolution and tiering ──────────────────────────────────────────────────
const APPS = [
  { num: 77, company: 'Siemens AG', role: 'Working Student Climate Data & Analytics', notes: 'Applied 2026-08-12.', raw: '| 77 | Siemens AG | https://jobs.siemens.com/en_US/externaljobs/JobDetail/511111 |' },
  { num: 115, company: 'Siemens AG', role: 'Working Student Simulation for Physical AI', notes: 'Job ID 516786, posted 17-Aug-2026.', raw: '| 115 | Siemens AG | https://jobs.siemens.com/en_US/externaljobs/JobDetail/516786 |' },
  // The contaminating row: prose that MENTIONS other rows' requisitions.
  { num: 85, company: 'Sana HR Solutions GmbH', role: 'Werkstudent Data Engineer', notes: 'Every other application that evening (Siemens 516786, Siemens Energy 301278, Thieme, Trench) produced a genuine acknowledgement; this one did not.', raw: '| 85 | Sana | https://www.stepstone.de/x--14405387.html |' },
];
const msg = { subject: 'An update on your recent Siemens application', body_snippet: 'the role of Working Student (f/m/d) Simulation for Physical AI (516786) at Siemens' };

{
  const got = resolveByReqId(msg, APPS, 77);
  got && got.num === 115
    ? pass('the rejection is re-pointed from the wrong Siemens row to the one holding the req')
    : fail(`resolved to ${got ? got.num : null}, expected 115`);
}

{
  // The whole point of the tiering: #85 mentions 516786 in prose and must lose
  // to #115, which carries it in its URL.
  const got = resolveByReqId(msg, APPS, null);
  got && got.num === 115
    ? pass('a passing mention in another row\'s notes does not outrank the row that owns the id')
    : fail(`prose mention won: resolved to ${got ? got.num : null}`);
}

{
  // Already correct — nothing to re-point, so no churn.
  resolveByReqId(msg, APPS, 115) === null
    ? pass('a match that is already right is left alone')
    : fail('re-pointed a correct match');
}

{
  // No id in the message: the fuzzy result must stand untouched.
  resolveByReqId({ subject: 'Wir bedanken uns!', body_snippet: 'Vielen Dank für Ihre Bewerbung.' }, APPS, null) === null
    ? pass('a message quoting no requisition changes nothing')
    : fail('resolved a message with no req id');
}

{
  // Genuinely ambiguous at the top tier — two rows own the same id in their
  // URLs (a re-application). Conservative: change nothing.
  const dupes = [
    { num: 12, company: 'ZEISS', role: 'Internship ML', notes: '', raw: '| 12 | ZEISS | https://zeissgroup.wd3.myworkdayjobs.com/JR_1047706 |' },
    { num: 43, company: 'ZEISS', role: 'Internship Machine Learning', notes: '', raw: '| 43 | ZEISS | https://zeissgroup.wd3.myworkdayjobs.com/JR_1047706 |' },
  ];
  resolveByReqId({ subject: 'ZEISS | JR_1047706', body_snippet: '' }, dupes, null) === null
    ? pass('an id held equally by two rows resolves to nothing rather than guessing')
    : fail('guessed between two equally-ranked rows');
}
