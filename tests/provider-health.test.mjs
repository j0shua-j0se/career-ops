// tests/provider-health.test.mjs
//
// A scraper does not fail loudly when a site changes its markup: it exits 0
// with the right row count and a null company on every row. This check reads
// evidence already on disk and names that. It must not, however, cry wolf —
// a health check that over-reports is one that gets ignored.
import { pass, fail } from './helpers.mjs';
import { assess, parseHistory, shiftDays, FIELD_CHECKS, EXPECTED_EMPTY } from '../provider-health.mjs';

console.log('\nprovider-health — name a half-working parser, without crying wolf');

const SINCE = '2026-08-01';
const row = (portal, over = {}) => ({
  portal, firstSeen: '2026-08-15', url: `https://x/${Math.random()}`,
  title: 'Working Student Data Science', company: 'Acme GmbH', location: 'Erlangen', ...over,
});
const many = (n, portal, over) => Array.from({ length: n }, () => row(portal, over));
const find = (rs, p) => rs.find((r) => r.portal === p);

// ── Healthy ─────────────────────────────────────────────────────────────────
find(assess(many(10, 'good'), SINCE), 'good').verdict === 'healthy'
  ? pass('a portal with complete fields is healthy') : fail('healthy portal misjudged');

// ── Degraded: the signature failure ─────────────────────────────────────────
{
  const r = find(assess(many(10, 'rotten', { company: '' }), SINCE), 'rotten');
  r.verdict === 'degraded' && /empty_company on 10\/10/.test(r.detail)
    ? pass('company empty on every row is degraded, with the count shown')
    : fail(`empty-company portal classified ${JSON.stringify(r)}`);
}
{
  const r = find(assess(many(10, 'ents', { title: 'Data &amp; AI Werkstudent' }), SINCE), 'ents');
  r.verdict === 'degraded' && /undecoded_entities/.test(r.detail)
    ? pass('undecoded HTML entities in titles are degraded')
    : fail(`entity portal classified ${JSON.stringify(r)}`);
}
{
  const r = find(assess(many(10, 'markup', { title: '<div>Data Scientist</div>' }), SINCE), 'markup');
  r.verdict === 'degraded' ? pass('surviving markup is degraded') : fail('markup not caught');
}

// ── A minority of bad rows is NOT breakage ──────────────────────────────────
{
  const rows = [...many(8, 'mixed'), ...many(2, 'mixed', { company: '' })];
  find(assess(rows, SINCE), 'mixed').verdict === 'healthy'
    ? pass('a few empty fields among many good ones is not a parser fault')
    : fail('minority of empty fields reported as degraded');
}

// ── Structural limits are reported, never called a fault ────────────────────
{
  const r = find(assess(many(10, 'stellenwerk-api', { company: '' }), SINCE), 'stellenwerk-api');
  r.verdict === 'limited' && /by design/.test(r.detail)
    ? pass('a field the source cannot supply is "limited", not "degraded"')
    : fail(`stellenwerk classified ${JSON.stringify(r)}`);
  /[Bb]lacklist/.test(r.detail)
    ? pass('and the downstream cost of the missing field is stated, not hidden')
    : fail('limited verdict does not say what the missing field costs');
}
{
  // The declaration is narrow: it excuses the declared field only.
  const r = find(assess(many(10, 'stellenwerk-api', { company: '', title: '' }), SINCE), 'stellenwerk-api');
  r.verdict === 'degraded' && /empty_title/.test(r.detail)
    ? pass('a declared-empty field does not excuse a different broken field')
    : fail(`declared-empty portal masked a real fault: ${JSON.stringify(r)}`);
}

// ── Silence and insufficiency are never breakage claims ─────────────────────
{
  const rows = many(10, 'quiet', { firstSeen: '2026-05-01' });
  const r = find(assess(rows, SINCE), 'quiet');
  r.verdict === 'silent' && /only way to tell/.test(r.detail)
    ? pass('a portal that produced before and nothing now is "silent", not "broken"')
    : fail(`quiet portal classified ${JSON.stringify(r)}`);
}
{
  const r = find(assess(many(3, 'thin'), SINCE), 'thin');
  r.verdict === 'inconclusive'
    ? pass('too few recent rows is inconclusive, never guessed at')
    : fail(`thin portal classified ${JSON.stringify(r)}`);
}
{
  // Three bad rows out of three is still too thin to accuse a parser.
  const r = find(assess(many(3, 'thinbad', { company: '' }), SINCE), 'thinbad');
  r.verdict === 'inconclusive'
    ? pass('and a thin sample is inconclusive even when every row looks wrong')
    : fail('accused a parser on three rows');
}

// ── Parsing ─────────────────────────────────────────────────────────────────
{
  const tsv = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
    + 'https://a\t2026-08-15\tp1\tTitle\tAcme\tnew\tErlangen\n';
  const rows = parseHistory(tsv);
  rows.length === 1 && rows[0].portal === 'p1' && rows[0].company === 'Acme'
    ? pass('scan-history rows are read by column name, not position')
    : fail(`parseHistory returned ${JSON.stringify(rows)}`);
}
parseHistory('').length === 0 && parseHistory('header-only\n').length === 0
  ? pass('an empty or header-only history yields nothing') : fail('empty history mishandled');

shiftDays('2026-08-31', 30) === '2026-08-01' ? pass('the window start is computed in UTC') : fail('shiftDays wrong');

Object.keys(EXPECTED_EMPTY).length > 0 && FIELD_CHECKS.empty_company({ company: '  ' })
  ? pass('whitespace-only counts as empty') : fail('whitespace company not counted empty');
