// tests/prefilter-in-loop.test.mjs
//
// triage-prefilter.mjs has ranked postings on title + location since it was
// written, and nothing in the loop ever called it: scan-loop and run-all both
// imported only its parsePipeline parser. Every posting therefore reached the
// agent — the most expensive step in a pass.
//
// Measured on the 113 postings triaged on 2026-08-31: look=4, maybe=33,
// skip=76. Scoring only look+maybe is a 67% cut, and both rows that went on to
// qualify land in `maybe`.
import { pass, fail } from './helpers.mjs';
import { rankEntry } from '../triage-prefilter.mjs';

console.log('\ntriage-prefilter — the zero-token cut the loop now actually uses');

const bucket = (title, location) => rankEntry({ title, location, url: '', company: '' }).bucket;

// ── The two rows that qualified on 2026-08-31 must survive ──────────────────
// Neither is `look` — both are `maybe`, which is exactly why only `skip` may be
// auto-rejected. Auto-rejecting `maybe` would have lost both.
{
  const a = bucket('Mitarbeiter (w/m/d) gesucht als Data Scientist / Experte für Machine Learning', 'Erlangen-Nürnberg');
  const b = bucket('Werkstudent*in - Datenannotation und Versuchsdurchführungen (all genders)', '91058 Erlangen');
  a !== 'skip' && b !== 'skip'
    ? pass('both rows that went on to qualify survive the prefilter')
    : fail(`qualifiers were bucketed ${a} / ${b}`);
}

// ── Clear skips ─────────────────────────────────────────────────────────────
for (const [t, l] of [
  ['Praktikum Redaktion Medien Journalismus (m/w/d)', 'Erlangen-Nürnberg'],
  ['Werkstudent im Verkauf Outlet Ingolstadt (m/w/d)', 'München'],
  ['Student Assistant Computer Vision and Graphics', 'Berlin'],
]) {
  bucket(t, l) === 'skip'
    ? pass(`skipped: ${t.slice(0, 44)}`)
    : fail(`expected skip for ${t}, got ${bucket(t, l)}`);
}

// ── Munich must NEVER be skipped for being Munich ───────────────────────────
// The location policy in modes/_profile.md treats Greater Munich as GOOD; the
// blocker is work mode, which a title never states. A prefilter that dropped
// Munich would re-create by machine the exact error made by hand on 2026-08-31.
for (const t of [
  'Werkstudent:in AI & Data Analytics (all genders)',
  'Working Student Power Platform (all genders)',
  'Werkstudent (m/w/d) Conversational AI',
]) {
  bucket(t, 'München') !== 'skip'
    ? pass(`Munich on-archetype role survives: ${t.slice(0, 40)}`)
    : fail(`Munich role was skipped on location: ${t}`);
}

// ── The home region is never skipped on reach ───────────────────────────────
bucket('Werkstudent (w/m/d) Data Analytics', 'Erlangen') !== 'skip'
  ? pass('an on-archetype home-region role is never skipped')
  : fail('a home-region role was skipped');

// ── Robustness: the ranker must not throw on junk ───────────────────────────
{
  let ok = true;
  for (const e of [{}, { title: '', location: '' }, { title: null, location: null }]) {
    try { rankEntry({ title: e.title ?? '', location: e.location ?? '', url: '', company: '' }); }
    catch { ok = false; }
  }
  ok ? pass('the ranker tolerates empty and missing fields') : fail('rankEntry threw on junk input');
}

// ── Foreign "remote" is not reachable remote ─────────────────────────
//
// The abroad guard fired only on COUNTRY names, and a US posting rarely prints
// one. Six of thirty-four high-priority inbox rows read "Remote - California",
// "Ohio Remote", "Remote-TX" and "Chile, Remote": the remote marker won
// outright and they scored 4.5 — the second-best reach tier — for a candidate
// on a German student residence permit who cannot work in any of them.
{
  const { classifyReach } = await import('../triage-prefilter.mjs');

  const foreign = ['Remote - California', 'Ohio Remote', 'Remote-TX', 'Chile, Remote', 'Pakistan', 'Remote - Poland'];
  if (foreign.every((l) => classifyReach(l, '', '') === 'abroad')) {
    pass('a remote role scoped to a foreign state or country reads as abroad');
  } else {
    fail(`still reachable: ${JSON.stringify(foreign.filter((l) => classifyReach(l, '', '') !== 'abroad'))}`);
  }

  // Genuinely reachable remote must survive — this guard must not become a
  // blanket refusal of the word "remote".
  const reachable = ['Remote', 'Remote, Germany', 'Deutschland Remote', 'Remote - Europe', 'Remote · EMEA'];
  if (reachable.every((l) => classifyReach(l, '', '') === 'remote')) {
    pass('remote with no foreign scope, or a German/European one, stays reachable');
  } else {
    fail(`wrongly refused: ${JSON.stringify(reachable.filter((l) => classifyReach(l, '', '') !== 'remote'))}`);
  }

  // The home and Munich tiers are unaffected.
  if (classifyReach('Erlangen', '', '') === 'home' && classifyReach('München', '', '') === 'munich') {
    pass('home and Munich tiers are untouched');
  } else {
    fail('the reachable German tiers regressed');
  }

  // Two-letter state codes are matched only in an anchored, punctuated form. A
  // bare "IN" or "DE" inside ordinary text must never mean Indiana or Delaware
  // — "DE" is also Deutschland's own code.
  const safe = ['Berlin, Deutschland', 'Remote in Germany', 'München, DE'];
  if (safe.every((l) => classifyReach(l, '', '') !== 'abroad')) {
    pass('bare two-letter codes in German locations are not read as US states');
  } else {
    fail(`false abroad: ${JSON.stringify(safe.filter((l) => classifyReach(l, '', '') === 'abroad'))}`);
  }
}
