#!/usr/bin/env node

/**
 * referral-links.mjs — search links for a row with no reachable contact.
 *
 * On 2026-08-31 nine follow-ups came due and six had no address a human reads:
 * ATS no-replies, a Workday platform mailbox, and one row that had resolved to
 * the candidate's own address. The blocker was never the draft, it was the
 * recipient.
 *
 * The answer is NOT a people-data broker and NOT scraping LinkedIn — its
 * robots.txt disallows /search/, and `robots-gate.mjs` refuses that path by
 * design. It is to hand the user two ready-made search URLs to open themselves.
 *
 * Adopted from the ai-job-search framework's /scrape Step 4.5 (MIT,
 * github.com/MadsLorentzen/ai-job-search), including its hard rule: these are
 * LINKS, NOT RESULTS. Nothing here fetches anything, no contact is invented,
 * and no claim is made that a specific person exists. `contacts.mjs` remains
 * the place a real contact is recorded once the user has identified one.
 *
 * Usage:
 *   node referral-links.mjs --row 13,16,23        # named tracker rows
 *   node referral-links.mjs --due                 # every overdue row lacking a contact
 *   node referral-links.mjs --company "ZEISS" --role "Internship Machine Learning"
 *   node referral-links.mjs --row 13 --json
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const TRACKER = resolveTrackerPath(CAREER_OPS);

const PEOPLE_SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=';

/**
 * Words that carry no signal in a people search.
 *
 * A LinkedIn people query is matched against headlines, and a headline never
 * says "(m/w/d)". Leaving the gender tag and the seniority prefix in returns
 * nothing at all, which reads as "no such team" rather than "bad query".
 */
const ROLE_NOISE = new Set([
  'm', 'w', 'd', 'f', 'x', 'mwd', 'fmd', 'mfd', 'all', 'genders', 'gender', 'divers', 'diverse',
  'werkstudent', 'werkstudentin', 'working', 'student', 'studentische', 'hilfskraft', 'hiwi',
  'intern', 'internship', 'praktikant', 'praktikantin', 'praktikum', 'trainee',
  'in', 'im', 'und', 'für', 'fuer', 'der', 'die', 'das', 'and', 'the', 'for', 'of', 'bei',
]);

/** Company suffixes that hurt a people search more than they help. */
const COMPANY_NOISE = /\b(gmbh|ag|kg|se|mbh|co|kgaa|ltd|limited|inc|llc|b\.?v\.?|s\.?a\.?|plc|group|holding|holdings)\b\.?/gi;

export function cleanCompany(name) {
  const raw = String(name ?? '');
  // A parenthetical is an expansion, not the name people put in a headline:
  // "DLR (Deutsches Zentrum fuer Luft- und Raumfahrt e.V.)" searches as "DLR".
  // Keep the parenthetical only when it is ALL there is.
  const outside = raw.replace(/\([^)]*\)/g, ' ').trim();
  const base = outside || raw.replace(/[()]/g, ' ');
  const cleaned = base
    .replace(/\s*[&/]\s*.*$/, '')       // "Georg Thieme Verlag KG / Thieme Compliance" -> first entity
    .replace(COMPANY_NOISE, ' ')
    // German/European legal forms that survive as loose letters once the dots
    // are stripped: e.V., S.A., N.V. Removed only as standalone tokens.
    .replace(/\be\.?\s?v\.?\b/gi, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw.trim();
}

/**
 * One or two substantive words from the role title.
 *
 * Kept short deliberately: a people search on a full posting title matches
 * nobody, because nobody's headline is a job ad.
 */
export function roleKeywords(role, limit = 2) {
  const words = String(role ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !ROLE_NOISE.has(w.toLowerCase()));
  return words.slice(0, limit).join(' ');
}

/** The two links. Pure — builds strings, touches nothing. */
export function buildLinks(company, role) {
  const c = cleanCompany(company);
  const kw = roleKeywords(role);
  const q = (s) => PEOPLE_SEARCH + encodeURIComponent(s);
  return {
    company: c,
    recruiter: q(`${c} recruiter`),
    talent: q(`${c} talent acquisition`),
    peers: kw ? q(`${c} ${kw}`) : null,
    peerKeyword: kw || null,
  };
}

function loadTrackerRows() {
  if (!existsSync(TRACKER)) return [];
  const rows = [];
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').map((s) => s.trim());
    if (c.length < 11 || !/^\d+$/.test(c[1])) continue;
    rows.push({ num: Number(c[1]), company: c[3], role: c[5], status: c[7] });
  }
  return rows;
}

/** Rows that check-followups-due reports as due AND unreachable. */
function dueWithoutContact() {
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'check-followups-due.mjs')],
      { cwd: ROOT, encoding: 'utf-8' });
  } catch (error) {
    // exit 10 means "something is due" — expected, and stdout is still valid.
    out = error?.stdout ? String(error.stdout) : '';
  }
  const nums = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*#(\d+)\s/);
    if (!m) continue;
    const block = lines.slice(i, i + 4).join('\n');
    if (/none reachable/.test(block)) nums.push(Number(m[1]));
  }
  return nums;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        row: { type: 'string' },
        due: { type: 'boolean', default: false },
        company: { type: 'string' },
        role: { type: 'string', default: '' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`referral-links: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (values.help || (!values.row && !values.due && !values.company)) {
    console.log('Usage: node referral-links.mjs [--row N,N] [--due] [--company X --role Y] [--json]\n'
      + '  --due   every overdue follow-up whose row has no reachable contact\n\n'
      + 'Emits LinkedIn people-search links for you to open. Fetches nothing,\n'
      + 'scrapes nothing, and never claims a specific person was found.');
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  let targets = [];
  if (values.company) {
    targets = [{ num: null, company: values.company, role: values.role, status: '' }];
  } else {
    const rows = loadTrackerRows();
    const wanted = values.due
      ? dueWithoutContact()
      : String(values.row).split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
    targets = wanted.map((n) => rows.find((r) => r.num === n)).filter(Boolean);
    const missing = wanted.filter((n) => !rows.some((r) => r.num === n));
    if (missing.length) console.error(`referral-links: no tracker row for ${missing.join(', ')}`);
  }

  if (targets.length === 0) {
    console.log(values.due
      ? 'Nothing overdue is missing a contact.'
      : 'No matching rows.');
    return;
  }

  const built = targets.map((t) => ({ num: t.num, role: t.role, ...buildLinks(t.company, t.role) }));

  if (values.json) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }

  console.log(`Referral search links for ${built.length} row(s). `
    + 'These are searches to open, not results — nothing was fetched.\n');
  for (const b of built) {
    console.log(`${b.num != null ? `#${b.num} ` : ''}${b.company}${b.role ? ` — ${b.role}` : ''}`);
    console.log(`   recruiter : ${b.recruiter}`);
    console.log(`   talent    : ${b.talent}`);
    if (b.peers) console.log(`   peers     : ${b.peers}   (keyword: ${b.peerKeyword})`);
    else console.log('   peers     : (no usable role keyword — the title was all boilerplate)');
    console.log('');
  }
  console.log('Open these yourself. When you identify a real person, record them with contacts.mjs —');
  console.log('nothing here invents a contact, and no result page is ever fetched or scraped.');
}

if (isMainModule(import.meta.url)) main();
