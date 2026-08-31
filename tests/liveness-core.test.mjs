// tests/liveness-core.test.mjs — classifyLiveness must treat the "filled"
// phrasing SPA ATSs inject (Phenom, e.g. careers.icf.com) as expired.
//
// Regression for the false-active reported on careers.icf.com: Phenom-hosted
// career pages return HTTP 200 with a generic "Apply" control in the shell,
// while the true status — "the job you are trying to apply for has been
// filled" — is rendered into the main content. The old HARD_EXPIRED pattern
// was /position has been filled/, which does not match that phrasing, so the
// generic apply control won and the posting was classified active. The
// generalized pattern requires any job noun within 60 chars of "has been
// filled" and rejects "filled out" (a candidate completing a form).
import { pass, fail } from './helpers.mjs';
import { classifyLiveness } from '../liveness-core.mjs';

console.log('\nliveness-core — "filled" reqs (incl. Phenom/ICF phrasing) classify as expired');

const expired = (bodyText, applyControls = ['Apply']) =>
  classifyLiveness({ status: 200, finalUrl: 'https://careers.example.com/job/123', bodyText, applyControls }).result;

// The reported bug: Phenom/ICF phrasing, HTTP 200, with a generic Apply control.
expired('We’re sorry… the job you are trying to apply for has been filled. Apply')
  === 'expired'
  ? pass('Phenom/ICF "the job ... has been filled" -> expired (was: active)')
  : fail('Phenom/ICF "the job ... has been filled" NOT classified expired');

// Regression: the original phrasing still classifies as expired.
expired('This position has been filled. Apply') === 'expired'
  ? pass('"position has been filled" still -> expired')
  : fail('"position has been filled" regressed');

// Regression: a genuinely active posting is NOT swept up by the new pattern.
classifyLiveness({
  status: 200,
  finalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  bodyText: 'Senior Program Manager. You will own the enterprise AI roadmap and lead delivery across teams. Apply now.',
  applyControls: ['Apply now'],
}).result === 'active'
  ? pass('active posting with an apply control stays active')
  : fail('new pattern over-triggered on an active posting');

// False-positive guard: "has been filled out" (a form) must NOT read as expired.
classifyLiveness({
  status: 200,
  finalUrl: 'https://careers.example.com/job/123',
  bodyText: 'Once the job application form has been filled out, submit it below. Apply',
  applyControls: ['Apply'],
}).result !== 'expired'
  ? pass('"job application form has been filled out" is NOT expired (form, not req)')
  : fail('false positive: "filled out" (a form) read as an expired req');

// False-positive guard (no "out"): "application form has been filled" must NOT
// read as expired — "job" satisfies the noun but the thing filled is the form,
// not the req. Reading a live posting as expired is the worse error.
classifyLiveness({
  status: 200,
  finalUrl: 'https://careers.example.com/job/123',
  bodyText: 'Please confirm the job application form has been filled and accurate before submitting. Apply',
  applyControls: ['Apply'],
}).result !== 'expired'
  ? pass('"job application form has been filled" (no "out") is NOT expired')
  : fail('false positive: "application form has been filled" read as an expired req');

console.log('\nliveness-core — transient 5xx must not classify as expired');

// Regression: a 502 with a typical short gateway body used to fall through to
// the insufficient-content heuristic and read as expired, which dedup-blocks
// the posting from every future scan. Any 5xx is transient, never "gone".
for (const status of [500, 502, 504]) {
  const verdict = classifyLiveness({
    status,
    requestedUrl: 'https://careers.example.com/job/123',
    finalUrl: 'https://careers.example.com/job/123',
    bodyText: `${status} Bad Gateway\nnginx`,
    applyControls: [],
  });
  verdict.result === 'uncertain' && verdict.code === 'server_error'
    ? pass(`HTTP ${status} -> uncertain/server_error (was: expired via insufficient_content)`)
    : fail(`HTTP ${status} classified ${verdict.result}/${verdict.code}, expected uncertain/server_error`);
}

// 503 keeps its more specific access-blocked classification: the 5xx guard
// sits below it, so both halves of the verdict must hold, not just the code.
const blocked = classifyLiveness({ status: 503, finalUrl: 'https://careers.example.com/job/123', bodyText: 'checking your browser', applyControls: [] });
blocked.result === 'uncertain' && blocked.code === 'access_blocked'
  ? pass('HTTP 503 still classifies as uncertain/access_blocked, not server_error')
  : fail(`HTTP 503 classified ${blocked.result}/${blocked.code}, expected uncertain/access_blocked`);

// 429 is throttling, never evidence the posting is gone. Its body is a short
// "Too Many Requests" — under MIN_CONTENT_CHARS — so before the guard covered it
// the verdict fell through to insufficient_content and read as `expired`, which
// scan-history records as skipped_expired and every later scan dedup-skips.
const throttled = classifyLiveness({
  status: 429,
  requestedUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
  finalUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
  bodyText: 'Too Many Requests. Please retry after some time.',
  applyControls: [],
});
throttled.result === 'uncertain' && throttled.code === 'access_blocked'
  ? pass('HTTP 429 classifies as uncertain/access_blocked, not expired')
  : fail(`HTTP 429 classified ${throttled.result}/${throttled.code}, expected uncertain/access_blocked`);

// A real 404/410 is still authoritative expiry — both statuses, both halves.
for (const status of [404, 410]) {
  const gone = classifyLiveness({
    status,
    finalUrl: 'https://careers.example.com/job/123',
    bodyText: 'Not found',
    applyControls: [],
  });
  gone.result === 'expired' && gone.code === 'http_gone'
    ? pass(`HTTP ${status} still -> expired/http_gone`)
    : fail(`HTTP ${status} classified ${gone.result}/${gone.code}, expected expired/http_gone`);
}

// ── Expiry stated in the redirect target's path ─────────────────────────────
//
// A dead permalink that 301s to a page whose PATH says the job is gone carries
// exactly the evidence an expired BODY phrase does. Before this, only the body
// and `?error=true` were read, so the redirect fell through to the generic
// "job id missing from final URL" rule and returned `uncertain` — which under
// modes/run.md means "go and re-verify by hand".
//
// Observed live 2026-08-18: four of six BMW Group postings redirected to
// bmwgroup.jobs/.../de/de/job-no-longer-available.html. Four unambiguous
// closures, four manual re-checks demanded.

{
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.bmwgroup.jobs/de/de/jobfinder/job-description.189100.html',
    finalUrl: 'https://www.bmwgroup.jobs/content/grpw/websites/bmwgroup_jobs/de/de/job-no-longer-available.html',
    bodyText: 'BMW Group careers. Search our open positions.',
    applyControls: ['Apply now'],
  });
  r.result === 'expired'
    ? pass('a redirect to job-no-longer-available is expired, not uncertain')
    : fail(`BMW redirect classified ${r.result}/${r.code}, expected expired`);
  r.code === 'expired_url'
    ? pass('and the code names the URL as the evidence')
    : fail(`expected expired_url, got ${r.code}`);
}

{
  // LinkedIn puts the expiry in a TRACKING PARAMETER, not the path: a dead
  // posting 302s to a search page with `trk=expired_jd_redirect`. The job id is
  // gone from the final URL, so the generic id-missing rule would otherwise
  // claim it and return `uncertain` — "re-verify by hand" for a site that just
  // said in writing that the job expired. Observed 2026-08-19 on hits from the
  // Stage 1b WebSearch sweep, where stale snapshots are the common case.
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://de.linkedin.com/jobs/view/werkstudent-w-m-d-data-science-at-siemens-3864190966',
    finalUrl: 'https://de.linkedin.com/jobs/siemens-healthineers-stellen?trk=expired_jd_redirect&position=1&pageNum=0',
    bodyText: 'Siemens Healthineers jobs. Browse open roles.',
    applyControls: ['Apply'],
  });
  r.result === 'expired'
    ? pass('a LinkedIn trk=expired_jd_redirect is expired, not uncertain')
    : fail(`LinkedIn expired redirect classified ${r.result}/${r.code}, expected expired`);

  // The guard around it: a LIVE LinkedIn posting also carries trk parameters,
  // and none of them may be read as an expiry.
  const live = classifyLiveness({
    status: 200,
    requestedUrl: 'https://de.linkedin.com/jobs/view/data-scientist-at-acme-4111222333',
    finalUrl: 'https://de.linkedin.com/jobs/view/data-scientist-at-acme-4111222333?trk=public_jobs_topcard',
    bodyText: 'Acme is hiring a Data Scientist in Erlangen. '.repeat(40),
    applyControls: ['Apply'],
  });
  live.result !== 'expired'
    ? pass('an ordinary trk= parameter on a live posting is not an expiry')
    : fail(`live LinkedIn posting misclassified ${live.result}/${live.code}`);
}

{
  // Same shape, other vocabularies — the pattern must not be BMW-specific.
  const en = classifyLiveness({
    status: 200, requestedUrl: 'https://x.com/jobs/123',
    finalUrl: 'https://x.com/careers/position-no-longer-available',
    bodyText: 'Careers', applyControls: ['Apply'],
  });
  const de = classifyLiveness({
    status: 200, requestedUrl: 'https://x.de/job/9',
    finalUrl: 'https://x.de/stellenangebot-nicht-gefunden',
    bodyText: 'Karriere', applyControls: ['Bewerben'],
  });
  en.result === 'expired' && de.result === 'expired'
    ? pass('the English and German "no longer available" landing pages both read as expired')
    : fail(`en=${en.result} de=${de.result}, expected both expired`);
}

{
  // The guard that matters: a LIVE posting whose body happens to talk about
  // availability must not be dragged into `expired`. Only the final URL is read.
  const r = classifyLiveness({
    status: 200, requestedUrl: 'https://x.com/jobs/55', finalUrl: 'https://x.com/jobs/55',
    bodyText: 'This role is available immediately and the position is not closed. Apply now.',
    applyControls: ['Apply'],
  });
  r.result === 'active'
    ? pass('a live posting that merely discusses availability stays active')
    : fail(`healthy posting classified ${r.result}/${r.code}`);
}

// ── StepStone's apply control ───────────────────────────────────────────────
//
// StepStone renders its apply button client-side, so /bewerben/ never matched
// and every StepStone posting returned `no_apply_control` however healthy.
// modes/run.md documents this as a known false negative whose remedy is
// --skip-liveness — but a gate the operator is trained to bypass protects
// nothing, so the checker now matches what StepStone actually renders.
//
// The docs also warn against grepping for "bewerben" as proof, because it hits
// the footer's "Bewerbende" (Applicants) nav label. These strings do not.

{
  const live = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.stepstone.de/stellenangebote--x--14405387-inline.html',
    finalUrl: 'https://www.stepstone.de/stellenangebote--x--14405387-inline.html',
    bodyText: 'Werkstudent Data Engineer (m/w/d) Sana HR Solutions GmbH Muenchen. '
      + 'Studentenjobs, Werkstudent. Homeoffice moeglich, Teilzeit. Erschienen: vor 16 Stunden. '
      + 'Ich bin interessiert. Deine Aufgaben: Du entwickelst und transformierst Datenmodelle mit dbt.',
    applyControls: ['Ich bin interessiert', 'Speichern'],
  });
  live.result === 'active'
    ? pass('a live StepStone posting is active via "Ich bin interessiert"')
    : fail(`live StepStone classified ${live.result}/${live.code}`);
}

{
  const quick = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.stepstone.de/stellenangebote--y--999-inline.html',
    finalUrl: 'https://www.stepstone.de/stellenangebote--y--999-inline.html',
    bodyText: 'Junior AI Automation Developer (m/w/d) Workspacer Muenchen. Feste Anstellung. '
      + 'Schnelle Bewerbung. Aufgaben: Du entwickelst KI-Automatisierungen in Plattformen wie n8n.',
    applyControls: ['Schnelle Bewerbung'],
  });
  quick.result === 'active'
    ? pass('"Schnelle Bewerbung" is also recognised as an apply control')
    : fail(`quick-apply StepStone classified ${quick.result}/${quick.code}`);
}

{
  // The guard: a StepStone chrome-only page (footer nav, no posting) must still
  // fail. "Bewerbende" in the footer must NOT read as an apply control.
  const footer = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.stepstone.de/stellenangebote--z--111-inline.html',
    finalUrl: 'https://www.stepstone.de/stellenangebote--z--111-inline.html',
    bodyText: 'Stepstone. Ueber uns. Karriere bei Stepstone. Presse. Bewerbende. Arbeitgebende. Impressum.',
    applyControls: [],
  });
  footer.result !== 'active'
    ? pass('a StepStone page with only footer chrome is NOT active')
    : fail('footer-only StepStone page wrongly classified active');
}

// ── The SITE is broken, not the posting ─────────────────────────────────────
//
// Cornerstone answers a session or backend fault with error.aspx and "An error
// occurred while processing your request" — no not-found wording, and it serves
// that page for every URL on the tenant including the careers index. Read as a
// content-bearing page with no apply control, it produced `no_apply_control`
// and the reason "content present but no visible apply control found": true,
// and misleading enough to send someone checking a posting that was fine.
//
// Observed live 2026-08-19: trench.csod.com returned it for req1690 AND for the
// careers home page, while the requisition itself was still open.
//
// The ordering against the not-found checks is the whole safety property, so
// both directions are pinned here.

{
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://trench.csod.com/ux/ats/careersite/1/home/requisition/1690?c=trench',
    finalUrl: 'https://trench.csod.com/error.aspx',
    bodyText: 'An error occurred while processing your request. You may continue working in '
      + 'another area of the system by clicking on another tab or link above. If this problem '
      + 'persists, please contact your system administrator and provide the following error details.',
    applyControls: [],
  });
  r.result === 'uncertain'
    ? pass('an ATS-wide error page is uncertain, never expired')
    : fail(`Cornerstone error page classified ${r.result}/${r.code}`);
  r.code === 'site_error'
    ? pass('and it carries its own code so the SITE is re-checked, not the requisition')
    : fail(`expected site_error, got ${r.code}`);
}

{
  // The guard: an error page that DOES name the posting as missing must stay
  // expired. Siemens serves "An error has occurred / Page not found" with a 403
  // for a withdrawn requisition — verified 2026-08-19 by fetching a sibling req
  // from the same host in the same minute, which returned 200 with its full JD.
  const r = classifyLiveness({
    status: 403,
    requestedUrl: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/515782',
    finalUrl: 'https://jobs.siemens.com/en_US/externaljobs/Error',
    bodyText: 'An error has occurred Page not found Go to open jobs',
    applyControls: [],
  });
  r.result === 'expired'
    ? pass('an error page that says "page not found" is still expired')
    : fail(`Siemens withdrawn posting classified ${r.result}/${r.code}`);
}

console.log('\nliveness-core — an aggregator delisting its own mirror is uncertain, not active');

{
  // Arbeitnow serves this under HTTP 200 with the entire JD, apply control and
  // all, still rendered below the banner — so the control is not evidence about
  // the requisition. Verified 2026-08-31: the ITONICS working-student req was
  // still open on itonics-gmbh.jobs.personio.de after arbeitnow had removed it,
  // and the old behaviour reported the row active against a dead mirror URL.
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.arbeitnow.com/jobs/companies/itonics/working-student-it-nurnberg-412516',
    finalUrl: 'https://www.arbeitnow.com/jobs/companies/itonics/working-student-it-nurnberg-412516',
    bodyText: 'This job position has been removed from Arbeitnow and might not be hiring still. '
      + 'Working Student (m/f/x) - IT ITONICS Nuremberg As a working student you help keep '
      + "ITONICS' internal IT environment reliable, secure, and easy to work with.",
    applyControls: ['Apply'],
  });
  r.result === 'uncertain'
    ? pass('an aggregator removal banner is not an active posting despite the apply control')
    : fail(`arbeitnow delisting classified ${r.result}/${r.code}`);
  r.code === 'aggregator_delisted'
    ? pass('and it carries its own code, pointing the re-check at the employer\'s own board')
    : fail(`expected aggregator_delisted, got ${r.code}`);
}

{
  // The guard in the other direction: uncertain, never expired. A false expired
  // writes skipped_expired into scan-history and filters the live job out of
  // every later scan — the exact error this posting would have suffered.
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.arbeitnow.com/jobs/companies/itonics/working-student-it-nurnberg-412516',
    finalUrl: 'https://www.arbeitnow.com/jobs/companies/itonics/working-student-it-nurnberg-412516',
    bodyText: 'This job position has been removed from Arbeitnow and might not be hiring still. '
      + 'Working Student (m/f/x) - IT ITONICS Nuremberg Your Contribution As a working student '
      + 'you help keep the internal IT environment reliable, secure, and easy to work with.',
    applyControls: [],
  });
  r.result !== 'expired'
    ? pass('a hedged aggregator banner never hard-expires a job that may still be open')
    : fail('arbeitnow delisting hard-expired the posting');
}

{
  // And a real employer-side closure still wins: the aggregator rule sits AFTER
  // the hard-expiry checks, so a genuinely closed posting is expired even when
  // the mirror also announces its own removal.
  const r = classifyLiveness({
    status: 200,
    requestedUrl: 'https://www.arbeitnow.com/jobs/companies/x/y-123',
    finalUrl: 'https://www.arbeitnow.com/jobs/companies/x/y-123',
    bodyText: 'This job position has been removed from Arbeitnow. '
      + 'This job has expired and the employer is no longer accepting applications.',
    applyControls: [],
  });
  r.result === 'expired'
    ? pass('a stated employer-side expiry still outranks the aggregator banner')
    : fail(`real expiry under a delisting banner classified ${r.result}/${r.code}`);
}
