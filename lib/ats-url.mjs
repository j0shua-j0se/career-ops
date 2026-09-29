// @ts-check
/**
 * lib/ats-url.mjs — pure hostname/URL -> ATS vendor resolver.
 *
 * `atsBoardFromUrl(url)` recognizes a public ATS careers-board URL and
 * returns `{ vendor, slug, boardUrl }`, or `null` when the URL does not
 * match any known vendor shape. Zero network, zero I/O — a plain `new URL()`
 * parse plus a per-vendor host/path regex, mirroring each provider's own
 * `detect()` host contract in `providers/*.mjs` (see ADDING_A_PROVIDER.md,
 * "SSRF hardening" — a vendor URL is always re-derived from its own fixed
 * suffix, never trusted by shape alone).
 *
 * `vendor` is exactly the provider `id` used across `providers/_registry.mjs`
 * and `portals.yml`'s `provider:` field (`greenhouse`, `lever`, `ashby`,
 * `personio`, `workday`, `smartrecruiters`, `recruitee`, `join`, `softgarden`,
 * `successfactors`, `workable`, `teamtailor`, `bamboohr`, `breezy`,
 * `pinpoint`, `rippling`) — a caller can hand `vendor` straight to a
 * `providers` Map from `providers/_registry.mjs`'s `loadProviders()` and get
 * back the matching provider with no further translation.
 *
 * `boardUrl` is the canonical `careers_url` for that board — the exact shape
 * the matching provider's own `detect()` recognizes (job-boards.greenhouse.io,
 * not boards-api.greenhouse.io) — so a caller can drop it straight into a
 * `tracked_companies` entry (see `discover-ats.mjs`'s `renderPortalEntry`) or
 * pass it to `provider.fetch({ careers_url: boardUrl, name }, ctx)` directly.
 *
 * Used by `harvest-companies.mjs` (a company sighting's URL resolves a board
 * with zero network — no `discover-ats.mjs` probe needed) and
 * `lib/resolve-employer-posting.mjs` (an already-known URL resolves a board
 * the same way).
 */

/** Provider ids this module can recognize, in the order they are tried. */
export const ATS_VENDORS = [
  'greenhouse', 'lever', 'ashby', 'personio', 'workday', 'smartrecruiters',
  'recruitee', 'join', 'softgarden', 'successfactors', 'workable',
  'teamtailor', 'bamboohr', 'breezy', 'pinpoint', 'rippling',
];

// Slug-safety guard — mirrors discover-ats.mjs's SLUG_RE. A slug that will be
// interpolated back into a board URL must never carry '/', '@', or anything
// else that could change what host/path the URL resolves to. Every slug this
// module extracts already came out of a URL's own host label or a single path
// segment (both already delimiter-free by construction), so this is
// belt-and-suspenders — it survives a future extraction bug rather than
// trusting today's regex to always agree with itself.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** @param {string} rawUrl @returns {URL|null} */
function parseHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  // Every vendor covered here is HTTPS-only in production; matching provider
  // guards (assertGreenhouseUrl, assertLeverUrl, ...) reject non-HTTPS the
  // same way. Rejecting here keeps this module's contract identical to theirs.
  if (u.protocol !== 'https:') return null;
  return u;
}

/** @param {string} host @returns {string} */
function lowerHost(host) {
  return String(host || '').toLowerCase();
}

/** First non-empty path segment, or ''. */
function firstPathSegment(u) {
  return u.pathname.split('/').filter(Boolean)[0] || '';
}

/**
 * @param {string} vendor
 * @param {string} slug
 * @param {string} boardUrl
 * @returns {{vendor: string, slug: string, boardUrl: string}|null}
 */
function resolved(vendor, slug, boardUrl) {
  if (!slug || !SLUG_RE.test(slug)) return null;
  return { vendor, slug, boardUrl };
}

// ── Per-vendor matchers ──────────────────────────────────────────────────
// Each takes a parsed https URL and returns a result or null. Order in
// MATCHERS below is arbitrary — hosts are disjoint across vendors, so at most
// one can ever match a given URL.

/** greenhouse — job-boards[.eu].greenhouse.io/<slug>, legacy boards.greenhouse.io/<slug>. */
function matchGreenhouse(u) {
  const host = lowerHost(u.hostname);
  const m = host.match(/^job-boards(\.eu)?\.greenhouse\.io$/) || (host === 'boards.greenhouse.io' ? [host, ''] : null);
  if (!m) return null;
  const slug = firstPathSegment(u);
  // Always normalize to the canonical, detect()-recognized host — a legacy
  // boards.greenhouse.io URL is NOT matched by greenhouse.mjs's own detect()
  // (it only recognizes job-boards[.eu].greenhouse.io), so re-emitting the
  // legacy host would produce a portals.yml entry no provider claims.
  const eu = m[1] ? '.eu' : '';
  return resolved('greenhouse', slug, `https://job-boards${eu}.greenhouse.io/${slug}`);
}

/** lever — jobs[.eu].lever.co/<slug>. */
function matchLever(u) {
  const m = lowerHost(u.hostname).match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!m) return null;
  const slug = firstPathSegment(u);
  return resolved('lever', slug, `https://jobs.${m[1]}/${slug}`);
}

/** ashby — jobs.ashbyhq.com/<slug>. Case-sensitive slug (ashby boards are). */
function matchAshby(u) {
  if (lowerHost(u.hostname) !== 'jobs.ashbyhq.com') return null;
  const slug = firstPathSegment(u);
  return resolved('ashby', slug, `https://jobs.ashbyhq.com/${slug}`);
}

/** personio — <slug>.jobs.personio.(de|com). */
function matchPersonio(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(de|com)$/);
  if (!m) return null;
  return resolved('personio', m[1], `https://${m[1]}.jobs.personio.${m[2]}`);
}

/**
 * workday — <tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>.
 * `slug` is the tenant (mirrors discover-ats.mjs's resolveWorkday, which
 * keys a resolved match's `slug` off `coords.tenant`).
 */
function matchWorkday(u) {
  const m = u.href.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/i);
  if (!m) return null;
  const [, tenant, instance, site] = m;
  if (!SLUG_RE.test(tenant) || !SLUG_RE.test(instance) || !/^[A-Za-z0-9_-]+$/.test(site)) return null;
  return resolved('workday', tenant.toLowerCase(), `https://${tenant}.${instance}.myworkdayjobs.com/${site}`);
}

/** smartrecruiters — careers[.jobs].smartrecruiters.com/<slug>. */
function matchSmartRecruiters(u) {
  const host = lowerHost(u.hostname);
  if (host !== 'careers.smartrecruiters.com' && host !== 'jobs.smartrecruiters.com') return null;
  const slug = firstPathSegment(u);
  return resolved('smartrecruiters', slug, `https://careers.smartrecruiters.com/${slug}`);
}

/** recruitee — <slug>.recruitee.com. */
function matchRecruitee(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/);
  if (!m) return null;
  return resolved('recruitee', m[1], `https://${m[1]}.recruitee.com`);
}

/** join.com — join.com/companies/<slug>. */
function matchJoin(u) {
  if (lowerHost(u.hostname) !== 'join.com') return null;
  const m = u.pathname.match(/^\/companies\/([^/?#]+)/);
  const slug = m?.[1] || '';
  return resolved('join', slug, `https://join.com/companies/${slug}`);
}

/** softgarden — <slug>.softgarden.io (bare softgarden.io has no tenant, no slug). */
function matchSoftgarden(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9][a-z0-9-]*)\.softgarden\.io$/);
  if (!m) return null;
  // The German widget is the default fetchable endpoint (softgarden.mjs's own
  // resolveWidgetUrl default) — a bare tenant host carries no lang segment.
  return resolved('softgarden', m[1], `https://${m[1]}.softgarden.io/de/widgets/jobs`);
}

/**
 * successfactors — career<N>.successfactors.(eu|com) with a `?company=`
 * query param. The provider's own detect() is a broad substring match on
 * ANY successfactors.(eu|com)/jobs2web.com host — branded RMK tenants
 * (jobs.zf.com) carry no such marker at all and can't be recognized from the
 * hostname alone — so this matcher only claims the one shape a `company=`
 * param actually names a tenant: the legacy career<N> portal host.
 */
function matchSuccessFactors(u) {
  if (!/^career\d*\.successfactors\.(eu|com)$/i.test(lowerHost(u.hostname))) return null;
  const company = u.searchParams.get('company');
  if (!company || !company.trim()) return null;
  const slug = company.trim();
  if (!SLUG_RE.test(slug)) return null;
  return resolved('successfactors', slug, u.href);
}

/** workable — apply.workable.com/<slug>. */
function matchWorkable(u) {
  if (lowerHost(u.hostname) !== 'apply.workable.com') return null;
  const slug = firstPathSegment(u);
  return resolved('workable', slug, `https://apply.workable.com/${slug}`);
}

/** teamtailor — <slug>.teamtailor.com. */
function matchTeamtailor(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.teamtailor\.com$/);
  if (!m) return null;
  return resolved('teamtailor', m[1], `https://${m[1]}.teamtailor.com`);
}

/** bamboohr — <tenant>.bamboohr.com. */
function matchBambooHr(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9][a-z0-9-]*)\.bamboohr\.com$/);
  if (!m) return null;
  return resolved('bamboohr', m[1], `https://${m[1]}.bamboohr.com`);
}

/** breezy — <tenant>.breezy.hr. */
function matchBreezy(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9][a-z0-9-]*)\.breezy\.hr$/);
  if (!m) return null;
  return resolved('breezy', m[1], `https://${m[1]}.breezy.hr`);
}

/** pinpoint — <slug>.pinpointhq.com. */
function matchPinpoint(u) {
  const m = lowerHost(u.hostname).match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.pinpointhq\.com$/);
  if (!m) return null;
  return resolved('pinpoint', m[1], `https://${m[1]}.pinpointhq.com`);
}

/** rippling — ats.rippling.com/<slug>[/jobs]. */
function matchRippling(u) {
  if (lowerHost(u.hostname) !== 'ats.rippling.com') return null;
  const slug = firstPathSegment(u);
  return resolved('rippling', slug, `https://ats.rippling.com/${slug}/jobs`);
}

const MATCHERS = [
  matchGreenhouse, matchLever, matchAshby, matchPersonio, matchWorkday,
  matchSmartRecruiters, matchRecruitee, matchJoin, matchSoftgarden,
  matchSuccessFactors, matchWorkable, matchTeamtailor, matchBambooHr,
  matchBreezy, matchPinpoint, matchRippling,
];

/**
 * Recognize a public ATS careers-board URL and resolve it to a vendor + slug
 * + canonical board URL. Pure, zero-network, never throws.
 *
 * @param {string} url - Any URL, trusted or not (a company's careers page, a
 *   job posting's URL, a scan-history row).
 * @returns {{vendor: string, slug: string, boardUrl: string}|null}
 */
export function atsBoardFromUrl(url) {
  const u = parseHttpsUrl(url);
  if (!u) return null;
  for (const matcher of MATCHERS) {
    const hit = matcher(u);
    if (hit) return hit;
  }
  return null;
}
