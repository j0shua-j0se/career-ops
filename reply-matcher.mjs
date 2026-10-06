/**
 * reply-matcher.mjs — deterministic matcher that maps email reply candidates to application tracker entries.
 */

import { isPlaceholderCompany } from './lib/placeholder-cell.mjs';

export function extractDomain(emailStr) {
  if (!emailStr) return null;
  const match = emailStr.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeStr(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

export function normalizeChinese(s) {
  return (s || '')
    .replace(/有限公司/g, '')
    .replace(/公司/g, '')
    .replace(/股份/g, '')
    .replace(/集团/g, '')
    .trim();
}

// A company value that carries no letter and no digit is a PLACEHOLDER, not a
// name: `?` is the documented marker for an unknown end employer (#1596), and a
// hand-edited row can hold the tracker's other no-data sentinels (`—`, `-`).
// Substring-matching those turns punctuation into a company signal — and since
// replies ask questions, `?` matched almost every mail, scoring 2, corroborating
// partial role matches, and reaching confidence `high` next to any
// post-application keyword.
// Definition in lib/placeholder-cell.mjs — it lived here and in
// process-quality.mjs, and a third reader of the same files had neither.

// Short names must land on a word boundary. The normalized check further down
// has always required more than two characters, but the two substring checks
// above it had no floor at all, so `HP` matched the word `PHP`. A boundary
// keeps the short names that are real — HP, 3M, IBM — while refusing the ones
// that merely occur inside a longer word.
const SHORT_NAME_MAX = 3;

// ...but only where a word boundary can exist. Chinese and Japanese run without
// separators, so every neighbour of a name is itself a letter and the boundary
// NEVER holds — requiring one would refuse `腾讯` inside `我们是腾讯的招聘团队`,
// and two-character names are the norm in those scripts. They keep the
// substring path and the normalizeChinese() handling written for them below.
//
// Hangul is deliberately NOT here. Korean orthography separates words with
// spaces (띄어쓰기), so the boundary holds for it exactly as it does for Latin —
// listing it would have waived the guard for no gain, letting a short Korean
// name match inside a longer word, which is the very bug this rule exists to
// stop. Found because the test asked for it never failed when Hangul was
// removed (CodeRabbit, #3001).
const NO_WORD_SEPARATOR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// \p{M} sits alongside \p{L}/\p{N} in both lookarounds so a combining mark counts
// as part of a word rather than as a boundary. Without it, "data" matches inside
// "datá" — the mark belongs to the preceding base letter, so that is the middle
// of a word, not the end of one. This has to agree with LATIN_WORD_RE: a needle
// allowed to CONTAIN marks needs boundaries that treat marks as word material,
// or the two halves of the rule disagree about where a word ends.
function matchesOnWordBoundary(text, company) {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(text);
}

export function checkCompanyMatch(text, company) {
  if (!company || !text) return false;
  if (isPlaceholderCompany(company)) return false;

  // In a word-separated script, a company name is decided by the boundary test
  // alone: falling through to the substring checks below would reinstate the
  // very match it just refused.
  //
  // This used to apply only to names of SHORT_NAME_MAX characters or fewer,
  // which put the threshold exactly one character too low. A tracker company
  // literally named `dida` is four characters, so it took the substring path
  // and matched inside the word "can-dida-tes" — two Mercedes-Benz rejections
  // were attributed to dida, and only an unrelated guard (that row happened to
  // be terminal) stopped them being written. `HP` inside `PHP` was the same bug
  // one character earlier.
  //
  // Length was never the real signal. A company mention in an email is a WORD,
  // at any length, and nothing legitimate is lost by requiring it to be one:
  // the normalized and CJK paths below still handle spacing variants and
  // scripts that do not separate words.
  if (!NO_WORD_SEPARATOR_RE.test(company)) {
    if (matchesOnWordBoundary(text, company)) return true;
    // Spacing variants still count — "Acme Corp" must match "AcmeCorp" — but as
    // a boundary match too. The variant is built from the COMPANY and tested
    // against the RAW text: normalizing the text instead would strip the very
    // separators the boundary needs ("Interview with AcmeCorp" collapses to
    // "interviewwithacmecorp", where nothing is a word any more).
    const cNoSpace = normalizeStr(company);
    if (cNoSpace.length > 2 && cNoSpace !== company.toLowerCase()
        && matchesOnWordBoundary(text, cNoSpace)) return true;
    return false;
  }

  // Exact substring
  if (text.includes(company)) return true;
  
  const textLower = text.toLowerCase();
  const compLower = company.toLowerCase();
  
  if (textLower.includes(compLower)) return true;

  // Ignore spacing
  const tNorm = normalizeStr(text);
  const cNorm = normalizeStr(company);
  if (cNorm.length > 2 && tNorm.includes(cNorm)) return true;

  // Chinese names normalisation
  const cChi = normalizeChinese(company);
  if (cChi && cChi.length >= 2 && text.includes(cChi)) return true;

  return false;
}

// Generic recruiting/HR vocabulary. These words are common enough in unrelated
// senders' signatures, job titles, and boilerplate (e.g. "Talent Acquisition &
// Diversity" in a recruiter's signature for a *different* company/role) that
// they must never, by themselves, count as a "significant word" match against
// a tracker role title — regardless of length (see #2671).
const GENERIC_ROLE_WORDS = new Set([
  'talent', 'acquisition', 'specialist', 'coordinator', 'operations',
  'recruiter', 'recruiting', 'human', 'resources', 'people'
]);

// Matches any CJK ideograph. Chinese role titles are normally written with no
// whitespace/underscore separators at all ("python开发工程师" is one semantic
// phrase, not one "word"), so the single-word rule below must not treat them
// as a bare single word the way it does for Latin-script titles.
const CJK_RE = /[一-鿿㐀-䶿]/;

// A role word the whole-word rule in checkRoleMatch() may safely be applied to:
// Latin letters and digits only. Anything else keeps the substring test it had
// before, because "does a word boundary exist here" has no script-independent
// answer — see the comment at the call site.
// \p{M} is load-bearing, not defensive. toLowerCase() can introduce a combining
// mark that is NOT Script=Latin: "İ" (U+0130) becomes "i" + U+0307, and U+0307
// is \p{M} with Script=Inherited. Without \p{M} here, "İstatistik" fails this
// gate, falls to the substring path, and matches inside "İstatistikler" — the
// bug this rule exists to remove, still live for Turkish. The same applies to
// any NFD-decomposed accented text, so it reaches French, Spanish, Portuguese
// and Vietnamese too, not just Turkish (CodeRabbit, #3535).
//
// It does not widen the gate to other scripts: a Devanagari or Thai word still
// fails on its base letters, which are not Script=Latin.
const LATIN_WORD_RE = /^[\p{Script=Latin}\p{M}\p{N}]+$/u;

// Ceiling on the needle handed to matchesOnWordBoundary() from checkRoleMatch().
//
// That helper builds `new RegExp(..., 'iu')`, and V8's compiler stack-overflows
// on a case-insensitive Unicode pattern once the literal needle is long enough
// — it THROWS at construction rather than failing to match, and the throw
// propagates uncaught out through matchCandidates() and into reply-watch. The
// exact limit is build- and content-dependent (a repeating "WordWord…" run
// blows up well before a single repeated character does), so this is set far
// below any observed threshold rather than tuned to one.
//
// checkCompanyMatch, the helper's only other caller, cannot reach this: it is
// gated by isShortName to names of SHORT_NAME_MAX characters. A role-title part
// has no such ceiling, which is what makes the ceiling explicit here.
//
// 128 is far longer than any real single role word — the longest in a job title
// is a German compound in the 40s — so nothing legitimate is turned away. A
// part above it is malformed data (a JD pasted into the role field, a merged
// CSV column) and falls through to the substring test, exactly as on main.
//
// The check must be on `bare`, not on the part it came from: toLowerCase() can
// LENGTHEN a string, so `bare` is not simply a shorter subset. "İ" (U+0130)
// lowercases to "i" plus a combining dot, and a part of 100 of them yields a
// bare of 199 — nearly 2x. The margin here absorbs that regardless (reaching a
// crash-length needle would still need a part in the thousands, which this
// rejects either way), but measuring the string that actually reaches the regex
// is the property worth holding onto.
const MAX_BOUNDARY_NEEDLE = 128;

// A role title that reduces to a single word — whether that word is generic
// recruiting vocabulary ("Recruiter") or a specific one ("Engineer") — is not
// specific enough to stand alone as an "exact" match: checking it as a whole-
// role substring degenerates into exactly the same bare-word check the
// corroboration requirement exists to gate. Such roles fall through to the
// partial-match path in checkRoleMatch(), which requires company/domain
// corroboration in matchCandidates(). Chinese compound titles are exempted:
// they carry no separators to split on, so "single part" doesn't mean
// "single word" for them.
function isSingleWordRole(role) {
  const parts = role.split(/[\s_\\/()-]+/).filter(Boolean);
  return parts.length === 1 && !CJK_RE.test(parts[0]);
}

// True only when the *entire* role title (or its Chinese, symbol-stripped form)
// appears in the text as one contiguous substring. This is specific enough to
// stand on its own, with no need for a corroborating company/domain signal —
// unless the role is nothing but a single word (see isSingleWordRole).
export function checkRoleMatchExact(text, role) {
  if (!role || !text) return false;
  if (isSingleWordRole(role)) return false;

  const tNorm = normalizeStr(text);
  const rNorm = normalizeStr(role);
  // A whitespace-only role normalizes to '' (normalizeStr strips whitespace),
  // and String.prototype.includes('') is always true — without this guard a
  // blank role would "exactly" match any text at all, bypassing corroboration
  // entirely. isSingleWordRole doesn't catch this: splitting a whitespace-only
  // string on separators yields zero parts, not one.
  if (!rNorm) return false;
  if (tNorm.includes(rNorm)) return true;

  // Handle Chinese role titles ignoring symbols
  const cleanRole = role.replace(/[\s_\\/()-]+/g, '');
  if (cleanRole.length > 2 && tNorm.includes(cleanRole.toLowerCase())) return true;

  return false;
}

export function checkRoleMatch(text, role) {
  if (!role || !text) return false;

  if (checkRoleMatchExact(text, role)) return true;

  const tNorm = normalizeStr(text);

  // Sometimes role has extra descriptors, we check if a significant part matches
  // Like "PY01_python开发工程师" vs "python开发工程师". Generic recruiting words
  // (see GENERIC_ROLE_WORDS) are excluded no matter how long they are — a bare
  // "Talent" or "Specialist" match is exactly the false-positive pattern from
  // #2671, not evidence of a real match.
  // Note tNorm is used only by the substring branch below. The whole-word branch
  // tests the RAW text, because normalizeStr strips all whitespace and a
  // boundary rule needs the delimiters intact — there is nothing left to anchor
  // to once every character is adjacent to another.
  const roleParts = role.split(/[\s_\\/()-]+/);
  for (const part of roleParts) {
    if (part.length <= 3) continue;

    // Splitting on [\s_\\/()-]+ leaves attached punctuation behind ("Director,"
    // keeps its comma), which both defeats a boundary anchor and, before this,
    // defeated the substring test outright — "director," is not in the text.
    // Two forms, deliberately. `stripped` keeps its case and is what reaches the
    // matcher; `bare` is lowercased and is only ever read by the gates below.
    //
    // Lowercasing the needle would be worse than redundant. matchesOnWordBoundary
    // is already case-insensitive ('iu'), and the two mechanisms disagree:
    // toLowerCase() applies FULL case mapping, which turns "İ" into "i" + U+0307,
    // while the regex 'i' flag uses SIMPLE case folding, under which "İ" does not
    // fold to that pair. Hand it the lowercased form and the needle is decomposed
    // while the text is composed, so a genuine mention can never match.
    // \p{M} belongs in this class for the same reason it belongs in the gate and
    // in both lookarounds: a combining mark is word material, not punctuation to
    // peel off. Without it, an NFD word ENDING in a mark loses it — "Chargé" as
    // e+U+0301 strips to "Charge" — and the boundary test then correctly refuses
    // the result, because the mark still sitting in the text makes that position
    // mid-grapheme. The word stops matching itself.
    //
    // Three predicates define "word material" here (this strip, LATIN_WORD_RE,
    // and matchesOnWordBoundary's lookarounds) and they have to move as a unit.
    // Updating two of the three is what produced that bug (CodeRabbit, #3535).
    const stripped = part.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
    const bare = stripped.toLowerCase();

    // The whole-word requirement applies to Latin-script parts ONLY, and every
    // other script keeps the substring test it had before — including the gates
    // above it, which is why the routing happens HERE and not before `bare` is
    // consulted. Stripping punctuation can push a part under the length gate:
    // "工程师。" is four characters and three without the ideographic period, so
    // gating on the stripped form would silently drop three-character Chinese
    // titles that main matches. Non-Latin parts are therefore judged on `part`,
    // exactly as before; only the Latin branch looks at `bare`.
    //
    // #3455 is a bug about English boilerplate — "Analytic" matching inside
    // "Analytics" — and "which scripts have word boundaries" turns out to be
    // the wrong question to answer in order to fix it. It has no clean answer:
    // Japanese runs without separators in all three of its scripts, while
    // Korean DOES separate words with spaces but glues grammatical particles
    // straight onto the noun ("개발자" + "를" -> "개발자를"), so a boundary rule
    // silently stops matching a genuinely mentioned Korean title. Both of those
    // were real false negatives in earlier drafts of this fix, found one script
    // at a time — which is the argument for not enumerating scripts at all.
    //
    // Restricting the stricter rule to Latin fixes the reported bug and leaves
    // every other script byte-identical to its previous behaviour.
    if (!LATIN_WORD_RE.test(bare) || stripped.length > MAX_BOUNDARY_NEEDLE) {
      // Deliberately the raw `part`, mirroring the pre-existing condition
      // exactly. Every word in GENERIC_ROLE_WORDS is pure Latin and would have
      // routed to the branch below, so this can never fire here — it is kept so
      // the two paths can be read as "unchanged" and "new" rather than
      // diffed for silent omissions.
      if (!GENERIC_ROLE_WORDS.has(part.toLowerCase()) && tNorm.includes(normalizeStr(part))) return true;
      continue;
    }

    // Latin branch only: re-apply the length and generic-word gates to the
    // stripped form, so "AI!!" is not four characters of significance and
    // "Recruiter," cannot slip past the #2671 blocklist on its comma.
    if (bare.length <= 3 || GENERIC_ROLE_WORDS.has(bare)) continue;

    // Reuse the company-name boundary helper rather than a second copy of the
    // same rule: it already escapes the needle and anchors on \p{L}/\p{N}
    // lookarounds instead of \b, which is what this needs. \b would be wrong in
    // both directions — a CJK ideograph is not \w, so \b reports a boundary and
    // matches "data" inside "data工程师"; while "_" IS \w, so \b reports none
    // and misses "data_engineer", though "_" is one of the separators the role
    // title itself is split on.
    if (matchesOnWordBoundary(text, stripped)) {
      return true; // partial match on a significant word
    }
  }

  return false;
}

// Shared ATS, job board, and webmail hosts. Mail from one of these identifies a
// vendor, never an employer, so it must never become a candidate domain: every
// message from the host would then score a sender-domain match against whichever
// application happened to mention it.
const SHARED_DOMAINS = [
  'linkedin.com',
  'applytojob.com',
  'greenhouse.io',
  'lever.co',
  'icims.com',
  'myworkday.com',
  'ashbyhq.com',
  'smartrecruiters.com',
  'taleo.net',
  'successfactors.com',
  'gmail.com',
  'outlook.com',
  'yahoo.com',
  'hotmail.com',
  // More ATS platforms and job boards. The list above only had to stop a notes
  // mention from becoming a candidate domain; sender-domain-to-company matching
  // (domainNameMatchKind) and tracker-URL hosts (getAppDomains) make it load
  // bearing, because a posting URL on datev.wd3.myworkdayjobs.com or
  // stepstone.de names the VENDOR and must never claim a mail from that vendor
  // for whichever row happens to link to it. Mirrors ATS_SENDER_DOMAINS in
  // gmail-sweep.mjs, plus the boards a tracker URL column commonly points at.
  'myworkdayjobs.com', 'successfactors.eu', 'csod.com', 'personio.de', 'personio.com',
  'join.com', 'avature.net', 'softgarden.io', 'softgarden.de', 'concludis.de',
  'hrworks.de', 'jobs2web.com', 'workable.com', 'teamtailor.com', 'recruitee.com',
  'jobvite.com', 'bamboohr.com', 'onlyfy.jobs', 'rexx-systems.com', 'prescreen.io',
  'breezy.hr', 'dvinci-hr.com', 'phenompeople.com', 'eightfold.ai', 'oraclecloud.com',
  'stepstone.de', 'stepstone.com', 'indeed.com', 'xing.com', 'glassdoor.com', 'glassdoor.de',
  'kununu.com', 'monster.de', 'jobware.de', 'meinestadt.de', 'arbeitsagentur.de',
  'absolventa.de', 'get-in-it.de', 'jobvector.de', 'joblift.de', 'ziprecruiter.com',
  'wellfound.com', 'welcometothejungle.com', 'github.io', 'notion.site', 'notion.so'
];

// Dot-separated labels ending in a letters-only TLD. Rejects the shapes tracker
// prose produces: sentence-final words ("gaps."), bare numerics ("3.34.5."), and
// paths or filenames ("output/cv-2026-06-23.pdf").
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

// Extensions of the artifacts career-ops writes into tracker notes. Several parse
// as a valid TLD, so shape alone cannot tell a filename from a hostname: "cv.md"
// would otherwise read as a Moldovan domain. Deliberately excludes extensions that
// are common employer TLDs (io, co, ai, sh, me, dev, app).
const FILE_EXTENSIONS = [
  'pdf', 'md', 'doc', 'docx', 'txt', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'csv', 'tsv', 'json', 'yaml', 'yml', 'mjs'
];

function isSharedDomain(domain) {
  return SHARED_DOMAINS.some(shared => domain === shared || domain.endsWith(`.${shared}`));
}

function isUsableDomain(domain) {
  if (!DOMAIN_SHAPE.test(domain)) return false;
  if (FILE_EXTENSIONS.includes(domain.slice(domain.lastIndexOf('.') + 1))) return false;
  return !isSharedDomain(domain);
}

// Second-level public suffixes worth knowing about. Not the whole public suffix
// list: this only decides which two-or-three labels form "the company's domain"
// for a sender whose TLD is one of these, and an unlisted suffix degrades to the
// two-label answer, which is right for every .de/.com/.io/.ai sender that
// dominates a German-market tracker.
const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.jp', 'co.in', 'com.br', 'co.nz',
  'com.cn', 'com.tr', 'co.za', 'com.sg', 'com.hk', 'com.mx', 'co.kr',
]);

/** "karriere.adac.de" -> "adac.de"; "jobs.example.co.uk" -> "example.co.uk". */
export function registrableDomain(domain) {
  const labels = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

// Local parts that name a MAILBOX FUNCTION, not a company. "workday@datev.de" and
// "bewerbung@adac.de" say what kind of mail this is; the employer is in the
// domain. Left in the matched text they are worse than useless — a tracker row
// for a company called "Workday", "Jobs" or "Talent" would claim every mail sent
// from such a mailbox at any employer. Prefix match so "talent-acquisition" and
// "recruiting-team" are covered without enumerating them.
const GENERIC_LOCAL_PART_RE = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|bewerbung|bewerber|application|apply|recruit|career|karriere|job|hr(?![a-z])|personal|talent|workday|hiring|human[-_.]?resources|people|info|service|support|contact|kontakt|hello|hallo|mail|team|notification|notify|system|admin|office|ats)/i;

export function isGenericLocalPart(local) {
  return GENERIC_LOCAL_PART_RE.test(String(local || '').trim());
}

/** Blank out generic mailbox names in every address of a From header. */
export function stripGenericLocalParts(from) {
  return String(from || '').replace(/([\w.+-]+)@/g, (m, local) => (isGenericLocalPart(local) ? '@' : m));
}

/** The display-name half of a From header, addresses removed. */
function fromDisplayName(from) {
  return String(from || '').replace(/<[^>]*>/g, ' ').replace(/[\w.+-]+@[\w.-]+/g, ' ');
}

const LEGAL_FORM_TOKENS = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'eg', 'ev', 'ltd', 'limited', 'inc',
  'corp', 'corporation', 'co', 'bv', 'nv', 'sa', 'srl', 'plc', 'oy', 'ab', 'llc', 'und', 'and',
]);
// Words a trading name adds after the brand ("ADAC Service GmbH" is ADAC).
const GENERIC_COMPANY_WORDS = new Set([
  'service', 'services', 'group', 'gruppe', 'holding', 'deutschland', 'germany', 'international',
  'technologies', 'technology', 'solutions', 'systems', 'consulting', 'software',
]);

function foldToAscii(s) {
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/**
 * How a sender's registrable domain relates to a tracker company name.
 *
 *   'exact'  the domain label IS the brand: datev.de <-> "DATEV eG",
 *            adac.de <-> "ADAC Service GmbH", moresophy.com <-> "MORESOPHY GmbH"
 *   'lead'   the label is only the first word of a longer name:
 *            siemens.com <-> "Siemens Energy AG"
 *   null     no relation, or the domain is a shared ATS/board/webmail host
 *
 * Domains are compared as ASCII with hyphens removed, so mercedes-benz.com meets
 * "Mercedes-Benz AG". A label under three characters is never trusted: it is an
 * initialism, and initialisms collide.
 */
export function domainNameMatchKind(fromDomain, company) {
  if (!fromDomain || !company || isPlaceholderCompany(company)) return null;
  const registrable = registrableDomain(fromDomain);
  if (!registrable || isSharedDomain(registrable) || isSharedDomain(fromDomain)) return null;
  const label = registrable.split('.')[0].replace(/-/g, '');
  if (label.length < 3) return null;

  const name = foldToAscii(String(company).replace(/\([^)]*\)/g, ' '));
  const tokens = name.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !LEGAL_FORM_TOKENS.has(t));
  if (tokens.length === 0) return null;
  const joined = tokens.join('');
  const brand = tokens.filter((t) => !GENERIC_COMPANY_WORDS.has(t)).join('');
  if (label === joined || (brand && label === brand)) return 'exact';
  if (tokens[0].length >= 3 && label === tokens[0]) return 'lead';
  return null;
}

function addDomain(domains, value) {
  const domain = (value || '').toLowerCase();
  if (isUsableDomain(domain)) domains.add(domain);
}

export function getAppDomains(app, followups) {
  const domains = new Set();
  
  // Extract from notes
  if (app.notes) {
    const emails = app.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
    for (const email of emails) {
      addDomain(domains, extractDomain(email));
    }
    // Also look for explicit domains in notes (e.g. "ATS: lever.co")
    const words = app.notes.split(/\s+/);
    for (const w of words) {
      if (w.includes('.') && !w.includes('@')) {
        // Notes are prose, so trim the punctuation wrapping the token rather than
        // deleting every disallowed character: dropping "/" would splice a path
        // like "output/cv-2026-06-23.pdf" into one plausible-looking hostname.
        addDomain(domains, w.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, ''));
      }
    }
  }

  // The posting URL's host. The tracker's URL cell is the one place a row names
  // the employer's own site ("karriere.adac.de"), and it is what makes a rejection
  // from an address the notes never mention still land on the right row. The
  // REGISTRABLE domain is stored, so bewerbung.adac.de and karriere.adac.de both
  // reach adac.de. Only cells that are exactly one URL count — notes are prose and
  // link to other companies — and ATS/board hosts fall out in addDomain().
  if (app.raw) {
    for (const cell of String(app.raw).split('|')) {
      const value = cell.trim();
      if (!/^https?:\/\/\S+$/i.test(value)) continue;
      try {
        addDomain(domains, registrableDomain(new URL(value).hostname));
      } catch { /* malformed URL cell: ignore */ }
    }
  }

  // Followups
  const appFollowups = followups.filter(f => f.appNum === app.num);
  for (const fu of appFollowups) {
    if (fu.contact) {
      addDomain(domains, extractDomain(fu.contact));
    }
    if (fu.notes) {
       const emails = fu.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
       for (const email of emails) {
         addDomain(domains, extractDomain(email));
       }
    }
  }

  // Add common company domain guess (companyname.com). "?" is the structural
  // marker for a confidential employer, not a name, so there is nothing to guess.
  const cNorm = normalizeStr(app.company);
  if (cNorm && cNorm !== '?') {
    addDomain(domains, `${cNorm}.com`);
    addDomain(domains, `${cNorm}.co`);
    addDomain(domains, `${cNorm}.io`);
  }

  return Array.from(domains);
}

// Title words that do not distinguish one posting from another at the same
// employer: the contract type, the gender tag, and connectives.
const ROLE_OVERLAP_STOPWORDS = new Set([
  'werkstudent', 'werkstudentin', 'working', 'student', 'studentin', 'praktikum', 'praktikant',
  'praktikantin', 'intern', 'internship', 'thesis', 'abschlussarbeit', 'masterarbeit',
  'bachelorarbeit', 'all', 'genders', 'gender', 'mwd', 'und', 'and', 'der', 'die', 'das',
  'the', 'of', 'for', 'fuer', 'im', 'in', 'bei', 'at', 'with', 'mit', 'jobs', 'job',
]);

/**
 * 0..1 bonus for how much of a role title the message repeats.
 *
 * Deliberately hard to earn: at least two distinguishing words AND at least half
 * of them. One shared word ("Data") is what two different roles at the same
 * company have in common, so it must not break a tie — that tie is the
 * ambiguity guard, and staying ambiguous is the right answer when the message
 * does not say which role it is about.
 */
export function roleOverlapBonus(text, role) {
  if (!text || !role) return 0;
  const words = [...new Set(
    foldToAscii(role).replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 2 && !ROLE_OVERLAP_STOPWORDS.has(w) && !GENERIC_ROLE_WORDS.has(w)),
  )];
  if (words.length < 2) return 0;
  const haystack = foldToAscii(text);
  const hits = words.filter((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack);
  }).length;
  const ratio = hits / words.length;
  return hits >= 2 && ratio >= 0.5 ? Math.round(ratio * 100) / 100 : 0;
}

export function matchCandidates(candidates, apps, followups = []) {
  const results = [];
  
  for (const cand of candidates) {
    // The mailbox name ("workday@", "bewerbung@") is dropped from the text the
    // company and role checks read: it names a function, and a tracker company
    // called "Workday" or "Talent" would otherwise claim every mail sent from one.
    const textContext = `${stripGenericLocalParts(cand.from)} ${cand.subject || ''} ${cand.body_snippet || ''}`;
    // The same text minus the sender ADDRESS, used to tell whether a company name
    // is corroborated by the message itself or merely restates the sender domain.
    const contentContext = `${fromDisplayName(cand.from)} ${cand.subject || ''} ${cand.body_snippet || ''}`;
    // Subject and body only: the words a role overlap is read from.
    const roleContext = `${cand.subject || ''} ${cand.body_snippet || ''}`;
    const fromDomain = extractDomain(cand.from);

    let bestMatches = [];
    let highestScore = -1;

    for (const app of apps) {
      let score = 0;
      let signals = [];
      let companyHint = '';
      let roleHint = '';

      const isCompanyMatch = checkCompanyMatch(textContext, app.company);

      let hasDomainMatch = false;
      if (fromDomain) {
        const appDomains = getAppDomains(app, followups);
        if (appDomains.some(d => fromDomain === d || fromDomain.endsWith(`.${d}`))) {
          hasDomainMatch = true;
          score += 2;
          signals.push('sender-domain');
          companyHint = companyHint || app.company;
        } else {
          // No address on file for this row, but the domain may still BE the
          // company: adac.de for "ADAC Service GmbH", datev.de for "DATEV eG".
          // An exact brand match outranks a first-word one so siemens.com prefers
          // "Siemens AG" over "Siemens Energy AG" without needing a role to say so.
          const kind = domainNameMatchKind(fromDomain, app.company);
          if (kind) {
            hasDomainMatch = true;
            score += kind === 'exact' ? 2.5 : 2;
            signals.push('sender-domain', 'domain-company-name');
            companyHint = companyHint || app.company;
          }
        }
      }

      if (isCompanyMatch) {
        // A company name that appears ONLY inside the sender address is the same
        // evidence as the sender domain, not a second piece of it. Counting it
        // twice let a Discarded "ADAC" row outscore the live "ADAC Service GmbH"
        // row on a receipt whose body never names the employer.
        const corroboratedByContent = checkCompanyMatch(contentContext, app.company);
        if (corroboratedByContent || !hasDomainMatch) score += 2;
        signals.unshift('company-name');
        companyHint = app.company;
      }

      // A role match on the *entire* role title is specific enough to stand on
      // its own. A match on just one "significant word" of the role (e.g. the
      // role split into descriptor parts) is not — those partial matches must be
      // corroborated by a company-name or sender-domain signal, otherwise a
      // generic multi-word title (e.g. "Talent Acquisition Specialist") lets any
      // unrelated email that happens to contain one of those words falsely
      // attribute itself to this application (#2671).
      const isRoleExactMatch = checkRoleMatchExact(textContext, app.role);
      const isRolePartialMatch = !isRoleExactMatch && checkRoleMatch(textContext, app.role);
      const isRoleMatch = isRoleExactMatch || (isRolePartialMatch && (isCompanyMatch || hasDomainMatch));
      if (isRoleMatch) {
        score += 1.5;
        signals.push('role-title');
        roleHint = app.role;
      }

      // Graded overlap, so two rows of ONE employer are told apart by how much of
      // their title the subject repeats — the boolean checks above score both
      // "Werkstudent Data & AI Solutions" and "Werkstudent Power BI & Data
      // Analytics" identically on a subject that only names the first. Only ever
      // a tie-breaker: it needs the sender to be the company already.
      if (isCompanyMatch || hasDomainMatch) {
        const bonus = roleOverlapBonus(roleContext, app.role);
        if (bonus > 0) {
          score = Math.round((score + bonus) * 100) / 100;
          signals.push('role-overlap');
          roleHint = roleHint || app.role;
        }
      }

      const postAppKeywords = ['interview', 'offer', 'rejection', '邀您面试', '简历通过', 'next steps', 'update on your application'];
      const strongSignals = ['interview_invite', 'offer', 'rejection'];
      const hasPostAppKeyword = (cand.signal && strongSignals.includes(cand.signal)) 
        || postAppKeywords.some(k => textContext.toLowerCase().includes(k.toLowerCase()));
      
      if (hasPostAppKeyword && (isCompanyMatch || hasDomainMatch)) {
         signals.push('post-application-keyword');
      }

      if (score > 0) {
        let confidence = 'low';
        if ((isCompanyMatch || hasDomainMatch) && isRoleMatch) {
          confidence = 'high';
        } else if ((isCompanyMatch || hasDomainMatch) && hasPostAppKeyword) {
          confidence = 'high';
        } else if (isCompanyMatch || hasDomainMatch) {
          confidence = 'medium';
        } else if (isRoleMatch) {
          confidence = 'low';
        }
        
        const matchInfo = {
          message_id: cand.message_id,
          company_hint: companyHint || app.company,
          role_hint: roleHint || app.role,
          application_num: app.num,
          confidence,
          signals: Array.from(new Set(signals)),
          score
        };
        
        if (score > highestScore) {
          highestScore = score;
          bestMatches = [matchInfo];
        } else if (score === highestScore) {
          bestMatches.push(matchInfo);
        }
      }
    }
    
    if (bestMatches.length === 1) {
      const match = bestMatches[0];
      delete match.score;
      results.push(match);
    } else if (bestMatches.length > 1) {
      // Ambiguous matches
      results.push({
        message_id: cand.message_id,
        company_hint: cand.from,
        role_hint: '',
        application_num: null, // ambiguous
        confidence: 'low',
        signals: ['ambiguous-match'],
      });
    } else {
      // No matches
      results.push({
        message_id: cand.message_id,
        company_hint: fromDomain || cand.from,
        role_hint: '',
        application_num: null,
        confidence: 'low',
        signals: ['no-match']
      });
    }
  }
  
  return results;
}

// ── German rejections ───────────────────────────────────────────────────────
//
// Observed live 2026-09-29: ADAC ("dass wir Sie für die ausgeschriebene Position
// nicht berücksichtigen können") and DATEV ("nicht in die engere Auswahl
// einbezogen ... keine positive Nachricht überbringen können") both classified
// Unknown, so a mailbox sweep moved nothing while the rows sat at Applied.
//
// These are PHRASE patterns, not keywords, on purpose. The English list can rely
// on substrings like 'unfortunately' because they are rare in acknowledgements;
// German has no such luxury. "nicht berücksichtigt werden" sits in application
// boilerplate ("unvollständige Bewerbungen können nicht berücksichtigt werden"),
// "Absage" in "Sie erhalten eine Zusage oder Absage", and "leider ... nicht" in
// "wir können Ihnen leider noch nicht mitteilen, wann wir uns melden" — the last
// being a DELAY notice, and TERMINAL_STATES means a wrongly Rejected row is never
// walked back. Each pattern therefore anchors on the candidate as its object
// (wir Sie / Ihre Bewerbung / Dich) and the exclusions below strip the known
// boilerplate before matching.
//
// Matched against umlaut-folded text (ä->ae, ö->oe, ü->ue, ß->ss), so the same
// pattern reads "berücksichtigen" and the ASCII spelling "beruecksichtigen" that
// German mail routinely arrives in. The Sie and Du forms share every pattern:
// each is anchored on an object pronoun or possessive, and the alternation lists
// both registers.
const NOT = 'nicht\\s+(?:weiter\\s+|mehr\\s+|laenger\\s+)?';
const CONSIDER = 'beruecksichtig(?:en|t)';

export const GERMAN_REJECTION_PATTERNS = [
  // "dass wir Sie ... nicht berücksichtigen können" / "können wir Dich nicht weiter berücksichtigen"
  { label: 'nicht berücksichtigen',
    re: new RegExp(`\\bwir\\b[^.!?\\n]{0,40}?\\b(?:sie|dich|euch)\\b[^.!?\\n]{0,120}?\\b${NOT}${CONSIDER}`) },
  // "Ihre Bewerbung konnte leider nicht berücksichtigt werden" (past tense / leider only:
  // the present-tense form is the boilerplate this must not catch)
  { label: 'Bewerbung nicht berücksichtigt',
    re: new RegExp(`\\b(?:ihre|deine|eure)\\s+(?:bewerbung|unterlagen)\\b[^.!?\\n]{0,60}?\\b(?:leider|konnte|konnten|wurde|wurden)\\b[^.!?\\n]{0,60}?\\b${NOT}${CONSIDER}`) },
  { label: 'nicht in die engere Auswahl',
    re: /\bnicht\s+in\s+die\s+(?:engere|engeren|finale|naechste|endgueltige)n?\s+(?:auswahl|wahl|runde|endauswahl)/ },
  { label: 'keine positive Nachricht',
    re: /\bkeine\s+positive[nr]?\s+(?:nachricht|rueckmeldung|antwort|mitteilung|neuigkeit\w*)/ },
  { label: 'für andere Kandidaten entschieden',
    re: /\bfuer\s+(?:einen?\s+|eine\s+)?(?:andere[nr]?\s+(?:kandidat|bewerber|mitbewerber|profil)|mitbewerber)\w*[^.!?\n]{0,60}?\bentschieden\b/ },
  { label: 'nicht für Sie entschieden',
    re: /\bnicht\s+fuer\s+(?:sie|dich|euch)\s+entschieden\b/ },
  { label: 'gegen Ihre Bewerbung entschieden',
    re: /\bgegen\s+(?:ihre|deine|eure)\s+bewerbung\s+entschieden\b|\bentschieden\b[^.!?\n]{0,40}\bgegen\s+(?:ihre|deine|eure)\s+bewerbung\b|\buns\s+gegen\s+(?:sie|dich|euch)\s+entschieden\b/ },
  { label: 'mit anderen Kandidaten fortfahren',
    re: /\b(?:mit|an)\s+(?:einem|einer|anderen)\s+(?:anderen\s+)?(?:kandidat|bewerber|mitbewerber)\w*\s+(?:weiter\w*|fortzufahren|fortfahren|besetzen|zu\s+besetzen|zusammenarbeiten)/ },
  { label: 'anderweitig besetzt',
    re: /\banderweitig\s+(?:besetzt|vergeben|entschieden)\b/ },
  { label: 'Stelle bereits besetzt',
    re: /\b(?:stelle|position|vakanz)\b[^.!?\n]{0,60}?\b(?:bereits|inzwischen|mittlerweile|zwischenzeitlich|leider)\s+(?:anderweitig\s+)?(?:besetzt|vergeben)\b/ },
  { label: 'nicht weiterverfolgen',
    re: /\bnicht\s+(?:mehr\s+)?weiter\s*(?:verfolg|fuehr)\w*/ },
  { label: 'Bewerbung abgelehnt',
    re: /\b(?:ihre|deine|eure)\s+bewerbung\b[^.!?\n]{0,60}?\b(?:ablehnen|abzulehnen|abgelehnt|absagen)\b/ },
  { label: 'Bewerbung nicht erfolgreich',
    re: /\b(?:ihre|deine|eure)\s+bewerbung\b[^.!?\n]{0,40}?\bleider\s+nicht\s+erfolgreich\b/ },
  // "Leider müssen wir Ihnen mitteilen, dass ..." only counts once a NEGATIVE object
  // follows; "leider können wir Ihnen noch keine Entscheidung mitteilen" has none
  // of these objects and is a delay notice.
  { label: 'leider mitteilen + Negation',
    re: new RegExp(
      '\\b(?:leider|bedauer\\w*|bedauerlicherweise)\\b[^!?\\n]{0,80}?\\b(?:mitteilen|informieren|sagen|absagen)\\b[^!?\\n]{0,200}?' +
      '(?:\\bnicht\\s+(?:weiter|mehr|zum|zur|fuer|in\\s+die|beruecksichtig\\w*|einladen|auswaehlen|einstellen|zusagen|entsprechen)\\b' +
      '|\\bkeine?n?\\s+(?:zusage|einladung|angebot|positive\\w*|stelle|einstellung|vertrag|moeglichkeit|weitere\\w*)\\b|\\babsage\\b)') },
  { label: 'Ihnen absagen',
    re: /\b(?:ihnen|dir|euch)\s+(?:leider\s+)?(?:eine\s+)?(?:absage|absagen)\b/ },
  { label: 'Absage erteilen',
    re: /\b(?:leider|muessen|erteilen|erhalten\s+sie|senden\s+wir\s+ihnen|schicken\s+wir\s+ihnen)\b[^.!?\n]{0,60}?\babsage\b|\babsage\s+(?:erteilen|erteilt|mitteilen|zusenden)/ },
];

// A bare "Absage" is only trusted in the SUBJECT ("Absage auf Ihre Bewerbung"),
// where it is the message's topic rather than a word in boilerplate.
const GERMAN_SUBJECT_REJECTION_PATTERNS = [
  { label: 'Absage (Betreff)', re: /\babsage\b/ },
];

// A sentence that makes the phrase conditional is a rule about future
// applications, not a decision about this one: "Falls Sie keine Unterlagen
// einreichen, können wir Sie nicht berücksichtigen". "auch wenn" and "selbst
// wenn" are concessions inside a real rejection ("Leider haben wir uns, auch
// wenn Ihr Profil überzeugend war, für einen anderen Bewerber entschieden").
const CONDITIONAL_SENTENCE_RE = /(?<!auch\s)(?<!selbst\s)\b(?:wenn|falls|sofern|soweit)\b|\b(?:andernfalls|ansonsten|bitte\s+beachten)\b/;

// Wording that contains a rejection word without being one.
const GERMAN_REJECTION_NEUTRALISERS = [
  /\b(?:zusage|absage)\s*(?:oder|\/|bzw\.?|und)\s*(?:eine\s+)?(?:zusage|absage)\b/g,
];

function foldGerman(s) {
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t\r\f\v ]+/g, ' ');
}

/** The sentence around a match, so a conditional clause can veto it. */
function sentenceAround(text, index, length) {
  let start = 0;
  const before = /[.!?]\s|\n/g;
  const head = text.slice(0, index);
  for (let m = before.exec(head); m; m = before.exec(head)) start = m.index + 1;
  const rest = text.slice(index + length);
  const end = rest.search(/[.!?](?:\s|$)|\n/);
  return text.slice(start, index + length + (end < 0 ? rest.length : end));
}

/**
 * Labels of every German rejection phrase in a message; empty when none.
 * Exported so the phrase table can be pinned by test without a full candidate.
 */
export function matchGermanRejection(subject, body) {
  const neutralise = (t) => GERMAN_REJECTION_NEUTRALISERS.reduce((acc, re) => acc.replace(re, ' '), t);
  const foldedSubject = neutralise(foldGerman(subject));
  const text = neutralise(foldGerman(`${subject || ''}\n${body || ''}`));
  const labels = [];
  for (const { label, re } of GERMAN_SUBJECT_REJECTION_PATTERNS) {
    if (re.test(foldedSubject)) labels.push(label);
  }
  for (const { label, re } of GERMAN_REJECTION_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    for (const m of text.matchAll(global)) {
      if (CONDITIONAL_SENTENCE_RE.test(sentenceAround(text, m.index, m[0].length))) continue;
      labels.push(label);
      break;
    }
  }
  return labels;
}

export function classifyReply(cand) {
  const subject = cand.subject || '';
  const body = cand.body_snippet || '';
  const text = `${cand.from || ''} ${subject} ${body}`;
  const textLower = text.toLowerCase();
  const signal = cand.signal || '';

  const evidence = [];

  // Define keyword match helper (case-insensitive)
  const check = (keywords) => {
    let found = false;
    for (const kw of keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        evidence.push(kw);
        found = true;
      }
    }
    return found;
  };

  // 1. Noise keywords (checked first to separate alerts/leads from actual interviews)
  const noiseKeywords = [
    '邀请投递', '抢面试先机', '近期热招', '立即投递', '热招职位', '订阅职位', '职位推荐', '推荐职位',
    'job alert', 'invitation to apply', 'recommended jobs', 'newsletter', 'marketing digest', 'job recommendation', 'suggested jobs'
  ];

  // 2. Offer keywords — specific phrases only. A bare 'offer' substring is deliberately
  //    excluded: it collides with rejection wording such as 'unable to offer' (see
  //    rejectionKeywords) and would mis-type rejections as offers.
  const offerKeywords = [
    '录取通知书', '录用信', '录用通知', '录用', '薪资确认', '入职协议', '意向书',
    'offer letter', 'employment agreement', 'job offer', 'congratulations on the offer', 'compensation details', 'pleased to offer'
  ];

  // 3. Rejected keywords
  const rejectionKeywords = [
    '很遗憾', '暂不匹配', '不合适', '未能进入下一轮', '感谢您的时间', '未通过', '不再考虑', '决定不推进',
    'unfortunately', 'not a match', 'not matching', 'decided not to proceed', 'will not be moving forward', 'position has been filled', 'role has been closed', 'unable to offer',
    // Every entry below was checked against offerKeywords, interviewKeywords and
    // autoKeywords for substring collisions, and rejection is decided before
    // Offer/Interview, so a rejection that mentions either in passing still
    // classifies Rejected.
    'we regret to inform', 'regret to inform you',
    'pursue other candidates', 'pursuing other candidates', 'moving forward with other candidates', 'proceed with other candidates',
    'not be able to move forward', 'unable to move forward', 'not moving forward with your application',
    'was not selected', 'not been selected', 'not selected at this time',
    'decided to move forward with other',
    'will not be progressing', 'not progressing your application',
    'no longer under consideration', 'not under consideration',
    'we have decided not to',
    // The "consider" family. Observed live: Primetals/MHI Erlangen closed an
    // application with "we won't consider your application in the further
    // process any more" — an unambiguous rejection that matched nothing above
    // and classified as Unknown, which would have left the row Applied
    // indefinitely while the follow-up cadence counted days against a company
    // that had already said no. Both apostrophe forms are listed because the
    // text is matched with a plain lowercase includes() and mail clients emit
    // either U+0027 or U+2019.
    'not consider your application', "won't consider your application",
    '’t consider your application',
    'no longer consider', 'unable to consider', 'not consider you further'
  ];

  // 4. Auto-confirmation keywords
  const autoKeywords = [
    '自动回复', '收到您的申请', '申请已收到', '投递成功', '确认收到',
    'thank you for applying', 'application received', 'received your application', 'auto-confirmation', 'confirmation of application', 'automatic reply'
  ];

  // 5. Need Action keywords
  const actionKeywords = [
    '补充信息', '提供信息', '完成测评', '在线测评', '笔试题', '做个测试', '截止日期前', '截止时间',
    'complete a form', 'provide information', 'finish an assessment', 'coding challenge', 'online test', 'respond by a deadline', 'pick a time', 'schedule a time', 'book a time',
    'complete assessment', 'take a test', 'assessment', 'coding test', 'deadline', 'fill out', 'complete the form', 'provide details', 'submit info'
  ];

  // 6. Interview keywords
  const interviewKeywords = [
    '邀您面试', '邀约面试', '微信小程序面试', 'AI微信小程序', '面试形式', '面试时间', '面试时长', '安排面试', '预约面试', '首轮面试', '视频面试', '电话面试', '现场面试', '面试邀请', '面试流程', '简历通过',
    'interview invitation', 'schedule an interview', 'scheduling link', 'ai interview', 'video interview', 'phone screen', 'onsite interview', 'final round', 'invite you to interview', 'interview request', 'interview schedule',
    // A booked slot, not an invitation to book one. Observed live 2026-10-05: an
    // Amazon/Adecco "Confirmation of Scheduled Appointment" ("Interview in
    // Niederlassung: …") matched nothing and classified Unknown, so the row sat
    // at Applied with the interview already on the calendar. Rejection and
    // auto-confirmation are decided first, so "after your interview" in a
    // rejection still classifies Rejected.
    'interview appointment', 'interview has been scheduled', 'interview is scheduled', 'interview in ', 'interview at ', 'interview on ',
    // German. The rejection side has matchGermanRejection(); the interview side
    // had no German at all, while most of this tracker's employers write German.
    'vorstellungsgespräch', 'vorstellungsgespraech', 'bewerbungsgespräch', 'bewerbungsgespraech',
    'kennenlerngespräch', 'kennenlerngespraech', 'einladung zum gespräch', 'einladung zu einem gespräch',
    'interviewtermin', 'gesprächstermin', 'gespraechstermin'
  ];

  // 7. Responded keywords
  const respondedKeywords = [
    '联系您', '回复您', '想沟通', '想聊聊', '进一步沟通',
    'would like to chat', 'reach out', 'connect with you', 'hiring manager responded'
  ];

  const isNoise = check(noiseKeywords);
  if (isNoise) {
    return {
      type: 'Noise',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  // Rejection is decided before Offer: an explicit rejection signal or rejection
  // wording (e.g. 'unable to offer', or 'we will not be sending an offer letter'
  // which still contains the 'offer letter' phrase) must win even when offer-ish
  // phrasing is present. Deciding Offer first would type such replies as Offer and
  // push a spurious Offer tracker update.
  const hasEnglishOrChineseRejection = check(rejectionKeywords);
  const germanRejection = matchGermanRejection(subject, body);
  for (const label of germanRejection) evidence.push(label);
  const hasRejectionKeywords = hasEnglishOrChineseRejection || germanRejection.length > 0;
  const isRejected = signal === 'rejection' || hasRejectionKeywords;
  if (isRejected) {
    if (signal === 'rejection' && !evidence.includes('rejection')) evidence.push('rejection');
    return {
      type: 'Rejected',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Rejected'
    };
  }

  const hasOfferKeywords = check(offerKeywords);
  const isOffer = signal === 'offer' || hasOfferKeywords;
  if (isOffer) {
    if (signal === 'offer' && !evidence.includes('offer')) evidence.push('offer');
    return {
      type: 'Offer',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Offer'
    };
  }

  const isAuto = check(autoKeywords);
  if (isAuto) {
    return {
      type: 'Auto-confirmation',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  const isAction = check(actionKeywords);
  if (isAction) {
    const hasSchedulingWording = textLower.includes('schedule') || textLower.includes('pick a time') || textLower.includes('book a time') || textLower.includes('book a slot') ||
                                 textLower.includes('choose a time') || textLower.includes('select a time') || textLower.includes('appointment') ||
                                 text.includes('预约') || text.includes('选择时间') || text.includes('选择面试') || text.includes('安排时间');
    return {
      type: 'Need Action',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: hasSchedulingWording ? 'Interview' : 'Responded'
    };
  }

  const hasInterviewKeywords = check(interviewKeywords);
  const isInterview = signal === 'interview_invite' || hasInterviewKeywords;
  if (isInterview) {
    if (signal === 'interview_invite' && !evidence.includes('interview_invite')) evidence.push('interview_invite');
    return {
      type: 'Interview',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Interview'
    };
  }

  const hasRespondedKeywords = check(respondedKeywords);
  const isResponded = signal === 'update' || hasRespondedKeywords;
  if (isResponded) {
    if (signal === 'update' && !evidence.includes('update')) evidence.push('update');
    return {
      type: 'Responded',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Responded'
    };
  }

  const recruitingTerms = [
    'application', 'career', 'job', 'recruiter', 'hiring', 'interview', 'resume',
    '简历', '职位', '招聘', '应聘'
  ];
  const isRecruiting = recruitingTerms.some(term => textLower.includes(term.toLowerCase()));
  if (isRecruiting) {
    return {
      type: 'Unknown',
      evidence: [],
      suggestedTrackerUpdate: 'Needs Review'
    };
  }

  return {
    type: 'Unknown',
    evidence: [],
    suggestedTrackerUpdate: 'Needs Review'
  };
}

