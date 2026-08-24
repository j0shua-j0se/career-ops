// tests/followup-draft.test.mjs
//
// followup-draft.mjs automates the retrieval and bookkeeping around a follow-up
// and deliberately stops short of writing the angle. These pin the two things
// that made the first version produce unsendable output.
import { pass, fail } from './helpers.mjs';
import { extractStrengths, isUnreplyable, toSentence, buildDraft, BANNED_OPENERS } from '../followup-draft.mjs';

console.log('\nfollowup-draft.mjs');

// ── Unreplyable addresses ───────────────────────────────────────────────────
// The most common contact on a row is the ATS receipt address, and it is
// exactly the one a follow-up must never go to. Observed live: Craftview's
// noreply@hrworks.de and Primetals' donotreply@mssa.com.
for (const [addr, want] of [
  ['donotreply@mssa.com', true],
  ['noreply@hrworks.de', true],
  ['no-reply@ashbyhq.com', true],
  ['do-not-reply@example.com', true],
  ['dlrdeutsch-jobnotification@noreply12.jobs2web.com', true],
  ['careers@moresophy.com', false],
  ['patrick.ziegler@faps.fau.de', false],
  ['wolfgang.maussner@siemens.com', false],
  // Guard: a real person whose name merely contains the letters must survive.
  ['normanreply@example.com', false],
  ['', false],
]) {
  isUnreplyable(addr) === want
    ? pass(`isUnreplyable(${JSON.stringify(addr)}) === ${want}`)
    : fail(`isUnreplyable(${JSON.stringify(addr)}) returned ${!want}`);
}

// ── Strength extraction, both report formats ────────────────────────────────
{
  const modern = [
    'top_strengths:',
    '  - "Erlangen — the home market. Location scores 5.0."',
    '  - "Python is named as advantageous and is evidenced."',
    'risk_level: "Medium"',
  ].join('\n');
  const got = extractStrengths(modern);
  got.length === 2 && got[0].startsWith('Erlangen')
    ? pass('extractStrengths reads a top_strengths: block')
    : fail(`modern format returned ${JSON.stringify(got)}`);
}

{
  // 30 of 100 reports predate top_strengths: and carry a CV Match table. Without
  // the fallback a third of the pipeline drafted with no candidate angles.
  const legacy = [
    '## B) CV Match',
    '',
    '| JD requirement | CV evidence | Verdict |',
    '|---|---|---|',
    '| Enrolled student | MSc Data Science, FAU | ✅ |',
    '| Python | Python across four roles | ✅ Direct |',
    '| Kubernetes | Not evidenced | ⚠️ Gap |',
    '',
    '## C) Level and Strategy',
  ].join('\n');
  const got = extractStrengths(legacy);
  got.length === 2 && got.includes('Python across four roles')
    ? pass('extractStrengths falls back to the CV Match table')
    : fail(`legacy format returned ${JSON.stringify(got)}`);
  !got.some(g => /Not evidenced/.test(g))
    ? pass('the fallback takes only the ticked rows, not the gaps')
    : fail('a ⚠️ gap row leaked into the candidate angles');
}

extractStrengths('no structure at all').length === 0
  ? pass('a report with neither format yields no angles rather than inventing one')
  : fail('extractStrengths invented evidence');

// ── The draft itself ────────────────────────────────────────────────────────
{
  const entry = {
    num: 10, company: 'MORESOPHY GmbH', role: 'Working Student ML & AI',
    appliedDate: '2026-08-05', daysSinceApplication: 14, followupCount: 1,
    urgency: 'overdue', appDateSource: 'notes',
    contacts: [{ email: 'donotreply@mssa.com' }, { email: 'careers@moresophy.com' }],
  };
  const d = buildDraft(entry, ['Python is the core skill. Everything else follows.']);

  d.contact === 'careers@moresophy.com'
    ? pass('buildDraft skips the unreplyable address and picks the real one')
    : fail(`buildDraft chose ${d.contact}`);
  d.rejected.includes('donotreply@mssa.com')
    ? pass('the rejected address is reported rather than silently dropped')
    : fail('rejected addresses were not surfaced');

  // The angle must NOT be auto-written: pasting report evidence produced
  // "MSc Data Science, FAU, Apr 2026 - Aug 2028 Within max_hours_per_week: 20".
  /\[ANGLE/.test(d.body)
    ? pass('the body leaves a marked ANGLE placeholder instead of faking prose')
    : fail('the draft auto-wrote an angle');
  !d.body.includes('Python is the core skill')
    ? pass('candidate evidence is not pasted into the letter body')
    : fail('report evidence leaked into the body verbatim');
  d.candidates.includes('Python is the core skill.')
    ? pass('candidate angles are offered separately for a human to choose')
    : fail(`candidates were ${JSON.stringify(d.candidates)}`);
  d.violations.length === 0
    ? pass('the stock body trips none of the banned openers')
    : fail(`stock body contains a banned opener: ${d.violations}`);
}

// toSentence keeps the claim and drops the justification.
toSentence('Erlangen is home. It scores 5.0 because the commute is 20 minutes.') === 'Erlangen is home.'
  ? pass('toSentence keeps the first sentence only')
  : fail('toSentence did not trim to the first sentence');

BANNED_OPENERS.length === 4
  ? pass('all four banned openers from modes/followup.md are enforced')
  : fail(`expected 4 banned openers, got ${BANNED_OPENERS.length}`);

// ── ATS platform domains and the candidate's own address ────────────────────
// Both surfaced on real rows while drafting the 2026-08-24 batch, and neither
// announced itself: the draft looked finished and the recipient line looked
// plausible.
import { isOwnAddress } from '../followup-draft.mjs';

for (const [addr, want] of [
  // ZEISS's acknowledgement comes from a Workday address whose local part is
  // the company name — it trips none of the noreply rules and is still a
  // platform mailbox.
  ['zeissgroup@myworkday.com', true],
  ['system@successfactors.eu', true],
  ['NoreplyTrenchRecruiting@csod.com', true],
  ['recruiting@avature.net', true],
  ['someone@boards.greenhouse.io', true],
  // A human at a real employer must survive all of it.
  ['patrick.ziegler@faps.fau.de', false],
  ['wolfgang.maussner@siemens.com', false],
  ['students.func@siemens-healthineers.com', false],
  ['personal@arf-gmbh.de', false],
]) {
  isUnreplyable(addr) === want
    ? pass(`ATS-domain check: ${JSON.stringify(addr)} → ${want}`)
    : fail(`ATS-domain check failed for ${JSON.stringify(addr)}`);
}

// The candidate's own address is assembled into contact lists from the mail
// around an application. DLR's row resolved to it, so the draft was addressed
// to the sender — a follow-up mailed to yourself.
isOwnAddress('joshuajoseprofessional@gmail.com')
  ? pass("the candidate's own address is recognised")
  : fail("own address not recognised");
isOwnAddress('JoshuaJoseProfessional@Gmail.com')
  ? pass('own-address matching is case-insensitive')
  : fail('own-address matching is case-sensitive');
!isOwnAddress('patrick.ziegler@faps.fau.de')
  ? pass('a third-party address is not treated as the candidate’s own')
  : fail('a third-party address was treated as own');

{
  const entry = {
    num: 23, company: 'DLR', role: 'Working student ML',
    appliedDate: '2026-08-10', daysSinceApplication: 14, followupCount: 0,
    urgency: 'overdue', appDateSource: 'notes',
    contacts: [{ email: 'joshuajoseprofessional@gmail.com' }, { email: 'zeissgroup@myworkday.com' }],
  };
  const d = buildDraft(entry, []);
  d.contact === null
    ? pass('a row whose only contacts are own/ATS yields NO recipient rather than a bad one')
    : fail(`buildDraft offered ${d.contact}`);
  d.rejected.length === 2
    ? pass('both rejected addresses are reported so the reason is visible')
    : fail(`rejected list was ${JSON.stringify(d.rejected)}`);
}
