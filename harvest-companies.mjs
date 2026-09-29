#!/usr/bin/env node
/**
 * harvest-companies.mjs — auto-feed portals.yml `tracked_companies` from
 * companies already SEEN in the region, instead of hand-typed.
 *
 * career-ops's scanners already speak ~80 ATS vendors (providers/), but
 * scan.mjs only ever crawls the companies a human listed by hand in
 * portals.yml. Every job-board aggregator already in `job_boards`
 * (arbeitnow, echojobs, a16z-speedrun-talent, getro, yourator, …) sees far
 * more employers than that — data/scan-history.tsv already has their names,
 * titles, locations and posting URLs sitting in it from ordinary scans. This
 * turns that exhaust into new tracked_companies candidates:
 *
 *   1. Read data/scan-history.tsv (+ optionally a JSON leads file via --in —
 *      the shape an external feed like a Pinloop-style provider would hand
 *      in), keep rows from the last N days (--days, default 30).
 *   2. Keep only rows with POSITIVE evidence of being in Germany and in
 *      reach — a blank/uninformative location is NOT enough here, unlike
 *      triage's own classifyReach gate. Adding a board costs scan time on
 *      every future pass, so harvesting demands real evidence instead of the
 *      "don't penalize missing data" default triage uses for a single
 *      posting. A row counts only when classifyReach (triage-prefilter.mjs)
 *      returns home/munich/remote, OR the row came from a Germany-only
 *      source (DE_ONLY_PORTALS) and isn't classified abroad — and even then
 *      a company is only kept once at least one of its qualifying sightings
 *      carries DIRECT Germany evidence (a German city, "Germany"/
 *      "Deutschland" in the location text, a .de host, or a Germany-only
 *      portal — see germanyEvidenceTag). Title relevance reuses
 *      triage-prefilter.mjs's own exported title signals.
 *   3. Group by normalized company — recomputed fresh via `normalizeCompanyName`
 *      (harvestCompanyKey) rather than trusting `data/scan-history.tsv`'s own
 *      stored `normalized_company` column, which can carry a STALE value from
 *      an older `normalizeCompanyName` algorithm (see harvestCompanyKey's own
 *      doc comment — this is why "BMW Group" used to show up as two separate
 *      groups with the identical display name).
 *   4. Skip any company already present anywhere in portals.yml — by
 *      normalized name, or because a URL it was sighted at already resolves
 *      to a board portals.yml already tracks under a different display name —
 *      and separately, skip any company that is OFF-LIMITS (see
 *      OFF_LIMITS_HOSTS / isOffLimitsCandidate below): a binding user rule,
 *      reported as `source: 'off-limits'`, never probed or written.
 *   5. For each company left: `lib/ats-url.mjs`'s `atsBoardFromUrl` on its
 *      sighted URLs first (zero network — one of those URLs may already BE
 *      the employer's own ATS board, e.g. an aggregator whose Job.url is the
 *      upstream employer link per Source Indexing Policy rule 2). Only with
 *      --probe does an unresolved company get a bounded, polite live probe
 *      via discover-ats.mjs's own resolver (`runDiscovery`) — --limit caps
 *      how many companies pay for that per run (default 25).
 *
 * portals.yml is a USER-LAYER file, so — exactly like discover-ats.mjs — this
 * command is preview-only by default: it prints what it WOULD add and writes
 * nothing. --write opts in, reusing discover-ats.mjs's own safe splice writer
 * (renderPortalEntry / dedupeAgainstPortals / insertIntoTrackedCompanies) —
 * this file does not implement a second YAML writer.
 *
 * Run: node harvest-companies.mjs                          # preview, url-tier only
 *      node harvest-companies.mjs --days 45                # wider window
 *      node harvest-companies.mjs --in leads.json           # + external leads
 *      node harvest-companies.mjs --probe --limit 10        # + live probe (bounded)
 *      node harvest-companies.mjs --probe --write            # opt in: append to portals.yml
 *      node harvest-companies.mjs --summary                  # human-readable table
 *      node harvest-companies.mjs --self-test
 *
 * Probing hits live third-party APIs (via discover-ats.mjs), so honor
 * CAREER_OPS_PORTALS / CAREER_OPS_SCAN_HISTORY to point at scratch files
 * during tests/experiments — same env vars discover-ats.mjs and scan.mjs
 * already read.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { parseScanHistory } from './detect-reposts.mjs';
import { classifyReach, STUDENT_RE, TECH_RE, ENTRY_RE } from './triage-prefilter.mjs';
import { atsBoardFromUrl } from './lib/ats-url.mjs';
import { renderPortalEntry, dedupeAgainstPortals, insertIntoTrackedCompanies, runDiscovery } from './discover-ats.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { flagValue, hasFlag, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const SCAN_HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || join(DATA_ROOT, 'data/scan-history.tsv');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');

export const DEFAULT_DAYS = 30;
export const DEFAULT_PROBE_LIMIT = 25;
// Lower than discover-ats.mjs's own DEFAULT_CONCURRENCY (8): these are
// companies nobody has vetted yet, potentially many at once, and this run is
// unattended — a lower concurrency spreads the same probe budget over more
// wall-clock time instead of bursting it, which is the "polite" half of
// "rate-limit probes politely" (the bounded --limit is the other half).
export const PROBE_CONCURRENCY = 3;

const USAGE = `Usage:
  node harvest-companies.mjs                          # preview — url-tier only, writes nothing
  node harvest-companies.mjs --days 45                 # widen the scan-history window (default 30)
  node harvest-companies.mjs --in leads.json           # + external leads (JSON array of {company,title,url,location})
  node harvest-companies.mjs --probe                   # + live discover-ats probe for unresolved companies
  node harvest-companies.mjs --probe --limit 10        # cap how many companies get probed (default 25)
  node harvest-companies.mjs --probe --write           # opt in: append resolved entries to portals.yml
  node harvest-companies.mjs --summary                 # human-readable table instead of JSON
  node harvest-companies.mjs --self-test               # inline test suite
  node harvest-companies.mjs --help                    # print this usage block

portals.yml is a user-layer file: this command NEVER writes it unless you pass
--write. The default previews the entries it would add.

--in accepts a top-level JSON array of {company, title?, url?, location?}, or
{"leads": [...]} — the shape a JSON-based lead feed (e.g. a Pinloop-style
provider) would produce. These leads are exempt from the --days window (they
carry no first_seen) but still pass through the same region + title filters.`;

const KNOWN_FLAGS = ['--in', '--days', '--limit', '--probe', '--write', '--dry-run', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--in', '--days', '--limit'];

// ── Pure filters (exported for tests) ────────────────────────────────────

/** A title that looks student/data/AI relevant — the same signals triage-prefilter.mjs's rankEntry() checks in Stage 2. */
export function titleLooksRelevant(title) {
  const t = typeof title === 'string' ? title : '';
  return STUDENT_RE.test(t) || TECH_RE.test(t) || ENTRY_RE.test(t);
}

// Positive-evidence reach verdicts only — triage-prefilter.mjs's classifyReach
// can also return 'unknown' (no usable location signal at all) and 'germany'
// (names a German place/word but isn't commutable and has no remote marker);
// both are hard drops for THIS gate. triage's own rankEntry() treats 'unknown'
// as a pass-through ("don't penalize missing data on a single posting a human
// is about to open"), which is right for triage but wrong for harvesting: a
// blank location proves nothing, and a wrongly-added board costs scan time on
// every future pass forever, not just once. See DE_ONLY_PORTALS below for the
// one case a blank location is still admissible.
const POSITIVE_REACH = new Set(['home', 'munich', 'remote']);

// Providers whose ENTIRE inventory is Germany-scoped by construction — a
// listing from one of these needs no location text to prove it's German, the
// source already guarantees it. Portal values match scan-history.tsv's
// `portal` column convention (`${provider.id}-api`, written by scan.mjs);
// 'pinloop-api' is included pre-emptively for the same reason `--in` accepts
// an optional `portal` field on a lead (see parseLeadsJson) — a Pinloop-style
// feed is itself Germany/Erlangen-scoped, so a lead it hands in through --in
// can opt into this same bypass by tagging itself 'pinloop-api'.
export const DE_ONLY_PORTALS = new Set([
  'arbeitsagentur-api', 'stellenanzeigen-api', 'stellenwerk-api', 'studierendenjobs-api', 'fau-api', 'pinloop-api',
]);

/**
 * Whether a sighting counts toward a company's harvest at all — the ROW-level
 * gate. Positive evidence only: either classifyReach itself says home/munich/
 * remote, or the row is sourced from a Germany-only portal and isn't
 * classified 'abroad' (a DE-only portal vouches for the employer being
 * German even when the location field is blank, but it can't override an
 * explicit foreign location if one is somehow present).
 * @param {{location?:string, title?:string, url?:string, portal?:string}} row
 * @returns {boolean}
 */
export function isQualifyingSighting(row) {
  const location = typeof row?.location === 'string' ? row.location : '';
  const title = typeof row?.title === 'string' ? row.title : '';
  const url = typeof row?.url === 'string' ? row.url : '';
  const portal = typeof row?.portal === 'string' ? row.portal.trim().toLowerCase() : '';
  const reach = classifyReach(location, title, url);
  if (POSITIVE_REACH.has(reach)) return true;
  return DE_ONLY_PORTALS.has(portal) && reach !== 'abroad';
}

const DE_TEXT_RE = /deutschland|germany/i;

/**
 * DIRECT textual/host/source evidence that a QUALIFYING sighting (see
 * isQualifyingSighting) is actually in Germany — narrower than "in reach".
 * A bare 'remote' verdict passes the row gate above (no foreign marker was
 * found), but "no foreign marker" is not the same claim as "this names
 * Germany" — a location of just "Remote" with no country at all proves
 * neither. This is the per-company minimum-evidence check: harvestCompanies
 * only keeps a company if at least one of its qualifying sightings returns a
 * non-null tag here (see filterAndGroup).
 * @param {{location?:string, title?:string, url?:string, portal?:string}} row
 * @returns {'city'|'de-text'|'de-host'|'de-portal'|null}
 */
export function germanyEvidenceTag(row) {
  const location = typeof row?.location === 'string' ? row.location : '';
  const title = typeof row?.title === 'string' ? row.title : '';
  const url = typeof row?.url === 'string' ? row.url : '';
  const portal = typeof row?.portal === 'string' ? row.portal.trim().toLowerCase() : '';
  const reach = classifyReach(location, title, url);
  // home/munich: a recognized commutable city. germany: OTHER_DE_CITY_RE/
  // GERMANY_RE matched the text (a German place or the word Germany itself) —
  // real textual evidence, even though rankEntry's OWN Stage-1 treats it as a
  // hard drop for a single posting (not commutable, no remote signal).
  // Harvesting a company is not a commute decision, so it counts as evidence
  // here even though it would never itself satisfy isQualifyingSighting.
  if (reach === 'home' || reach === 'munich' || reach === 'germany') return 'city';
  if (DE_TEXT_RE.test(location)) return 'de-text';
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (host.endsWith('.de')) return 'de-host';
  if (DE_ONLY_PORTALS.has(portal)) return 'de-portal';
  return null;
}

/**
 * Parse a --in leads file's raw text. Never throws — a malformed file or a
 * bad entry is a warning, mirroring discover-ats.mjs's parseCompanyInput.
 * `portal` is optional and not part of the documented Pinloop-lead shape —
 * it exists so a feed that IS entirely Germany-scoped (a Pinloop-style
 * provider) can tag its own leads 'pinloop-api' and use the DE_ONLY_PORTALS
 * bypass in isQualifyingSighting, the same as a scan-history row would.
 * @param {string} raw
 * @returns {{leads: {company:string, title:string, url:string, location:string, portal:string}[], warnings: string[]}}
 */
export function parseLeadsJson(raw) {
  const warnings = [];
  const leads = [];
  if (typeof raw !== 'string' || !raw.trim()) return { leads, warnings };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    warnings.push(`--in: malformed JSON — ${err.message}`);
    return { leads, warnings };
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data?.leads) ? data.leads : null);
  if (!list) {
    warnings.push('--in: expected a top-level JSON array, or {"leads": [...]}');
    return { leads, warnings };
  }
  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') {
      warnings.push(`--in[${idx}]: dropped non-object entry`);
      return;
    }
    const company = typeof item.company === 'string' ? item.company.trim() : '';
    if (!company) {
      warnings.push(`--in[${idx}]: dropped entry with missing/empty company`);
      return;
    }
    leads.push({
      company,
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      location: typeof item.location === 'string' ? item.location : '',
      portal: typeof item.portal === 'string' ? item.portal : '',
    });
  });
  return { leads, warnings };
}

/**
 * Grouping key for a sighting — ALWAYS derived fresh from the raw company
 * display text via `normalizeCompanyName`, never from a row's stored
 * `normalized_company` column.
 *
 * detect-reposts.mjs's own `companyKey()` deliberately PREFERS that stored
 * column when present, so a row written by an older `normalizeCompanyName`
 * algorithm still clusters with its own history — the right call for a
 * repost detector reading years of accumulated rows. It is the wrong call
 * here: two rows with the byte-identical company text "BMW Group" carried
 * different stored `normalized_company` values ('bmw' vs 'bmw group', from
 * before/after "Group" was added to `normalizeCompanyName`'s generic-
 * descriptor strip list), so the SAME display name split into two separate
 * harvest groups with different sighting counts. Recomputing fresh can only
 * MERGE rows whose text normalizes identically TODAY — it can never split
 * an existing cluster, and it never merges genuinely different spellings
 * ("Fraunhofer IIS" vs the long institute name still normalize differently
 * and stay separate groups).
 * @param {{company?:string}} row
 * @returns {string}
 */
export function harvestCompanyKey(row) {
  const raw = typeof row?.company === 'string' ? row.company.trim() : '';
  return normalizeCompanyName(raw) || raw.toLowerCase();
}

/**
 * Filter rows to the qualifying (isQualifyingSighting), title-relevant,
 * in-window subset, group them by harvestCompanyKey(), then drop any company
 * whose qualifying sightings carry no DIRECT Germany evidence at all
 * (germanyEvidenceTag) — the per-company minimum-evidence gate. Rows must
 * already carry a `date` (a valid Date) — parseScanHistory() and the
 * lead-row shaper below both produce that.
 *
 * @param {any[]} rows
 * @param {{days?:number, now?:number}} [opts]
 * @returns {{groups: {key:string, company:string, sightings:number, urls:string[], evidence:string[]}[], matchedRows:number, droppedForNoEvidence:number}}
 */
export function filterAndGroup(rows, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  /** @type {Map<string, {key:string, nameCounts:Map<string,number>, sightings:number, urls:string[], evidence:Set<string>}>} */
  const groups = new Map();
  let matchedRows = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.company !== 'string' || !row.company.trim()) continue;
    if (!(row.date instanceof Date) || Number.isNaN(row.date.getTime())) continue;
    if (row.date.getTime() < cutoff) continue;

    const title = typeof row.title === 'string' ? row.title : '';
    if (!isQualifyingSighting(row)) continue;
    if (!titleLooksRelevant(title)) continue;

    const key = harvestCompanyKey(row);
    if (!key) continue;
    matchedRows += 1;

    let g = groups.get(key);
    if (!g) {
      g = { key, nameCounts: new Map(), sightings: 0, urls: [], evidence: new Set() };
      groups.set(key, g);
    }
    g.sightings += 1;
    const rawName = row.company.trim();
    g.nameCounts.set(rawName, (g.nameCounts.get(rawName) || 0) + 1);
    const url = typeof row.url === 'string' ? row.url : '';
    // Capped, not unbounded: a high-volume aggregator company could otherwise
    // carry hundreds of near-duplicate posting URLs into memory for no
    // benefit — atsBoardFromUrl only ever needs to find ONE that resolves.
    if (url && g.urls.length < 25 && !g.urls.includes(url)) g.urls.push(url);
    const tag = germanyEvidenceTag(row);
    if (tag) g.evidence.add(tag);
  }

  const out = [];
  let droppedForNoEvidence = 0;
  for (const g of groups.values()) {
    // Every qualifying row passed isQualifyingSighting, but that alone can be
    // a bare 'remote' verdict with no textual/host/portal proof of Germany
    // (see germanyEvidenceTag's doc comment) — require at least one row that
    // actually names Germany, a German city, a .de host, or a DE-only portal.
    if (g.evidence.size === 0) {
      droppedForNoEvidence += 1;
      continue;
    }
    let bestName = '';
    let bestCount = -1;
    for (const [name, count] of g.nameCounts) {
      // Ties broken toward the shorter spelling — an abbreviation-free tie
      // ("Acme" vs "Acme Inc.") is rare in practice, and shorter is the safer
      // default for a portals.yml display name.
      if (count > bestCount || (count === bestCount && name.length < bestName.length)) {
        bestName = name;
        bestCount = count;
      }
    }
    out.push({ key: g.key, company: bestName, sightings: g.sightings, urls: g.urls, evidence: [...g.evidence].sort() });
  }
  out.sort((a, b) => b.sightings - a.sightings || a.company.localeCompare(b.company));
  return { groups: out, matchedRows, droppedForNoEvidence };
}

/**
 * Index of what portals.yml already covers, for the "skip already-tracked"
 * gate — by normalized name (either list) and by resolved board (vendor+slug,
 * from careers_url/api via atsBoardFromUrl), so a company already tracked
 * under a DIFFERENT display name is still caught.
 * @param {any} portalsDoc - Parsed portals.yml (or {} when absent/unreadable).
 * @returns {{names: Set<string>, boards: Set<string>}}
 */
export function buildExistingIndex(portalsDoc) {
  const names = new Set();
  const boards = new Set();
  for (const list of [portalsDoc?.tracked_companies, portalsDoc?.job_boards]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.name === 'string' && entry.name.trim()) {
        names.add(normalizeCompanyName(entry.name));
      }
      for (const field of [entry.careers_url, entry.api]) {
        if (typeof field !== 'string' || !field) continue;
        const hit = atsBoardFromUrl(field);
        if (hit) boards.add(`${hit.vendor}:${hit.slug.toLowerCase()}`);
      }
    }
  }
  return { names, boards };
}

// ── Off-limits denylist (binding user rule, not a heuristic) ─────────────
// NEVER probe, resolve, or write a board at one of these hosts. Every entry
// here has a specific reason, not "looked risky":
//   - bmwgroup.jobs — BMW Group's own careers domain. BMW's jobs already
//     flow in via the arbeitsagentur-api job board (many-employers, already
//     tracked); a dedicated per-company probe/board for BMW is explicitly
//     unwanted, never just untried.
//   - linkedin.com / xing.com — social networks, never an ATS board host.
//   - stepstone.de — excluded from scanning entirely per project policy
//     (robots.txt/ToS; see the repo-wide "never send a request to
//     stepstone.de" rule this session was given directly).
//   - indeed.* — blocked across every TLD (indeed.com, indeed.de, ...), not
//     one hardcoded domain — matched by INDEED_WILDCARD_RE below.
// Matched by exact host OR any subdomain (host === X or host.endsWith('.'+X)),
// so www.linkedin.com / de.indeed.com / to.indeed.com are all covered by one
// entry each. This is the ONE exported constant covering the host side of
// the rule; OFF_LIMITS_COMPANY_KEYS below covers the one case a host check
// alone cannot reach (see its own comment).
export const OFF_LIMITS_HOSTS = ['bmwgroup.jobs', 'linkedin.com', 'xing.com', 'stepstone.de'];
const INDEED_WILDCARD_RE = /(^|\.)indeed\.[a-z.]+$/i;

/** @param {string} hostname */
export function isOffLimitsHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (INDEED_WILDCARD_RE.test(host)) return true;
  return OFF_LIMITS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** @param {string} url */
export function isOffLimitsUrl(url) {
  try {
    return isOffLimitsHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Companies excluded from url-tier AND probe-tier resolution by NAME, not by
// host — the one case OFF_LIMITS_HOSTS alone cannot catch. BMW Group's own
// bmwgroup.jobs sightings in data/scan-history.tsv carry no `company` value
// at all (verified 2026-09: every bmwgroup.jobs row in the live history is a
// bare `url \t first_seen \t portal \t title` line — a pre-existing
// websearch/scraper data-quality gap), so filterAndGroup drops those rows
// before a company is ever attributed and a pure host check on `candidate.urls`
// never sees bmwgroup.jobs at all for this company. The user named the
// company directly alongside its host in the same instruction
// ("bmwgroup.jobs (BMW Group — jobs come via Arbeitsagentur instead)"), so it
// is ALSO excluded by its normalized display name here.
//
// BMW Group / BMW AG / BMW — one employer, three spellings, because
// bmwgroup.jobs is its only real board and harvestCompanyKey deliberately
// does NOT merge all three into one group ("AG" is not a stripped legal
// suffix, so "BMW AG" keys differently from "BMW"/"BMW Group" — see
// harvestCompanyKey's own comment). Off-limits is a per-GROUP classification,
// not automatically inherited across groups that normalize differently, so
// every spelling this employer is known to appear under is listed
// explicitly. 'BMW' and 'BMW Group' both normalize to the same key ('bmw')
// and so collapse to one Set entry; 'BMW AG' normalizes to a different key
// ('bmw ag') and needs its own — same normalization
// harvestCompanyKey/normalizeCompanyName use everywhere else, so a casing or
// whitespace variant of any of the three still matches.
const OFF_LIMITS_COMPANY_KEYS = new Set([
  normalizeCompanyName('BMW Group'),
  normalizeCompanyName('BMW AG'),
  normalizeCompanyName('BMW'),
]);

/**
 * Whether a grouped candidate must be excluded from BOTH the url-tier and the
 * probe-tier entirely, reported as `source: 'off-limits'` instead.
 *
 * NAME-based only (OFF_LIMITS_COMPANY_KEYS) — currently BMW Group/BMW AG/BMW,
 * excluded because their only real board is bmwgroup.jobs (never a
 * resolvable ATS vendor) and BMW's coverage already comes via the
 * arbeitsagentur-api job board instead. A company is deliberately NOT made
 * off-limits merely because every one of its sighted URLs happens to be on
 * an OFF_LIMITS_HOSTS aggregator (linkedin.com/xing.com/stepstone.de/
 * indeed.*) — discover-ats.mjs's probe tier never visits a sighted URL at
 * all (it derives its own candidate URLs from the company name/slug), so
 * probing such a company can never actually contact one of those hosts, and
 * these are exactly the companies harvest-companies.mjs exists to find
 * (Fraunhofer IIS, MAN Truck & Bus Group, Münchener Verein, Primetals
 * Technologies, …, all discovered via a LinkedIn/Indeed sighting with no
 * other URL evidence). Those hosts stay relevant only as ATS-board-host
 * refusals — resolveViaUrls below already skips them as candidate board
 * URLs, so they are never mistaken for a resolvable board either way.
 * @param {{company:string, urls?:string[]}} candidate
 * @returns {boolean}
 */
export function isOffLimitsCandidate(candidate) {
  return OFF_LIMITS_COMPANY_KEYS.has(normalizeCompanyName(candidate?.company || ''));
}

/**
 * Try to resolve a candidate's board from its already-known sighting URLs.
 * Zero network. First URL that atsBoardFromUrl recognizes wins; a URL on an
 * off-limits host is skipped outright — never even offered to atsBoardFromUrl
 * — so a board can never be resolved there even if some future vendor's
 * detect() would otherwise recognize the host (defense in depth: none of the
 * 16 vendors atsBoardFromUrl covers today matches any OFF_LIMITS_HOSTS entry).
 * @param {{urls:string[]}} candidate
 * @returns {{vendor:string, slug:string, boardUrl:string}|null}
 */
export function resolveViaUrls(candidate) {
  for (const url of Array.isArray(candidate?.urls) ? candidate.urls : []) {
    if (isOffLimitsUrl(url)) continue;
    const hit = atsBoardFromUrl(url);
    if (hit) return hit;
  }
  return null;
}

// Vendors this module additionally covers beyond discover-ats.mjs's own
// VENDOR_ORDER (softgarden, successfactors, teamtailor) — their detect() is
// broader/substring-based rather than a single pinned host, so an explicit
// `provider:` line removes any ambiguity about routing. workday always needs
// it (a name alone carries no coordinates a bare careers_url could imply
// otherwise). Every other vendor here (lever, ashby, personio,
// smartrecruiters, recruitee, join, workable, bamboohr, breezy, pinpoint,
// rippling) has a cleanly host-pinned detect() that reliably claims the
// canonical boardUrl atsBoardFromUrl produces, so no extra field is needed —
// exactly the convention discover-ats.mjs's own renderPortalEntry follows
// (only greenhouse gets `api:`, only workday gets an explicit `provider:`).
const EXPLICIT_PROVIDER_VENDORS = new Set(['workday', 'softgarden', 'successfactors', 'teamtailor']);

/**
 * Extra portals.yml entry fields a resolved vendor+slug should carry, beyond
 * `name`/`careers_url` — mirrors discover-ats.mjs's per-vendor VENDORS config.
 * @param {string} vendor
 * @param {string} slug
 * @returns {{api?:string, provider?:string}}
 */
export function entryFieldsForVendor(vendor, slug) {
  if (vendor === 'greenhouse') return { api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` };
  if (EXPLICIT_PROVIDER_VENDORS.has(vendor)) return { provider: vendor };
  return {};
}

/** @param {{company:string, sightings:number, evidence?:string[]}} candidate @param {string} source */
function unresolvedRow(candidate, source) {
  return {
    company: candidate.company, sightings: candidate.sightings, vendor: null, slug: null, careers_url: null,
    source, evidence: candidate.evidence || [],
  };
}

// ── Orchestration (network only in the --probe tier, and only via ctx) ────

/**
 * @param {object} opts
 * @param {string} [opts.scanHistoryContent]
 * @param {string} [opts.leadsRaw]
 * @param {any} [opts.portalsDoc]
 * @param {number} [opts.days]
 * @param {number} [opts.now]
 * @param {boolean} [opts.probe]
 * @param {number} [opts.limit]
 * @param {any} [opts.ctx] - Injectable for tests; defaults to a real HTTP ctx.
 * @param {number} [opts.concurrency]
 * @returns {Promise<{results: any[], metadata: any, warnings: string[]}>}
 */
export async function harvestCompanies({
  scanHistoryContent = '', leadsRaw = '', portalsDoc = null, days = DEFAULT_DAYS,
  now = Date.now(), probe = false, limit = DEFAULT_PROBE_LIMIT, ctx, concurrency = PROBE_CONCURRENCY,
} = {}) {
  const warnings = [];

  const scanRows = parseScanHistory(scanHistoryContent).filter((r) => r.status === 'added');
  const { leads, warnings: leadWarnings } = parseLeadsJson(leadsRaw);
  warnings.push(...leadWarnings);
  // Leads have no first_seen (they're a fresh sighting handed in this run),
  // so they are exempted from the --days window by stamping `now` — they
  // still pass through the same region/title filters as everything else.
  const leadRows = leads.map((l) => ({ ...l, date: new Date(now), status: 'added', normCompany: '' }));

  const { groups: allCandidates, matchedRows, droppedForNoEvidence } = filterAndGroup([...scanRows, ...leadRows], { days, now });

  const { names: existingNames, boards: existingBoards } = buildExistingIndex(portalsDoc || {});

  const alreadyTracked = [];
  const offLimits = [];
  const candidates = [];
  for (const g of allCandidates) {
    if (existingNames.has(normalizeCompanyName(g.company))) alreadyTracked.push(g);
    else if (isOffLimitsCandidate(g)) offLimits.push(g);
    else candidates.push(g);
  }

  const results = [];
  // Off-limits candidates never reach resolveViaUrls or the probe tier at
  // all — reported up front, unconditionally, regardless of --probe.
  for (const candidate of offLimits) results.push(unresolvedRow(candidate, 'off-limits'));

  const needsProbe = [];
  let duplicateBoards = 0;

  for (const candidate of candidates) {
    const hit = resolveViaUrls(candidate);
    if (!hit) {
      needsProbe.push(candidate);
      continue;
    }
    const boardKey = `${hit.vendor}:${hit.slug.toLowerCase()}`;
    if (existingBoards.has(boardKey)) {
      duplicateBoards += 1;
      continue;
    }
    existingBoards.add(boardKey); // guards against two candidates resolving to the same board this run
    results.push({
      company: candidate.company, sightings: candidate.sightings, vendor: hit.vendor, slug: hit.slug,
      careers_url: hit.boardUrl, source: 'url', evidence: candidate.evidence, ...entryFieldsForVendor(hit.vendor, hit.slug),
    });
  }

  let probedCount = 0;
  let probeCapped = [];
  if (probe && needsProbe.length) {
    const toProbe = needsProbe.slice(0, Math.max(0, limit));
    probeCapped = needsProbe.slice(Math.max(0, limit));
    probedCount = toProbe.length;
    if (toProbe.length) {
      const httpCtx = ctx || makeHttpCtx();
      const { resolved } = await runDiscovery(toProbe.map((c) => ({ name: c.company })), { ctx: httpCtx, concurrency });
      const resolvedByName = new Map(resolved.map((r) => [r.name, r]));
      for (const candidate of toProbe) {
        const r = resolvedByName.get(candidate.company);
        if (!r) {
          results.push(unresolvedRow(candidate, 'unresolved'));
          continue;
        }
        // Defense in depth: discover-ats.mjs's probe only ever visits the
        // fixed ATS-vendor canonical hosts (never a company's own sighted
        // URLs), so this can't currently trigger — but "never probe, resolve
        // or write boards for hosts X" is an unconditional rule, not one
        // scoped to how resolution happens to work today.
        if (isOffLimitsUrl(r.careers_url) || (r.api && isOffLimitsUrl(r.api))) {
          results.push(unresolvedRow(candidate, 'off-limits'));
          continue;
        }
        const boardKey = `${r.vendor}:${String(r.slug).toLowerCase()}`;
        if (existingBoards.has(boardKey)) {
          duplicateBoards += 1;
          continue;
        }
        existingBoards.add(boardKey);
        results.push({
          company: candidate.company, sightings: candidate.sightings, vendor: r.vendor, slug: r.slug,
          careers_url: r.careers_url, source: 'probe', evidence: candidate.evidence,
          ...(r.api ? { api: r.api } : {}), ...entryFieldsForVendor(r.vendor, r.slug),
        });
      }
    }
  } else {
    probeCapped = needsProbe;
  }
  for (const candidate of probeCapped) results.push(unresolvedRow(candidate, 'unresolved'));

  results.sort((a, b) => b.sightings - a.sightings || a.company.localeCompare(b.company));

  const metadata = {
    scanHistoryRows: scanRows.length,
    leadRows: leadRows.length,
    matchedRows,
    droppedForNoEvidence,
    groupedCompanies: allCandidates.length,
    alreadyTracked: alreadyTracked.length,
    offLimits: results.filter((r) => r.source === 'off-limits').length,
    candidates: candidates.length,
    resolvedViaUrl: results.filter((r) => r.source === 'url').length,
    resolvedViaProbe: results.filter((r) => r.source === 'probe').length,
    unresolved: results.filter((r) => r.source === 'unresolved').length,
    duplicateBoards,
    probed: probedCount,
    probeLimit: limit,
    probeRequested: probe === true,
    probeSkippedDueToLimit: probe ? Math.max(0, needsProbe.length - probedCount) : 0,
    days,
  };

  return { results, metadata, warnings };
}

// ── Self-test (pure, no network) ────────────────────────────────────────

function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) pass += 1; else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  check(titleLooksRelevant('Werkstudent (m/w/d) Data Science'), 'titleLooksRelevant: student title');
  check(titleLooksRelevant('Junior AI Engineer'), 'titleLooksRelevant: entry-level + tech title');
  check(!titleLooksRelevant('Sales Account Executive'), 'titleLooksRelevant: irrelevant title rejected');

  check(isQualifyingSighting({ location: 'Erlangen' }), 'isQualifyingSighting: home city, no portal needed');
  check(isQualifyingSighting({ location: 'Munich' }), 'isQualifyingSighting: Munich commuter ring qualifies');
  check(!isQualifyingSighting({ location: '' }), 'isQualifyingSighting: a blank location from an unknown portal does NOT qualify (the fix)');
  check(!isQualifyingSighting({ location: 'Berlin' }), 'isQualifyingSighting: elsewhere-in-Germany, no portal, does NOT qualify');
  check(!isQualifyingSighting({ location: 'Remote, US' }), 'isQualifyingSighting: "Remote, US" is abroad, rejected');
  check(!isQualifyingSighting({ location: 'New York, USA' }), 'isQualifyingSighting: abroad rejected');
  check(isQualifyingSighting({ location: '', portal: 'arbeitsagentur-api' }), 'isQualifyingSighting: blank location from a DE-only portal qualifies');
  check(isQualifyingSighting({ location: '', portal: 'ARBEITSAGENTUR-API' }), 'isQualifyingSighting: DE-only portal match is case-insensitive');
  check(!isQualifyingSighting({ location: 'New York, USA', portal: 'arbeitsagentur-api' }), 'isQualifyingSighting: a DE-only portal cannot override an explicit foreign location');
  check(!isQualifyingSighting({ location: '', portal: 'greenhouse-api' }), 'isQualifyingSighting: a blank location from a non-DE-only portal (greenhouse-api) does NOT qualify');

  check(germanyEvidenceTag({ location: 'Erlangen' }) === 'city', 'germanyEvidenceTag: home city → "city"');
  check(germanyEvidenceTag({ location: 'Remote, Deutschland' }) === 'de-text', 'germanyEvidenceTag: explicit "Deutschland" text → "de-text"');
  check(germanyEvidenceTag({ location: '', url: 'https://acme.de/jobs/1' }) === 'de-host', 'germanyEvidenceTag: a .de host → "de-host"');
  check(germanyEvidenceTag({ location: '', portal: 'stellenwerk-api' }) === 'de-portal', 'germanyEvidenceTag: a DE-only portal → "de-portal"');
  check(germanyEvidenceTag({ location: 'Remote' }) === null, 'germanyEvidenceTag: bare "Remote" with no country proves nothing on its own');

  const p1 = parseLeadsJson('[{"company":"Acme","title":"Werkstudent AI","url":"https://jobs.lever.co/acme","location":"Erlangen"}]');
  check(p1.leads.length === 1 && p1.leads[0].company === 'Acme', 'parseLeadsJson: bare array form');
  const p2 = parseLeadsJson('{"leads":[{"company":"Acme"}]}');
  check(p2.leads.length === 1, 'parseLeadsJson: {"leads":[...]} form');
  const p3 = parseLeadsJson('not json');
  check(p3.leads.length === 0 && p3.warnings.length > 0, 'parseLeadsJson: malformed JSON warns, never throws');
  const p4 = parseLeadsJson('[{"title":"no company"}]');
  check(p4.leads.length === 0, 'parseLeadsJson: drops entries with no company');
  check(parseLeadsJson('').leads.length === 0, 'parseLeadsJson: empty input → no leads, no warnings');

  const now = Date.parse('2026-09-24T00:00:00Z');
  const rows = [
    { company: 'Acme', title: 'Werkstudent Data Science', location: 'Erlangen', url: 'https://jobs.lever.co/acme', portal: 'arbeitnow-api', date: new Date(now - 5 * 86400000), status: 'added', normCompany: '' },
    { company: 'Acme Inc', title: 'Werkstudent Data Science', location: 'Erlangen', url: 'https://jobs.lever.co/acme', portal: 'arbeitnow-api', date: new Date(now - 6 * 86400000), status: 'added', normCompany: '' },
    { company: 'Too Old Co', title: 'Werkstudent AI', location: 'Erlangen', url: 'https://x', portal: 'arbeitnow-api', date: new Date(now - 90 * 86400000), status: 'added', normCompany: '' },
    { company: 'Abroad Co', title: 'Werkstudent AI', location: 'New York, USA', url: 'https://x', portal: 'arbeitnow-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
    { company: 'Irrelevant Co', title: 'Sales Manager', location: 'Erlangen', url: 'https://x', portal: 'arbeitnow-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
    // The coordinator's four required scenarios:
    { company: 'Blank US Co', title: 'Werkstudent AI', location: '', url: 'https://x', portal: 'greenhouse-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
    { company: 'Blank DE Portal Co', title: 'Werkstudent AI', location: '', url: 'https://x', portal: 'arbeitsagentur-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
    { company: 'Munich Co', title: 'Werkstudent AI', location: 'Munich', url: 'https://x', portal: 'arbeitnow-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
    { company: 'Remote US Co', title: 'Werkstudent AI', location: 'Remote, US', url: 'https://x', portal: 'arbeitnow-api', date: new Date(now - 1 * 86400000), status: 'added', normCompany: '' },
  ];
  const { groups, matchedRows } = filterAndGroup(rows, { days: 30, now });
  check(matchedRows === 4, 'filterAndGroup: only in-window, qualifying, relevant rows counted (Acme x2, Blank DE Portal Co, Munich Co)');
  const byCompany = Object.fromEntries(groups.map((g) => [g.company, g]));
  check(groups.length === 3, 'filterAndGroup: 3 companies survive (Acme, Blank DE Portal Co, Munich Co)');
  check(!!byCompany['Acme'] && byCompany['Acme'].sightings === 2, 'filterAndGroup: "Acme"/"Acme Inc" cluster into one company');
  check(byCompany['Acme'].urls.includes('https://jobs.lever.co/acme'), 'filterAndGroup: carries the sighted URL forward');
  check(!byCompany['Blank US Co'], 'filterAndGroup: blank-location US company from greenhouse-api is EXCLUDED');
  check(!!byCompany['Blank DE Portal Co'] && byCompany['Blank DE Portal Co'].evidence.includes('de-portal'), 'filterAndGroup: blank-location company from arbeitsagentur-api is INCLUDED (de-portal evidence)');
  check(!!byCompany['Munich Co'] && byCompany['Munich Co'].evidence.includes('city'), 'filterAndGroup: "Munich" company is INCLUDED (city evidence)');
  check(!byCompany['Remote US Co'], 'filterAndGroup: "Remote, US" company is EXCLUDED (classifies abroad)');
  check(!byCompany['Abroad Co'], 'filterAndGroup: abroad company excluded');
  check(!byCompany['Irrelevant Co'], 'filterAndGroup: irrelevant-title company excluded');
  check(!byCompany['Too Old Co'], 'filterAndGroup: out-of-window company excluded');

  const idx = buildExistingIndex({
    tracked_companies: [{ name: 'Existing Co', careers_url: 'https://job-boards.greenhouse.io/existing' }],
    job_boards: [{ name: 'Some Board', careers_url: 'https://arbeitnow.com/api/job-board-api' }],
  });
  check(idx.names.has(normalizeCompanyName('Existing Co')), 'buildExistingIndex: indexes tracked_companies name');
  check(idx.names.has(normalizeCompanyName('Some Board')), 'buildExistingIndex: indexes job_boards name too');
  check(idx.boards.has('greenhouse:existing'), 'buildExistingIndex: indexes resolved board (vendor:slug)');

  const viaUrl = resolveViaUrls({ urls: ['https://acme.example.com/careers', 'https://jobs.lever.co/acme'] });
  check(viaUrl?.vendor === 'lever' && viaUrl.slug === 'acme', 'resolveViaUrls: resolves the first recognizable URL');
  check(resolveViaUrls({ urls: ['https://acme.example.com/careers'] }) === null, 'resolveViaUrls: null when nothing resolves');

  check(entryFieldsForVendor('greenhouse', 'acme').api === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'entryFieldsForVendor: greenhouse gets an api: line');
  check(entryFieldsForVendor('workday', 'acme').provider === 'workday', 'entryFieldsForVendor: workday gets an explicit provider: line');
  check(Object.keys(entryFieldsForVendor('lever', 'acme')).length === 0, 'entryFieldsForVendor: lever needs no extra fields');

  // harvestCompanyKey — the "BMW Group reported twice" fix. Same display
  // text must always cluster together regardless of a row's (possibly
  // stale) stored normalized_company column.
  check(harvestCompanyKey({ company: 'BMW Group' }) === harvestCompanyKey({ company: 'BMW Group' }), 'harvestCompanyKey: identical display text always keys identically');
  check(harvestCompanyKey({ company: 'BMW Group' }) === harvestCompanyKey({ company: 'BMW' }), 'harvestCompanyKey: "BMW Group" and "BMW" share a key ("Group" is a generic descriptor)');
  check(harvestCompanyKey({ company: 'Fraunhofer IIS' }) !== harvestCompanyKey({ company: 'Fraunhofer-Institut für Integrierte Schaltungen IIS' }), 'harvestCompanyKey: genuinely different spellings still key differently');
  check(harvestCompanyKey({ company: '  Acme  ' }) === harvestCompanyKey({ company: 'Acme' }), 'harvestCompanyKey: ignores surrounding whitespace');

  // Off-limits — the binding user denylist.
  check([...OFF_LIMITS_HOSTS].sort().join(',') === ['bmwgroup.jobs', 'linkedin.com', 'stepstone.de', 'xing.com'].sort().join(','), 'OFF_LIMITS_HOSTS: the four literal hosts (indeed.* is a wildcard, matched separately)');
  check(isOffLimitsHost('bmwgroup.jobs'), 'isOffLimitsHost: exact host');
  check(isOffLimitsHost('www.bmwgroup.jobs'), 'isOffLimitsHost: subdomain of a denylisted host');
  check(isOffLimitsHost('de.linkedin.com'), 'isOffLimitsHost: linkedin.com subdomain');
  check(isOffLimitsHost('xing.com'), 'isOffLimitsHost: xing.com');
  check(isOffLimitsHost('stepstone.de'), 'isOffLimitsHost: stepstone.de');
  check(isOffLimitsHost('indeed.com') && isOffLimitsHost('indeed.de') && isOffLimitsHost('to.indeed.com'), 'isOffLimitsHost: indeed.* wildcard covers every TLD and subdomain');
  check(!isOffLimitsHost('jobs.bmwgroup.com'), 'isOffLimitsHost: a DIFFERENT BMW domain (jobs.bmwgroup.com, not bmwgroup.jobs) is not on the literal list');
  check(!isOffLimitsHost('example.com'), 'isOffLimitsHost: an unrelated host is not off-limits');
  check(!isOffLimitsHost('bmwgroup.jobs.evil.com'), 'isOffLimitsHost: a suffix-spoofed look-alike host is NOT matched (host check, not substring)');
  check(isOffLimitsUrl('https://de.linkedin.com/jobs/view/123'), 'isOffLimitsUrl: resolves the hostname from a full URL');
  check(!isOffLimitsUrl('not a url'), 'isOffLimitsUrl: an unparseable URL is not off-limits, never throws');

  check(isOffLimitsCandidate({ company: 'BMW Group', urls: ['https://www.arbeitsagentur.de/x'] }), 'isOffLimitsCandidate: BMW Group is off-limits by NAME regardless of its urls');
  check(isOffLimitsCandidate({ company: 'BMW', urls: [] }), 'isOffLimitsCandidate: "BMW" alone also matches (same normalized name)');
  check(isOffLimitsCandidate({ company: 'BMW AG', urls: [] }), 'isOffLimitsCandidate: "BMW AG" also matches (its own, non-merged normalized key)');
  // NAME-based only, corrected per the coordinator's follow-up: a company is
  // NOT off-limits merely because every sighted URL happens to be on an
  // aggregator host (linkedin/xing/stepstone/indeed) — discover-ats.mjs's
  // probe tier never visits a sighted URL at all, so probing such a company
  // by name can never actually contact one of those hosts, and these are
  // exactly the companies harvest-companies.mjs exists to find.
  check(!isOffLimitsCandidate({ company: 'Fraunhofer IIS', urls: ['https://de.linkedin.com/jobs/view/1', 'https://to.indeed.com/abc'] }), 'isOffLimitsCandidate: a LinkedIn/Indeed-only company is NOT off-limits (falls through to unresolved/probe-eligible)');
  check(!isOffLimitsCandidate({ company: 'Some Co', urls: ['https://de.linkedin.com/jobs/view/1', 'https://jobs.lever.co/someco'] }), 'isOffLimitsCandidate: a MIX of off-limits and legitimate URLs is NOT off-limits (the legitimate one still resolves)');
  check(!isOffLimitsCandidate({ company: 'Some Co', urls: [] }), 'isOffLimitsCandidate: no urls at all is not off-limits (nothing to judge)');
  check(!isOffLimitsCandidate({ company: 'Acme', urls: ['https://jobs.lever.co/acme'] }), 'isOffLimitsCandidate: an ordinary candidate is untouched');

  const mixedUrlHit = resolveViaUrls({ urls: ['https://de.linkedin.com/jobs/view/1', 'https://jobs.lever.co/acme'] });
  check(mixedUrlHit?.vendor === 'lever', 'resolveViaUrls: skips an off-limits URL and resolves the next legitimate one');
  check(resolveViaUrls({ urls: ['https://de.linkedin.com/jobs/view/1'] }) === null, 'resolveViaUrls: an off-limits-only url list never resolves');

  console.log(`\n  harvest-companies self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// ── Summary output ────────────────────────────────────────────────────

function printSummary({ results, metadata }) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Company Harvest — career-ops');
  console.log(`  scan-history rows: ${metadata.scanHistoryRows} | lead rows: ${metadata.leadRows} | matched: ${metadata.matchedRows}`);
  console.log(`  companies: ${metadata.groupedCompanies} | no Germany evidence (dropped): ${metadata.droppedForNoEvidence} | already tracked: ${metadata.alreadyTracked} | off-limits: ${metadata.offLimits} | candidates: ${metadata.candidates}`);
  console.log(`  resolved via url: ${metadata.resolvedViaUrl} | via probe: ${metadata.resolvedViaProbe} | unresolved: ${metadata.unresolved} | duplicate boards: ${metadata.duplicateBoards}`);
  if (metadata.probeRequested) {
    console.log(`  probed: ${metadata.probed}/${metadata.probeLimit}${metadata.probeSkippedDueToLimit ? ` (${metadata.probeSkippedDueToLimit} skipped — raise --limit)` : ''}`);
  }
  console.log(`${'='.repeat(78)}\n`);

  const resolved = results.filter((r) => r.source === 'url' || r.source === 'probe');
  if (resolved.length) {
    console.log('  ' + 'Company'.padEnd(24) + 'Sightings'.padEnd(11) + 'Vendor'.padEnd(16) + 'Source'.padEnd(8) + 'Evidence'.padEnd(18) + 'Board');
    console.log('  ' + '-'.repeat(120));
    for (const r of resolved) {
      console.log('  ' + String(r.company).substring(0, 22).padEnd(24)
        + String(r.sightings).padEnd(11) + String(r.vendor).padEnd(16) + String(r.source).padEnd(8)
        + (r.evidence || []).join(',').padEnd(18) + r.careers_url);
    }
    console.log('');
  }
  const offLimitsRows = results.filter((r) => r.source === 'off-limits');
  if (offLimitsRows.length) {
    console.log(`  Off-limits (${offLimitsRows.length}, never probed/written):`);
    for (const r of offLimitsRows) console.log(`    - ${r.company} (${r.sightings} sighting${r.sightings === 1 ? '' : 's'})`);
    console.log('');
  }

  const unresolved = results.filter((r) => r.source === 'unresolved');
  if (unresolved.length) {
    console.log(`  Unresolved (${unresolved.length}):`);
    for (const r of unresolved.slice(0, 30)) console.log(`    - ${r.company} (${r.sightings} sighting${r.sightings === 1 ? '' : 's'})`);
    if (unresolved.length > 30) console.log(`    ... and ${unresolved.length - 30} more`);
    console.log('');
  }
}

// ── CLI arg parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  return {
    inPath: flagValue(args, '--in') ?? null,
    days: safeIntFlag(flagValue(args, '--days'), DEFAULT_DAYS),
    limit: safeIntFlag(flagValue(args, '--limit'), DEFAULT_PROBE_LIMIT),
    probe: hasFlag(args, '--probe'),
    write: hasFlag(args, '--write'),
    summary: hasFlag(args, '--summary'),
    selfTest: hasFlag(args, '--self-test'),
  };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) runSelfTest();

  const warnings = [];

  let scanHistoryContent = '';
  if (existsSync(SCAN_HISTORY_PATH)) {
    scanHistoryContent = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  } else {
    warnings.push(`scan-history not found at ${SCAN_HISTORY_PATH} — proceeding with 0 scan-history rows`);
  }

  let leadsRaw = '';
  if (opts.inPath) {
    const path = resolve(process.cwd(), opts.inPath);
    if (!existsSync(path)) {
      console.error(`Error: --in file not found: ${opts.inPath}`);
      process.exit(1);
    }
    leadsRaw = readFileSync(path, 'utf-8');
  }

  let portalsDoc = {};
  let portalsFileText = null;
  if (existsSync(PORTALS_PATH)) {
    portalsFileText = readFileSync(PORTALS_PATH, 'utf-8');
    try {
      portalsDoc = yaml.load(portalsFileText) || {};
    } catch (err) {
      warnings.push(`portals.yml: could not parse — ${err.message}`);
      portalsDoc = {};
    }
  } else {
    warnings.push(`portals.yml not found at ${PORTALS_PATH} — nothing to dedupe against`);
  }

  const { results, metadata, warnings: harvestWarnings } = await harvestCompanies({
    scanHistoryContent, leadsRaw, portalsDoc, days: opts.days, probe: opts.probe, limit: opts.limit,
  });
  warnings.push(...harvestWarnings);

  // --write: reuse discover-ats.mjs's OWN safe splice writer end to end —
  // render + dedupe + splice + atomic rename — rather than a second YAML
  // writer. dedupeAgainstPortals is a final safety net (buildExistingIndex
  // already filtered by name/board once, but a stale in-memory portalsDoc
  // read before this run started should not be trusted blindly either).
  const resolvedRows = results.filter((r) => r.source === 'url' || r.source === 'probe');
  const matches = resolvedRows.map((r) => ({
    name: r.company, careers_url: r.careers_url, ...(r.api ? { api: r.api } : {}), ...(r.provider ? { provider: r.provider } : {}),
  }));
  const existingEntries = Array.isArray(portalsDoc?.tracked_companies) ? portalsDoc.tracked_companies : [];
  const { fresh, duplicates } = dedupeAgainstPortals(matches, existingEntries);
  const snippets = fresh.map(renderPortalEntry);

  let written = false;
  if (opts.write && fresh.length && portalsFileText !== null) {
    const tmpPath = `${PORTALS_PATH}.tmp-${process.pid}`;
    writeFileSync(tmpPath, insertIntoTrackedCompanies(portalsFileText, snippets), 'utf-8');
    renameSyncWithRetry(tmpPath, PORTALS_PATH);
    written = true;
  } else if (opts.write && fresh.length && portalsFileText === null) {
    warnings.push(`--write given but portals.yml not found at ${PORTALS_PATH} — printing entries instead`);
  } else if (!opts.write && fresh.length) {
    warnings.push(`preview only — ${fresh.length} new entr${fresh.length === 1 ? 'y' : 'ies'} shown in pendingEntries; re-run with --write to append them to portals.yml`);
  }

  const out = {
    metadata: {
      ...metadata,
      fresh: fresh.length,
      freshWritten: written ? fresh.length : 0,
      written,
      previewOnly: !written,
      portalsPath: PORTALS_PATH,
      scanHistoryPath: SCAN_HISTORY_PATH,
      staleDedupeSkipped: duplicates.length,
      warnings,
    },
    results,
  };
  if (!written) out.pendingEntries = snippets.join('');

  if (opts.summary) printSummary({ results, metadata: out.metadata });
  else console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`harvest-companies: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
