// tests/providers/_place-from-slug.test.mjs — direct coverage for the shared
// "recognized place" matcher (providers/_place-from-slug.mjs), consumed by
// infineon.mjs, successfactors.mjs (Fraunhofer/ZF) and icims.mjs's enrichDate
// to fill `location` for postings whose provider carries no structured
// location field — see the module's own header comment for the measured
// empty-location problem this closes.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — _place-from-slug (shared recognizePlace matcher)');

try {
  const { recognizePlace } = await import(pathToFileURL(join(ROOT, 'providers/_place-from-slug.mjs')).href);

  // ── Basic contract ───────────────────────────────────────────────────────
  if (recognizePlace('') === '' && recognizePlace(null) === '' && recognizePlace(undefined) === '') {
    pass('recognizePlace tolerates empty/non-string input, returning ""');
  } else {
    fail('recognizePlace should return "" for empty/non-string input');
  }

  if (recognizePlace('internship environmental health and safety') === '') {
    pass('recognizePlace returns "" for text naming no recognized place (never guesses)');
  } else {
    fail(`recognizePlace should return "" for place-less text, got ${JSON.stringify(recognizePlace('internship environmental health and safety'))}`);
  }

  // ── Whole-word matching — must not match a place name as a substring of an
  // unrelated word ──────────────────────────────────────────────────────────
  if (recognizePlace('ulmaceous research associate') === '') {
    pass('recognizePlace does not match "ulm" inside an unrelated word ("ulmaceous")');
  } else {
    fail(`recognizePlace should not match a substring, got ${JSON.stringify(recognizePlace('ulmaceous research associate'))}`);
  }
  if (recognizePlace('working student ulm site') === 'Ulm') {
    pass('recognizePlace matches "ulm" as a whole word');
  } else {
    fail(`recognizePlace whole-word match wrong: ${JSON.stringify(recognizePlace('working student ulm site'))}`);
  }

  // ── City + country combination ──────────────────────────────────────────
  if (recognizePlace('industrial trainee kulim malaysia') === 'Kulim, Malaysia') {
    pass('recognizePlace combines a recognized city and country into "City, Country"');
  } else {
    fail(`city+country combo wrong: ${JSON.stringify(recognizePlace('industrial trainee kulim malaysia'))}`);
  }
  if (recognizePlace('industrial trainee kulim') === 'Kulim') {
    pass('recognizePlace returns the bare city when no country is present');
  } else {
    fail(`bare city wrong: ${JSON.stringify(recognizePlace('industrial trainee kulim'))}`);
  }
  if (recognizePlace('working student ai team germany') === 'Germany') {
    pass('recognizePlace returns the bare country when no recognized city is present');
  } else {
    fail(`bare country wrong: ${JSON.stringify(recognizePlace('working student ai team germany'))}`);
  }

  // Singapore is both a city and a country name; it lives only in the city
  // list so it never combines into the nonsensical "Singapore, Singapore".
  if (recognizePlace('internship application engineering singapore') === 'Singapore') {
    pass('recognizePlace returns "Singapore" alone, never "Singapore, Singapore"');
  } else {
    fail(`Singapore case wrong: ${JSON.stringify(recognizePlace('internship application engineering singapore'))}`);
  }

  // ── CJK text glued to a Latin word with no space — the boundary must still
  // land correctly (shanghai上海 is a real Infineon sitemap slug shape) ──────
  if (recognizePlace('data analysis intern shanghai 上海') === 'Shanghai') {
    pass('recognizePlace matches a Latin place name next to a CJK run');
  } else {
    fail(`CJK-adjacent case wrong: ${JSON.stringify(recognizePlace('data analysis intern shanghai 上海'))}`);
  }

  // ── Accented / umlaut place names ───────────────────────────────────────
  if (recognizePlace('working student qm lab cegléd hungary') === 'Cegléd, Hungary') {
    pass('recognizePlace matches an accented city name (Cegléd) and combines with its country');
  } else {
    fail(`accented city wrong: ${JSON.stringify(recognizePlace('working student qm lab cegléd hungary'))}`);
  }
  if (recognizePlace('werkstudent in opc site planning regensburg') === 'Regensburg') {
    pass('recognizePlace matches a plain German city');
  } else {
    fail(`German city wrong: ${JSON.stringify(recognizePlace('werkstudent in opc site planning regensburg'))}`);
  }
  if (recognizePlace('münchen germany') === 'Munich, Germany') {
    pass('recognizePlace normalizes a spelling variant (münchen) to the canonical display name (Munich)');
  } else {
    fail(`spelling-variant city wrong: ${JSON.stringify(recognizePlace('münchen germany'))}`);
  }

  // ── Multi-word place names ──────────────────────────────────────────────
  if (recognizePlace('internship facility management mechanical engineer samut prakan thailand') === 'Samut Prakan, Thailand') {
    pass('recognizePlace matches a multi-word city name and combines with its country');
  } else {
    fail(`multi-word city wrong: ${JSON.stringify(recognizePlace('internship facility management mechanical engineer samut prakan thailand'))}`);
  }
  if (recognizePlace('internship product engineer colorado springs') === 'Colorado Springs') {
    pass('recognizePlace matches a multi-word US city name');
  } else {
    fail(`multi-word US city wrong: ${JSON.stringify(recognizePlace('internship product engineer colorado springs'))}`);
  }

  // ── Real Infineon slug titles (data/scan-history.tsv, verified 2026-09-14)
  // — a broader spot-check across the actual empty-location population ──────
  const realCases = [
    ['bachelor thesis artificial intelligence in microcontroller villach austria', 'Villach, Austria'],
    ['industriepraktikum ai collaboration support klagenfurt', 'Klagenfurt'],
    ['internship applications engineer warwick', 'Warwick'],
    ['intern production planner wuxi 无锡', 'Wuxi'],
    ['international graduate program hybrid customer journey architect porto maia portugal', 'Porto, Portugal'],
    ['intern g2m academy americas guadalajara mexico', 'Guadalajara, Mexico'],
    ['engineer data science bangalore btp india', 'Bangalore, India'],
    ['internship memory controller verification hanoi vietnam', 'Hanoi, Vietnam'],
    ['internship automotive quality management seoul', 'Seoul'],
    ['internship analog mixed signal design verification andover ma', 'Andover'],
    ['pool position praktika werkstudententätigkeiten und abschlussarbeiten am standort warstein warstein germany', 'Warstein, Germany'],
  ];
  let realOk = true;
  for (const [text, expected] of realCases) {
    const got = recognizePlace(text);
    if (got !== expected) {
      realOk = false;
      fail(`recognizePlace wrong for real title ${JSON.stringify(text)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }
  if (realOk) pass(`recognizePlace correct across ${realCases.length} additional real Infineon titles`);
} catch (e) {
  fail(`_place-from-slug tests crashed: ${e.message}`);
}
