// tests/check-followups-due-contact.test.mjs
//
// The scheduler's daily listing prints a contact next to every overdue row, and
// an address printed there reads as "this is who to chase". Three kinds of
// address must never read that way: an ATS no-reply, an ATS platform mailbox,
// and — the one actually observed on #23 DLR — the candidate's OWN address.
//
// followup-draft.mjs already refused all three when writing a draft. This
// listing did not, so the two disagreed: the scheduler advertised 14 reachable
// contacts while the drafter could only address 6 of them.
import { pass, fail } from './helpers.mjs';
import { pickContact } from '../check-followups-due.mjs';

console.log('\ncheck-followups-due.mjs — the contact line must not advertise dead addresses');

{
  const c = pickContact([{ email: 'patrick.ziegler@faps.fau.de' }]);
  c.replyable === true && c.email === 'patrick.ziegler@faps.fau.de'
    ? pass('a named human is reported as replyable')
    : fail(`named human classified ${JSON.stringify(c)}`);
}

for (const addr of ['NoreplyTrenchRecruiting@csod.com', 'no-reply-jobs@hr.allianz.com', 'donotreply@mssa.com']) {
  const c = pickContact([{ email: addr }]);
  c.replyable === false
    ? pass(`${addr} is not offered as a contact`)
    : fail(`${addr} was offered as replyable`);
}

{
  // zeissgroup@myworkday.com trips no noreply pattern — the local part is the
  // company name — but a reply goes to Workday, not to ZEISS.
  const c = pickContact([{ email: 'zeissgroup@myworkday.com' }]);
  c.replyable === false
    ? pass('an ATS platform mailbox is not offered as a contact')
    : fail('Workday platform address was offered as replyable');
}

{
  // The worst case: chasing yourself and believing it was sent.
  const c = pickContact([{ email: 'joshuajoseprofessional@gmail.com' }]);
  c.replyable === false && c.why === 'own address'
    ? pass("the candidate's own address is refused, and named as such")
    : fail(`own address classified ${JSON.stringify(c)}`);
}

{
  // A usable address behind unusable ones must still be found.
  const c = pickContact([
    { email: 'donotreply@mssa.com' },
    { email: 'careers@moresophy.com' },
  ]);
  c.replyable === true && c.email === 'careers@moresophy.com'
    ? pass('a real address is found behind a no-reply on the same row')
    : fail(`ordering not honoured: ${JSON.stringify(c)}`);
}

{
  const c = pickContact([]);
  c.replyable === false && c.email === null && c.why === 'none on file'
    ? pass('an empty contact list says so plainly')
    : fail(`empty list classified ${JSON.stringify(c)}`);
}
