// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// Studierendenjobs provider — the Deutsche Hochschulwerbung student-job-board
// network (pattern: hecklerkoch/rheinmetall — small SSR board, one GET).
//
// These are the job boards the Studierendenwerke point students at. Each city
// runs its own host (studierendenjobs-muenchen.de, studentenjobs-{city}.de …)
// on the same codebase, so one provider covers every city by config. The
// listing at {origin}/stellenangebote is SERVER-rendered — a single bare-HTTP
// GET returns every posting, no JS, no auth.
//
// Card markup:
//   <a href="/anzeige/{id}-{slug}" …>{Title}</a>
//
// {id} is the board's posting id and the stable dedup key. The board carries
// no per-card location (every posting is in the host's own city by
// construction), so location is derived from the hostname unless the
// portals.yml entry overrides it.
//
// Scale note: these boards are SMALL — Munich carried 3 open postings when
// this provider was written, mostly hospitality and marketing gigs. The value
// is standing coverage of a source that would otherwise never be scanned, not
// volume. title_filter does the relevance work downstream.

const MAX_JOBS = 500; // generous cap; these boards are tiny

// Umlaut cities whose hostname is the transliterated form.
const CITY_NAMES = {
  muenchen: 'München',
  nuernberg: 'Nürnberg',
  koeln: 'Köln',
  wuerzburg: 'Würzburg',
  duesseldorf: 'Düsseldorf',
  osnabrueck: 'Osnabrück',
  saarbruecken: 'Saarbrücken',
  tuebingen: 'Tübingen',
  goettingen: 'Göttingen',
  luebeck: 'Lübeck',
};

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Resolve the listing URL from api:/careers_url. Accepts any host in the
 * studierendenjobs-/studentenjobs- network; a non-network host returns null so
 * detect() declines the entry.
 * @param {import('./_types.js').PortalEntry} entry
 */
export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase().replace(/^www\./, '');
  if (!/^(studierendenjobs|studentenjobs)-[a-z-]+\.de$/.test(host)) return null;
  // An explicit listing path passes through; anything else on the host defaults.
  if (/stellenangebote/i.test(u.pathname)) return `${u.origin}${u.pathname}`;
  return `${u.origin}/stellenangebote`;
}

/**
 * Derive the city label from a network hostname:
 * studierendenjobs-muenchen.de → "München".
 * @param {string} listUrl
 */
export function cityFromHost(listUrl) {
  let host;
  try {
    host = new URL(listUrl).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
  const m = host.match(/^(?:studierendenjobs|studentenjobs)-([a-z-]+)\.de$/);
  if (!m) return '';
  const slug = m[1];
  if (CITY_NAMES[slug]) return CITY_NAMES[slug];
  return slug.replace(/(^|-)([a-z])/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
}

/**
 * Parse the SSR listing into raw {id, title, path} records. Anchors on the
 * /anzeige/{id}-{slug} href (the stable id + URL) and reads the anchor text.
 * @param {string} html
 */
export function parseListing(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="(\/anzeige\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[2];
    if (seen.has(id)) continue;
    const title = clean(m[3]);
    if (!title) continue;
    seen.add(id);
    out.push({ id, title, path: decodeEntities(m[1]) });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'studierendenjobs',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveListUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`studierendenjobs: cannot resolve listing for ${entry.name}`);
    const origin = new URL(listUrl).origin;
    const location = entry.location || cityFromHost(listUrl);

    const html = await ctx.fetchText(listUrl, { headers: { accept: 'text/html' } });
    const rows = parseListing(html);

    const jobs = [];
    for (const row of rows) {
      jobs.push({
        title: row.title,
        url: `${origin}${row.path}`,
        company: entry.name,
        location,
      });
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs;
  },
};
