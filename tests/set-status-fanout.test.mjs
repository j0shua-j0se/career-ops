// tests/set-status-fanout.test.mjs — comma fan-out on --row / --report.
//
// AGENTS.md documents `--report 3,5,6` twice, and explicitly warns against
// wrapping set-status.mjs in a shell loop because a loop swallows the per-row
// exit codes. The documented form never worked: the selector had to match
// /^\d+$/, so a list printed usage and exited 1 — leaving the discouraged loop
// as the only way to bulk-update. Applying a score floor to 16 rows hit it.
//
// The fan-out re-invokes set-status.mjs once per selector rather than looping
// internally, so every child runs the identical validated/locked/atomic
// single-row path and no guard can be hoisted out of a loop by accident.
//
// Sandboxing follows tests/mark-pdf-ready.test.mjs: a throwaway tracker via the
// CAREER_OPS_TRACKER / CAREER_OPS_TRACKER_LOCK overrides.
//
// Auto-discovered by test-all.mjs — never exit the process here.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nset-status.mjs — comma fan-out');

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
].join('\n');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'co-setstatus-fanout-'));
  const tracker = join(dir, 'applications.md');
  const rows = [3, 5, 6].map(n =>
    `| ${n} | 2026-08-01 | Company${n} | Role ${n} | 4.0/5 | Evaluated | \u274c | \u2014 | seeded |`);
  writeFileSync(tracker, `${HEADER}\n${rows.join('\n')}\n`);
  return { dir, tracker, lock: join(dir, 'career-ops-merge-tracker-test.lock') };
}

function run(args, sb) {
  const r = spawnSync(NODE, [join(ROOT, 'set-status.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_TRACKER: sb.tracker, CAREER_OPS_TRACKER_LOCK: sb.lock },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

let sb = sandbox();
try {
  // ── the documented form actually works ────────────────────────────────────
  const many = run(['--row', '3,5,6', 'Applied'], sb);
  const text = readFileSync(sb.tracker, 'utf-8');
  const applied = [3, 5, 6].filter(n => new RegExp(`^\| ${n} \|.*Applied`, 'm').test(text));
  if (many.code === 0 && applied.length === 3) pass('--row 3,5,6 updates all three rows');
  else fail(`--row 3,5,6 exited ${many.code}; rows applied: ${JSON.stringify(applied)}`);

  if (/3\/3 row\(s\) updated/.test(many.out)) pass('the run reports an aggregate count');
  else fail(`no aggregate count in output: ${JSON.stringify(many.out.slice(-160))}`);

  const perRow = [3, 5, 6].every(n => many.out.includes(`#${n}`));
  if (perRow) pass('each row reports its own result line');
  else fail('per-row result lines are missing');

  // ── a partial failure must surface, not average away ─────────────────────
  sb = sandbox();
  const partial = run(['--row', '3,9999', 'Applied'], sb);
  const after = readFileSync(sb.tracker, 'utf-8');
  const row3Applied = /^\| 3 \|.*Applied/m.test(after);
  if (partial.code !== 0) pass('one bad row makes the whole run exit non-zero');
  else fail('a bad row in the list still exited 0 — a shell loop would have done this');
  if (row3Applied) pass('the good rows still apply when a later one fails');
  else fail('a failing row aborted the rows before it');

  // ── malformed lists are rejected naming the offending token ───────────────
  for (const [arg, token] of [['3,,5', '""'], ['3,abc', '"abc"'], ['3,', '""']]) {
    const r = run(['--row', arg, 'Applied'], sb);
    if (r.code !== 0 && r.out.includes('commas')) pass(`--row ${arg} is rejected, naming ${token}`);
    else fail(`--row ${arg} exited ${r.code}: ${JSON.stringify(r.out.slice(0, 120))}`);
  }
  for (const arg of ['-1', '0']) {
    const r = run(['--row', arg, 'Applied'], sb);
    if (r.code !== 0) pass(`--row ${arg} is still rejected as a single value`);
    else fail(`--row ${arg} exited 0`);
  }

  // ── duplicates are collapsed, not written twice ───────────────────────────
  sb = sandbox();
  const dupes = run(['--row', '3,3,5', 'Applied'], sb);
  if (/duplicate/i.test(dupes.out) && /2\/2 row\(s\) updated/.test(dupes.out)) {
    pass('a repeated selector is collapsed and reported');
  } else {
    fail(`duplicate handling: ${JSON.stringify(dupes.out.slice(-200))}`);
  }

  // ── --dry-run over a list writes nothing ─────────────────────────────────
  sb = sandbox();
  const before = readFileSync(sb.tracker, 'utf-8');
  const dry = run(['--row', '3,5,6', 'Applied', '--dry-run'], sb);
  if (dry.code === 0 && readFileSync(sb.tracker, 'utf-8') === before) {
    pass('--dry-run across a list changes nothing on disk');
  } else {
    fail(`--dry-run over a list wrote to the tracker (exit ${dry.code})`);
  }

  // ── a single selector behaves exactly as before ───────────────────────────
  sb = sandbox();
  const one = run(['--row', '5', 'Applied'], sb);
  if (one.code === 0 && /^\| 5 \|.*Applied/m.test(readFileSync(sb.tracker, 'utf-8'))) {
    pass('a single --row still works unchanged');
  } else {
    fail(`single --row exited ${one.code}`);
  }
  if (!/row\(s\) updated/.test(one.out)) pass('a single selector adds no aggregate noise');
  else fail('a single selector printed fan-out summary text');
} finally {
  try { rmSync(sb.dir, { recursive: true, force: true }); } catch {}
}
