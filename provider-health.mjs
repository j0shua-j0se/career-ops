#!/usr/bin/env node

/**
 * provider-health.mjs — which scrapers are quietly returning junk?
 *
 * A scraper does not fail loudly when a site changes its markup. It exits 0
 * with zero results, or with the right number of results and a null company on
 * every one of them. The Step-1c-style fallback never fires, because nothing
 * threw. This repo's own recorded lesson: "career-ops analyses fail by
 * returning nothing, not by erroring; a zero result usually means an unread
 * field."
 *
 * `verify-portals.mjs` already answers a different question — is a COMPANY's
 * ATS slug still valid — and answers it well. Nothing asked whether the
 * PROVIDERS that parse HTML (interamt, stellenanzeigen, stepstone, eures, and
 * the -full sweeps) still parse it correctly.
 *
 * This makes no requests. It reads `data/scan-history.tsv`, which every scan
 * already writes, and reasons over the evidence on disk — the "free pass" of
 * the ai-job-search framework's portal health check (/scrape Step 4.75, MIT,
 * github.com/MadsLorentzen/ai-job-search), whose verdict vocabulary and
 * rate-limit rule this follows.
 *
 * Verdicts:
 *   healthy      nothing to say (silence is the default; healthy portals get no line)
 *   degraded     rows are arriving but fields are wrong — the parser is half-working
 *   limited      a field is empty because the source cannot supply it, not
 *                because parsing broke. Reported, never treated as a fault.
 *   silent       produced rows historically, nothing in the recent window
 *   inconclusive too little history to judge — never guessed at
 *
 * A portal is never called "broken" from stored evidence alone. Breakage is a
 * claim about the parser NOW, and only a live probe can support it; a quiet
 * board and a dead parser look identical in a log.
 *
 * Usage: node provider-health.mjs [--window N] [--json] [--strict]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const HISTORY = join(CAREER_OPS, 'data', 'scan-history.tsv');

/**
 * Fields a provider structurally CANNOT supply, and why.
 *
 * Without this the check cries wolf on every run, and a health check that
 * over-reports is one that gets ignored — the exact fate worth avoiding.
 *
 * These are not parser faults. `providers/stellenwerk.mjs` builds its rows from
 * the portal's SITEMAP, whose URL slug carries title, city and date and no
 * employer at all (`company: ''` is written literally, on purpose). WebSearch
 * ingestion has no structured employer field either.
 *
 * They are still reported — as a capability note, not a fault — because an
 * absent company is not free downstream: `data/blacklist.md` matching and
 * `providers/_trust-validator.mjs`'s company-vs-hostname check both key on it,
 * so those two filters simply do not engage for these rows.
 */
export const EXPECTED_EMPTY = {
  'stellenwerk-api': { fields: ['empty_company'], why: 'sitemap-derived: the URL slug carries title/city/date, never an employer' },
  websearch: { fields: ['empty_company'], why: 'WebSearch ingestion has no structured employer field' },
};

/** Rows below this in the recent window are too few to call anything. */
const MIN_ROWS_TO_JUDGE = 5;
/** A field wrong on this share of a portal's recent rows is a parser fault. */
const DEGRADED_SHARE = 0.5;

/**
 * Field-level damage that a parser produces and an exit code never shows.
 *
 * Each returns true when the value is WRONG, not merely absent-but-plausible.
 * An empty location is normal on a remote posting; an empty company is not,
 * because every posting has an employer.
 */
export const FIELD_CHECKS = {
  empty_company: (r) => !String(r.company ?? '').trim(),
  empty_title: (r) => !String(r.title ?? '').trim(),
  // "&amp;" in a title means the parser skipped entity decoding — the classic
  // half-working symptom, and it travels straight into a tracker row.
  undecoded_entities: (r) => /&(amp|lt|gt|quot|#\d+|nbsp);/i.test(String(r.title ?? '') + String(r.company ?? '')),
  // Markup that survived extraction.
  html_in_fields: (r) => /<[a-z/][^>]*>/i.test(String(r.title ?? '') + String(r.company ?? '')),
  // A title that is really a whole page.
  runaway_title: (r) => String(r.title ?? '').length > 200,
};

export function parseHistory(text) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const cols = lines[0].split('\t');
  const idx = Object.fromEntries(cols.map((c, i) => [c.trim(), i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    rows.push({
      url: f[idx.url] ?? '', firstSeen: f[idx.first_seen] ?? '', portal: (f[idx.portal] ?? '').trim(),
      title: f[idx.title] ?? '', company: f[idx.company] ?? '', location: f[idx.location] ?? '',
    });
  }
  return rows;
}

/**
 * Classify every portal from stored rows. Pure — unit-testable offline.
 *
 * @param {object[]} rows       parsed scan-history rows
 * @param {string}   sinceDate  YYYY-MM-DD; rows on/after this are "recent"
 */
export function assess(rows, sinceDate) {
  const byPortal = new Map();
  for (const r of rows) {
    if (!r.portal) continue;
    if (!byPortal.has(r.portal)) byPortal.set(r.portal, { recent: [], older: 0 });
    const bucket = byPortal.get(r.portal);
    if (r.firstSeen >= sinceDate) bucket.recent.push(r);
    else bucket.older += 1;
  }

  const out = [];
  for (const [portal, { recent, older }] of byPortal) {
    // Silent: it has produced before and produced nothing in the window. Worth
    // a look, never a breakage claim — the same queries may simply have no new
    // matches, which is the ordinary state of a small board.
    if (recent.length === 0) {
      out.push(older > 0
        ? { portal, verdict: 'silent', recent: 0, historical: older,
            detail: `no rows since ${sinceDate}; ${older} historically. Quiet board or dead parser — a live probe is the only way to tell.` }
        : { portal, verdict: 'inconclusive', recent: 0, historical: 0, detail: 'no rows at all' });
      continue;
    }
    if (recent.length < MIN_ROWS_TO_JUDGE) {
      out.push({ portal, verdict: 'inconclusive', recent: recent.length, historical: older,
        detail: `only ${recent.length} recent row(s) — too few to judge` });
      continue;
    }

    const expected = EXPECTED_EMPTY[portal]?.fields ?? [];
    const faults = [];
    const expectedHits = [];
    for (const [name, check] of Object.entries(FIELD_CHECKS)) {
      const hits = recent.filter(check).length;
      if (hits / recent.length < DEGRADED_SHARE) continue;
      if (expected.includes(name)) expectedHits.push(`${name} (${hits}/${recent.length})`);
      else faults.push(`${name} on ${hits}/${recent.length} rows`);
    }
    if (faults.length) {
      out.push({ portal, verdict: 'degraded', recent: recent.length, historical: older, detail: faults.join('; ') });
    } else if (expectedHits.length) {
      out.push({ portal, verdict: 'limited', recent: recent.length, historical: older,
        detail: `${expectedHits.join(', ')} — by design: ${EXPECTED_EMPTY[portal].why}. `
          + 'Blacklist matching and company-vs-hostname trust scoring do not engage for these rows.' });
    } else {
      out.push({ portal, verdict: 'healthy', recent: recent.length, historical: older, detail: '' });
    }
  }
  out.sort((a, b) => a.portal.localeCompare(b.portal));
  return out;
}

export function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        window: { type: 'string', default: '30' },
        json: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`provider-health: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log('Usage: node provider-health.mjs [--window N] [--json] [--strict]\n'
      + '  --window N  days of scan-history to treat as recent (default 30)\n'
      + '  --strict    exit non-zero when any portal is degraded');
    return;
  }
  if (!existsSync(HISTORY)) {
    console.log('No data/scan-history.tsv yet — nothing to assess.');
    return;
  }

  const since = shiftDays(new Date().toISOString().slice(0, 10), Number(values.window));
  const results = assess(parseHistory(readFileSync(HISTORY, 'utf-8')), since);

  if (values.json) {
    console.log(JSON.stringify({ since, results }, null, 2));
  } else {
    const bad = results.filter((r) => r.verdict !== 'healthy');
    console.log(`Provider health — ${results.length} portal(s) in scan-history, window since ${since}. No requests made.\n`);
    if (bad.length === 0) {
      console.log('✅ Every portal that produced rows in the window looks structurally sound.');
    } else {
      for (const r of bad) {
        const icon = { degraded: '🔴', silent: '🟡', limited: '🔵', inconclusive: '⚪' }[r.verdict];
        console.log(`${icon} ${r.portal.padEnd(22)} ${r.verdict}`);
        if (r.detail) console.log(`   ${r.detail}`);
      }
      console.log('\nA rate-limit or a block page is never evidence of breakage.');
      console.log('Confirm a degraded portal with one probe before changing anything.');
    }
    const healthy = results.filter((r) => r.verdict === 'healthy').length;
    console.log(`\n${healthy} healthy · ${results.filter((r) => r.verdict === 'degraded').length} degraded · `
      + `${results.filter((r) => r.verdict === 'silent').length} silent · `
      + `${results.filter((r) => r.verdict === 'inconclusive').length} inconclusive`);
  }

  if (values.strict && results.some((r) => r.verdict === 'degraded')) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
