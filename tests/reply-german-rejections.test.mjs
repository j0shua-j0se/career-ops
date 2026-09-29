// tests/reply-german-rejections.test.mjs — German rejections and sender-domain row matching.
//
// Observed live 2026-09-29: `gmail-sweep.mjs plan` returned type "Unknown",
// confidence low, skipReason "no tracker row matched this sender" for two
// unambiguous German rejections — ADAC (formal "Sie") and DATEV (informal "Du") —
// so both rows sat at Applied. Two independent halves failed, and each is pinned
// here on the real mail text:
//
//   1. classifyReply() knew no German rejection phrasing at all.
//   2. matchCandidates() could only reach a row through a company name in the
//      mail text or an address already in the row's notes. It ignored that
//      adac.de / datev.de ARE the company, and never read the tracker's URL cell.
//
// The negative cases matter more than the positives. A row wrongly moved to
// Rejected is terminal — TERMINAL_STATES means the sweep never reopens it — so
// every phrase is pinned next to the boilerplate it must not swallow.
//
// Auto-discovered by test-all.mjs: runs in-process, shares its counters, and
// must never terminate the process.

import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { pass, fail, rmSync, ROOT, NODE } from './helpers.mjs';
import {
  classifyReply, matchCandidates, matchGermanRejection, domainNameMatchKind, registrableDomain,
  stripGenericLocalParts, roleOverlapBonus, getAppDomains,
} from '../reply-matcher.mjs';
import { buildPlan, toCandidate, extractReqIds, resolveByReqId, screenTransition } from '../gmail-sweep.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

console.log('\n🇩🇪 reply-matcher.mjs — German rejections + sender-domain matching');

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
const eq = (actual, expected, msg) => check(
  Object.is(actual, expected),
  Object.is(actual, expected) ? msg : `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
);

// ── The real mail, verbatim ─────────────────────────────────────────────────

const ADAC_REJECTION = {
  id: 'adac-rejection',
  from: 'bewerbung@adac.de',
  subject: 'Ihre Bewerbung vom 24.09.2026, Werkstudent Data & AI Solutions (w|m|d) (ID: 16758)',
  body: 'Guten Tag Joshua Jose, noch einmal herzlichen Dank für Ihre Bewerbung und Ihr Interesse an der ausgeschriebenen Stelle: Werkstudent Data & AI Solutions (w|m|d) (Stellenkennziffer: 16758). Ihre Unterlagen wurden von uns sorgfältig geprüft. Leider müssen wir Ihnen mitteilen, dass wir Sie für die ausgeschriebene Position nicht berücksichtigen können. Die Tatsache, dass wir uns nicht für Sie entschieden haben, bedeutet kein Werturteil über Ihre persönliche und fachliche Qualifikation. ... ADAC Service GmbH Bewerbermanagement',
};
const DATEV_REJECTION = {
  id: 'datev-rejection',
  from: 'workday@datev.de',
  subject: 'Deine Bewerbung bei DATEV auf die Stelle Werkstudent Data Analyst Business Intelligence (m/w/d)',
  body: 'Guten Tag Joshua, vielen Dank für Deine Bewerbung und Dein Interesse an unserem Unternehmen. Wir schätzen jede Bewerbung und nehmen uns die Zeit, diese sorgfältig zu prüfen. Leider haben wir Dich bei der Besetzung der Stelle nicht in die engere Auswahl einbezogen und bedauern, dass wir Dir damit heute keine positive Nachricht überbringen können.',
};
const ADAC_RECEIPT = {
  id: 'adac-receipt',
  from: 'bewerbung@adac.de',
  subject: 'Ihre Bewerbung - Eingangsbestätigung Werkstudent Data & AI Solutions (w|m|d)',
  body: 'Sehr geehrter Herr Jose, herzlichen Dank für Ihr Interesse an einer Mitarbeit in unserem Unternehmen. Wir werden Ihre Bewerbungsunterlagen sichten und uns schnellstmöglich bei Ihnen melden.',
};

// ── Classification of the real mail ─────────────────────────────────────────

{
  const c = classifyReply(toCandidate(ADAC_REJECTION));
  eq(c.type, 'Rejected', 'the ADAC rejection (formal Sie) classifies as Rejected');
  eq(c.suggestedTrackerUpdate, 'Rejected', 'and proposes the Rejected status');
  check(c.evidence.length > 0, 'and records which phrase decided it');
}
{
  const c = classifyReply(toCandidate(DATEV_REJECTION));
  eq(c.type, 'Rejected', 'the DATEV rejection (informal Du) classifies as Rejected');
  check(c.evidence.includes('nicht in die engere Auswahl'), 'the evidence names the phrase that decided it');
}
{
  const c = classifyReply(toCandidate(ADAC_RECEIPT));
  check(c.type !== 'Rejected', 'the ADAC receipt confirmation is NOT a rejection');
  check(c.suggestedTrackerUpdate !== 'Rejected', 'and proposes no Rejected status');
  eq(matchGermanRejection(ADAC_RECEIPT.subject, ADAC_RECEIPT.body).length, 0, 'no German rejection phrase fires on the receipt');
}

// ── The phrase table: formal (Sie) and informal (Du) ────────────────────────

const rejects = (body, subject = 'Ihre Bewerbung') => matchGermanRejection(subject, body).length > 0;

const REJECTIONS = [
  // nicht berücksichtigen
  'Leider müssen wir Ihnen mitteilen, dass wir Sie für die ausgeschriebene Position nicht berücksichtigen können.',
  'Wir können Sie leider nicht weiter berücksichtigen.',
  'Leider können wir Dich bei der Besetzung nicht berücksichtigen.',
  'Wir müssen Dir leider mitteilen, dass wir Dich nicht weiter berücksichtigen können.',
  'Ihre Bewerbung konnte leider nicht berücksichtigt werden.',
  'Deine Bewerbung konnte leider nicht berücksichtigt werden.',
  'wir koennen sie leider nicht beruecksichtigen',
  // nicht in die engere Auswahl / keine positive Nachricht
  'Leider haben wir Sie nicht in die engere Auswahl einbezogen.',
  'Leider haben wir Dich nicht in die engere Auswahl einbezogen.',
  'Leider können wir Ihnen heute keine positive Nachricht überbringen.',
  'Leider haben wir keine positive Rückmeldung für Dich.',
  // für andere Kandidaten entschieden / anderweitig besetzt
  'Wir haben uns für einen anderen Kandidaten entschieden.',
  'Wir haben uns leider für eine andere Kandidatin entschieden.',
  'Wir haben uns für andere Bewerber entschieden.',
  'Wir haben uns für einen Mitbewerber entschieden.',
  'Wir haben uns entschieden, mit einem anderen Kandidaten weiterzumachen.',
  'Leider haben wir uns, auch wenn Ihr Profil überzeugend war, für einen anderen Bewerber entschieden.',
  'Die Stelle ist bereits anderweitig besetzt.',
  'Die Position wurde leider bereits vergeben.',
  // nicht für Sie / gegen Ihre Bewerbung entschieden
  'Die Tatsache, dass wir uns nicht für Sie entschieden haben, bedeutet kein Werturteil.',
  'Wir haben uns gegen Ihre Bewerbung entschieden.',
  'Wir haben uns gegen Dich entschieden.',
  // weiterverfolgen / ablehnen / nicht erfolgreich
  'Wir werden Ihre Bewerbung nicht weiterverfolgen.',
  'Leider werden wir Deine Bewerbung nicht weiter verfolgen.',
  'Ihre Bewerbung wurde leider abgelehnt.',
  'Deine Bewerbung war leider nicht erfolgreich.',
  // müssen ... leider mitteilen + Negation
  'Leider müssen wir Ihnen mitteilen, dass wir Ihnen keine Zusage geben können.',
  'Wir bedauern, Ihnen mitteilen zu müssen, dass wir Ihre Bewerbung nicht berücksichtigen können.',
  'Leider müssen wir Dir mitteilen, dass wir Dir kein Angebot machen können.',
  // Absage
  'Wir müssen Ihnen leider eine Absage erteilen.',
  'Leider müssen wir Dir absagen.',
];
for (const text of REJECTIONS) {
  check(rejects(text), `rejection recognised: "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"`);
}
check(rejects('Hallo', 'Absage auf Ihre Bewerbung'), 'a bare "Absage" in the SUBJECT is recognised');
check(rejects('Leider müssen wir Ihnen mitteilen, dass wir Sie nicht in die engere Auswahl einbezogen haben.'.toUpperCase()),
  'matching is case-insensitive');

// ── ...and the boilerplate each phrase must not swallow ─────────────────────
//
// Each of these carries a rejection WORD. None is a rejection.

const NOT_REJECTIONS = [
  ['acknowledgement', 'Sehr geehrter Herr Jose, herzlichen Dank für Ihr Interesse an einer Mitarbeit in unserem Unternehmen. Wir werden Ihre Bewerbungsunterlagen sichten und uns schnellstmöglich bei Ihnen melden.'],
  ['"Zusage oder Absage" in a receipt', 'Sobald wir entschieden haben, erhalten Sie von uns eine Zusage oder Absage.'],
  ['"Absage oder Zusage" reversed', 'Sie erhalten eine Absage oder Zusage innerhalb von zwei Wochen.'],
  ['deadline boilerplate', 'Unvollständige Bewerbungen können nicht berücksichtigt werden.'],
  ['conditional rule (Falls)', 'Falls Sie keine Unterlagen einreichen, können wir Sie nicht berücksichtigen.'],
  ['conditional rule (Wenn)', 'Wenn die Unterlagen fehlen, können wir Sie leider nicht berücksichtigen.'],
  ['delay notice', 'Leider können wir Ihnen noch keine Entscheidung mitteilen. Wir melden uns.'],
  ['delay notice with nicht', 'Leider können wir Ihnen derzeit nicht mitteilen, wann wir uns melden.'],
  ['"engere Auswahl" promise', 'Wenn Sie in die engere Auswahl kommen, laden wir Sie zu einem Gespräch ein.'],
  ['positive news', 'Wir haben uns über Ihre Bewerbung gefreut und laden Sie zum Gespräch ein.'],
  ['"Terminabsage" is not "Absage"', 'Bitte vermeiden Sie eine Terminabsage kurz vor dem Gespräch.'],
  ['a positive Nachricht', 'Wir haben eine positive Nachricht für Sie: Sie sind in der engeren Auswahl.'],
];
for (const [what, text] of NOT_REJECTIONS) {
  check(!rejects(text), `not a rejection: ${what}`);
}
check(!rejects('Bitte melden Sie sich.', 'Terminabsage'), 'a subject containing "Terminabsage" is not an Absage');

// The classifier's other buckets are undisturbed by the new table.
eq(classifyReply({ from: 'a@b.de', subject: 'Einladung', body_snippet: 'We would like to invite you to interview next week.' }).type, 'Interview', 'an English interview invite still classifies as Interview');
eq(classifyReply({ from: 'a@b.de', subject: 's', body_snippet: 'Unfortunately we will not be moving forward.' }).type, 'Rejected', 'English rejections still classify as Rejected');
eq(classifyReply({ from: 'a@b.de', subject: 's', body_snippet: 'Thank you for applying. Application received.' }).type, 'Auto-confirmation', 'an English auto-confirmation is still Auto-confirmation');

// ── Sender domain <-> company name ──────────────────────────────────────────

eq(domainNameMatchKind('adac.de', 'ADAC Service GmbH'), 'exact', 'adac.de is the brand of "ADAC Service GmbH" (generic "Service" dropped)');
eq(domainNameMatchKind('datev.de', 'Datev'), 'exact', 'datev.de is "Datev"');
eq(domainNameMatchKind('datev.de', 'DATEV eG'), 'exact', 'datev.de is "DATEV eG" (legal form dropped)');
eq(domainNameMatchKind('karriere.adac.de', 'ADAC'), 'exact', 'a subdomain reduces to its registrable domain');
eq(domainNameMatchKind('mercedes-benz.com', 'Mercedes-Benz AG'), 'exact', 'hyphens fold away on both sides');
eq(domainNameMatchKind('siemens.com', 'Siemens Energy AG'), 'lead', 'a first-word match is weaker than a brand match');
eq(domainNameMatchKind('siemens.com', 'Siemens AG'), 'exact', 'siemens.com prefers "Siemens AG" to "Siemens Energy AG"');
eq(domainNameMatchKind('myworkday.com', 'Workday'), null, 'an ATS sending domain never names an employer');
eq(domainNameMatchKind('mail.stepstone.de', 'Stepstone'), null, 'a job-board domain never names an employer');
eq(domainNameMatchKind('gmail.com', 'Gmail'), null, 'a webmail domain never names an employer');
eq(domainNameMatchKind('db.com', 'DB'), null, 'a two-letter label is never trusted');
eq(domainNameMatchKind('adac.de', '?'), null, 'the unknown-employer marker matches nothing');
eq(registrableDomain('jobs.example.co.uk'), 'example.co.uk', 'a second-level public suffix keeps three labels');
eq(registrableDomain('datev.wd3.myworkdayjobs.com'), 'myworkdayjobs.com', 'a tenant subdomain reduces to the ATS vendor');

eq(stripGenericLocalParts('DATEV <workday@datev.de>'), 'DATEV <@datev.de>', 'a generic mailbox name is dropped from the sender');
eq(stripGenericLocalParts('bewerbung@adac.de'), '@adac.de', '"bewerbung@" is generic');
eq(stripGenericLocalParts('talent-acquisition@x.com'), '@x.com', 'a generic prefix covers its variants');
eq(stripGenericLocalParts('anna.balikci@datev.de'), 'anna.balikci@datev.de', 'a personal mailbox name is left alone');

// ── Tracker fixtures, parsed the way the sweep parses the real tracker ──────

const HEADER = [
  '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |',
  '|---|------|---------|-----|------|-------|--------|-----|--------|-------|---|',
];
const row = (num, company, role, status, notes, url) =>
  `| ${num} | 2026-09-02 | ${company} | — | ${role} | 3.8/5 | ${status} | ✅ | [${num}](../reports/${num}.md) | ${notes} | ${url} |`;

function parseTracker(rows) {
  const lines = [...HEADER, ...rows];
  const colmap = resolveColumns(lines);
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
}

// Sparse rows: no email address in any notes, so the only route to the row is
// the company name in the domain or the host of the URL cell. This is the shape
// the tracker had when the two real rejections failed to match.
const SPARSE = parseTracker([
  row(8, 'DATEV eG', 'Werkstudent Data Analytics & Business Analytics (m/w/d)', 'Rejected', 'Req ID15339.', 'https://datev.wd3.myworkdayjobs.com/Datev_Careers/job/Nuremberg/Werkstudent-Data-Analytics---Business-Analytics--m-w-d-_ID15339'),
  row(14, 'DATEV eG', 'Werkstudent Prozessautomatisierung / UiPath / Power Platform (m/w/d)', 'Discarded', 'Job ID ID15321.', 'https://datev.wd3.myworkdayjobs.com/Datev_Careers/job/Nuremberg/Werkstudent-Prozessautomatisierung--m-w-d-_ID15321'),
  row(88, 'DATEV eG', 'Werkstudent Software Engineering (m/w/d)', 'SKIP', 'Req ID15366.', 'https://datev.wd3.myworkdayjobs.com/Datev_Careers/job/Nuremberg/Werkstudent-Software-Engineering--m-w-d-_ID15366'),
  row(193, 'Datev', 'Werkstudent Data Analyst Business Intelligence (m/w/d)', 'Applied', 'Workday confirmation received.', 'https://datev.wd3.myworkdayjobs.com/Datev_Careers/job/Nuremberg/Werkstudent-Data-Analyst-Business-Intelligence--m-w-d-_ID15534-1'),
  row(162, 'ADAC Service GmbH', 'Werkstudent Data & AI Solutions (w / m / d)', 'Applied', 'Munich.', 'https://karriere.adac.de/stellenanzeige/werkstudent-data-ai-solutions-wmd-de-j16758.html'),
  row(189, 'ADAC', 'Werkstudent Power BI & Data Analytics (w/m/d)', 'Discarded', 'StepStone only.', 'https://www.stepstone.de/stellenangebote--Werkstudent-Power-BI-Data-Analytics-wmd-Muenchen-ADAC--14439562.html'),
  row(200, 'Workday', 'Software Engineer', 'Applied', 'Unrelated.', 'https://www.workday.com/careers/200'),
]);

const planOf = (messages, apps = SPARSE) => buildPlan(messages.map(toCandidate), apps);
const findIn = (plan, id) => [...plan.updates, ...plan.review, ...plan.noise].find((e) => e.message_id === id);

{
  const plan = planOf([ADAC_REJECTION]);
  const e = plan.updates.find((u) => u.message_id === 'adac-rejection');
  check(!!e, 'the ADAC rejection is queued for auto-apply');
  eq(e?.row, 162, 'it lands on the ADAC Service GmbH row (#162), not the Discarded sibling (#189)');
  eq(e?.newStatus, 'Rejected', 'proposing Rejected');
  eq(e?.confidence, 'high', 'at high confidence, so gmail-sweep will apply it');
  check(e?.signals.includes('sender-domain'), 'the sender domain is among the signals');
}
{
  const plan = planOf([DATEV_REJECTION]);
  const e = plan.updates.find((u) => u.message_id === 'datev-rejection');
  check(!!e, 'the DATEV rejection is queued for auto-apply');
  eq(e?.row, 193, 'it lands on #193, the Data Analyst BI row, out of four DATEV rows');
  eq(e?.newStatus, 'Rejected', 'proposing Rejected');
  eq(e?.confidence, 'high', 'at high confidence');
}
{
  const plan = planOf([ADAC_RECEIPT]);
  check(!plan.updates.some((u) => u.newStatus === 'Rejected'), 'the ADAC receipt never queues a Rejected update');
  check(!plan.updates.length, 'and queues nothing else either');
  const e = findIn(plan, 'adac-receipt');
  eq(e?.row, 162, 'the receipt is still attributed to #162 — the role words break the tie with #189');
}
{
  // The rejection with the employer named nowhere but the sender address: the
  // body is what a shorter snippet leaves behind.
  const bare = { ...ADAC_REJECTION, id: 'adac-bare', body: 'Leider müssen wir Ihnen mitteilen, dass wir Sie für die ausgeschriebene Position nicht berücksichtigen können.' };
  const e = planOf([bare]).updates.find((u) => u.message_id === 'adac-bare');
  eq(e?.row, 162, 'a rejection that never names the employer still reaches #162 through the sender domain');
}

// ── Guards that must not move ───────────────────────────────────────────────

{
  // The Rejected row stays Rejected: a second copy of the same mail is a no-op.
  const rejectedAlready = parseTracker([
    row(162, 'ADAC Service GmbH', 'Werkstudent Data & AI Solutions (w / m / d)', 'Rejected', 'Munich.', 'https://karriere.adac.de/stellenanzeige/werkstudent-data-ai-solutions-wmd-de-j16758.html'),
  ]);
  const plan = planOf([ADAC_REJECTION], rejectedAlready);
  eq(plan.updates.length, 0, 'a row that is already Rejected is never rewritten');
  check(/already|terminal/.test(findIn(plan, 'adac-rejection')?.skipReason ?? ''), 'and the reason says the row is already there or terminal');
  eq(screenTransition('Rejected', 'Interview', 'high').allow, false, 'a Rejected row is never reopened by a later mail');
  eq(screenTransition('Applied', 'Rejected', 'medium').allow, false, 'a medium-confidence rejection still needs review');
  eq(screenTransition('Interview', 'Rejected', 'high').allow, true, 'a high-confidence rejection still applies at any stage');
}

// ── Ambiguity: two rows of one employer stay Needs Review ───────────────────

{
  const twoAdac = parseTracker([
    row(301, 'ADAC Service GmbH', 'Werkstudent Marketing Analytics', 'Applied', 'x.', 'https://karriere.adac.de/stellenanzeige/marketing-j11111.html'),
    row(302, 'ADAC Service GmbH', 'Werkstudent Finance Controlling', 'Applied', 'y.', 'https://karriere.adac.de/stellenanzeige/finance-j22222.html'),
  ]);
  const generic = {
    id: 'adac-generic', from: 'bewerbung@adac.de', subject: 'Ihre Bewerbung bei ADAC',
    body: 'Leider müssen wir Ihnen mitteilen, dass wir Sie für die ausgeschriebene Position nicht berücksichtigen können.',
  };
  const plan = planOf([generic], twoAdac);
  eq(plan.updates.length, 0, 'a rejection that fits two rows equally is NOT auto-applied');
  const e = findIn(plan, 'adac-generic');
  eq(e?.row, null, 'no row is chosen');
  check(e?.signals.includes('ambiguous-match'), 'the match is flagged ambiguous');
  eq(e?.type, 'Rejected', 'it is still recognised as a rejection, so the user is asked rather than left in the dark');
  check(e?.skipReason && e.skipReason.length > 0, 'and says why it was held back');

  // One shared word is what two roles at one employer have in common: it must not
  // break the tie the guard exists to keep.
  const oneWord = { ...generic, id: 'adac-oneword', subject: 'Ihre Bewerbung bei ADAC - Werkstudent Analytics' };
  const plan2 = planOf([oneWord], twoAdac);
  eq(plan2.updates.length, 0, 'a single shared title word does not break the tie');
  eq(findIn(plan2, 'adac-oneword')?.row, null, 'the row stays unchosen');

  // Enough of one title, though, is exactly the evidence that should decide it.
  const decisive = { ...generic, id: 'adac-decisive', subject: 'Ihre Bewerbung - Werkstudent Marketing Analytics' };
  eq(findIn(planOf([decisive], twoAdac), 'adac-decisive')?.row, 301, 'a subject repeating the title of one row picks that row');
}
eq(roleOverlapBonus('Werkstudent Data & AI Solutions', 'Werkstudent Data & AI Solutions (w / m / d)') > 0, true, 'full title overlap earns a bonus, ignoring the gender tag');
eq(roleOverlapBonus('Bewerbung Data', 'Werkstudent Power BI & Data Analytics'), 0, 'one word of a longer title earns nothing');

// ── Mailbox names and ATS hosts do not become company evidence ──────────────

{
  // A tracker row for a company literally named "Workday" must not claim
  // workday@datev.de: "workday" there is a mailbox function.
  const plan = planOf([DATEV_REJECTION]);
  check(findIn(plan, 'datev-rejection')?.row !== 200, 'a row named "Workday" does not claim mail from workday@datev.de');

  // Mail from an ATS vendor is attributed to nobody by domain.
  const ats = { id: 'ats', from: 'noreply@myworkday.com', subject: 'Update', body: 'Leider haben wir uns für andere Bewerber entschieden.' };
  eq(findIn(planOf([ats]), 'ats')?.row, null, 'a rejection from an ATS sending domain is not pinned on a row by domain');
  check(!getAppDomains(SPARSE.find((a) => a.num === 8), []).some((d) => /myworkdayjobs/.test(d)), 'a Workday tenant URL does not become the DATEV row\'s domain');
  check(!getAppDomains(SPARSE.find((a) => a.num === 189), []).some((d) => /stepstone/.test(d)), 'a StepStone URL does not become the row\'s domain');
  check(getAppDomains(SPARSE.find((a) => a.num === 162), []).includes('adac.de'), 'the employer\'s own posting host becomes the row\'s domain');
}

// ── Requisition ids: German labels, short ids, corroboration ────────────────

check(extractReqIds('Ihre Bewerbung ... (ID: 16758)').has('16758'), '"(ID: 16758)" is extracted');
check(extractReqIds('Stelle (Stellenkennziffer: 16758).').has('16758'), '"Stellenkennziffer: 16758" is extracted');
check(extractReqIds('Kennziffer 4711').has('4711'), '"Kennziffer" is a label');
eq(extractReqIds('Am Weichselgarten 30a, 91058 Erlangen').size, 0, 'a postcode is still not a requisition');
eq(extractReqIds('Termin am 24.09.2026 um 10 Uhr').size, 0, 'a date is not a requisition');
{
  const siblings = parseTracker([
    row(401, 'ADAC Service GmbH', 'Werkstudent Marketing Analytics', 'Applied', 'x.', 'https://karriere.adac.de/stellenanzeige/marketing-j11111.html'),
    row(162, 'ADAC Service GmbH', 'Werkstudent Data & AI Solutions (w / m / d)', 'Applied', 'Stellenkennziffer 16758.', 'https://karriere.adac.de/stellenanzeige/werkstudent-data-ai-solutions-wmd-de-j16758.html'),
  ]);
  const candidate = toCandidate({ ...ADAC_REJECTION, subject: 'Ihre Bewerbung (ID: 16758)', body: 'Leider haben wir uns für andere Bewerber entschieden.' });
  eq(resolveByReqId(candidate, siblings, 401)?.num, 162, 'a short labelled id re-points a wrong sibling match when the sender is the employer');

  const stranger = toCandidate({ id: 's', from: 'jobs@other-company.example', subject: 'Your application (ID: 16758)', body: 'We regret to inform you.' });
  eq(resolveByReqId(stranger, siblings, null), null, 'the same short id from an unrelated sender re-points nothing');

  const strongStranger = toCandidate({ id: 's2', from: 'jobs@other-company.example', subject: 'Job ID 516786', body: 'x' });
  const withLongId = parseTracker([row(500, 'Siemens AG', 'Working Student', 'Applied', 'Job ID 516786.', 'https://jobs.siemens.com/JobDetail/516786')]);
  eq(resolveByReqId(strongStranger, withLongId, null)?.num, 500, 'a six-digit id keeps its old behaviour and needs no corroboration');
}

// ── End to end: `node gmail-sweep.mjs plan --file`, on a temp workspace ─────

{
  const dir = mkdtempSync(join(tmpdir(), 'reply-german-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const tracker = join(dir, 'data', 'applications.md');
    writeFileSync(tracker, `# Applications Tracker\n\n${[...HEADER, ...[
      row(162, 'ADAC Service GmbH', 'Werkstudent Data & AI Solutions (w / m / d)', 'Applied', 'Munich.', 'https://karriere.adac.de/stellenanzeige/werkstudent-data-ai-solutions-wmd-de-j16758.html'),
      row(189, 'ADAC', 'Werkstudent Power BI & Data Analytics (w/m/d)', 'Discarded', 'x.', 'https://www.stepstone.de/stellenangebote--x--14439562.html'),
      row(193, 'Datev', 'Werkstudent Data Analyst Business Intelligence (m/w/d)', 'Applied', 'x.', 'https://datev.wd3.myworkdayjobs.com/Datev_Careers/job/Nuremberg/x_ID15534-1'),
    ]].join('\n')}\n`, 'utf-8');
    const file = join(dir, 'msgs.json');
    writeFileSync(file, JSON.stringify([ADAC_REJECTION, DATEV_REJECTION, ADAC_RECEIPT]), 'utf-8');

    const res = spawnSync(NODE, ['gmail-sweep.mjs', 'plan', '--file', file], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CAREER_OPS_ROOT: dir,
        CAREER_OPS_TRACKER: tracker,
        CAREER_OPS_REPLY_CANDIDATES: join(dir, 'data', 'reply-candidates.json'),
        CAREER_OPS_GMAIL_SWEEP_STATE: join(dir, 'data', 'gmail-sweep-state.json'),
      },
    });
    eq(res.status, 0, 'the plan command exits 0');
    let plan = null;
    try { plan = JSON.parse(res.stdout); } catch { /* reported below */ }
    check(!!plan, 'and prints a JSON plan');
    if (plan) {
      eq(plan.willUpdate, 2, 'the plan will update exactly the two rejections');
      const byId = Object.fromEntries(plan.updates.map((u) => [u.message_id, u]));
      eq(byId['adac-rejection']?.row, 162, 'CLI: ADAC rejection -> row 162');
      eq(byId['datev-rejection']?.row, 193, 'CLI: DATEV rejection -> row 193');
      check(plan.updates.every((u) => u.newStatus === 'Rejected' && u.confidence === 'high'), 'CLI: both are high-confidence Rejected');
      check(!plan.updates.some((u) => u.message_id === 'adac-receipt'), 'CLI: the receipt is not an update');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
