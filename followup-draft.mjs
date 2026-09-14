#!/usr/bin/env node

/**
 * followup-draft.mjs — assemble follow-up drafts for the applications that are due.
 *
 * Zero-token. Reads `followup-cadence.mjs` for what is due, pulls each row's
 * evidenced points out of its evaluation report, and writes one markdown draft
 * per application into `output/follow-ups/`.
 *
 * **It writes drafts. It never sends anything**, and it deliberately cannot —
 * nothing here touches a mail API. That separation is the point: the retrieval
 * and bookkeeping are the repetitive parts worth automating, and the send is
 * the irreversible part that stays a human decision. Two date bugs have already
 * been found in the cadence plumbing (#2607, and the `.;` scope break on
 * 2026-08-19), both of which made an application look older than it was. An
 * unattended sender on top of that would have emailed recruiters on bad data.
 *
 * It also does NOT write the angle — the one specific sentence a follow-up
 * lives or dies on. An earlier version pasted report evidence straight into the
 * letter and produced lines like "MSc Data Science, FAU, Apr 2026 - Aug 2028
 * Within max_hours_per_week: 20": true, traceable, and unsendable. The body now
 * carries a marked placeholder and lists the candidate evidence underneath, so
 * the judgement call is visible rather than faked.
 *
 * Usage:
 *   node followup-draft.mjs              # drafts for everything currently due
 *   node followup-draft.mjs --all        # drafts for every in-flight row
 *   node followup-draft.mjs --row 9,10   # specific tracker rows
 *   node followup-draft.mjs --dry-run    # print instead of writing
 *
 * Exit codes: 0 nothing due · 10 drafts written · 1 the cadence run failed.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const OUT_DIR = join(CAREER_OPS, 'output', 'follow-ups');
const DUE = new Set(['overdue', 'urgent', 'cold']);

/** Openers modes/followup.md forbids outright. */
export const BANNED_OPENERS = [
  'just checking in',
  'just following up',
  'touching base',
  'circling back',
];

/**
 * Evidenced points from a report, newest format first.
 *
 * `top_strengths:` is the current shape. Older reports — 30 of 100 at the time
 * of writing — predate it and carry a `## B) CV Match` table instead, whose
 * rows are `| JD requirement | CV evidence | verdict |`. Reading the evidence
 * column of the ticked rows gets the same thing: claims the evaluation already
 * traced to cv.md. Without the fallback, a third of the pipeline produced
 * drafts with no candidate angles at all.
 *
 * @param {string} reportText
 * @returns {string[]}
 */
export function extractStrengths(reportText) {
  const text = String(reportText ?? '');

  const block = text.match(/^top_strengths:\s*$([\s\S]*?)^(?:risk_level|confidence|next_action|hard_stops|soft_gaps):/m);
  if (block) {
    const bullets = block[1]
      .split('\n')
      .map((l) => l.match(/^\s*-\s*"?(.*?)"?\s*$/))
      .filter(Boolean)
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0);
    if (bullets.length > 0) return bullets;
  }

  const cvMatch = text.match(/^##\s*B\)\s*CV Match\s*$([\s\S]*?)^##\s/m);
  if (!cvMatch) return [];
  return cvMatch[1]
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && l.includes('✅'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 4)
    .map((cells) => cells[2].replace(/\*\*/g, '').trim())
    .filter((s) => s.length > 0 && !/^-+$/.test(s));
}

/**
 * Addresses that cannot receive a reply.
 *
 * An ATS acknowledgement is the most common thing sitting in a row's contact
 * list, and it is exactly the address a follow-up must not go to. Craftview's
 * receipt came from `noreply@hrworks.de`, Primetals' from `donotreply@mssa.com`
 * — a follow-up sent to either is never read by anyone.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isUnreplyable(email) {
  const addr = String(email ?? '').trim();
  if (!addr) return false;
  const at = addr.lastIndexOf('@');
  const local = at === -1 ? addr : addr.slice(0, at);
  const host = at === -1 ? '' : addr.slice(at + 1);

  // Separator-anchored so a real name is never caught: "normanreply@" contains
  // no "noreply" and must stay replyable.
  if (/(^|[._-])(no-?reply|do-?not-?reply|donotreply|automated|mailer-daemon)([._-]|$)/i.test(local)) return true;

  // "notification" is matched anywhere in the local part, unanchored. It arrives
  // glued to another word — DLR's sender is
  // `dlrdeutsch-jobnotification@noreply12.jobs2web.com`, where the separator
  // rule above cannot see it — and no human mailbox is called notification.
  if (/notification/i.test(local)) return true;

  // The domain carries it just as often, and its labels take digit suffixes:
  // `noreply12.jobs2web.com`. Anchored to a label boundary so a company simply
  // called e.g. "replyco.com" is unaffected.
  if (/(^|\.)(no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon)\d*(\.|$)/i.test(host)) return true;

  // ATS platform domains. Mail from these is sent BY the applicant-tracking
  // system on the employer's behalf, and a reply reaches the platform rather
  // than a person — even when the local part looks like a company name and
  // trips none of the rules above. ZEISS's acknowledgement comes from
  // `zeissgroup@myworkday.com`, which reads like a perfectly good address and
  // is not one.
  if (ATS_PLATFORM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;

  return false;
}

/** @type {string[]} */
const ATS_PLATFORM_DOMAINS = [
  'myworkday.com',
  'workday.com',
  'myworkdayjobs.com',
  'successfactors.eu',
  'successfactors.com',
  'csod.com',
  'ashbyhq.com',
  'join.com',
  'msg.join.com',
  'hrworks.de',
  'jobs2web.com',
  'avature.net',
  'greenhouse.io',
  'lever.co',
  'personio.de',
  'softgarden.io',
  'concludis.de',
  'mssa.com',
];

/**
 * The candidate's own addresses, which must never be offered as a recipient.
 *
 * A row's contact list is assembled from whatever addresses appear around the
 * application, and that includes the candidate's own: DLR's row resolved to
 * `joshuajoseprofessional@gmail.com`, so the generated draft was addressed to
 * the sender. A follow-up mailed to yourself is not a failure that announces
 * itself — the draft looks complete and the recipient line looks plausible.
 *
 * @type {string[]}
 */
export const OWN_ADDRESSES = [
  'joshuajoseprofessional@gmail.com',
];

/** @param {string} email */
export function isOwnAddress(email) {
  const a = String(email ?? '').trim().toLowerCase();
  return OWN_ADDRESSES.includes(a);
}

/**
 * Reduce a report bullet to its first sentence.
 *
 * Report bullets are written for someone reading the evaluation: the first
 * sentence is the claim, the rest is justification the recipient does not need.
 *
 * @param {string} bullet
 * @returns {string}
 */
export function toSentence(bullet) {
  const first = String(bullet ?? '').split(/(?<=\.)\s+/)[0] ?? '';
  return first.replace(/\s+/g, ' ').trim();
}

/**
 * Build the draft body and everything derivable around it.
 *
 * @param {object} entry - One `followup-cadence.mjs` entry.
 * @param {string[]} strengths - From extractStrengths().
 */
export function buildDraft(entry, strengths) {
  const company = entry.company ?? 'the team';
  const role = entry.role ?? 'the role';
  const applied = entry.appliedDate ?? 'my application date';
  const emails = (entry.contacts ?? []).map((c) => c.email).filter(Boolean);
  const contact = emails.find((e) => !isUnreplyable(e) && !isOwnAddress(e)) ?? null;
  const rejected = emails.filter((e) => isUnreplyable(e) || isOwnAddress(e));
  const candidates = strengths.slice(0, 5).map(toSentence).filter(Boolean);

  const body = [
    `Hi ${company} team,`,
    '',
    `I applied for the ${role} role on ${applied}, and wanted to add one thing to my application.`,
    '',
    '[ANGLE — one specific sentence: the strongest evidenced reason this candidate is',
    'worth a second look at THIS company. Choose from the candidates below and write',
    'it as prose. Do not paste a candidate line in verbatim.]',
    '',
    'I would be glad to talk it through — would any time this week or next suit you?',
    '',
    'Best regards,',
    'Joshua Jose',
    '',
    'MSc Data Science, FAU Erlangen-Nürnberg',
    'joshuajoseprofessional@gmail.com',
  ].join('\n');

  const lower = body.toLowerCase();
  const violations = BANNED_OPENERS.filter((p) => lower.includes(p));

  return { body, contact, rejected, violations, candidates };
}

function cadence() {
  const res = spawnSync(process.execPath, [join(ROOT, 'followup-cadence.mjs')], {
    encoding: 'utf-8', cwd: ROOT,
  });
  if (res.status !== 0) {
    console.error(`followup-cadence.mjs failed (exit ${res.status})`);
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    console.error(`could not parse cadence output: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const rowIdx = argv.indexOf('--row');
  const onlyRows = rowIdx !== -1 && argv[rowIdx + 1] && !argv[rowIdx + 1].startsWith('--')
    ? new Set(argv[rowIdx + 1].split(',').map((s) => Number(s.trim())))
    : null;

  const data = cadence();
  let entries = data.entries ?? [];
  if (onlyRows) entries = entries.filter((e) => onlyRows.has(e.num));
  else if (!all) entries = entries.filter((e) => DUE.has(String(e.urgency ?? '')));

  const today = new Date().toISOString().slice(0, 10);
  if (entries.length === 0) {
    const next = (data.entries ?? []).map((e) => e.nextFollowupDate).filter(Boolean).sort()[0];
    console.log(`${today}: nothing due.${next ? ` Next falls due ${next}.` : ''} No drafts written.`);
    process.exit(0);
  }

  if (!dryRun) mkdirSync(OUT_DIR, { recursive: true });
  const written = [];

  for (const e of entries) {
    let strengths = [];
    const rp = e.reportPath ? join(CAREER_OPS, e.reportPath) : null;
    if (rp && existsSync(rp)) {
      try {
        strengths = extractStrengths(readFileSync(rp, 'utf-8'));
      } catch { /* unreadable report → no candidate angles, flagged below */ }
    }

    const { body, contact, rejected, violations, candidates } = buildDraft(e, strengths);
    const slug = String(e.company ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file = join(OUT_DIR, `${String(e.num).padStart(3, '0')}-${slug}.md`);

    const doc = [
      `# Follow-up draft — ${e.company} (#${e.num})`,
      '',
      `**To:** ${contact ?? '⚠️ NO REPLYABLE CONTACT — find one before sending'}`,
      `**Subject:** Re: ${e.role} — Joshua Jose`,
      `**Applied:** ${e.appliedDate} (${e.daysSinceApplication} days ago, date source: ${e.appDateSource})`,
      `**Follow-ups already sent:** ${e.followupCount}`,
      `**Urgency:** ${e.urgency}`,
      '',
      ...(rejected.length > 0
        ? [`> ⚠️ Ignored ${rejected.length} unreplyable address(es): ${rejected.join(', ')} — an ATS receipt address cannot take a follow-up.`, '']
        : []),
      ...(violations.length > 0
        ? [`> ⚠️ Contains a banned opener (${violations.join(', ')}) — rewrite before sending.`, '']
        : []),
      '---',
      '',
      body,
      '',
      '---',
      '',
      '## Candidate angles',
      '',
      ...(candidates.length > 0
        ? [
          `Drawn from \`${e.reportPath}\`. Each was already traced to cv.md by the`,
          'evaluation, so none can introduce a claim the report did not make.',
          'Choose one and write it as prose.',
          '',
          ...candidates.map((c, i) => `${i + 1}. ${c}`),
        ]
        : [
          '⚠️ No evidence found in the report — it has neither a `top_strengths:` block',
          'nor a `## B) CV Match` table. Write the angle from the report by hand.',
        ]),
      '',
      '---',
      '',
      '*Draft only. Nothing was sent. After sending, record it in `data/follow-ups.md`.*',
    ].join('\n');

    if (dryRun) {
      console.log(`\n--- would write ${file}\n${doc}`);
    } else {
      writeFileSync(file, `${doc}\n`, 'utf-8');
      written.push({ num: e.num, company: e.company, file, contact, candidates: candidates.length });
    }
  }

  console.log(`${today}: ${entries.length} due, ${written.length} draft(s) in output/follow-ups/\n`);
  for (const w of written) {
    console.log(`  #${w.num} ${w.company}`);
    console.log(`      to: ${w.contact ?? '⚠️ NO REPLYABLE CONTACT'}  ·  ${w.candidates} candidate angle(s)`);
  }
  console.log('\nNothing was sent. Each draft needs its ANGLE written before it goes out.');
  process.exit(10);
}

if (isMainModule(import.meta.url)) main();
