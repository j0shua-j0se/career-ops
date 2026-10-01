#!/usr/bin/env node
// @ts-check
/**
 * resolve-aggregator-leads.mjs — employer-first resolution for aggregator leads.
 *
 * WHY: a StepStone or Indeed URL in `data/pipeline.md` is a LEAD, not a
 * destination — the posting almost always also lives on the employer's own
 * ATS board, and pointing the user at that instead means one fewer aggregator
 * page the user (or this repo) ever has to open. It matters more than usual
 * for StepStone right now: `lib/host-circuit.mjs`'s breaker means a
 * still-tripped StepStone URL literally cannot be opened by this machine at
 * all (see providers/stepstone.mjs), so an unresolved StepStone lead sitting
 * in the pipeline is a dead end until 2026-10-07 unless it gets resolved to
 * the employer's own posting first.
 *
 * For every PENDING, non-`done` `data/pipeline.md` entry (or every record in
 * `--in leads.json`, see below) whose URL host is a configured aggregator
 * (`stepstone.de`, `indeed.*` by default — see DEFAULT_AGGREGATOR_HOSTS),
 * this calls `lib/resolve-employer-posting.mjs`'s `resolveEmployerPosting()`
 * with `{company, title, location, urls: [aggregatorUrl]}`. That function
 * tries, cheapest first: (1) an already-tracked `portals.yml` board for the
 * company (zero network), (2) any OTHER known URL for the company that
 * `lib/ats-url.mjs` recognizes as an ATS board (zero network), and only with
 * `--probe` (3) a live `discover-ats.mjs` probe. See that module's own file
 * doc for the full tier breakdown.
 *
 * A resolved lead gets its pipeline line rewritten in place: the URL cell
 * becomes the employer's own posting URL, and the original aggregator URL is
 * kept as PROVENANCE in a `note:` segment (`modes/pipeline.md`'s existing
 * `| {label}: {value}` convention) — nothing about the row's identity, score,
 * or history is lost, only the URL a human or script would actually open.
 *
 * An UNRESOLVED aggregator lead is never deleted or skipped silently — it is
 * marked `note: aggregator-only, unresolved` so `triage-prefilter.mjs` and a
 * human reviewer can deprioritize it, and re-tried on every future run (the
 * marker does not stop a later pass from trying again once, say, the
 * employer's board picks the posting up).
 *
 * PREVIEW BY DEFAULT. Nothing is written to `data/pipeline.md` unless
 * `--write` is passed — this mirrors every other preview-first tool in this
 * repo (`triage-prefilter.mjs`, `normalize-statuses.mjs`, ...). A run with no
 * aggregator leads in the inbox is a clean no-op either way.
 *
 * Usage:
 *   node resolve-aggregator-leads.mjs                       # preview, data/pipeline.md
 *   node resolve-aggregator-leads.mjs --write                # apply the rewrite
 *   node resolve-aggregator-leads.mjs --probe --write         # also try a live discover-ats probe
 *   node resolve-aggregator-leads.mjs --in leads.json          # preview over a JSON file instead
 *       leads.json: [{"company":"...", "title":"...", "url":"...", "location":"..."}]
 *       (reporting only — there is no pipeline.md line to rewrite for a
 *       --in lead that is not also present in data/pipeline.md, so --write
 *       has nothing to apply for it)
 *   node resolve-aggregator-leads.mjs --aggregators stepstone.de,indeed.com,otherboard.example
 *   node resolve-aggregator-leads.mjs --help
 *
 * Exit code is always 0 — an unresolved lead is a normal, expected outcome
 * (not every posting lives on an ATS this repo's providers cover), not a
 * script failure. Coverage (resolved/total) is printed for the human to judge.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { parsePipeline, parsePipelineLine } from './triage-prefilter.mjs';
import { resolveEmployerPosting } from './lib/resolve-employer-posting.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE_FILE || join(CAREER_OPS, 'data', 'pipeline.md');
const PORTALS_PATH = join(CAREER_OPS, 'portals.yml');

const USAGE = `Usage:
  node resolve-aggregator-leads.mjs [--write] [--probe] [--in <leads.json>]
                                     [--aggregators host1,host2,...]
  node resolve-aggregator-leads.mjs --help

  --write         apply the rewrite to data/pipeline.md (default: preview only)
  --probe         also allow a live discover-ats.mjs probe when no zero-network
                   tier resolves the company's board (default: zero-network only)
  --in <path>     resolve leads from this JSON file instead of data/pipeline.md
                   ([{"company","title","url","location"}]) — reporting only
  --aggregators   comma-separated aggregator hosts to resolve (default:
                   ${''}stepstone.de,indeed.com). A listed host also matches its
                   subdomains — indeed.com covers to.indeed.com and de.indeed.com.`;

/** Every host this script treats as "a lead, not a destination" by default. */
export const DEFAULT_AGGREGATOR_HOSTS = ['stepstone.de', 'indeed.com'];

/**
 * Is `url`'s host one of `aggregatorHosts` (exact match or a subdomain of
 * one — `de.indeed.com` matches `indeed.com`)? Mirrors the suffix-matching
 * convention `verify-pipeline.mjs`'s Check 20 and `lib/host-circuit.mjs` both
 * already use, so "is this an aggregator host" reads the same way everywhere
 * in the repo.
 *
 * @param {string} url
 * @param {string[]} [aggregatorHosts]
 * @returns {boolean}
 */
export function isAggregatorUrl(url, aggregatorHosts = DEFAULT_AGGREGATOR_HOSTS) {
  let host;
  try {
    host = new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return aggregatorHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// ── pipeline line rewriting (pure — no fs) ──────────────────────────────────

/** The `note:` clause marking a lead no zero-network tier could resolve. */
const UNRESOLVED_NOTE = 'aggregator-only, unresolved';

/** @param {string} line @returns {{prefix: string, cells: string[]}|null} */
function splitPipelineLine(line) {
  const m = /^(\s*-\s*\[[ xX]\]\s*)(.+?)\s*$/.exec(line);
  if (!m) return null;
  return { prefix: m[1], cells: m[2].split('|').map((s) => s.trim()) };
}

/**
 * Add `text` to the line's `note:` segment, creating one if absent. Idempotent:
 * if `text` is already present in the note (verbatim substring), the cells are
 * returned unchanged — a re-run must not grow the note on every pass.
 * @param {string[]} cells
 * @param {string} text
 * @returns {string[]}
 */
function upsertNote(cells, text) {
  const idx = cells.findIndex((c) => /^note:/i.test(c));
  if (idx === -1) return [...cells, `note: ${text}`];
  const existing = cells[idx].replace(/^note:\s*/i, '');
  if (existing.includes(text)) return cells;
  const out = [...cells];
  out[idx] = existing ? `note: ${existing}; ${text}` : `note: ${text}`;
  return out;
}

/**
 * Rewrite a resolved pipeline line: the URL cell becomes the employer's own
 * posting, and the aggregator URL is kept as provenance in the `note:` cell.
 *
 * @param {string} line
 * @param {{employerUrl: string, aggregatorUrl: string, host: string}} opts
 * @returns {string} the rewritten line, or `line` unchanged if it does not parse.
 */
export function rewriteResolvedLine(line, { employerUrl, aggregatorUrl, host }) {
  const parsed = splitPipelineLine(line);
  if (!parsed) return line;
  const cells = [...parsed.cells];
  cells[0] = employerUrl;
  // A line an earlier pass marked `aggregator-only, unresolved` is resolved now:
  // leaving the marker would tell the next reader the opposite of the URL cell.
  const noted = dropNoteText(upsertNote(cells, `resolved from ${host} lead: ${aggregatorUrl}`), UNRESOLVED_NOTE);
  return `${parsed.prefix}${noted.join(' | ')}`;
}

/**
 * Remove one `;`-separated clause from the line's `note:` segment. The segment
 * disappears altogether if that was all it held. A line without the clause is
 * returned unchanged.
 * @param {string[]} cells
 * @param {string} text
 * @returns {string[]}
 */
function dropNoteText(cells, text) {
  const idx = cells.findIndex((c) => /^note:/i.test(c));
  if (idx === -1) return cells;
  const clauses = cells[idx].replace(/^note:\s*/i, '').split(';').map((s) => s.trim());
  if (!clauses.includes(text)) return cells;
  const kept = clauses.filter((s) => s && s !== text);
  const out = [...cells];
  if (kept.length) out[idx] = `note: ${kept.join('; ')}`;
  else out.splice(idx, 1);
  return out;
}

/**
 * Mark a still-unresolved aggregator lead so triage can deprioritize it.
 * Idempotent — re-marking an already-marked line is a no-op.
 *
 * @param {string} line
 * @returns {string}
 */
export function rewriteUnresolvedLine(line) {
  const parsed = splitPipelineLine(line);
  if (!parsed) return line;
  const noted = upsertNote(parsed.cells, UNRESOLVED_NOTE);
  return `${parsed.prefix}${noted.join(' | ')}`;
}

// ── resolution driver (injectable resolver — no network in tests) ──────────

/**
 * Resolve every aggregator-host entry in `entries` against `resolveFn`
 * (defaults to the real `resolveEmployerPosting`). Pure aside from the
 * resolver call itself, so a test can hand in a fake resolver and assert on
 * `results`/`resolvedCount`/`total` with no network and no real portals.yml.
 *
 * @param {Array<{company:string, title?:string, location?:string, url:string, raw?:string|null}>} entries
 * @param {{
 *   resolveFn?: typeof resolveEmployerPosting,
 *   aggregatorHosts?: string[],
 *   probe?: boolean,
 *   portals?: any,
 * }} [options]
 * @returns {Promise<{
 *   results: Array<{entry: any, host: string, resolved: boolean, employerUrl?: string, matchTitle?: string, score?: number, error?: string}>,
 *   resolvedCount: number,
 *   total: number,
 * }>}
 */
export async function resolveAggregatorLeads(entries, {
  resolveFn = resolveEmployerPosting,
  aggregatorHosts = DEFAULT_AGGREGATOR_HOSTS,
  probe = false,
  portals = null,
} = {}) {
  const aggregatorEntries = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && isAggregatorUrl(e.url, aggregatorHosts));

  const results = [];
  let resolvedCount = 0;

  for (const entry of aggregatorEntries) {
    let host = '';
    try { host = new URL(entry.url).hostname.replace(/^www\./i, ''); } catch { host = ''; }

    let match = null;
    let error;
    try {
      match = await resolveFn(
        {
          company: entry.company || '', title: entry.title || '', location: entry.location || '', urls: [entry.url],
        },
        { portals, probe },
      );
    } catch (err) {
      error = err?.message ?? String(err);
    }

    if (match && match.url) {
      resolvedCount += 1;
      results.push({
        entry, host, resolved: true, employerUrl: match.url, matchTitle: match.title, score: match.score,
      });
    } else {
      results.push({ entry, host, resolved: false, error });
    }
  }

  return { results, resolvedCount, total: aggregatorEntries.length };
}

// ── file glue ────────────────────────────────────────────────────────────

function loadPortals() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    return yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

function loadPipelineEntries() {
  const md = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
  const { pending } = parsePipeline(md);
  // `raw` carries the original line text, which is what makes a pipeline-sourced
  // entry (unlike a --in leads.json one) rewritable.
  return { md, entries: pending.filter((e) => e && !e.done) };
}

/** @param {string} path @returns {Array<{company:string, title:string, url:string, location:string, raw: null}>} */
function loadLeadsFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`could not read --in ${path}: ${err.message}`);
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--in ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`--in ${path} must contain a JSON array`);
  return arr.map((l) => ({
    company: l?.company || '', title: l?.title || '', url: l?.url || '', location: l?.location || '', raw: null,
  }));
}

/**
 * Apply queued rewrites to `data/pipeline.md`'s text, matching each rewrite to
 * its line by URL (not by exact string), the same technique
 * `prescan.mjs`'s `markExpiredInPipeline` uses — so two pipeline lines that
 * happen to be byte-identical still each get their own, correctly-keyed
 * outcome.
 *
 * @param {string} md
 * @param {Map<string, (line: string) => string>} transformByUrl
 * @returns {{text: string, applied: number}}
 */
export function applyPipelineChanges(md, transformByUrl) {
  if (transformByUrl.size === 0) return { text: md, applied: 0 };
  const out = [];
  let applied = 0;
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const entry = parsePipelineLine(line);
    if (!entry || entry.done || !transformByUrl.has(entry.url)) { out.push(line); continue; }
    out.push(transformByUrl.get(entry.url)(line));
    applied += 1;
  }
  return { text: out.join('\n'), applied };
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(
    args,
    ['--write', '--probe', '--in', '--aggregators', '--help', '-h'],
    USAGE,
    { valueFlags: ['--in', '--aggregators'], requireOperand: true },
  );
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const write = args.includes('--write');
  const probe = args.includes('--probe');
  const inPath = flagValue(args, '--in');
  const aggregatorsFlag = flagValue(args, '--aggregators');
  const aggregatorHosts = aggregatorsFlag
    ? aggregatorsFlag.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_AGGREGATOR_HOSTS;

  let md = '';
  let entries;
  if (inPath) {
    entries = loadLeadsFile(inPath);
  } else {
    ({ md, entries } = loadPipelineEntries());
  }

  const portals = loadPortals();
  const { results, resolvedCount, total } = await resolveAggregatorLeads(entries, {
    aggregatorHosts, probe, portals,
  });

  if (total === 0) {
    console.log(`resolve-aggregator-leads: no aggregator lead(s) among ${inPath ? 'the --in file' : 'data/pipeline.md'} (hosts: ${aggregatorHosts.join(', ')}) — nothing to do.`);
    return;
  }

  const transformByUrl = new Map();
  for (const r of results) {
    const label = `${r.entry.company || '?'} — ${r.entry.title || '?'}`;
    if (r.resolved) {
      console.log(`✅ ${label}: resolved (${r.host}) → ${r.employerUrl}`);
      if (r.entry.raw) {
        transformByUrl.set(r.entry.url, (line) => rewriteResolvedLine(line, {
          employerUrl: r.employerUrl, aggregatorUrl: r.entry.url, host: r.host,
        }));
      }
    } else {
      console.log(`— ${label}: unresolved (${r.host})${r.error ? ` — resolver error: ${r.error}` : ''}`);
      if (r.entry.raw) {
        transformByUrl.set(r.entry.url, (line) => rewriteUnresolvedLine(line));
      }
    }
  }

  console.log(`\nresolve-aggregator-leads: coverage ${resolvedCount}/${total} aggregator lead(s) resolved to an employer posting.`);

  if (inPath) {
    console.log('resolve-aggregator-leads: --in was given — nothing in data/pipeline.md is touched (reporting only).');
    return;
  }

  if (!write) {
    console.log('resolve-aggregator-leads: preview only — pass --write to apply these changes to data/pipeline.md.');
    return;
  }

  const { text, applied } = applyPipelineChanges(md, transformByUrl);
  if (applied > 0) {
    writeFileSync(PIPELINE_PATH, text, 'utf-8');
  }
  console.log(`resolve-aggregator-leads: wrote ${applied} updated pipeline line(s) to data/pipeline.md.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`resolve-aggregator-leads: fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
