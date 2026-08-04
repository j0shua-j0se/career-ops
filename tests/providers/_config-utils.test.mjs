// tests/providers/_config-utils.test.mjs — direct tests for the shared
// provider config-parsing helper (E3: the provider layer's untested modules).
//
// intInRange() is the only thing standing between a stray portals.yml value and
// a pathological upstream query: arbeitsagentur derives umkreis/days/size/
// remoteMaxPages from it, vdab derives days/size/detailLimit. A size=0 or a
// 100000-day window is a user-visible scan failure, so the clamp, the coercion
// rules, and the fallback are pinned here rather than left to the call sites.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — _config-utils');

try {
  const { intInRange } = await import(pathToFileURL(join(ROOT, 'providers/_config-utils.mjs')).href);

  // ── Clamping ────────────────────────────────────────────────────
  if (intInRange(5000, 100, 1, 100) === 100 && intInRange(-7, 100, 1, 100) === 1)
    pass('intInRange() clamps an out-of-range value to max / min');
  else fail(`intInRange(5000,...)=${intInRange(5000, 100, 1, 100)}, intInRange(-7,...)=${intInRange(-7, 100, 1, 100)}`);

  // size=0 is the failure this clamp exists to prevent: a zero-size page query
  // returns nothing and the scan reports "no results" instead of an error.
  if (intInRange(0, 100, 1, 100) === 1)
    pass('intInRange() lifts a zero to min, so size=0 can never reach the API');
  else fail(`intInRange(0, 100, 1, 100) = ${intInRange(0, 100, 1, 100)}`);

  if (intInRange(50, 100, 1, 100) === 50)
    pass('intInRange() passes an in-range value through untouched');
  else fail(`intInRange(50, 100, 1, 100) = ${intInRange(50, 100, 1, 100)}`);

  // ── Truncation is toward zero, not floor ────────────────────────
  if (intInRange(3.9, 100, 1, 100) === 3 && intInRange(-3.9, 50, -10, 10) === -3)
    pass('intInRange() truncates toward zero (3.9→3, -3.9→-3), not Math.floor');
  else fail(`intInRange(3.9,...)=${intInRange(3.9, 100, 1, 100)}, intInRange(-3.9,...)=${intInRange(-3.9, 50, -10, 10)}`);

  // ── Non-finite input falls back to the default ──────────────────
  const nonFinite = [undefined, NaN, Infinity, -Infinity, 'abc', {}];
  const nonFiniteBad = nonFinite.filter((v) => intInRange(v, 30, 1, 1000) !== 30);
  if (nonFiniteBad.length === 0)
    pass('intInRange() returns the default for undefined / NaN / ±Infinity / non-numeric string / object');
  else fail(`intInRange() did not fall back for: ${JSON.stringify(nonFiniteBad.map(String))}`);

  // ── Numeric-string coercion (YAML often hands over strings) ─────
  if (intInRange('25', 30, 1, 1000) === 25 && intInRange('1e3', 30, 1, 10000) === 1000)
    pass('intInRange() coerces numeric strings, including exponent notation');
  else fail(`intInRange('25')=${intInRange('25', 30, 1, 1000)}, intInRange('1e3')=${intInRange('1e3', 30, 1, 10000)}`);

  // ── Documented sharp edges (pinned, not endorsed) ───────────────
  // Number(null) === 0 and Number('') === 0, so an explicitly-null or empty
  // portals.yml value does NOT get the default — it gets clamped to min. A
  // future maintainer reading "falling back to `def` for NaN" in the docblock
  // could reasonably assume otherwise; this is the behaviour that ships.
  if (intInRange(null, 30, 1, 1000) === 1 && intInRange('', 30, 1, 1000) === 1)
    pass('intInRange() treats null and "" as 0 → clamped to min, NOT the default (Number() coercion)');
  else fail(`intInRange(null)=${intInRange(null, 30, 1, 1000)}, intInRange('')=${intInRange('', 30, 1, 1000)}`);

  // The default is returned verbatim on the non-finite path — it is never
  // clamped into [min,max]. Every current call site passes a def already inside
  // its own range, so this is latent rather than live, but a future call site
  // with an out-of-range default would silently emit one.
  if (intInRange('abc', 5000, 1, 100) === 5000)
    pass('intInRange() returns an out-of-range default unclamped (latent: def is never range-checked)');
  else fail(`intInRange('abc', 5000, 1, 100) = ${intInRange('abc', 5000, 1, 100)}`);

  // ── Real call-site bounds ───────────────────────────────────────
  // Mirrors arbeitsagentur/vdab: size is capped at the API maximum of 100.
  if (intInRange(101, 100, 1, 100) === 100 && intInRange(1000000, 30, 1, 1000) === 1000)
    pass('intInRange() holds the real call-site ceilings (size≤100, days≤1000)');
  else fail(`size ceiling=${intInRange(101, 100, 1, 100)}, days ceiling=${intInRange(1000000, 30, 1, 1000)}`);

} catch (e) {
  fail(`_config-utils tests crashed: ${e.message}`);
}
