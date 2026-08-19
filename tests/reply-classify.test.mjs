// tests/reply-classify.test.mjs — what classifyReply() must recognise as a No.
//
// gmail-sweep.test.mjs opens by saying "reply-matcher.mjs has its own suite".
// It did not. This is that suite, and it starts where the gap actually cost
// something: a rejection that classified as `Unknown`.
//
// The failure mode here is quiet in exactly the way the sweep's other guards
// are not. A misfire in the other direction is loud — a row moves and the user
// sees it. A rejection that classifies as Unknown moves nothing: the row sits
// at `Applied`, the follow-up cadence keeps counting days against a company
// that already said no, and the funnel keeps the application in flight forever.
// Nothing errors. So the patterns are pinned by test rather than by inspection.
//
// Auto-discovered by test-all.mjs: runs in-process, shares its counters, and
// must never terminate the process.

import { pass, fail } from './helpers.mjs';
import { classifyReply } from '../reply-matcher.mjs';

console.log('\n📪 reply-matcher.mjs — reply classification');

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

/** classifyReply takes the shape gmail-sweep's toCandidate() produces. */
const classify = (body, subject = 'Your application') =>
  classifyReply({ from: 'hr@example.com', subject, body_snippet: body });

// ── The "consider" family ───────────────────────────────────────────────────
//
// Observed live 2026-08-18: Primetals Technologies Germany GmbH (trading as
// Mitsubishi Heavy Industries EMEA, Erlangen) closed an application with
// "we won't consider your application in the further process any more". That
// matched none of the rejection keywords and returned Unknown.
//
// Both apostrophe forms are covered because the matcher uses a plain lowercase
// `includes` and mail clients emit either U+0027 or U+2019 — a rejection that
// depended on which quote character a recruiter's mail client chose would be a
// coin flip.

{
  const live = "I am sorry to inform you that we won't consider your application in the further process any more.";
  check(classify(live).type === 'Rejected', 'the live Primetals/MHI wording classifies as Rejected');
  check(classify(live).evidence.length > 0, 'and it records which phrase decided it');
}

check(
  classify('we won’t consider your application any further').type === 'Rejected',
  'the typographic apostrophe (U+2019) is recognised too',
);
check(
  classify('we will not consider your application further').type === 'Rejected',
  'the uncontracted "will not consider your application" is recognised',
);
check(
  classify('we can no longer consider you for this position').type === 'Rejected',
  '"no longer consider" is recognised',
);
check(
  classify('we are unable to consider your profile at this time').type === 'Rejected',
  '"unable to consider" is recognised',
);

// ── The negative side of the same patterns ──────────────────────────────────
//
// "consider" appears just as often in acknowledgements as in rejections, so the
// added phrases must not swallow them. A confirmation misread as a rejection is
// worse than the original bug: it walks a live application into a terminal
// state, and TERMINAL_STATES means the sweep will not walk it back out.

check(
  classify('Thank you for applying. We will consider your application carefully.').type !== 'Rejected',
  'an acknowledgement promising to consider the application is NOT a rejection',
);
check(
  classify('Your application is now with us and will be reviewed thoroughly.').type !== 'Rejected',
  'a plain acknowledgement is not a rejection',
);
check(
  classify('We are pleased to offer you the position.').type === 'Offer',
  'an offer still classifies as Offer',
);
check(
  classify('We would like to invite you to interview next week.').type === 'Interview',
  'an interview invitation still classifies as Interview',
);

// ── Rejection outranks a passing mention of interview or offer ──────────────
//
// Pinned because the ordering is load-bearing and easy to break: rejection is
// decided before Offer and Interview precisely so a "we will not be moving
// forward to interview" does not read as an invitation.

check(
  classify('Unfortunately we will not be moving forward to interview.').type === 'Rejected',
  'a rejection mentioning "interview" in passing is still a rejection',
);
check(
  classify('We are unable to offer you the role at this time.').type === 'Rejected',
  'a rejection containing "offer" is still a rejection',
);
