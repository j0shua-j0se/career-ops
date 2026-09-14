// @ts-check
// Shared "recognized place" matcher for scraping/sitemap providers whose
// postings carry no structured location field — only a de-slugged title or
// URL slug with the location smashed into ordinary words (infineon.mjs), or
// a slug segment that's usually but not verifiably a city (successfactors.mjs
// Fraunhofer URLs, icims.mjs titles).
//
// ── Why this exists (read providers/infineon.mjs's module comment first) ───
// infineon.mjs's own comment lays out the hard rule: NEVER guess a location
// by splitting on a hyphen or by position ("last word is the country"), because
// a wrong location silently mis-filters a posting against portals.yml's
// location_filter — worse than no location at all. But leaving `location`
// empty for every posting whose slug has no `--` delimiter means portals.yml's
// location_filter (which cannot penalize missing data, by design) passes
// EVERY one of those postings straight to LLM triage. Measured against
// data/scan-history.tsv on 2026-09-14: icims-full 202/212, infineon-api
// 161/166, successfactors-api 20/25 of postings since 2026-09-01 carried an
// empty location.
//
// recognizePlace closes that gap the only safe way: instead of guessing WHERE
// in the text the location sits, it checks WHETHER any of the text is a place
// name it already knows. A miss returns '' — exactly today's behavior — never
// a fabricated guess. Whole-word matching only (see wordRe below), so this
// can never mistake a place name for a substring of an unrelated word.
//
// ── The `\s`-inside-a-plain-string trap (do not repeat it here) ────────────
// triage-prefilter.mjs's FOREIGN_REGION_RE was built from `new RegExp(str)`
// where `str` contained a literal `\s` typed inside an ordinary '...' string
// literal. `\s` is not a recognized string escape, so JS silently drops the
// backslash and leaves the bare letter `s` — "optional whitespace" silently
// became "optional literal s", and an entire matching branch went dead. The
// fix there was `\\s` (a real backslash followed by `s`). This file has the
// same shape of risk (regexes assembled from string fragments below), so every
// escape sequence destined for the regex engine is written as a DOUBLE
// backslash in the source (`\\p{L}`, `\\p{N}`) so the string that actually
// reaches `new RegExp(...)` carries a real backslash.

/**
 * Escape a literal string for safe embedding inside a regex alternation.
 * @param {string} s
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a whole-word (Unicode-aware, umlaut/CJK-safe), case-insensitive
 * regex matching any of `names`. The lookarounds use \p{L}/\p{N} (real
 * Unicode letter/number classes, via the `u` flag) rather than a hand-rolled
 * `[a-zäöüß]` list — see successfactors.mjs's cityFromSlug for the same
 * convention already in this codebase. That also makes the boundary correct
 * next to a CJK run glued on with no space ("shanghai上海"): CJK characters
 * are not in \p{L}'s Latin range in the sense that matters here — they are
 * simply not part of the ASCII/German run being matched, so the boundary
 * still lands correctly on either side of the Latin word.
 * @param {string[]} names
 */
function wordRe(names) {
  const alt = names.map(escapeRe).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'iu');
}

// ── City list ────────────────────────────────────────────────────────────
// Data-driven and commented by region. Each entry is the canonical display
// name plus every spelling/transliteration actually worth matching. Kept
// deliberately narrow — see infineon.mjs's own warning about guessing — this
// is a floor of well-attested places, not an attempt at a gazetteer.
const CITY_ENTRIES = [
  // ── Home region + Munich (already in portals.yml's location_filter
  // always_allow, but still worth recognizing here for consistency) ──
  { names: ['erlangen'], name: 'Erlangen' },
  { names: ['nürnberg', 'nuernberg', 'nuremberg'], name: 'Nürnberg' },
  { names: ['fürth', 'fuerth'], name: 'Fürth' },
  { names: ['münchen', 'munich', 'muenchen'], name: 'Munich' },
  { names: ['neubiberg'], name: 'Neubiberg' },
  { names: ['garching'], name: 'Garching' },
  // ── Other German cities relevant to these boards ──
  { names: ['regensburg'], name: 'Regensburg' },
  { names: ['dresden'], name: 'Dresden' },
  { names: ['warstein'], name: 'Warstein' },
  { names: ['augsburg'], name: 'Augsburg' },
  { names: ['berlin'], name: 'Berlin' },
  { names: ['hamburg'], name: 'Hamburg' },
  { names: ['frankfurt'], name: 'Frankfurt' },
  { names: ['stuttgart'], name: 'Stuttgart' },
  { names: ['karlsruhe'], name: 'Karlsruhe' },
  { names: ['freising'], name: 'Freising' },
  { names: ['freiburg'], name: 'Freiburg' },
  { names: ['leipzig'], name: 'Leipzig' },
  { names: ['chemnitz'], name: 'Chemnitz' },
  { names: ['oberhausen'], name: 'Oberhausen' },
  { names: ['stade'], name: 'Stade' },
  { names: ['duisburg'], name: 'Duisburg' },
  { names: ['ettlingen'], name: 'Ettlingen' },
  { names: ['wachtberg'], name: 'Wachtberg' },
  { names: ['lemgo'], name: 'Lemgo' },
  { names: ['jena'], name: 'Jena' },
  { names: ['kaiserslautern'], name: 'Kaiserslautern' },
  { names: ['darmstadt'], name: 'Darmstadt' },
  { names: ['aachen'], name: 'Aachen' },
  { names: ['ilmenau'], name: 'Ilmenau' },
  { names: ['magdeburg'], name: 'Magdeburg' },
  { names: ['bremen'], name: 'Bremen' },
  { names: ['hannover', 'hanover'], name: 'Hannover' },
  { names: ['köln', 'koeln', 'cologne'], name: 'Köln' },
  { names: ['düsseldorf', 'duesseldorf'], name: 'Düsseldorf' },
  { names: ['mannheim'], name: 'Mannheim' },
  { names: ['ulm'], name: 'Ulm' },
  { names: ['ingolstadt'], name: 'Ingolstadt' },
  // ── Foreign cities seen on Infineon/ZF/iCIMS boards ──
  { names: ['singapore'], name: 'Singapore' },
  { names: ['kulim'], name: 'Kulim' },
  { names: ['penang'], name: 'Penang' },
  { names: ['melaka', 'malacca'], name: 'Melaka' },
  { names: ['samut prakan'], name: 'Samut Prakan' },
  { names: ['shanghai'], name: 'Shanghai' },
  { names: ['wuxi'], name: 'Wuxi' },
  { names: ['villach'], name: 'Villach' },
  { names: ['graz'], name: 'Graz' },
  { names: ['klagenfurt'], name: 'Klagenfurt' },
  { names: ['linz'], name: 'Linz' },
  { names: ['padua', 'padova'], name: 'Padua' },
  { names: ['warwick'], name: 'Warwick' },
  { names: ['bangalore', 'bengaluru'], name: 'Bangalore' },
  { names: ['hyderabad'], name: 'Hyderabad' },
  { names: ['hanoi'], name: 'Hanoi' },
  { names: ['seoul'], name: 'Seoul' },
  { names: ['cegléd', 'cegled'], name: 'Cegléd' },
  { names: ['monterrey'], name: 'Monterrey' },
  { names: ['guadalajara'], name: 'Guadalajara' },
  { names: ['san jose'], name: 'San Jose' },
  { names: ['el segundo'], name: 'El Segundo' },
  { names: ['colorado springs'], name: 'Colorado Springs' },
  { names: ['leominster'], name: 'Leominster' },
  { names: ['andover'], name: 'Andover' },
  { names: ['morrisville'], name: 'Morrisville' },
  { names: ['stockholm'], name: 'Stockholm' },
  { names: ['porto'], name: 'Porto' },
];

// ── Country list ─────────────────────────────────────────────────────────
// Used to enrich a recognized city ("Kulim, Malaysia") and, alone, to
// recognize a posting that names only a country with no matched city.
// Singapore is deliberately NOT here — it is both city and country, and is
// already a CITY_ENTRIES name; adding it here too would combine into the
// nonsensical "Singapore, Singapore".
const COUNTRY_ENTRIES = [
  { names: ['malaysia'], name: 'Malaysia' },
  { names: ['thailand'], name: 'Thailand' },
  { names: ['austria', 'österreich', 'oesterreich'], name: 'Austria' },
  { names: ['india'], name: 'India' },
  { names: ['vietnam'], name: 'Vietnam' },
  { names: ['hungary'], name: 'Hungary' },
  { names: ['mexico', 'méxico'], name: 'Mexico' },
  { names: ['germany', 'deutschland'], name: 'Germany' },
  { names: ['portugal'], name: 'Portugal' },
  { names: ['china'], name: 'China' },
];

// Precompute one regex per entry (built once at module load, not per call).
const CITY_MATCHERS = CITY_ENTRIES.map((e) => ({ re: wordRe(e.names), name: e.name }));
const COUNTRY_MATCHERS = COUNTRY_ENTRIES.map((e) => ({ re: wordRe(e.names), name: e.name }));

/**
 * Recognize a place in a de-slugged title/URL fragment, returning a clean
 * "City", "Country", or "City, Country" string — or '' when nothing in the
 * text matches a known place. NEVER infers a place from position, hyphen
 * splitting, or "the last word looks like a place" — only an explicit
 * whole-word match against CITY_ENTRIES/COUNTRY_ENTRIES counts.
 *
 * German-postcode-adjacent-to-city composition (Fraunhofer's `{City} {PLZ}`
 * slug shape) is intentionally NOT handled here — that pattern depends on
 * knowing which URL segment is the city, which is provider-specific URL
 * structure, not general text recognition. See successfactors.mjs.
 * @param {unknown} text
 * @returns {string}
 */
export function recognizePlace(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return '';
  const city = CITY_MATCHERS.find((m) => m.re.test(s));
  const country = COUNTRY_MATCHERS.find((m) => m.re.test(s));
  if (city && country) return `${city.name}, ${country.name}`;
  if (city) return city.name;
  if (country) return country.name;
  return '';
}
