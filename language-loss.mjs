#!/usr/bin/env node

/**
 * language-loss.mjs — how much of this pipeline dies on a language requirement?
 *
 * `analyze-patterns.mjs` already computes it, and buries it: "language-requirement
 * 22 (30%)" sits inside a JSON blob nobody reads, alongside fifteen other
 * fields. It is not one blocker among many. It is THREE TIMES the next one:
 *
 *     language-requirement  30%
 *     hours-or-contract     14%
 *     distance              12%
 *     stack-mismatch        11%
 *
 * And it is the only blocker on that list the candidate can actually change.
 * Distance is fixed by the degree until Aug 2028, hours by the visa, stack by
 * years of work — German is the one that moves with study.
 *
 * This pulls it out and puts a number on the decision: how many roles were lost,
 * how good they were, and what tier of requirement killed them. A role blocked
 * ONLY by language is the interesting case — it is a role that would otherwise
 * have been pursued, so the count is a direct measure of what B1 would buy.
 *
 * Reads reports/ and data/applications.md. No network, no tokens.
 *
 * Usage: node language-loss.mjs [--json]
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const REPORTS = join(CAREER_OPS, 'reports');
const TRACKER = resolveTrackerPath(CAREER_OPS);

/**
 * Read the language verdict from the report's STRUCTURED field. Never prose.
 *
 * The first version of this scraped the whole report for phrases like "sehr
 * gute Deutschkenntnisse". Every single match it produced was a FALSE POSITIVE,
 * because an evaluation discusses other postings as often as its own:
 *
 *   #134 quotes its own OPEN gate ("Deutschkenntnisse sind von Vorteil") and
 *        then says sibling requisitions "demand sehr gute Deutschkenntnisse".
 *        Prose matching read the sibling clause and condemned a 4.5 role.
 *   #90  says that AGAINST four Siemens requisitions that demand it, Thieme is
 *        "the difference between a live application and a dead one".
 *   #43  quotes the profile.yml RULE, not the posting.
 *   #64  says explicitly that it is the penalty tier, not hard_stop.
 *
 * A gate built on that would have blocked the best role in the pipeline. So
 * this reads `language_gate:` out of the Machine Summary and nothing else. When
 * the field is absent the answer is UNKNOWN — which is a different fact from
 * "no requirement", and is reported as such rather than counted as clear.
 *
 * modes/_custom.md makes writing the field mandatory for new evaluations.
 */
export function classifyLanguage(text) {
  const fence = String(text ?? '').match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i);
  if (!fence) return { tier: 'unknown', quote: '' };
  const gate = fence[1].match(/^language_gate:\s*["']?(PASS|FLAG|FAIL)["']?/im);
  if (!gate) return { tier: 'unknown', quote: '' };
  const note = fence[1].match(/^language_note:\s*["']?(.*?)["']?\s*$/im);
  const tier = { FAIL: 'hard_stop', FLAG: 'penalty', PASS: 'none' }[gate[1].toUpperCase()];
  return { tier, quote: note ? note[1].trim() : gate[1].toUpperCase() };
}

/** Pull `score:` out of a report's Machine Summary, falling back to the header. */
export function reportScore(text) {
  const fence = String(text ?? '').match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const m = fence[1].match(/^score:\s*([\d.]+)/m);
    if (m) return Number(m[1]);
  }
  const h = String(text ?? '').match(/^\*\*Score:\*\*\s*([\d.]+)/m);
  return h ? Number(h[1]) : null;
}

/**
 * Fold reports + tracker into the loss picture. Pure over its inputs.
 *
 * @param {Array<{num:string, text:string, status:string}>} reports
 */
export function analyse(reports) {
  const out = { total: 0, hardStop: [], penalty: [], clear: 0, unknown: 0 };
  for (const r of reports) {
    out.total += 1;
    const { tier, quote } = classifyLanguage(r.text);
    const entry = { num: r.num, status: r.status, score: reportScore(r.text), quote, company: r.company };
    if (tier === 'hard_stop') out.hardStop.push(entry);
    else if (tier === 'penalty') out.penalty.push(entry);
    else if (tier === 'none') out.clear += 1;
    else out.unknown += 1;
  }
  const sortByScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);
  out.hardStop.sort(sortByScore);
  out.penalty.sort(sortByScore);

  // The decision number: roles good enough to pursue that a hard stop removed.
  // These are not "roles that were a bit of a stretch" — every one cleared the
  // pursue floor on its own merits and was then refused on one line of German.
  const FLOOR = 3.5;
  out.lostAbovePursueFloor = out.hardStop.filter((e) => (e.score ?? 0) >= FLOOR);
  out.pctHardStop = out.total ? Math.round((out.hardStop.length / out.total) * 100) : 0;
  return out;
}

function loadReports() {
  if (!existsSync(REPORTS)) return [];
  const statusByReport = new Map();
  const companyByReport = new Map();
  if (existsSync(TRACKER)) {
    for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
      if (!line.startsWith('|')) continue;
      const c = line.split('|').map((s) => s.trim());
      if (c.length < 11 || !/^\d+$/.test(c[1])) continue;
      const m = c[9].match(/\[(\d+)\]/);
      if (m) {
        statusByReport.set(String(Number(m[1])), c[7]);
        companyByReport.set(String(Number(m[1])), c[3]);
      }
    }
  }
  const out = [];
  for (const name of readdirSync(REPORTS)) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(/^(\d+)-/);
    if (!m) continue;
    const num = String(Number(m[1]));
    out.push({
      num,
      text: readFileSync(join(REPORTS, name), 'utf-8'),
      status: statusByReport.get(num) ?? '—',
      company: companyByReport.get(num) ?? '?',
    });
  }
  return out;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { json: { type: 'boolean', default: false } }, strict: true }));
  } catch (error) {
    console.error(`language-loss: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const r = analyse(loadReports());
  if (values.json) { console.log(JSON.stringify(r, null, 2)); return; }

  console.log(`Language loss — ${r.total} evaluated role(s). No requests made.\n`);
  console.log(`  language_gate: FAIL (hard stop) : ${r.hardStop.length}`);
  console.log(`  language_gate: FLAG (penalty)   : ${r.penalty.length}`);
  console.log(`  language_gate: PASS             : ${r.clear}`);
  console.log(`  field absent (UNKNOWN)          : ${r.unknown}\n`);

  if (r.unknown === r.total) {
    console.log('  Nothing measurable yet: no evaluation carries `language_gate:`.');
    console.log('  modes/_custom.md now requires it, so this fills in from the next pass onward.');
    console.log('');
    console.log('  Old reports are deliberately NOT backfilled. The first version of this script');
    console.log('  inferred the tier from report prose, and EVERY match it produced was a false');
    console.log('  positive — an evaluation quotes sibling postings, and the profile rule itself,');
    console.log('  as often as it states its own requirement. It condemned a 4.5 role whose gate');
    console.log('  was open. Prose is not a field.');
    return;
  }

  if (r.lostAbovePursueFloor.length) {
    console.log(`❗ ${r.lostAbovePursueFloor.length} role(s) scored at or above the 3.5 pursue floor and were`);
    console.log('   refused on a language line alone — these are what B1 would have bought:\n');
    for (const e of r.lostAbovePursueFloor) {
      console.log(`   ${String(e.score).padEnd(4)} #${e.num.padEnd(4)} ${String(e.company).slice(0, 34).padEnd(34)} "${e.quote}"`);
    }
    const best = r.lostAbovePursueFloor[0];
    console.log(`\n   Best of them: #${best.num} at ${best.score}/5.`);
  } else {
    console.log('No role above the pursue floor was lost to a hard language stop.');
  }
}

if (isMainModule(import.meta.url)) main();
