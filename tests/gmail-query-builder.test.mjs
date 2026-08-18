// tests/gmail-query-builder.test.mjs — buildGmailQuery term derivation.
//
// The old builder quoted each tracker company label verbatim. Two measured
// failures on 2026-08-18:
//
//   "FAU Erlangen-Nuernberg (Lehrstuhl FAPS)" matched nothing — it is an
//   internal disambiguator with an ASCII-folded umlaut and a parenthetical, and
//   no real email contains it. The row it covered was a live application.
//
//   "Amazon" matched everything — vouchers, newsletters, marketing — burying
//   the one real reply.
//
// Worse, the query named none of the three companies that had actually replied
// that day, so running the documented sweep would have surfaced nothing.
//
// Pure-function tests: no network, no Gmail, no mailbox access.
//
// Auto-discovered by test-all.mjs — never exit the process here.
import { pass, fail } from './helpers.mjs';
import { buildGmailQuery, companySearchTerms, isTooGenericTerm } from '../gmail-sweep.mjs';

console.log('\ngmail-sweep.mjs — query builder');

const rows = (names) => names.map((company, i) => ({ num: i + 1, company, status: 'Applied' }));

// ── the FAU regression ──────────────────────────────────────────────────────
const fau = companySearchTerms('FAU Erlangen-Nuernberg (Lehrstuhl FAPS)');
if (fau.includes('FAPS')) pass('a parenthetical qualifier yields its distinctive token (FAPS)');
else fail(`FAU terms lacked FAPS: ${JSON.stringify(fau)}`);
if (fau.includes('FAU')) pass('the leading institution token is emitted (FAU)');
else fail(`FAU terms lacked FAU: ${JSON.stringify(fau)}`);
if (!fau.includes('FAU Erlangen-Nuernberg (Lehrstuhl FAPS)')) {
  pass('the raw parenthetical label is not emitted as a search term');
} else {
  fail('the unusable raw label is still being searched');
}

// ── legal forms ─────────────────────────────────────────────────────────────
const mores = companySearchTerms('MORESOPHY GmbH');
if (mores.includes('MORESOPHY GmbH') && mores.includes('MORESOPHY')) {
  pass('a legal form yields both the full name and the stripped variant');
} else {
  fail(`MORESOPHY terms: ${JSON.stringify(mores)}`);
}
const prime = companySearchTerms('Primetals Technologies Germany GmbH');
if (prime.includes('Primetals')) pass('a compound name yields its leading token');
else fail(`Primetals terms: ${JSON.stringify(prime)}`);

// ── generic-name guard ──────────────────────────────────────────────────────
if (isTooGenericTerm('Amazon')) pass('Amazon is classified too generic to search bare');
else fail('Amazon was not classified as generic');
if (!isTooGenericTerm('Primetals')) pass('a distinctive name is not classified generic');
else fail('Primetals was wrongly classified generic');
if (!isTooGenericTerm('Allianz Partners')) pass('a multi-word term is never classified generic');
else fail('a multi-word term was classified generic');

const q = buildGmailQuery(rows(['Amazon', 'MORESOPHY GmbH', 'FAU Erlangen-Nuernberg (Lehrstuhl FAPS)']));
if (!/(^|[^("\w])Amazon(?=\s+OR|\s*\))/.test(q.replace(/\(Amazon \([^)]*\)\)/g, ''))) {
  pass('Amazon never appears as a bare standalone term');
} else {
  fail(`Amazon appears bare: ${q}`);
}
if (/Amazon \(Bewerbung/.test(q)) pass('Amazon appears only paired with recruiting vocabulary');
else fail(`Amazon is not qualified by job context: ${q}`);

// ── structural guarantees ───────────────────────────────────────────────────
if (/newer_than:30d/.test(q)) pass('the recency window is preserved');
else fail(`no newer_than window: ${q}`);
if (/Bewerbung OR Absage/.test(q)) pass('a job-context OR-group is present for ATS mail');
else fail('no job-context group — ATS mail that never names the employer stays invisible');
if (buildGmailQuery([]) === null) pass('an empty in-flight list still returns null');
else fail('an empty list did not return null');
if (buildGmailQuery(rows(['Acme']), { days: 7 }).includes('newer_than:7d')) {
  pass('a custom days window is honoured');
} else {
  fail('custom days window ignored');
}

// ── the three companies that actually replied must be reachable ─────────────
const live = buildGmailQuery(rows(['ZEISS', 'Primetals Technologies Germany GmbH', 'Allianz Partners']));
const reachable = ['ZEISS', 'Primetals', 'Allianz'].every((n) => live.includes(n));
if (reachable) pass('ZEISS, Primetals and Allianz are all reachable by the query');
else fail(`query missed a live company: ${live}`);

// ── length cap ──────────────────────────────────────────────────────────────
const many = buildGmailQuery(rows(Array.from({ length: 80 }, (_, i) => `Company Number ${i} Holdings GmbH`)), { maxLength: 400 });
if (many && many.length < 900) pass('an over-long query is capped rather than emitted unusable');
else fail(`query not capped: length ${many && many.length}`);
