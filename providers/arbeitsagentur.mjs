// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { sleep } from './_http.mjs';

import { safeEncodeURIComponent } from './_safe-url.mjs';

// Arbeitsagentur (Bundesagentur für Arbeit) provider — hits the public Jobsuche
// REST API (the same endpoint arbeitsagentur.de uses), so it lives in-process
// alongside the other JSON-API providers (greenhouse/ashby shape). One or more
// keywords are queried; scan.mjs applies title_filter + location_filter + dedup
// afterwards, so this provider over-fetches (recall-first).
//
// Configure via a `job_boards` (or `tracked_companies`) entry with
// `provider: arbeitsagentur` and an `arbeitsagentur:` block:
//
//   - name: Arbeitsagentur — ML/KI Deutschland
//     provider: arbeitsagentur
//     arbeitsagentur:
//       keywords: ["Machine Learning Engineer", "Data Scientist"]  # required
//       wo: Berlin              # optional anchor city; omit for nationwide
//       umkreis: 50             # km radius around `wo` (default 50)
//       days: 30                # recency window in days (default 30)
//       size: 100               # results per keyword (1–100, default 100)
//       remoteNationwide: true  # also run a nationwide pass keeping remote-eligible hits
//       remoteMatch: filter     # how that pass detects remote (default 'title'):
//                               #   'filter' — server-side `homeoffice=nv_true` query + pagination to narrow
//                               #              the set, then the same title check as 'title'. Recommended:
//                               #              same standard of proof, applied to a far better candidate set.
//                               #              (v4 confirmed `homeofficetyp: VOLLSTAENDIG` per hit via the
//                               #              detail endpoint; v6 no longer serves it to this key — #2494.)
//                               #   'title'  — regex on the job title only (cheap; misses body-level remote)
//                               #   'off'    — skip the remote pass entirely
//       remoteMaxPages: 10      # 'filter' mode: max pages to paginate (size each); default 1
//       fetchDetails: true      # OPT-IN, default false — see the v4 detail note below (#2637)
//       maxDetailFetches: 20    # hard cap on detail requests per fetch() call; default 20, max 100
//     enabled: true

// v6 for search. The v4 (and v5) SEARCH endpoint 404s as of 2026-08-04
// (#2494); v6 keeps every query parameter this provider sends
// (was/wo/umkreis/veroeffentlichtseit/angebotsart/homeoffice/page/size) but
// renames the response fields — see normalizeJob().
//
// The DETAIL endpoint is a separate story, corrected 2026-09-01 (#2637): v4's
// detail endpoint is alive and answers 200 (v6's answers 403 to this public
// client key) — see fetchDetailDescription() and the note above
// normalizeJob(). Search and detail versions are independent; don't conflate
// "v4 search 404s" with "v4 detail is unusable".
const API_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const API_KEY = 'jobboerse-jobsuche'; // public client key the arbeitsagentur.de UI uses
const DETAIL_BASE = 'https://www.arbeitsagentur.de/jobsuche/jobdetail/';
const REMOTE_RE = /(remote|homeoffice|home[-\s]?office|ortsunabh|deutschlandweit|bundesweit|100\s*%|full[-\s]?remote|fully remote)/i;

// Opt-in per-posting detail fetch (FINDING 2, #2637) — see the note above
// normalizeJob() for why v4, not v6. Off by default: a keyword sweep can
// return hundreds of postings, and this is one extra request per posting.
const V4_DETAIL_BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/';
const DEFAULT_MAX_DETAIL_FETCHES = 20;
const HARD_MAX_DETAIL_FETCHES = 100;
const DETAIL_FETCH_DELAY_MS = 300; // polite pacing between detail requests

// Enum values observed on `verguetungsangabe`/`vertragsdauer` that carry no
// signal worth surfacing ("no information given"). Anything else is shown verbatim.
const VERGUETUNG_NO_INFO = 'KEINE_ANGABEN';

// Clamp a runtime integer into [min, max], falling back to `def` for NaN, so a
// stray portals.yml value can't produce empty (size=0) or pathological queries.
function intInRange(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Reads and sanitizes the entry's `arbeitsagentur:` config block.
 * @param {{ arbeitsagentur?: any }} entry
 * @returns {{ keywords: string[], wo: string, umkreis: number, days: number, size: number, remoteNationwide: boolean, remoteMatch: 'title'|'filter'|'off', remoteMaxPages: number, fetchDetails: boolean, maxDetailFetches: number }}
 */
export function parseArbeitsagenturConfig(entry) {
  const cfg = (entry && entry.arbeitsagentur) || {};
  const keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
    : [];
  return {
    keywords,
    wo: typeof cfg.wo === 'string' ? cfg.wo.trim() : '',
    umkreis: intInRange(cfg.umkreis, 50, 0, 1000), // km; only used when `wo` is set
    days: intInRange(cfg.days, 30, 1, 1000),       // recency window
    size: intInRange(cfg.size, 100, 1, 100),       // results per keyword (API max 100)
    remoteNationwide: cfg.remoteNationwide === true,
    // Remote-detection mode is config-driven (not hardcoded).
    remoteMatch: ['title', 'filter', 'off'].includes(cfg.remoteMatch) ? cfg.remoteMatch : 'title',
    remoteMaxPages: intInRange(cfg.remoteMaxPages, 1, 1, 20),
    // Opt-in v4 detail fetch (FINDING 2, #2637). Default OFF — costs one
    // request per posting, so it must be explicitly enabled in portals.yml.
    fetchDetails: cfg.fetchDetails === true,
    maxDetailFetches: intInRange(cfg.maxDetailFetches, DEFAULT_MAX_DETAIL_FETCHES, 1, HARD_MAX_DETAIL_FETCHES),
  };
}

/**
 * Assembles a human-readable location from v6's `stellenlokationen` array. Most
 * postings are in Germany; only a non-DE country is appended so the downstream
 * location_filter can act on it.
 *
 * v4 exposed a single `arbeitsort` object whose `region` was a display name, so
 * it was joined onto the city. v6 nests the address one level deeper and its
 * `region` is an uppercase federal-state enum (`BADEN_WUERTTEMBERG`), which
 * would only add noise to a string the commute filter has to match — so the
 * city stands alone. A posting may list several locations; the downstream shape
 * is one string, so the first is used, as v4's single field effectively was.
 * @param {any} lokationen
 */
export function buildLocation(lokationen) {
  if (!Array.isArray(lokationen)) return '';
  const adresse = lokationen[0] && lokationen[0].adresse;
  if (!adresse || typeof adresse !== 'object') return '';
  const loc = String(adresse.ort || '').trim();
  const land = adresse.land;
  if (land && !/deutschland|germany/i.test(land)) return loc ? `${loc}, ${land}` : String(land);
  return loc;
}

/**
 * Folds the search response's structured facts into a compact one-line
 * description, the way `providers/fau.mjs`'s `describe()` folds its card
 * metadata. The Job contract (`providers/_types.js`) has no first-class home
 * for "full-time", "home office possible", "contract duration", or "the
 * employer's own posting URL" — adding four narrow fields nothing else reads
 * would be more surface area than the facts are worth, and `description` is
 * exactly the free-text bucket the contract already documents for this case.
 * Only facts with real signal are emitted; a flag whose absence is not
 * informative (most postings ARE full-time, most are NOT home-office) is
 * dropped rather than printed as a wall of booleans (#2637).
 * @param {any} job
 */
export function describeJob(job) {
  if (!job || typeof job !== 'object') return '';
  const parts = [];
  if (job.arbeitszeitVollzeit === true) parts.push('Vollzeit');
  if (job.homeofficemoeglich === true) parts.push('Homeoffice möglich');
  const vertragsdauer = typeof job.vertragsdauer === 'string' ? job.vertragsdauer.trim() : '';
  if (vertragsdauer) parts.push(`Vertrag: ${vertragsdauer}`);
  const verguetung = typeof job.verguetungsangabe === 'string' ? job.verguetungsangabe.trim() : '';
  if (verguetung && verguetung !== VERGUETUNG_NO_INFO) parts.push(`Vergütung: ${verguetung}`);
  if (job.istGeringfuegigeBeschaeftigung === true) parts.push('Geringfügige Beschäftigung');
  const externeURL = typeof job.externeURL === 'string' ? job.externeURL.trim() : '';
  if (/^https?:\/\//i.test(externeURL)) parts.push(`Extern: ${externeURL}`);
  return parts.join(' · ');
}

/**
 * Normalizes one raw Arbeitsagentur posting into a Job plus its `refnr` (kept
 * for dedup, stripped before the provider returns). Returns null when the
 * posting lacks a usable reference number or title.
 *
 * v6 renamed every field this reads — `refnr` → `referenznummer`, `titel` →
 * `stellenangebotsTitel`, `arbeitgeber` → `firma`, `arbeitsort` →
 * `stellenlokationen[]` (#2494). The public job-detail page still resolves by
 * reference number, so the outgoing URL is unchanged.
 *
 * `description` carries whatever `describeJob()` can fold from the search
 * response for free (#2637); a posting with none of those facts gets an
 * empty string, same as fau's empty-metadata case.
 * @param {any} job
 * @returns {({title: string, url: string, company: string, location: string, description: string, refnr: string}) | null}
 */
export function normalizeJob(job) {
  const refnr = job && job.referenznummer;
  const title = String((job && job.stellenangebotsTitel) || '').trim();
  if (!refnr || !title) return null;
  // A lone surrogate in refnr would throw URIError out of encodeURIComponent and
  // abort the per-job loop in fetch(); refnr is also the dedup key (byRef), so a
  // degraded-but-kept value would collide malformed postings. Drop this one.
  const encodedRefnr = safeEncodeURIComponent(refnr);
  if (encodedRefnr === null) return null;
  return {
    title,
    url: DETAIL_BASE + encodedRefnr,
    company: String((job && job.firma) || '').trim(),
    location: buildLocation(job && job.stellenlokationen),
    description: describeJob(job),
    refnr: String(refnr),
  };
}

/**
 * Base64-encodes a `referenznummer` into the id the v4 detail endpoint takes.
 * @param {string} refnr
 */
export function buildDetailId(refnr) {
  return Buffer.from(String(refnr)).toString('base64');
}

/**
 * Opt-in v4 detail fetch (FINDING 2, #2637). Fetches the full posting body
 * (`stellenangebotsBeschreibung`) for one refnr, or returns '' on any failure
 * — a detail miss must not take down the postings already fetched.
 * @param {string} refnr
 * @param {{ fetchJson: (url: string, opts?: object) => Promise<any> }} ctx
 */
export async function fetchDetailDescription(refnr, ctx) {
  try {
    const id = buildDetailId(refnr);
    const json = await ctx.fetchJson(`${V4_DETAIL_BASE}${encodeURIComponent(id)}`, {
      headers: { 'X-API-Key': API_KEY, accept: 'application/json' },
      redirect: 'error',
      timeoutMs: 12_000,
    });
    const text = json && json.stellenangebotsBeschreibung;
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

// What `remoteMatch: 'filter'` lost in the v6 move, and why it still exists.
//
// v4 proved a role was fully remote by reading `homeofficetyp: VOLLSTAENDIG`
// from the detail endpoint, because the `homeoffice=nv_true` query alone also
// returns `NACH_VEREINBARUNG` ("nach Absprache") — an office-anchored hybrid.
//
// CORRECTED 2026-09-01 (#2637): the earlier version of this comment claimed
// the detail endpoint outright doesn't work, full stop. Re-verified live: v6's
// detail endpoint (`pc/v6/jobdetails/{id}`) does answer 403 to this public
// client key, but v4's (`pc/v4/jobdetails/{id}`, same base64(refnr) id
// scheme) answers 200 — measured across four postings, with a
// `stellenangebotsBeschreibung` body 1252–3145 chars long. See
// `fetchDetailDescription()` / the `fetchDetails` opt-in below. What is still
// true: that v4 response does NOT carry `homeofficetyp` — checked its full key
// list — so the fully-remote-vs-hybrid proof this comment mourns is still
// gone, and `homeofficemoeglich` (present on both v6 search hits and the v4
// detail) is exactly what nv_true already filtered on (a sampled nv_true page
// was 100% `true`). A boolean that cannot separate fully-remote from hybrid is
// not evidence.
//
// So 'filter' keeps the half that still works — the server-side query narrows
// the candidate set far better than a nationwide sweep — and falls back to the
// posting's own title for the proof, the same standard 'title' mode uses. A
// candidate whose title makes no remote claim keeps its real city, which is the
// fail-closed behaviour an unverifiable lookup had in v4: the `Deutschlandweit
// (Homeoffice)` marker exempts a job from the commute location_filter, so
// tagging on nv_true alone would smuggle every hybrid past it.

/** @type {Provider} */
export default {
  id: 'arbeitsagentur',

  /**
   * Fetches and normalizes postings from the Arbeitsagentur Jobsuche API.
   * @param {{ name?: string, arbeitsagentur?: any }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, description?: string}>>}
   */
  async fetch(entry, ctx) {
    const { keywords, wo, umkreis, days, size, remoteNationwide, remoteMatch, remoteMaxPages, fetchDetails, maxDetailFetches } = parseArbeitsagenturConfig(entry);
    if (!keywords.length) {
      throw new Error(`arbeitsagentur: entry "${entry.name || '(unnamed)'}" has no arbeitsagentur.keywords[]`);
    }

    /** @param {string} was @param {Record<string,string>} [extra] */
    const fetchKeyword = async (was, extra = {}) => {
      const params = new URLSearchParams({
        was,
        size: String(size),
        page: '1',
        angebotsart: '1', // 1 = ARBEIT (employment; excludes Ausbildung/Selbständigkeit)
        veroeffentlichtseit: String(days),
        ...extra,
      });
      // redirect:'error' prevents SSRF via server-side redirects.
      const json = await ctx.fetchJson(`${API_URL}?${params.toString()}`, {
        headers: { 'X-API-Key': API_KEY, accept: 'application/json' },
        redirect: 'error',
        timeoutMs: 12_000,
      });
      return Array.isArray(json && json.ergebnisliste) ? json.ergebnisliste : [];
    };

    const byRef = new Map();
    const errors = [];
    let succeeded = 0; // keywords whose primary pass completed (i.e. the source answered)
    for (const kw of keywords) {
      let primary;
      try {
        // Pass A: commutable radius around `wo`, or a single nationwide pass.
        primary = wo
          ? await fetchKeyword(kw, { wo, umkreis: String(umkreis) })
          : await fetchKeyword(kw);
        succeeded++;
      } catch (err) {
        // Recall-first: tolerate a single failed keyword and keep going.
        errors.push(`"${kw}": ${(err && err.message) || err}`);
        continue;
      }
      // Pass B (optional): a nationwide pass for remote roles hosted at a far HQ
      // (which the radius pass misses). Detection is config-driven via `remoteMatch`:
      //   'filter' — server-side `homeoffice=nv_true` query + pagination, narrowing
      //              the candidate set; the title still has to claim remote (see
      //              the note on what v6 took away, above)
      //   'title'  — keep only nationwide hits whose title matches the remote regex
      // Its failure must NOT discard the primary results already fetched above.
      let wide = [];
      if (wo && remoteNationwide && remoteMatch !== 'off') {
        try {
          if (remoteMatch === 'filter') {
            // Server-side home-office filter: collect the candidates. `nv_true` only
            // means "home office is possible", so these are not yet known to be
            // remote — the title check below is what decides.
            for (let page = 1; page <= remoteMaxPages; page++) {
              const res = await fetchKeyword(kw, { homeoffice: 'nv_true', page: String(page) });
              wide.push(...res);
              if (res.length < size) break; // short page → done
            }
          } else { // 'title'
            const nationwide = await fetchKeyword(kw);
            wide = nationwide.filter(j => REMOTE_RE.test(String((j && j.stellenangebotsTitel) || '')));
          }
        } catch (err) {
          errors.push(`"${kw}" (remote pass): ${(err && err.message) || err}`);
        }
      }
      // Pass A (commutable) keeps its city as-is.
      for (const raw of primary) {
        const job = normalizeJob(raw);
        if (job && !byRef.has(job.refnr)) byRef.set(job.refnr, job);
      }
      // Pass B roles get a `Deutschlandweit (Homeoffice)` marker, which makes
      // scan.mjs's commute-based location_filter rescue them via always_allow
      // instead of dropping them on a far office city. A wrong marker therefore
      // smuggles an office-anchored hybrid past the distance check, so it may
      // only be applied on evidence:
      //   'title'  — the posting's own title claims remote; take it at face value.
      //   'filter' — `homeoffice=nv_true` narrowed the set but only means "home
      //              office possible", so the title is what proves it. Hits that
      //              make no such claim keep their real city.
      // Dedup by refnr first: paginating a live index can return the same posting
      // on two pages.
      const wideJobs = [...new Map(
        wide
          .map(normalizeJob)
          .filter(Boolean)
          .filter(job => !byRef.has(job.refnr))
          .map(job => [job.refnr, job]),
      ).values()];
      for (const job of wideJobs) {
        if (remoteMatch !== 'filter' || REMOTE_RE.test(job.title)) {
          job.location = job.location ? `${job.location} · Deutschlandweit (Homeoffice)` : 'Deutschlandweit (Homeoffice)';
        }
        if (!byRef.has(job.refnr)) byRef.set(job.refnr, job);
      }
    }

    // Total outage = every primary request failed. A keyword that answered with
    // zero results is not an outage, so key off the success count, not the
    // deduped result size — otherwise a legitimately-empty search throws.
    if (succeeded === 0 && errors.length) {
      throw new Error(`arbeitsagentur: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    // Opt-in v4 detail fetch (FINDING 2, #2637). Bounded by maxDetailFetches
    // regardless of how many keywords/passes fed byRef — a keyword sweep can
    // dedupe to hundreds of postings, and each detail is one extra request.
    // A miss just leaves that posting's description as normalizeJob() already
    // folded it; it never discards a posting or aborts the run.
    if (fetchDetails) {
      const jobs = [...byRef.values()];
      const limit = Math.min(maxDetailFetches, jobs.length);
      for (let i = 0; i < limit; i++) {
        const job = jobs[i];
        const detail = await fetchDetailDescription(job.refnr, ctx);
        if (detail) {
          job.description = job.description ? `${detail}\n\n${job.description}` : detail;
        }
        if (i < limit - 1) await sleep(DETAIL_FETCH_DELAY_MS, ctx);
      }
    }

    return [...byRef.values()].map(({ refnr, ...job }) => job);
  },
};
