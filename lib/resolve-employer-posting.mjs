// @ts-check
/**
 * lib/resolve-employer-posting.mjs — company + rough title/location -> the
 * single best-matching live posting on that employer's own ATS board.
 *
 * `resolveEmployerPosting({company, title, location, urls?, slug?, website?},
 * {ctx?, portals?, providers?, probe?, minScore?})` finds the company's board
 * in three tiers (cheapest first, first hit wins):
 *
 *   1. `portals` — an already-loaded portals.yml `{tracked_companies}` object
 *      (or array), matched by normalized company name. Zero network.
 *   2. `target.urls` — any URL already known for this company (a scan-history
 *      sighting, a lead from an external feed) resolved via
 *      `lib/ats-url.mjs`'s `atsBoardFromUrl`. Zero network.
 *   3. `discover-ats.mjs`'s `resolveCompany` probe — only when `probe: true`
 *      is explicitly passed (this tier hits the network).
 *
 * Once a board is known, the matching `providers/*.mjs` module (via
 * `providers/_registry.mjs`, exactly the routing `scan.mjs` itself uses)
 * fetches its current postings, and the best title match is returned as
 * `{url, title, location, score}` — or `null` when no board resolves, the
 * board has no postings, or nothing clears `minScore`.
 *
 * Title matching is deliberately rough: postings are titled inconsistently
 * across a company's own board ("Werkstudent (m/w/d) Data Science" vs.
 * "Werkstudent:in Data Science — KI") for the same underlying role, so this
 * normalizes gender markers/punctuation and scores by token Jaccard
 * similarity rather than requiring an exact string match. `minScore`
 * (default 0.6) is the acceptance floor; `classifyReach` (from
 * `triage-prefilter.mjs`) is an additional location-sanity gate — a posting
 * that resolves as clearly 'abroad' is never returned, even if its title
 * matches perfectly, because a same-titled role in a different country is a
 * different opening.
 *
 * No network happens in a test that supplies its own `providers` Map (fake
 * `{id, fetch}` objects) — see tests/lib/resolve-employer-posting.test.mjs.
 *
 * Off-limits hosts (harvest-companies.mjs's `OFF_LIMITS_HOSTS` — a binding
 * user rule, not a heuristic) are refused at every tier, including the
 * discover-ats probe tier: whatever board entry a tier would otherwise
 * return, if its `careers_url`/`api` resolves to one of those hosts,
 * `resolveBoardEntry` returns `null` instead — the same single failure
 * channel every other "couldn't resolve" case already uses here (see
 * `refuseIfOffLimits`).
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import { atsBoardFromUrl } from './ats-url.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';
import { classifyReach, REACH_SCORE } from '../triage-prefilter.mjs';
import { resolveCompany } from '../discover-ats.mjs';
import { isOffLimitsUrl } from '../harvest-companies.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(HERE, '..', 'providers');

export const DEFAULT_MIN_SCORE = 0.6;

// ── Title normalization ──────────────────────────────────────────────────

// Bracketed or bare gender markers in any letter order/length: "(m/w/d)",
// "(w/m/d)", "(f/m/x)", bare "m/w/d". 2-4 letters so both the common
// three-letter German form and a four-letter "(m/w/d/x)" variant match.
const GENDER_MARKER_RE = /\(\s*[mwfdx]\s*(?:\/\s*[mwfdx]\s*){1,3}\)|\b[mwfdx](?:\/[mwfdx]){1,3}\b/gi;

// Gender-neutral suffixes attached to a role noun via *, : or / — "Mitarbeiter*in",
// "Student:in", "Berater/in", "Mitarbeiter*innen". Deliberately only "in"/"innen"
// (never a bare word-boundary "in", which is an ordinary English/German word).
const GENDER_SUFFIX_RE = /[*:/](in|innen)\b/gi;

/**
 * Normalize a job title for fuzzy comparison: strip gender markers/suffixes,
 * fold to lowercase, collapse all punctuation to spaces.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  let s = String(title || '').toLowerCase();
  s = s.replace(GENDER_MARKER_RE, ' ');
  s = s.replace(GENDER_SUFFIX_RE, ' ');
  // \p{L}\p{N} keeps script-preserving behavior (mirrors tracker-utils.mjs's
  // normalizeCompany) rather than an ASCII-only [^a-z0-9] filter, so an umlaut
  // or a non-Latin title still tokenizes on real word boundaries.
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** @param {string} title @returns {Set<string>} */
export function titleTokens(title) {
  const norm = normalizeTitle(title);
  return norm ? new Set(norm.split(' ')) : new Set();
}

/**
 * Jaccard similarity of two token sets. Two empty sets score 0, not 1 — an
 * empty title is not evidence of a match.
 * @param {Set<string>|string[]} a
 * @param {Set<string>|string[]} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Board resolution ─────────────────────────────────────────────────────

/** @param {any} portals @returns {any[]} */
function trackedCompaniesOf(portals) {
  if (Array.isArray(portals)) return portals;
  if (portals && Array.isArray(portals.tracked_companies)) return portals.tracked_companies;
  return [];
}

/**
 * Tier 1: an existing portals.yml `tracked_companies` entry for this company,
 * matched by normalized name. Zero network.
 * @param {string} company
 * @param {any} portals
 * @returns {any|null}
 */
export function findPortalsEntry(company, portals) {
  const key = normalizeCompany(company);
  if (!key) return null;
  for (const entry of trackedCompaniesOf(portals)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;
    if (normalizeCompany(entry.name) === key) return entry;
  }
  return null;
}

/**
 * Tier 2: any already-known URL for this company that `atsBoardFromUrl`
 * recognizes. Zero network. `provider` is set explicitly so downstream
 * routing (`resolveProvider`) skips `detect()` entirely — the vendor is
 * already certain. A URL on an off-limits host (harvest-companies.mjs's
 * `OFF_LIMITS_HOSTS`) is skipped outright, before it is ever offered to
 * `atsBoardFromUrl` — defense in depth, since none of the vendors
 * `atsBoardFromUrl` covers today matches any of those hosts anyway.
 * @param {string} company
 * @param {string[]} urls
 * @returns {any|null}
 */
export function entryFromKnownUrls(company, urls) {
  for (const url of Array.isArray(urls) ? urls : []) {
    if (isOffLimitsUrl(url)) continue;
    const hit = atsBoardFromUrl(url);
    if (hit) return { name: company, careers_url: hit.boardUrl, provider: hit.vendor };
  }
  return null;
}

/**
 * Refuse a resolved board entry outright when its careers_url/api is on an
 * off-limits host — the reason every tier's return value passes through this
 * before `resolveBoardEntry` hands it back. Applied uniformly regardless of
 * which tier produced the entry: a portals.yml entry a human configured, a
 * URL-tier match, or a live discover-ats probe result are all refused the
 * same way, because the rule is "never resolve a board at this host", not
 * "never resolve one THIS way". Exported so a test can exercise the tier-3
 * (discover-ats probe) refusal directly: discover-ats.mjs's real
 * `resolveCompany` can only ever build a `careers_url` from a fixed
 * ATS-vendor host, never an off-limits one, so there is no way to organically
 * drive it there through a fake ctx — this is the same function tier 3's
 * result is piped through, given an entry shaped exactly like what that tier
 * produces (`{name, careers_url, provider, api?}`).
 * @param {any} entry
 * @returns {any|null}
 */
export function refuseIfOffLimits(entry) {
  if (!entry) return null;
  if (isOffLimitsUrl(entry.careers_url) || (entry.api && isOffLimitsUrl(entry.api))) return null;
  return entry;
}

/**
 * Resolve a `providers/*.mjs`-ready entry for `target.company`, trying each
 * tier in order and returning the first hit (or `null`).
 * @param {{company:string, urls?:string[], slug?:string, website?:string}} target
 * @param {{ctx:any, portals?:any, probe?:boolean}} opts
 * @returns {Promise<any|null>}
 */
export async function resolveBoardEntry(target, { ctx, portals, probe = false }) {
  const fromPortals = findPortalsEntry(target.company, portals);
  // A portals.yml entry pointing at an off-limits host is refused outright,
  // not treated as "no match, try the next tier" — the user's rule is
  // absolute for that company, so resolution stops here rather than quietly
  // trying to find some OTHER board for it behind the rule's back.
  if (fromPortals) return refuseIfOffLimits(fromPortals);

  const fromUrl = entryFromKnownUrls(target.company, target.urls);
  if (fromUrl) return refuseIfOffLimits(fromUrl);

  if (!probe) return null;

  // Tier 3 — a live discover-ats probe. Only reached when the caller opted
  // in: it hits the network (bounded by discover-ats.mjs's own VENDOR_ORDER
  // probing and ctx timeouts), which the first two tiers deliberately don't.
  const { resolved } = await resolveCompany(
    { name: target.company, slug: target.slug, website: target.website },
    { ctx },
  );
  if (!resolved) return null;
  /** @type {any} */
  const entry = { name: target.company, careers_url: resolved.careers_url, provider: resolved.vendor };
  if (resolved.api) entry.api = resolved.api;
  // Defense in depth: discover-ats.mjs's probe only ever visits fixed
  // ATS-vendor canonical hosts, never one of OFF_LIMITS_HOSTS, so this
  // branch can't currently trigger — but "refuse... including in its
  // discover-ats probe tier" is unconditional, not scoped to today's
  // resolution mechanics.
  return refuseIfOffLimits(entry);
}

// ── Title matching ───────────────────────────────────────────────────────

/**
 * Best-scoring job in `jobs` against `targetTitle`, subject to `minScore` and
 * a location-sanity gate (an 'abroad' classification is never returned).
 * Ties break toward the more reachable location (home > remote > munich >
 * unknown > germany), then keep the first-seen job — the board's own order.
 * @param {string} targetTitle
 * @param {any[]} jobs
 * @param {{minScore:number}} opts
 * @returns {{url:string, title:string, location:string, score:number}|null}
 */
export function bestTitleMatch(targetTitle, jobs, { minScore = DEFAULT_MIN_SCORE } = {}) {
  const targetTokens = titleTokens(targetTitle);
  let best = null;
  let bestReachRank = -Infinity;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.url !== 'string' || !job.url) continue;
    const jobTitle = typeof job.title === 'string' ? job.title : '';
    const score = jaccardSimilarity(targetTokens, titleTokens(jobTitle));
    if (score < minScore) continue;
    const location = typeof job.location === 'string' ? job.location : '';
    const reach = classifyReach(location, jobTitle);
    if (reach === 'abroad') continue;
    const reachRank = REACH_SCORE[reach] ?? 2.5;
    if (!best || score > best.score || (score === best.score && reachRank > bestReachRank)) {
      best = { url: job.url, title: jobTitle, location, score };
      bestReachRank = reachRank;
    }
  }
  return best;
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * @param {{company:string, title?:string, location?:string, urls?:string[], slug?:string, website?:string}} target
 * @param {{ctx?:any, portals?:any, providers?:Map<string,any>, probe?:boolean, minScore?:number}} [options]
 * @returns {Promise<{url:string, title:string, location:string, score:number}|null>}
 */
export async function resolveEmployerPosting(target, options = {}) {
  const company = typeof target?.company === 'string' ? target.company.trim() : '';
  if (!company) return null;

  const ctx = options.ctx || makeHttpCtx();
  const providers = options.providers || await loadProviders(PROVIDERS_DIR);

  const entry = await resolveBoardEntry({ ...target, company }, {
    ctx, portals: options.portals, probe: options.probe === true,
  });
  if (!entry) return null;

  const routed = resolveProvider(entry, providers);
  if (!routed || routed.error || !routed.provider) return null;

  let jobs;
  try {
    jobs = await routed.provider.fetch(entry, ctx);
  } catch {
    // A board that fails to fetch resolves to "no match", same as an empty
    // board — this function has one failure mode (null), not a second error
    // channel a caller would have to handle separately.
    return null;
  }
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  return bestTitleMatch(typeof target?.title === 'string' ? target.title : '', jobs, {
    minScore: typeof options.minScore === 'number' ? options.minScore : DEFAULT_MIN_SCORE,
  });
}
