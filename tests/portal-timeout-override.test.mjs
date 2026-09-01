// tests/portal-timeout-override.test.mjs — a portal that is merely slow must
// not be indistinguishable from a portal that is dead.
//
// Schaeffler's SuccessFactors tenant answers /tile-search-results/ in 85-97s
// (measured twice, 1.1 MB each time). It is not blocked and not broken; it just
// takes that long. Under the 25s scan-wide default it aborted on every run and
// left the scan as a single "operation was aborted" line — the same line a
// genuinely dead board produces. With the override it returns 730 postings.
//
// The cap is the other half: portals.yml is the user layer, and a typo in a
// timeout must not be able to hang a scan indefinitely.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan.mjs — per-portal timeout override');

const { portalHttpFor } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const base = portalHttpFor({ name: 'Ordinary' });
if (base && base.timeoutMs === 25_000 && base.retry && base.retry.retries === 1) {
  pass('an entry with no override gets the scan-wide default (25s, one retry)');
} else {
  fail(`default policy wrong: ${JSON.stringify(base)}`);
}

const slow = portalHttpFor({ name: 'Schaeffler', timeout_ms: 120_000 });
if (slow.timeoutMs === 120_000 && slow.retry.retries === base.retry.retries) {
  pass('timeout_ms raises the timeout and leaves the retry policy alone');
} else {
  fail(`override wrong: ${JSON.stringify(slow)}`);
}

const capped = portalHttpFor({ name: 'Typo', timeout_ms: 9_999_999 });
if (capped.timeoutMs === 180_000) {
  pass('an over-large timeout_ms is capped rather than honoured');
} else {
  fail(`cap not applied: ${JSON.stringify(capped)}`);
}

// Zero is the dangerous one: honoured literally it aborts every request the
// instant it starts, which would read as a portal that is refusing us.
const junk = [
  { timeout_ms: 0 },
  { timeout_ms: -1 },
  { timeout_ms: 'soon' },
  { timeout_ms: null },
  { timeout_ms: NaN },
  {},
  null,
  undefined,
];
if (junk.every((e) => portalHttpFor(e).timeoutMs === 25_000)) {
  pass('zero, negative, non-numeric and absent timeout_ms all fall back to the default');
} else {
  const bad = junk.filter((e) => portalHttpFor(e).timeoutMs !== 25_000);
  fail(`malformed timeout_ms was honoured: ${JSON.stringify(bad)}`);
}
