#!/usr/bin/env node

/**
 * check-followups-due.mjs — "is any follow-up actually due today?"
 *
 * A zero-token wrapper over followup-cadence.mjs, meant to be run unattended by
 * Windows Task Scheduler / cron. It writes nothing and sends nothing: it prints
 * what is due and exits 10 when there is something, so a scheduler can act on
 * the exit code.
 *
 * Why a local script and not a cloud routine: every input this needs — the
 * tracker, the follow-up history, the profile — is gitignored and lives only on
 * this machine. A cloud agent checking out the repository would find no tracker
 * at all and would report "nothing due" forever while appearing to work.
 *
 * Exit codes:
 *   0  nothing due
 *  10  at least one follow-up is due (overdue / urgent / cold)
 *   1  the cadence analysis itself failed
 */

import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { isUnreplyable, isOwnAddress } from './followup-draft.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DUE = new Set(['overdue', 'urgent', 'cold']);

export function selectDue(entries) {
  return (entries ?? []).filter((e) => DUE.has(String(e?.urgency ?? '')));
}

/**
 * The same recipient guards followup-draft.mjs applies, so this listing can
 * never advertise an address the drafter would refuse to write to.
 *
 * Printing a no-reply mailbox, an ATS platform address, or — worst — the
 * candidate's OWN address next to "follow-up due" reads as an actionable
 * contact and is not one. The first cost is a wasted evening writing to a
 * mailbox nobody reads; the second is believing a chase was sent.
 */
export function pickContact(contacts) {
  const emails = (contacts ?? []).map((c) => c?.email).filter(Boolean);
  const usable = emails.find((e) => !isUnreplyable(e) && !isOwnAddress(e));
  if (usable) return { email: usable, replyable: true };
  if (emails.length > 0) {
    const why = emails.some(isOwnAddress) ? 'own address' : 'no-reply/ATS mailbox';
    return { email: emails[0], replyable: false, why };
  }
  return { email: null, replyable: false, why: 'none on file' };
}

function main() {
  const res = spawnSync(process.execPath, [join(ROOT, 'followup-cadence.mjs')], {
    encoding: 'utf-8',
    cwd: ROOT,
  });
  if (res.status !== 0) {
    console.error(`followup-cadence.mjs failed (exit ${res.status})`);
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (err) {
    console.error(`could not parse cadence output: ${err.message}`);
    process.exit(1);
  }

  const due = selectDue(data.entries);
  const today = new Date().toISOString().slice(0, 10);

  if (due.length === 0) {
    const next = (data.entries ?? [])
      .map((e) => e.nextFollowupDate)
      .filter(Boolean)
      .sort()[0];
    console.log(`${today}: no follow-up due.${next ? ` Next one falls due ${next}.` : ''}`);
    process.exit(0);
  }

  console.log(`${today}: ${due.length} follow-up(s) due\n`);
  let sendable = 0;
  for (const e of due) {
    const c = pickContact(e.contacts);
    if (c.replyable) sendable += 1;
    console.log(`  #${e.num} ${e.company} — ${e.role}`);
    console.log(`      applied ${e.appliedDate} (${e.appDateSource}), ${e.daysSinceApplication}d ago, `
      + `${e.followupCount} follow-up(s) sent, ${e.urgency}`);
    console.log(c.replyable
      ? `      contact: ${c.email}`
      : `      contact: ⚠️ none reachable${c.email ? ` (${c.email} — ${c.why})` : ''}`);
  }
  console.log(`\n${sendable} of ${due.length} have a replyable address; `
    + `${due.length - sendable} would need a contact found first.`);
  console.log('\nDrafts are NOT written and nothing is sent. Run `/career-ops followup` to draft them.');
  process.exit(10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
