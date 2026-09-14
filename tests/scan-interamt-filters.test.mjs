// tests/scan-interamt-filters.test.mjs
//
// scan-interamt.mjs reimplemented both portal filters locally, and both copies
// were wrong in ways that produced no error and no warning:
//
//   * matchesLocation() read only `allow`/`block`, ignoring `always_allow`
//     entirely — the tier that outranks `block` and where this profile keeps
//     its whole home region. The scanner printed "Filtered location: 0" while
//     the filter did nothing.
//   * matchesTitle() used plain `includes`, which cannot satisfy an AND-group
//     ("werkstudent + data") and matches short keywords inside longer words.
//
// The fix was to delete both copies and use scan.mjs's builders. This pins the
// behaviour those builders provide, so a future local reimplementation fails
// here instead of silently passing everything through.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTitleFilter, buildLocationFilter } from '../scan.mjs';

console.log('\nscan-interamt.mjs — shared portal filters');

const src = readFileSync(join(ROOT, 'scan-interamt.mjs'), 'utf-8');

// Structural: the scanner must not grow its own copies back.
if (src.includes('buildTitleFilter') && src.includes('buildLocationFilter')) {
  pass('scan-interamt imports the shared filter builders');
} else {
  fail('scan-interamt no longer imports buildTitleFilter/buildLocationFilter');
}
if (!/function\s+matchesLocation\s*\(/.test(src)) {
  pass('scan-interamt has no local matchesLocation reimplementation');
} else {
  fail('scan-interamt reintroduced a local matchesLocation — always_allow will be ignored again');
}
if (!/const\s+locAllow\s*=/.test(src) && !/const\s+positiveKw\s*=/.test(src)) {
  pass('the local allow/positive keyword copies are gone');
} else {
  fail('scan-interamt reintroduced local keyword lists');
}
// An unguarded main() that calls process.exit() on import is what hid 21
// failing tests behind doctor.mjs.
//
// [CALL] The literal string this checked for was the old, six-times-hand-
// rolled "am I main?" comparison (`import.meta.url === pathToFileURL(...)`).
// scan-interamt.mjs migrated to lib/is-main-module.mjs's isMainModule() —
// the convention tests/main-guard-convention.test.mjs (#3170) now enforces
// repo-wide — so this check just needs to look for the current guard instead
// of the retired one; the property being pinned (an entry guard exists at
// all) is unchanged.
if (src.includes('isMainModule(import.meta.url)')) {
  pass('scan-interamt guards its entry point against import');
} else {
  fail('scan-interamt runs main() at module scope — importing it would run a scan');
}

// Behavioural: always_allow must outrank block, which is the tier the old copy
// could not see at all.
const loc = buildLocationFilter({
  always_allow: ['Erlangen', 'Nürnberg'],
  block: ['United States', 'Berlin'],
});
if (loc('Erlangen, Germany')) pass('always_allow admits the home region');
else fail('always_allow region was rejected');
if (loc('Remote, Berlin or Erlangen')) {
  pass('always_allow outranks block on a multi-location string');
} else {
  fail('a blocked token overrode always_allow — the tier order is wrong');
}
if (!loc('Berlin, Germany')) pass('block still rejects a blocked-only location');
else fail('block tier stopped rejecting');

const title = buildTitleFilter({ positive: ['werkstudent + data'], negative: ['senior'] });
if (title('Werkstudent Data Analytics (m/w/d)')) {
  pass('AND-group matches when both words are present in any order');
} else {
  fail('AND-group did not match a title containing both words');
}
if (!title('Werkstudent Marketing')) {
  pass('AND-group rejects a title with only one of the two words');
} else {
  fail('AND-group matched on a single word — plain includes behaviour');
}
if (!title('Senior Werkstudent Data Engineer')) pass('negative keyword still vetoes');
else fail('negative keyword stopped vetoing');
