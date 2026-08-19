// Portals write closure banners with typographic punctuation and accents:
// WTTJ renders "Cette offre n’est plus disponible." with U+2019, not ASCII "'".
// A pattern spelled with a plain apostrophe silently never matches, so a clearly
// expired posting fell through to `no_apply_control` → uncertain → never filtered.
// Normalize once at the entry point and spell every pattern below in the
// normalized alphabet: ASCII quotes, no diacritics, collapsed whitespace.
function normalizeForMatch(text = '') {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  // Generalized "filled" signal. The old /position has been filled/ missed the
  // phrasing SPA ATSs (Phenom, e.g. careers.icf.com) inject on a filled req —
  // "the job you are trying to apply for has been filled" — so those pages
  // returned HTTP 200 with a generic Apply control and were classified active.
  // A job noun within 60 chars, then "has been filled" — but NOT when the thing
  // filled is an application/form (the lookbehind) or "filled out" (the
  // lookahead). Both guards avoid the worse error: reading a LIVE posting whose
  // copy says "once the application form has been filled…" as expired.
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  // French closure banners. Spelled accent-free on purpose: normalizeForMatch
  // strips diacritics, so "expiree" here matches "expirée" on the page.
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  /(offre|poste|annonce) (deja )?pourvu(e)?/i,
  /offre (cloturee|desactivee|terminee)/i,
  /ce poste n'est plus (disponible|a pourvoir|ouvert)/i,
  /recrutement (termine|cloture)/i,
  /candidatures (closes|cloturees)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

// Anti-bot interstitials (Cloudflare "Just a moment...", hCaptcha walls, etc.)
// render a tiny challenge page instead of the posting. Headless Playwright trips
// these on portals like pracuj.pl. They must NOT be read as expired: the body is
// short and lacks an apply control, so without this guard they fall through to
// `insufficient_content` → expired, and scan --verify would write live jobs to
// scan-history and permanently filter them out. Treat as uncertain instead.
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /\bcf-ray\b/i,
  /please complete the security check/i,
  // A captcha IS a challenge — it invites you to prove you are human.
  /\bcaptcha\b/i,
];

// Generic WAF / access-denial phrasing (Akamai, AWS WAF, F5, reverse proxies).
// Not a challenge: it does not invite you to prove anything, it refuses. These
// must outrank NOT_FOUND_BODY_PATTERNS, because a denial page often contains
// the word "error" — but they must NOT report bot_challenge, because the
// operator's response differs: a challenge may pass in a real browser, a
// denial will not.
const ACCESS_DENIED_PATTERNS = [
  /access denied/i,
  /request blocked/i,
];

// Explicit not-found/gone phrasing, used ONLY to override a blocking status
// code (401/403/429/503, any 5xx) that would otherwise short-circuit to
// `uncertain` before the body is ever read. See classifyLiveness for why this
// exists: jobs.siemens.com serves its SPA's client-side 404 route ("An error
// has occurred — Page not found") with HTTP 403, because the origin's
// anti-bot layer and the SPA's own routing are independent — the app renders
// its error page for the dead id regardless of what the edge does with the
// request. Reading only the status code there reads a deleted posting as
// "probably fine, just blocked" — worse than uncertain, because
// modes/run.md trains the operator to route exactly that verdict through
// `--skip-liveness`.
//
// PRECEDENCE (must hold, and is enforced by call order in classifyLiveness,
// not by anything in this list): BOT_CHALLENGE_PATTERNS is checked first and
// unconditionally, before status is even inspected. A challenge page often
// contains the bare word "error" too ("we hit an error verifying you're
// human"), so if these ran first a challenge could misread as expired. Every
// pattern here is deliberately a specific not-found/gone phrase rather than a
// bare generic word, precisely so it cannot out-rank a challenge marker on
// meaning alone — but the real guarantee is the check order below.
const NOT_FOUND_BODY_PATTERNS = [
  /page not found/i,
  /the page you(?:'re| are) looking for (?:doesn.t|does not) exist/i,
  /an error has occurred/i,
  /\b404\b/,
  /\bjob not found\b/i,
  /\bposition not found\b/i,
  /no longer available/i,
  /stellenangebot nicht gefunden/i,
  /seite nicht gefunden/i,
  /diese seite existiert nicht/i,
];

/**
 * Look for an explicit not-found/gone signal in a response body that arrived
 * with a blocking status code. Returns null (never a guess) for an empty or
 * whitespace-only body — a blocked response with no body at all carries no
 * evidence either way, so the existing `uncertain` verdict must stand.
 *
 * @param {string} bodyText - Already normalized via normalizeForMatch.
 * @returns {RegExp|null} The matched pattern, or null.
 */
function notFoundBodySignal(bodyText = '') {
  if (!bodyText || !bodyText.trim()) return null;
  return firstMatch(NOT_FOUND_BODY_PATTERNS, bodyText);
}

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
  // An ATS that redirects a dead permalink to a page whose PATH says the job is
  // gone. This is the same evidence as an expired body phrase, just delivered in
  // the URL, and it must outrank the generic "job id missing from final URL"
  // rule below — that rule returns `uncertain` because a portal migration can
  // 301 live postings too, but nothing migrates a posting TO a page called
  // job-no-longer-available. Observed live 2026-08-18: four of six BMW Group
  // postings redirected to
  // bmwgroup.jobs/.../de/de/job-no-longer-available.html and every one was
  // reported `uncertain`, which under modes/run.md means "re-verify by hand"
  // — six manual checks for four unambiguous closures.
  /job[-_]?no[-_]?longer[-_]?available/i,
  /(?:job|position|vacancy|stelle|posting)[-_]?(?:not[-_]?found|expired|closed|removed|unavailable)/i,
  /no[-_]?longer[-_]?(?:available|accepting|open)/i,
  /stellenangebot[-_]?(?:nicht[-_]?gefunden|abgelaufen)/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  // StepStone renders its apply button client-side, so `/bewerben/` never
  // matches and every StepStone posting came back `no_apply_control` however
  // healthy — modes/run.md documents this as a known false negative whose
  // remedy is --skip-liveness. Training the operator to bypass the gate is
  // worse than the wrong verdict, so match what StepStone ACTUALLY renders.
  //
  // These two strings are the apply affordances on a live StepStone listing.
  // Neither collides with the footer's "Bewerbende" (Applicants) nav label,
  // which is the false positive the docs warn against grepping for.
  /ich bin interessiert/i,
  /schnelle bewerbung/i,
  // Polish (pracuj.pl, justjoin.it, bulldogjob.pl): "Aplikuj" / "Aplikuj teraz" /
  // "Wyślij CV" / "Przejdź do panelu aplikowania". Without these, a fully-loaded
  // Polish posting has no recognized apply control and falls to no_apply_control.
  /\baplikuj\b/i,
  /panelu aplikowania/i,
  // Accent-free: apply controls go through normalizeForMatch too ("wyślij" → "wyslij").
  /wyslij (cv|aplikacj)/i,
];

// Some postings have no Apply button because the application channel IS email:
// the JD says "send your application to x@y". Academic and public-sector German
// postings do this routinely — FAU FAPS, the top-scoring row in this pipeline,
// was blocked by exactly this. Without these patterns such a posting falls to
// `no_apply_control` → uncertain → `build-application.mjs` aborts, and the only
// way through was `--skip-liveness`, which disables the check for real closures
// too. Detecting the channel is strictly better than disabling the gate.
//
// Deliberately narrow: an email address alone is NOT enough (career pages carry
// "questions? careers@…" in body copy). The imperative application phrasing must
// be present, within a short window of an address, and the window stops at a
// sentence boundary so two unrelated sentences cannot combine into a match.
//
// `W` is that window. A dot only ends a sentence when whitespace follows it, so
// `.` inside an address must stay legal — the real FAU case is
// "send your application documents to patrick.ziegler@faps.fau.de", where a
// dot-free window cannot reach past the local part and the match is lost.
const W = '(?:[^.!?\\n]|[.!?](?!\\s))';
const ADDR = '@[a-z0-9.-]+\\.[a-z]{2,}';

const EMAIL_APPLY_PATTERNS = [
  // EN: "send/submit/email your application|CV|resume|documents ... to x@y"
  new RegExp(`(?:send|submit|e-?mail|forward)${W}{0,60}(?:application|applications|cv|resume|résumé|documents)${W}{0,80}${ADDR}`, 'i'),
  // EN: "apply by/via email", "applications by email to"
  /(?:apply|application|applications)\s+(?:by|via|per|through)\s+e-?mail/i,
  // DE: "Bewerbung(en) ... per/an/via E-Mail", "Bewerbung an x@y",
  // "richten/senden Sie Ihre Bewerbung an x@y"
  /bewerbung(?:en|sunterlagen)?[^.!?\n]{0,80}(?:per|via|an)\s+e-?-?mail/i,
  new RegExp(`bewerbung(?:en|sunterlagen)?${W}{0,80}${ADDR}`, 'i'),
  new RegExp(`(?:richten|senden|schicken)\\s+sie${W}{0,100}${ADDR}`, 'i'),
  // FR: "envoyez/adressez votre candidature à x@y", "candidature par e-mail"
  /candidature[^.!?\n]{0,80}(?:par|via)\s+e-?-?mail/i,
  new RegExp(`(?:envoyez|adressez)${W}{0,100}${ADDR}`, 'i'),
  // ES: "envía tu candidatura/CV a x@y"
  new RegExp(`(?:envi[aá]|remite|manda)${W}{0,100}${ADDR}`, 'i'),
];

// A visible `mailto:` control inside the posting body (nav/header/footer are
// already excluded upstream) is the strongest form of the same signal.
const MAILTO_CONTROL = /\bmailto:/i;

function hasEmailApplyChannel(bodyText = '', applyControls = []) {
  if (applyControls.some((control) => MAILTO_CONTROL.test(control))) return 'mailto control';
  const matched = firstMatch(EMAIL_APPLY_PATTERNS, bodyText);
  return matched ? matched.source : null;
}

const MIN_CONTENT_CHARS = 300;

// A job-detail URL almost always carries the posting's identity: a numeric req id
// (Greenhouse, Workday pid, Microsoft) or a UUID (Lever, Ashby). If the requested
// URL had one and the final URL lost it, the browser landed somewhere else.
const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function jobIdToken(url = '') {
  const matches = url.match(JOB_ID_TOKEN);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

/**
 * Pull checkable URLs out of a `check-liveness.mjs --file` argument.
 *
 * Accepts both shapes the project passes:
 *   - a plain list, one URL per line (`#` comments and blanks ignored)
 *   - `data/pipeline.md`, whose rows are `- [ ] {url} | {company} | {title} | ...`
 *
 * Reading the inbox directly is the point: the `pipeline` mode Liveness sweep used
 * to ask the agent to hand-copy URLs into a temp file, which costs tokens and is
 * the step that gets skipped, and `--file data/pipeline.md` (already printed in
 * `modes/apply.md` and `docs/APPLY_AUTOFILL.md`) used to feed Playwright whole
 * markdown rows as URLs.
 *
 * Only unprocessed `- [ ]` rows are swept: `- [x]` is already resolved and `- [!]`
 * was unreachable at extraction time, so re-checking either wastes a browser run.
 * Lines carrying no http(s) URL — `local:jds/…` entries, prose, table rules — are
 * counted rather than passed along, and the caller reports the count.
 *
 * @param {string} text file contents
 * @returns {{ urls: string[], skipped: number }}
 */
export function extractPipelineUrls(text = '') {
  const urls = [];
  let skipped = 0;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const task = /^[-*]\s*\[(.)\]\s*/.exec(line);
    if (task && task[1] !== ' ') continue;

    const body = task ? line.slice(task[0].length) : line;
    // Stop at the pipeline row's column separator, a closing paren, or a bracket so
    // both `{url} | {company}` rows and markdown links yield the bare URL.
    const match = /https?:\/\/[^\s|)\]>]+/.exec(body);
    if (match) urls.push(match[0]);
    else skipped++;
  }

  return { urls, skipped };
}

export function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText: rawBodyText = '', applyControls: rawApplyControls = [] } = {}) {
  const bodyText = normalizeForMatch(rawBodyText);
  const applyControls = (Array.isArray(rawApplyControls) ? rawApplyControls : []).map(normalizeForMatch);

  if (status === 404 || status === 410) {
    return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  }

  // Bot/anti-scraping walls — never expired. Check before the content-length and
  // listing-page heuristics, which would otherwise misread the short challenge
  // body as a dead posting. 403/503 are access-blocked signals, not "gone"
  // (a genuinely removed posting returns 404/410 or a hard-expired banner).
  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) {
    return { result: 'uncertain', code: 'bot_challenge', reason: `anti-bot challenge: ${botChallenge.source}` };
  }
  if (status === 403 || status === 503) {
    // The body outranks the status code in both directions (already true for
    // 200 + not-found via insufficient_content/HARD_EXPIRED_PATTERNS below).
    // This is the other direction: a blocking status whose body plainly says
    // the posting is gone. Real Siemens case: HTTP 403, body "An error has
    // occurred — Page not found".
    const denied = firstMatch(ACCESS_DENIED_PATTERNS, bodyText);
    if (denied) {
      return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status} (access denied: ${denied.source})` };
    }
    const notFound = notFoundBodySignal(bodyText);
    if (notFound) {
      return { result: 'expired', code: 'not_found_body', reason: `HTTP ${status} but body reads not-found: ${notFound.source}` };
    }
    return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status} (access blocked, likely anti-bot)` };
  }
  // Any other 5xx is a transient origin error (502/504 gateway hiccups, 500s
  // during deploys), not evidence the posting is gone. Without this guard the
  // short error body ("502 Bad Gateway / nginx") falls through to the
  // insufficient-content heuristic and reads as expired — and a false
  // "expired" permanently dedup-filters a real job out of future scans.
  if (status >= 500) {
    const notFound = notFoundBodySignal(bodyText);
    if (notFound) {
      return { result: 'expired', code: 'not_found_body', reason: `HTTP ${status} but body reads not-found: ${notFound.source}` };
    }
    return { result: 'uncertain', code: 'server_error', reason: `HTTP ${status} (transient server error)` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', code: 'expired_url', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  }

  // A dead permalink that 301s to a generic search/listing page still shows
  // "Apply" buttons — on OTHER jobs' cards (seen when jobs.careers.microsoft.com
  // permalinks migrated to apply.careers.microsoft.com). When the requested URL
  // carried a job identifier and the final URL lost it, the page being read is
  // not the posting, so apply controls are not evidence of liveness. Uncertain,
  // not expired: a portal migration can 301 live postings too, and a false
  // "expired" permanently filters a real job out of scans.
  const jobId = jobIdToken(requestedUrl);
  if (jobId && finalUrl && !finalUrl.toLowerCase().includes(jobId)) {
    return {
      result: 'uncertain',
      code: 'redirected_off_posting',
      reason: `redirected to ${finalUrl} — job id "${jobId}" missing from final URL`,
    };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', code: 'listing_page', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', code: 'insufficient_content', reason: 'insufficient content — likely nav/footer only' };
  }

  // No Apply control, but the posting says how to apply: by email. Checked last,
  // so every expiry signal above still wins — a filled req that happens to print
  // a contact address is expired, not "applies by email".
  const emailChannel = hasEmailApplyChannel(bodyText, applyControls);
  if (emailChannel) {
    return {
      result: 'active',
      code: 'email_apply_channel',
      reason: `no apply control, but the posting applies by email (${emailChannel})`,
    };
  }

  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no visible apply control found' };
}
