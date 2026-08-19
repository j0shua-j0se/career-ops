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
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
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

// ---------------------------------------------------------------------------
// A blocking status code (403/503/5xx) must not out-rank an explicit
// not-found body. Regression for the Siemens near-miss: jobs.siemens.com
// redirects a deleted posting to its SPA error route, which renders "An
// error has occurred — Page not found" — but the server answers that page
// with HTTP 403. The old code read the status alone and returned
// uncertain/access_blocked, and modes/run.md trains the operator to route
// exactly that verdict through --skip-liveness, which would have produced a
// tailored CV/cover letter for a dead posting.
console.log('\nliveness-core — a blocking status with a not-found body classifies as expired, not uncertain');

{
  // The real Siemens shape: HTTP 403, SPA error route body.
  const r = classifyLiveness({
    status: 403,
    requestedUrl: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/516903',
    finalUrl: 'https://jobs.siemens.com/en_US/externaljobs/Error',
    bodyText: 'An error has occurred — Page not found',
    applyControls: [],
  });
  r.result === 'expired' && r.code === 'not_found_body'
    ? pass('Siemens shape: HTTP 403 + "An error has occurred — Page not found" -> expired/not_found_body')
    : fail(`Siemens shape classified ${r.result}/${r.code}, expected expired/not_found_body`);
}

{
  // Cloudflare challenge markers must still win over a blocking status, even
  // though the body carries no not-found phrasing at all.
  const r = classifyLiveness({ status: 403, bodyText: 'Just a moment... checking your browser before accessing this site.', applyControls: [] });
  r.result === 'uncertain' && r.code === 'bot_challenge'
    ? pass('HTTP 403 + Cloudflare challenge body -> uncertain/bot_challenge (unchanged)')
    : fail(`HTTP 403 + challenge body classified ${r.result}/${r.code}, expected uncertain/bot_challenge`);
}

{
  // No body at all: no evidence either way, prior behaviour must hold.
  const r = classifyLiveness({ status: 403, bodyText: '', applyControls: [] });
  r.result === 'uncertain' && r.code === 'access_blocked'
    ? pass('HTTP 403 + empty body -> uncertain/access_blocked (unchanged)')
    : fail(`HTTP 403 + empty body classified ${r.result}/${r.code}, expected uncertain/access_blocked`);
}

{
  // No regression: a 200 not-found body (DATEV/Workday shape) was already
  // caught via the existing insufficient-content / HARD_EXPIRED_PATTERNS path.
  const r = classifyLiveness({ status: 200, bodyText: "The page you're looking for doesn't exist", applyControls: [] });
  r.result === 'expired'
    ? pass('HTTP 200 + not-found body still classifies expired (no regression)')
    : fail(`HTTP 200 + not-found body classified ${r.result}, expected expired`);
}

{
  // Precedence: a WAF denial AND a bare generic error word together must stay
  // uncertain — the thing that must never happen is a blocked page reading as
  // `expired`, which would permanently filter a live job out of future scans.
  // The code is access_blocked, not bot_challenge: this body denies, it does
  // not invite anyone to prove they are human. (A genuine challenge marker is
  // covered separately below.)
  const r = classifyLiveness({ status: 403, bodyText: 'Access Denied. An error occurred while processing your request.', applyControls: [] });
  r.result === 'uncertain' && r.code === 'access_blocked'
    ? pass('HTTP 403 + denial + generic "error" word -> uncertain (never expired)')
    : fail(`HTTP 403 + denial + "error" classified ${r.result}/${r.code}, expected uncertain/access_blocked`);
}

{
  // A healthy live posting behind no blocking status is unaffected.
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://boards.greenhouse.io/acme/jobs/456',
    bodyText: 'Senior Backend Engineer. Own the payments platform end to end. Apply now.',
    applyControls: ['Apply now'],
  });
  r.result === 'active' && r.code === 'apply_control_visible'
    ? pass('a healthy 200 posting still classifies active (no regression)')
    : fail(`healthy posting classified ${r.result}/${r.code}, expected active/apply_control_visible`);
}

{
  // 429 isn't one of the statuses classifyLiveness short-circuits on, so it was
  // already falling through to the normal body-reading pipeline (HARD_EXPIRED_PATTERNS
  // catches it there) rather than the new access_blocked/server_error branches.
  // Asserted here so the scope of this change (403/503/5xx) stays documented and
  // doesn't silently regress if 429 gains a short-circuit later.
  const r = classifyLiveness({ status: 429, bodyText: 'This job is no longer available.', applyControls: [] });
  r.result === 'expired'
    ? pass('HTTP 429 with a not-found body still classifies expired via the existing body pipeline')
    : fail(`HTTP 429 + not-found body classified ${r.result}, expected expired`);
}

{
  // A 5xx (server_error branch) with an unambiguous not-found body.
  const r = classifyLiveness({ status: 500, bodyText: 'position not found', applyControls: [] });
  r.result === 'expired' && r.code === 'not_found_body'
    ? pass('HTTP 500 + "position not found" body -> expired/not_found_body')
    : fail(`HTTP 500 + not-found body classified ${r.result}/${r.code}, expected expired/not_found_body`);
}

{
  // A 5xx with a generic gateway body (no not-found phrase) must stay uncertain.
  const r = classifyLiveness({ status: 502, bodyText: '502 Bad Gateway\nnginx', applyControls: [] });
  r.result === 'uncertain' && r.code === 'server_error'
    ? pass('HTTP 502 + generic gateway body still classifies uncertain/server_error (no regression)')
    : fail(`HTTP 502 + gateway body classified ${r.result}/${r.code}, expected uncertain/server_error`);
}

// ── Drift guard: aria-hidden must not disqualify an apply control ──────────
// The apply-control extractor runs inside page.evaluate(), so it cannot be unit
// tested without a browser — this guards the invariant at the source level.
//
// Primetals' Phenom careers portal renders five "Apply Now" links on a live
// requisition, all with correct display/visibility and non-zero geometry, every
// one inside an `aria-hidden="true"` wrapper. While the extractor rejected any
// element with an aria-hidden ancestor, that live posting classified as
// "content present but no visible apply control found" and aborted every kit
// build for it. aria-hidden is an accessibility-tree signal, not a rendering
// one, and portals misuse it on painted content; the geometric checks are the
// real evidence and reject genuinely hidden elements on their own.
{
  const src = readFileSync(join(ROOT, 'liveness-browser.mjs'), 'utf-8');
  if (!/closest\(\s*['"`]\[aria-hidden="true"\]['"`]\s*\)/.test(src)) {
    pass('the apply-control extractor does not disqualify elements by aria-hidden ancestor');
  } else {
    fail('liveness-browser.mjs rejects apply controls with an aria-hidden ancestor again — this reports live Phenom/Primetals postings as uncertain');
  }
  // The geometry checks are what makes dropping the aria-hidden rule safe, so
  // they must still be present.
  const geo = /getClientRects\(\)/.test(src) && /display\s*===\s*['"`]none['"`]/.test(src) && /visibility\s*===\s*['"`]hidden['"`]/.test(src);
  if (geo) pass('the extractor still rejects display:none, visibility:hidden and zero-geometry elements');
  else fail('the geometric visibility checks are missing — dropping the aria-hidden rule is only safe alongside them');
}

// ---------------------------------------------------------------------------
// Postings that apply BY EMAIL have no Apply button by design.
//
// FAU FAPS — the highest-scoring row in this pipeline — is an academic posting
// whose JD says to send the application to a named address. It has no Apply
// control, so classifyLiveness dead-ended at `no_apply_control` → uncertain, and
// `build-application.mjs` aborted the kit. The only workaround was
// `--skip-liveness`, which disables the gate for genuine closures too.
//
// The check is deliberately last: every expiry signal still wins, so a filled
// req that happens to print a contact address stays expired.
console.log('\nliveness-core — email-application postings classify as active, not uncertain');

const BODY = 'Werkstudent Machine Learning. '.repeat(20); // clears MIN_CONTENT_CHARS

const classify = (bodyText, applyControls = []) =>
  classifyLiveness({ status: 200, requestedUrl: 'https://www.faps.fau.de/stellen/123', finalUrl: 'https://www.faps.fau.de/stellen/123', bodyText, applyControls });

{
  const r = classify(`${BODY} Please send your application documents to patrick.ziegler@faps.fau.de`);
  r.result === 'active' && r.code === 'email_apply_channel'
    ? pass('EN "send your application documents to x@y" -> active (email_apply_channel)')
    : fail(`EN email-application posting classified ${r.result}/${r.code}, expected active/email_apply_channel`);
}

{
  const r = classify(`${BODY} Bitte richten Sie Ihre Bewerbung an bewerbung@example.de`);
  r.result === 'active' && r.code === 'email_apply_channel'
    ? pass('DE "richten Sie Ihre Bewerbung an x@y" -> active')
    : fail(`DE email-application posting classified ${r.result}/${r.code}`);
}

{
  const r = classify(`${BODY} Bewerbungen bitte per E-Mail.`);
  r.result === 'active'
    ? pass('DE "Bewerbungen bitte per E-Mail" -> active')
    : fail(`DE "per E-Mail" classified ${r.result}`);
}

{
  const r = classify(`${BODY} Applications by email only.`);
  r.result === 'active'
    ? pass('EN "applications by email" -> active')
    : fail(`EN "applications by email" classified ${r.result}`);
}

// A visible mailto: control is the strongest form of the signal, and works even
// when the body copy never spells out the channel.
{
  const r = classify(BODY, ['patrick.ziegler@faps.fau.de mailto:patrick.ziegler@faps.fau.de']);
  r.result === 'active' && r.code === 'email_apply_channel'
    ? pass('a visible mailto: control alone -> active')
    : fail(`mailto: control classified ${r.result}/${r.code}`);
}

// --- False-positive guards: the expensive error is calling a dead posting live.

{
  const r = classify(`${BODY} This position has been filled. Questions? Send your CV to careers@example.com`);
  r.result === 'expired'
    ? pass('an expired req printing an application address stays expired (expiry wins)')
    : fail(`expired req with a contact address classified ${r.result} — expiry must win`);
}

{
  const r = classify(`${BODY} For questions about this role contact careers@example.com`);
  r.result === 'uncertain'
    ? pass('a bare contact address is NOT an application channel (stays uncertain)')
    : fail(`bare contact address classified ${r.result} — imperative phrasing is required`);
}

// The window must stop at a sentence boundary, so an unrelated sentence about
// applications cannot combine with a later, unrelated address.
{
  const r = classify(`${BODY} We review every application carefully. Our privacy officer is dpo@example.com`);
  r.result === 'uncertain'
    ? pass('phrasing and address in different sentences do NOT combine into a match')
    : fail(`cross-sentence match leaked: classified ${r.result}`);
}

// A real Apply control still wins outright and reports the original code.
{
  const r = classify(`${BODY} Send your application to jobs@example.com`, ['Apply now']);
  r.result === 'active' && r.code === 'apply_control_visible'
    ? pass('a real apply control still reports apply_control_visible, not the email path')
    : fail(`apply control regressed: ${r.result}/${r.code}`);
}

// 404 must not be rescued by an address in the error page.
{
  const r = classifyLiveness({ status: 404, bodyText: `${BODY} send your application to jobs@example.com`, applyControls: [] });
  r.result === 'expired'
    ? pass('HTTP 404 stays expired regardless of an application address in the body')
    : fail(`404 rescued by the email path — classified ${r.result}`);
}

// ---------------------------------------------------------------------------
// iCIMS serves the job description from a CROSS-ORIGIN content iframe.
//
// The outer page returns HTTP 200 carrying only nav, footer and cookie chrome —
// or, on some tenants, an AWS WAF human-verification challenge — so a live
// posting classified as "insufficient content" or "no visible apply control".
// Three independent triage passes over 152 iCIMS rows hit this and all three
// landed on the same answer: `?in_iframe=1` serves the iframe's own document.
// (A second working form, `?mobile=true&needsRedirect=false`, returns the
// server-rendered page; `in_iframe` is preferred because scan-ats-full.mjs
// already uses it for iCIMS search URLs.)
//
// Not a bot-detection bypass: it is iCIMS's own embedded-rendering parameter.
console.log('\nliveness-browser — iCIMS job URLs are fetched via their content iframe');

{
  const { fetchableUrl } = await import('../liveness-browser.mjs');

  const u = fetchableUrl('https://careers-otterproducts.icims.com/jobs/6912/ai-intern/job');
  /[?&]in_iframe=1/.test(u)
    ? pass('an iCIMS job URL gains in_iframe=1')
    : fail(`iCIMS URL not rewritten: ${u}`);

  // The rest of the URL must survive intact — path and existing query.
  const keep = fetchableUrl('https://careers-x.icims.com/jobs/1/job?foo=bar');
  keep.includes('/jobs/1/job') && keep.includes('foo=bar') && /in_iframe=1/.test(keep)
    ? pass('path and existing query parameters are preserved')
    : fail(`iCIMS rewrite damaged the URL: ${keep}`);

  // Idempotent, and an explicit opt-out is respected rather than overwritten.
  fetchableUrl('https://careers-x.icims.com/jobs/1/job?in_iframe=0') === 'https://careers-x.icims.com/jobs/1/job?in_iframe=0'
    ? pass('an existing in_iframe value is left alone')
    : fail('an explicit in_iframe value was overwritten');

  // Non-iCIMS hosts must be untouched — this is a vendor-specific quirk.
  for (const other of [
    'https://boards.greenhouse.io/acme/jobs/123',
    'https://jobs.lever.co/acme/uuid',
    'https://acme.wd3.myworkdayjobs.com/careers/job/Berlin/Engineer_R1',
  ]) {
    fetchableUrl(other) === other
      ? pass(`non-iCIMS URL untouched: ${new URL(other).hostname}`)
      : fail(`non-iCIMS URL was rewritten: ${other}`);
  }

  // Hostname matching must be anchored: a lookalike domain is not iCIMS.
  fetchableUrl('https://noticims.com/jobs/1') === 'https://noticims.com/jobs/1'
    ? pass('a lookalike hostname (noticims.com) is not treated as iCIMS')
    : fail('hostname match is not anchored — a lookalike domain was rewritten');

  // A non-URL string must pass through rather than throw.
  fetchableUrl('local:jds/acme.md') === 'local:jds/acme.md'
    ? pass('an unparseable URL is returned unchanged instead of throwing')
    : fail('unparseable input mishandled');
}

// ── WAF denial vs. not-found precedence ──────────────────────────────────────
// "Access denied" and "page not found" can appear on the same 403. A denial
// must win: it is not evidence the posting is gone, only that we were refused.
// Reporting it as bot_challenge would also be wrong — a challenge may pass in
// a real browser, a denial will not, so the operator's next move differs.
{
  const denied = classifyLiveness({ status: 403, bodyText: 'Access denied', finalUrl: 'https://x.example/j' });
  if (denied.result === 'uncertain' && denied.code === 'access_blocked') {
    pass('a 403 "Access denied" body is access_blocked, not bot_challenge');
  } else {
    fail(`403 "Access denied" gave ${denied.result} (${denied.code})`);
  }

  const both = classifyLiveness({ status: 403, bodyText: 'Access Denied - an error has occurred', finalUrl: 'https://x.example/j' });
  if (both.result === 'uncertain' && both.code === 'access_blocked') {
    pass('a denial outranks not-found wording on the same 403');
  } else {
    fail(`403 denial+not-found gave ${both.result} (${both.code})`);
  }

  const challenge = classifyLiveness({ status: 403, bodyText: 'Please complete the captcha to continue', finalUrl: 'https://x.example/j' });
  if (challenge.result === 'uncertain' && challenge.code === 'bot_challenge') {
    pass('a captcha is still reported as a bot challenge, not a denial');
  } else {
    fail(`403 captcha gave ${challenge.result} (${challenge.code})`);
  }
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
