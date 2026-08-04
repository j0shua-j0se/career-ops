// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// stellenwerk provider — the university-affiliated student job portals
// (stellenwerk.de/{city}), including stellenwerk.de/erlangen-nuernberg, which is
// the portal FAU points its own students at.
//
// ── Why this reads the sitemap instead of the listing ──────────────────────
// The city landing page is SvelteKit SSR and renders exactly TEN cards. Its
// pagination is a <button> (client-side), not a link, and the SSR ignores query
// parameters outright: ?page=2 / ?p=2 / ?offset=10 / ?seite=2 all return the
// byte-identical first page (?page=2 previously 500'd; ?p= and friends are
// simply dropped). /{city}/jobs returns 400. There is no reachable page 2.
//
// The site's own robots.txt advertises a sitemap, and it is a single flat
// <urlset> — no index, no lastmod — listing every posting on every city portal:
//
//   <url><loc>https://www.stellenwerk.de/erlangen-nuernberg/{slug}-{YYMMDD}-{id}</loc></url>
//
// So ONE GET enumerates the whole board. This matters: the ten cards the
// landing page shows are alphabetical noise (call-centre, Nachhilfe,
// Haushaltshilfe), while the sitemap surfaced Werkstudent roles in Edge AI,
// DevOps/MLOps, machine learning for audio compression, and künstliche
// Intelligenz — none of which were reachable through the UI without JS.
//
// robots.txt compliance: it allows everything except /arbeitgeber/ (employer
// area) and /jobs-feed. We touch NEITHER — only the advertised sitemap. If you
// are tempted by /jobs-feed because it sounds like a clean API: it is
// explicitly disallowed, so it is off-limits.
//
// ── Known limitation: titles are reconstructed from the URL slug ───────────
// The sitemap carries a URL and nothing else, so titles are de-slugged rather
// than read. That is lossy in a specific, bounded way:
//   - umlauts are transliterated by the site ("kuenstliche", not "künstliche")
//   - the gender tag is compressed ("mwd" → we expand back to "(m/w/d)")
//   - original capitalisation is gone; we Title-Case every word
// Hyphens become spaces, so a portals.yml title_filter term like
// "Machine Learning" still matches. Company, salary and the Homeoffice flag are
// NOT available — they live only on the card/detail pages, and fetching 50+
// detail pages per scan would trade the zero-cost property for metadata the
// title filter mostly doesn't need.
//
// ── postedAt is derived from the slug, and that derivation is checked ───────
// The {YYMMDD} segment is the publication date. Evidence: across ~50 sampled
// URLs the date segment and the numeric id are strictly co-monotonic
// (260216→263129, 260408→266587, 260608→270280, 260715→272639, 260731→273658),
// which holds under a YYMMDD reading and breaks under DDMMYY. Implausible
// values are dropped rather than guessed, so a format change degrades to "no
// date" instead of to a wrong one.

const SITEMAP_PATH = '/sitemap.xml';
const SITEMAP_TIMEOUT_MS = 25_000; // the sitemap is ~360 KB; the 10s default is tight
const MAX_JOBS = 1000;

// Both lookup tables below are keyed by text taken straight out of a URL, so
// they are null-prototype: a plain object literal inherits from
// Object.prototype, and a slug word of "constructor" would then look up as a
// truthy Function and be spliced into the title as
// "function Object() { [native code] }". Object.create(null) removes the
// inherited keys entirely rather than relying on every call site remembering a
// hasOwn guard.

// Portal slugs whose display name carries an umlaut. Anything else is
// title-cased from the slug.
const REGION_NAMES = Object.assign(Object.create(null), {
  'erlangen-nuernberg': 'Erlangen-Nürnberg',
  muenchen: 'München',
  koeln: 'Köln',
  wuerzburg: 'Würzburg',
  duesseldorf: 'Düsseldorf',
  osnabrueck: 'Osnabrück',
  saarbruecken: 'Saarbrücken',
  tuebingen: 'Tübingen',
  goettingen: 'Göttingen',
  luebeck: 'Lübeck',
});

// Standalone gender tags German job ads use, as they survive slugification.
const GENDER_TAGS = Object.assign(Object.create(null), {
  mwd: '(m/w/d)',
  wmd: '(w/m/d)',
  mfd: '(m/f/d)',
  fmd: '(f/m/d)',
  dmw: '(d/m/w)',
  mfx: '(m/f/x)',
  mwx: '(m/w/x)',
});

/** Extract every <loc> from a sitemap document. */
export function parseSitemap(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * Split a stellenwerk posting URL into its parts, or null when it isn't one.
 * Shape: https://www.stellenwerk.de/{city}/{slug}-{YYMMDD}-{id}
 */
export function parseJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  if (host !== 'stellenwerk.de' && !host.endsWith('.stellenwerk.de')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null; // city landing pages and static pages
  const [city, tail] = parts;
  const m = tail.match(/^(.+)-(\d{6})-(\d+)$/);
  if (!m) return null;
  return { city, slug: m[1], dateStr: m[2], id: m[3] };
}

/** {YYMMDD} → epoch ms, or undefined when the value isn't a plausible date. */
export function postedAtFrom(dateStr) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return undefined;
  const [, yy, mm, dd] = m;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  // Reject a roll-over (e.g. 31 February) — Date.UTC silently normalizes those.
  const d = new Date(ms);
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return ms;
}

/** Reconstruct a readable title from the URL slug. Lossy by construction. */
export function deslugTitle(slug) {
  if (typeof slug !== 'string' || !slug) return '';
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => GENDER_TAGS[word] || word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Display name for a portal slug. */
export function regionName(city) {
  if (!city) return '';
  if (REGION_NAMES[city]) return REGION_NAMES[city];
  return city.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
}

/** The portal city slug: explicit `city:`, else the careers_url's first segment. */
export function resolveCity(entry) {
  if (typeof entry.city === 'string' && entry.city.trim()) return entry.city.trim().toLowerCase();
  const raw = entry.api || entry.careers_url || '';
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase();
    if (host !== 'stellenwerk.de' && !host.endsWith('.stellenwerk.de')) return null;
    const first = u.pathname.split('/').filter(Boolean)[0];
    return first ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** @type {Provider} */
export default {
  id: 'stellenwerk',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.host.toLowerCase();
    if (host !== 'stellenwerk.de' && !host.endsWith('.stellenwerk.de')) return null;
    return { url };
  },

  async fetch(entry, ctx) {
    const city = resolveCity(entry);
    if (!city) throw new Error(`stellenwerk: cannot resolve the portal city for ${entry.name} — set careers_url to https://www.stellenwerk.de/{city} or add city:`);

    const origin = 'https://www.stellenwerk.de';
    const xml = await ctx.fetchText(`${origin}${SITEMAP_PATH}`, {
      headers: { accept: 'application/xml,text/xml' },
      timeoutMs: SITEMAP_TIMEOUT_MS,
    });

    const locs = parseSitemap(xml);
    if (locs.length === 0) {
      console.warn(`stellenwerk: ${origin}${SITEMAP_PATH} returned no <loc> entries — sitemap format may have changed`);
      return [];
    }

    // The portal slug is where the posting is ADVERTISED, not necessarily where
    // the work is: the Erlangen-Nürnberg board carries the occasional Madrid or
    // Koblenz posting. Location is therefore the portal region, and it is a
    // regional hint rather than a per-posting fact.
    const location = entry.location || regionName(city);

    const jobs = [];
    const seen = new Set();
    for (const loc of locs) {
      const parsed = parseJobUrl(loc);
      if (!parsed || parsed.city !== city) continue;
      if (seen.has(loc)) continue;
      const title = deslugTitle(parsed.slug);
      if (!title) continue;
      seen.add(loc);
      const job = { title, url: loc, company: '', location };
      const postedAt = postedAtFrom(parsed.dateStr);
      if (postedAt !== undefined) job.postedAt = postedAt;
      jobs.push(job);
      if (jobs.length >= MAX_JOBS) break;
    }

    if (jobs.length === 0) {
      console.warn(`stellenwerk: sitemap had ${locs.length} URLs but none under /${city}/ — check the city slug for ${entry.name}`);
    }
    return jobs;
  },
};
