// tests/country-eligibility-testability.test.mjs — "0 removed" must not be
// able to mean two opposite things.
//
// country_eligibility_filter reads the JD description. Eight of eighty-nine
// providers ship one, and across a full run zero of 249 loop candidates carried
// a description at all — so the filter reported "0 removed" on every scan while
// being structurally unable to judge anything. That line reads as "all clear".
// It meant "nothing was checked".
//
// countryEligibilityTestable() is what separates the two, so the summary can
// say `0 removed (N had no description to judge)` instead of a bare zero.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan.mjs — country-eligibility testability');

const { countryEligibilityTestable, buildCountryEligibilityFilter } =
  await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const untestable = [undefined, null, '', '   ', '\n\t ', 42, {}, []];
if (untestable.every((d) => countryEligibilityTestable(d) === false)) {
  pass('countryEligibilityTestable() is false for absent, blank and non-string descriptions');
} else {
  fail(`treated as testable: ${JSON.stringify(untestable.filter((d) => countryEligibilityTestable(d)))}`);
}

if (countryEligibilityTestable('Must be located in the United States.')) {
  pass('countryEligibilityTestable() is true for real description text');
} else {
  fail('real description text reported as untestable');
}

// The distinction is only worth anything if a blank description and a clean
// description produce the SAME verdict — which they do, and which is exactly
// why the counter is needed to tell them apart.
const cfg = {
  exclusionary: ['must be located in the united states'],
  inclusive: ['germany'],
};
const filter = buildCountryEligibilityFilter(cfg, 'Germany');
const blankPasses = filter('') === true;
const cleanPasses = filter('Open to candidates across Europe.') === true;
const blockedRejects = filter('Must be located in the United States.') === false;

if (blankPasses && cleanPasses) {
  pass('a blank and a genuinely-eligible description both pass — indistinguishable by verdict alone');
} else {
  fail(`verdicts wrong: blank=${blankPasses} clean=${cleanPasses}`);
}
if (blockedRejects) {
  pass('an exclusionary phrase with no inclusive counterweight still rejects');
} else {
  fail('exclusionary phrase was not rejected');
}
if (countryEligibilityTestable('') === false && countryEligibilityTestable('Open to candidates across Europe.') === true) {
  pass('but countryEligibilityTestable() separates them, which is the whole point');
} else {
  fail('testability check failed to separate blank from real text');
}
