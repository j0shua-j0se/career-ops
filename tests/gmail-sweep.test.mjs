// tests/gmail-sweep.test.mjs — the Gmail sweep's guards.
//
// The sweep is the one part of `/career-ops pipeline` that writes to the tracker
// from something the user didn't type. What keeps that safe is not the
// classifier (reply-matcher.mjs has its own suite) but the screen in front of
// it: high confidence only, forward only, never out of a terminal state. Those
// three rules are what this file pins.
//
// Auto-discovered by test-all.mjs: runs in-process, shares its counters, and
// must never terminate the process.

import { pass, fail } from './helpers.mjs';
import {
  STATUS_RANK, TERMINAL_STATES, screenTransition, toCandidate, buildGmailQuery, buildPlan,
} from '../gmail-sweep.mjs';

console.log('\n📬 gmail-sweep.mjs — mailbox → tracker guards');

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
const eq = (actual, expected, msg) => check(
  Object.is(actual, expected),
  Object.is(actual, expected) ? msg : `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
);

// ── Transition screen ───────────────────────────────────────────────────────

check(STATUS_RANK.Applied < STATUS_RANK.Interview, 'Interview ranks ahead of Applied');
check(STATUS_RANK.Interview < STATUS_RANK.Offer, 'Offer ranks ahead of Interview');
check(TERMINAL_STATES.has('Hired') && TERMINAL_STATES.has('Rejected'), 'Hired and Rejected are terminal');
check(TERMINAL_STATES.has('Discarded') && TERMINAL_STATES.has('SKIP'), 'Discarded and SKIP are terminal');

eq(screenTransition('Applied', 'Interview', 'high').allow, true, 'forward progress on a high-confidence match is applied');
eq(screenTransition('Applied', 'Offer', 'high').allow, true, 'skipping a stage forward is still forward');
eq(screenTransition('Evaluated', 'Applied', 'high').allow, true, 'Evaluated → Applied is forward');

{
  // The failure this rule exists for: an inbox is not ordered. A "thanks for
  // applying" autoresponder can arrive after the interview invite.
  const s = screenTransition('Interview', 'Responded', 'high');
  eq(s.allow, false, 'a backwards transition is refused');
  check(/backwards/.test(s.reason), 'the refusal says it would move backwards');
}
{
  const s = screenTransition('Applied', 'Interview', 'medium');
  eq(s.allow, false, 'a medium-confidence match is not auto-applied');
  check(/confidence/.test(s.reason), 'the refusal names the confidence level');
}
eq(screenTransition('Applied', 'Interview', 'low').allow, false, 'a low-confidence match is not auto-applied');

{
  // A rejection genuinely can arrive at any stage, including out of order.
  eq(screenTransition('Applied', 'Rejected', 'high').allow, true, 'a rejection after Applied is applied');
  eq(screenTransition('Interview', 'Rejected', 'high').allow, true, 'a rejection during interviews is applied');
  eq(screenTransition('Offer', 'Rejected', 'high').allow, true, 'a rejection after an offer is applied');
  eq(screenTransition('Offer', 'Rejected', 'medium').allow, false, 'even a rejection needs a high-confidence match');
}
{
  const s = screenTransition('Rejected', 'Interview', 'high');
  eq(s.allow, false, 'a terminal row is never reopened by an email');
  check(/terminal/.test(s.reason), 'the refusal says the row is terminal');
}
eq(screenTransition('Hired', 'Offer', 'high').allow, false, 'Hired is never walked back');
eq(screenTransition('Discarded', 'Responded', 'high').allow, false, 'a discarded row stays discarded');

eq(screenTransition('Applied', 'none', 'high').allow, false, 'a reply with no actionable status changes nothing');
eq(screenTransition('Applied', 'Needs Review', 'high').allow, false, 'Needs Review is a question for the user, not a transition');
eq(screenTransition('Applied', 'Applied', 'high').allow, false, 'a no-op transition is skipped');
eq(screenTransition('Weird Legacy Status', 'Interview', 'high').allow, false, 'an unrecognized current status blocks the write');

// ── Message normalization ───────────────────────────────────────────────────

{
  const c = toCandidate({ id: 'm1', from: 'a@b.com', subject: 'Hi', body: 'x'.repeat(9000), date: '2026-08-01' });
  eq(c.message_id, 'm1', 'the Gmail message id becomes the candidate id');
  eq(c.body_snippet.length, 4000, 'an oversized body is truncated rather than stored whole');
  eq(c.signal, null, 'normalization never pre-judges the classification');
  eq(c.date, '2026-08-01', 'the date is carried through');
}
{
  const c = toCandidate({ message_id: 'm2', snippet: 'short' });
  eq(c.message_id, 'm2', 'message_id is accepted as an alias for id');
  eq(c.body_snippet, 'short', 'snippet is accepted as an alias for body');
  eq(c.from, '', 'a missing sender becomes an empty string, not undefined');
}
check(toCandidate({}).message_id.length > 0, 'a message with no id still gets one rather than colliding on undefined');

// ── Query scoping ───────────────────────────────────────────────────────────

{
  const apps = [
    { num: 1, company: 'Acme GmbH', role: 'AI Engineer', status: 'Applied' },
    { num: 2, company: 'Good Co', role: 'MLE', status: 'Interview' },
    { num: 3, company: 'Dead Co', role: 'PM', status: 'Rejected' },
    { num: 4, company: 'Skipped Co', role: 'PM', status: 'SKIP' },
    { num: 5, company: 'Acme GmbH', role: 'Data Engineer', status: 'Responded' },
    { num: 6, company: '?', role: 'Unknown', status: 'Applied' },
  ];
  const q = buildGmailQuery(apps, { days: 14 });
  check(q.includes('"Acme GmbH"'), 'an in-flight company is in the query');
  check(q.includes('"Good Co"'), 'a company in interviews is in the query');
  check(!q.includes('Dead Co'), 'a rejected row is not swept — the mailbox read stays proportionate');
  check(!q.includes('Skipped Co'), 'a SKIP row is not swept');
  check(!q.includes('"?"'), 'the unknown-employer marker is not turned into a search term');
  eq((q.match(/"Acme GmbH"/g) || []).length, 1, 'two rows at one company produce one search term');
  check(q.includes('newer_than:14d'), 'the recency window is honored');
}
eq(buildGmailQuery([], {}), null, 'nothing in flight means no query — and no mailbox read at all');
eq(buildGmailQuery([{ num: 1, company: 'X', role: 'Y', status: 'Evaluated' }], {}), null, 'an evaluated-but-unapplied row is not swept');

// ── Plan ────────────────────────────────────────────────────────────────────

const APPS = [
  { num: 11, company: 'Acme', role: 'AI Engineer', status: 'Applied', notes: '' },
  { num: 12, company: 'Northwind', role: 'Data Engineer', status: 'Interview', notes: '' },
  { num: 13, company: 'Contoso', role: 'Platform Engineer', status: 'Offer', notes: '' },
];

{
  const candidates = [
    toCandidate({
      id: 'invite',
      from: 'recruiting@acme.com',
      subject: 'Interview invitation — AI Engineer at Acme',
      body: 'We would like to invite you to interview for the AI Engineer role at Acme.',
    }),
    toCandidate({
      id: 'reject',
      from: 'noreply@northwind.com',
      subject: 'Your application to Northwind — Data Engineer',
      body: 'Unfortunately we have decided not to proceed with your application.',
    }),
    toCandidate({
      id: 'auto',
      from: 'noreply@acme.com',
      subject: 'Application received — AI Engineer at Acme',
      body: 'Thank you for applying. Your application has been received.',
    }),
    toCandidate({
      id: 'stranger',
      from: 'newsletter@unrelated-example.org',
      subject: 'Weekly digest of jobs and career news',
      body: 'Here are this week job listings for your career.',
    }),
  ];
  const plan = buildPlan(candidates, APPS);
  const ids = (bucket) => bucket.map((e) => e.message_id);

  check(ids(plan.updates).includes('invite'), 'a high-confidence interview invite is queued for application');
  check(ids(plan.updates).includes('reject'), 'a rejection is queued for application');
  check(ids(plan.noise).includes('auto'), 'an application autoresponder changes nothing');
  check(!ids(plan.updates).includes('auto'), 'an autoresponder never moves a row');
  check(!ids(plan.updates).includes('stranger'), 'unmatched mail never moves a row');

  const invite = plan.updates.find((e) => e.message_id === 'invite');
  eq(invite.row, 11, 'the invite is matched to the right tracker row');
  eq(invite.newStatus, 'Interview', 'the invite proposes Interview');
  eq(invite.currentStatus, 'Applied', 'the plan records where the row was, so the change is reviewable');

  const rejection = plan.updates.find((e) => e.message_id === 'reject');
  eq(rejection.newStatus, 'Rejected', 'the rejection proposes Rejected');
  eq(rejection.row, 12, 'the rejection is matched to the row it names');

  check(plan.review.every((e) => typeof e.skipReason === 'string' && e.skipReason.length > 0),
    'every entry held back for review says why');
}

{
  // Backwards transition inside a real plan, not just the unit screen: a late
  // "thanks for applying" for a row that is already at Offer.
  const candidates = [toCandidate({
    id: 'late',
    from: 'recruiting@contoso.com',
    subject: 'Next steps — Platform Engineer at Contoso',
    body: 'Our hiring manager would like to chat with you about the Platform Engineer role.',
  })];
  const plan = buildPlan(candidates, APPS);
  eq(plan.updates.length, 0, 'a reply that would walk an Offer row back is not applied');
  eq(plan.review.length, 1, 'it is handed to the user instead of being dropped');
  check(/backwards|already/.test(plan.review[0].skipReason), 'the reason explains the hold-back');
}

{
  const plan = buildPlan([], APPS);
  eq(plan.updates.length + plan.review.length + plan.noise.length, 0, 'an empty mailbox produces an empty plan');
}
