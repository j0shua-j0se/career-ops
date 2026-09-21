// tests/prescan.test.mjs — unit tests for prescan.mjs, the unattended weekly
// zero-token prescan.
//
// prescan.mjs's whole reason for existing separately from an interactive
// `/career-ops run` pass is that its stages are safe to run with nobody
// watching: no model calls, no submission, nothing that needs a judgement
// call. That only holds if the orchestration itself is trustworthy — a
// step that silently blocks the ones after it, a lock check that never
// actually refuses, an expired-JD marker that corrupts a row — so those are
// exactly what this suite pins, all offline and without spawning scan.mjs,
// scan-ats-full.mjs, triage-prefilter.mjs or fetch-jds.mjs for real.
//
// Auto-discovered by test-all.mjs: runs in-process, shares its counters, and
// must never call process.exit().
import { pass, fail } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  isPassRunning, planScanSteps, buildJdBatch, tallyJdStatuses,
  markExpiredInPipeline, parseTsvLastRow, countLines, summarizeAtsJson,
  formatDuration, orchestrateSteps, buildSummary, renderPrescanLogLine,
} from '../prescan.mjs';
import { DEFAULT_LOOP_CONFIG, resolveLoopConfig } from '../loop-core.mjs';
import { acquirePortalHealthLock, LockTimeoutError } from '../portal-health-lock.mjs';

console.log('\nprescan.mjs — unattended weekly zero-token prescan');

const check = (desc, condition, details = '') => {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` — ${details}` : ''}`);
};

// ── isPassRunning — the data/run-state.json guard ───────────────────────────

check('no state file at all is not "running"', isPassRunning(null) === false);
check('a non-object state is not "running"', isPassRunning('garbage') === false);
check(
  'a state with every stage completed is not "running"',
  isPassRunning({ completed: ['scan', 'pipeline', 'kits', 'sync'], skipped: [], halted_reason: null }) === false,
);
check(
  'a state with every stage completed-or-skipped is not "running"',
  isPassRunning({ completed: ['scan', 'pipeline'], skipped: ['kits', 'sync'], halted_reason: null }) === false,
);
check(
  'a state mid-way through, not halted, IS "running"',
  isPassRunning({ completed: ['scan'], skipped: [], halted_reason: null }) === true,
);
check(
  'a halted state is NOT "running" — stopped and waiting on the user, not active',
  isPassRunning({ completed: ['scan'], skipped: [], halted_reason: 'stage kits exceeded max attempts' }) === false,
);
check(
  'a corrupt/partial state (missing arrays) degrades to "not running" rather than throwing',
  isPassRunning({ halted_reason: null }) === true, // no stages completed/skipped => still mid-run, and that's fine — it must not throw
);

// ── planScanSteps — skip_strategies / ats_sources honoured ─────────────────

{
  const config = resolveLoopConfig({});
  const steps = planScanSteps(config, { dryRun: true });
  const ids = steps.map((s) => s.id);
  check('default config plans both portals and ats-recent', ids.includes('portals') && ids.includes('ats-recent'));
  const ats = steps.find((s) => s.id === 'ats-recent');
  check('ats-recent runs scan-ats-full.mjs with --since 7', ats.args.includes('--since') && ats.args.includes('7'), JSON.stringify(ats.args));
  check('an unscoped config does not inject --ats', !ats.args.includes('--ats'), JSON.stringify(ats.args));
}

{
  const config = resolveLoopConfig({ loop: { skip_strategies: ['interamt'], ats_sources: ['workday', 'ashby'] } });
  const steps = planScanSteps(config, { dryRun: true });
  const ids = steps.map((s) => s.id);
  check('skip_strategies: [interamt] leaves portals + ats-recent untouched (interamt is never in the wanted set anyway)',
    ids.includes('portals') && ids.includes('ats-recent') && !ids.includes('interamt'));
  const ats = steps.find((s) => s.id === 'ats-recent');
  check('ats_sources: [workday, ashby] narrows the ats-recent rung to --ats workday,ashby',
    ats.args.includes('--ats') && ats.args[ats.args.indexOf('--ats') + 1] === 'workday,ashby', JSON.stringify(ats.args));
}

{
  const config = resolveLoopConfig({ loop: { skip_strategies: ['portals'] } });
  const steps = planScanSteps(config, { dryRun: true });
  const ids = steps.map((s) => s.id);
  check('loop.skip_strategies naming a wanted rung (portals) removes it from the plan',
    !ids.includes('portals') && ids.includes('ats-recent'), JSON.stringify(ids));
}

check('planScanSteps with dryRun:true appends --dry-run to every step (never touches the scan-ats-full checkpoint on disk)',
  planScanSteps(DEFAULT_LOOP_CONFIG, { dryRun: true }).every((s) => s.args.includes('--dry-run')));

// ── buildJdBatch — pending, non-done entries only ───────────────────────────

{
  const md = [
    '# Pipeline',
    '## Pending',
    '- [ ] https://ex.com/a | Acme | Werkstudent Data | Erlangen | posted: 2026-09-01',
    '- [x] https://ex.com/b | Beta | Werkstudent ML | Munich | posted: 2026-09-02',
    '- [!] https://ex.com/c | Gamma | Intern | Berlin | posted: 2026-09-03',
    '- [ ] https://ex.com/d | Delta | Werkstudent AI | Nuremberg | posted: 2026-09-04',
  ].join('\n');
  const batch = buildJdBatch(md);
  check('only [ ] (pending, not done/unreachable) rows enter the JD batch', batch.length === 2, JSON.stringify(batch));
  check('a batch entry carries key/url/company/title/location',
    batch[0].url === 'https://ex.com/a' && batch[0].company === 'Acme' && typeof batch[0].key === 'string');
}

check('buildJdBatch on an empty pipeline returns an empty array', buildJdBatch('# Pipeline\n\n## Pending\n').length === 0);

// ── tallyJdStatuses ──────────────────────────────────────────────────────────

{
  const results = [
    { status: 'ok' }, { status: 'ok' }, { status: 'expired' },
    { status: 'robots-blocked' }, { status: 'blocked' }, { status: 'error' },
  ];
  const counts = tallyJdStatuses(results);
  check('ok/expired/other tally correctly', counts.ok === 2 && counts.expired === 1 && counts.other === 3, JSON.stringify(counts));
}
check('tallyJdStatuses on a non-array is all zero, not a throw', JSON.stringify(tallyJdStatuses(null)) === JSON.stringify({ ok: 0, expired: 0, other: 0 }));

// ── markExpiredInPipeline — the exact required format ───────────────────────

{
  const md = [
    '# Pipeline',
    '## Pending',
    '- [ ] https://ex.com/a | Acme | Werkstudent Data | Erlangen | posted: 2026-09-01',
    '- [ ] https://ex.com/b | Beta | Werkstudent ML | Munich | posted: 2026-09-02',
  ].join('\n');
  const { text, marked, lines } = markExpiredInPipeline(md, [{ url: 'https://ex.com/a', code: 'http_gone' }]);
  check('exactly one row is marked', marked === 1);
  const line = text.split('\n').find((l) => l.includes('ex.com/a'));
  check(
    'the expired row matches the exact spec\'d format: "- [x] #-- | <rest> | skipped (posting closed: liveness <code>)"',
    line === '- [x] #-- | https://ex.com/a | Acme | Werkstudent Data | Erlangen | posted: 2026-09-01 | skipped (posting closed: liveness http_gone)',
    line,
  );
  check('the untouched row is left byte-identical', text.includes('- [ ] https://ex.com/b | Beta | Werkstudent ML | Munich | posted: 2026-09-02'));
  check('one discard.log-shaped line is produced (iso-timestamp\\turl\\treason)', lines.length === 1 && /^\S+\thttps:\/\/ex\.com\/a\tposting closed: liveness http_gone$/.test(lines[0]), lines[0]);
}

check('an already-done row is never re-marked', markExpiredInPipeline(
  '- [x] https://ex.com/a | Acme | X | Y', [{ url: 'https://ex.com/a', code: 'http_gone' }],
).marked === 0);

check('an empty expired list changes nothing', markExpiredInPipeline('- [ ] https://ex.com/a | A | B | C', []).marked === 0);

check('a missing liveness code falls back to "unknown" rather than "undefined"',
  markExpiredInPipeline('- [ ] https://ex.com/a | A | B | C', [{ url: 'https://ex.com/a' }]).text.includes('liveness unknown'));

// ── parseTsvLastRow / countLines ─────────────────────────────────────────────

{
  const tsv = 'a\tb\tc\n1\t2\t3\n4\t5\t6\n';
  const row = parseTsvLastRow(tsv);
  check('parseTsvLastRow reads the LAST row by header name', row.a === '4' && row.b === '5' && row.c === '6', JSON.stringify(row));
}
check('parseTsvLastRow on a header-only file is null (no data rows)', parseTsvLastRow('a\tb\tc\n') === null);
check('parseTsvLastRow on empty text is null', parseTsvLastRow('') === null);
check('countLines counts non-empty lines only', countLines('a\nb\n\nc\n') === 3);

// ── summarizeAtsJson ─────────────────────────────────────────────────────────

{
  const json = {
    companiesScanned: 1234,
    postingsKept: 3,
    offers: [{ source: 'workday' }, { source: 'workday' }, { source: 'ashby' }],
  };
  const s = summarizeAtsJson(json);
  check('companiesScanned passes through', s.companiesScanned === 1234);
  check('new = postingsKept', s.new === 3);
  check('bySource groups offers by their own .source field', s.bySource.workday === 2 && s.bySource.ashby === 1, JSON.stringify(s.bySource));
}
check('summarizeAtsJson(null) degrades to nulls/empty rather than throwing',
  summarizeAtsJson(null).companiesScanned === null && JSON.stringify(summarizeAtsJson(null).bySource) === '{}');

// ── formatDuration ───────────────────────────────────────────────────────────

check('formatDuration renders sub-minute as seconds', formatDuration(45_000) === '45s');
check('formatDuration renders minutes+seconds', formatDuration(754_000) === '12m34s', formatDuration(754_000));
check('formatDuration floors negative/garbage to 0s', formatDuration(-5) === '0s' && formatDuration(NaN) === '0s');

// ── orchestrateSteps — the core "failing step doesn't block others" contract ─

{
  const order = [];
  const stepList = [
    { id: 'a', run: async () => { order.push('a'); return { exitCode: 0, found: 5 }; } },
    { id: 'b', run: async () => { order.push('b'); throw new Error('b blew up'); } },
    { id: 'c', run: async () => { order.push('c'); return { exitCode: 0 }; } },
  ];
  const { steps, anyRan } = await orchestrateSteps(stepList);
  check('every step is invoked, in order, even though one throws', order.join(',') === 'a,b,c', order.join(','));
  check('a throwing step is recorded with exitCode 1 and an error message', steps.b.exitCode === 1 && typeof steps.b.error === 'string' && steps.b.error.includes('b blew up'));
  check('a step AFTER the failure still ran and reports success', steps.c.exitCode === 0);
  check('a step BEFORE the failure keeps its own extra fields (found: 5)', steps.a.found === 5);
  check('anyRan is true once at least one step executed', anyRan === true);
}

{
  const stepList = [
    { id: 'x', run: () => ({ exitCode: 7 }) }, // a synchronous, non-throwing, non-zero-exit "failure"
  ];
  const { steps } = await orchestrateSteps(stepList);
  check('a step that returns a non-zero exitCode (not a throw) is reported as-is, not coerced to 1', steps.x.exitCode === 7);
}

check('orchestrateSteps on an empty list returns anyRan: false', (await orchestrateSteps([])).anyRan === false);
check('orchestrateSteps on undefined does not throw', (await orchestrateSteps(undefined)).anyRan === false);

{
  // A rejected (async-throw) step is handled the same way as a synchronous throw.
  const stepList = [{ id: 'r', run: async () => { throw new Error('rejected'); } }];
  const { steps, anyRan } = await orchestrateSteps(stepList);
  check('an async-rejecting step is caught the same way as a synchronous throw', steps.r.exitCode === 1 && anyRan === true);
}

// ── buildSummary / renderPrescanLogLine — shape ─────────────────────────────

{
  const summary = buildSummary({
    startedAt: '2026-09-21T02:00:00.000Z',
    finishedAt: '2026-09-21T04:15:00.000Z',
    steps: {
      portals: { exitCode: 0, durationMs: 723_000, found: 11485, new: 39 },
      'ats-recent': { exitCode: 0, durationMs: 2_280_000, companiesScanned: 4368, new: 3, bySource: { workday: 2, ashby: 1 } },
      'triage-prefilter': { exitCode: 0, durationMs: 4_000, freeRejected: 12, pendingLeft: 8 },
      'fetch-jds': { exitCode: 0, durationMs: 60_000, batchSize: 8, jd: { ok: 6, expired: 1, other: 1 }, expiredMarked: 1 },
    },
    jdCounts: { ok: 6, expired: 1, other: 1 },
    freeRejected: 12,
    pendingLeft: 8,
  });

  check('buildSummary carries started_at/finished_at through unchanged', summary.started_at === '2026-09-21T02:00:00.000Z' && summary.finished_at === '2026-09-21T04:15:00.000Z');
  check('buildSummary carries every step through', Object.keys(summary.steps).length === 4);
  check('buildSummary defaults jd/free_rejected/pending_left sanely when omitted',
    JSON.stringify(buildSummary({}).jd) === JSON.stringify({ ok: 0, expired: 0, other: 0 })
    && buildSummary({}).free_rejected === null && buildSummary({}).pending_left === null);

  // JSON.stringify must round-trip cleanly — this is what actually lands in
  // data/cache/prescan-summary.json.
  const roundtrip = JSON.parse(JSON.stringify(summary));
  check('the summary survives a JSON round-trip', roundtrip.steps.portals.found === 11485 && roundtrip.jd.expired === 1);

  const line = renderPrescanLogLine(summary);
  check('renderPrescanLogLine produces exactly one line', !line.includes('\n'));
  check('the log line starts with a markdown bullet', line.startsWith('- '));
  for (const needle of ['portals', 'ats-recent', 'triage-prefilter', 'fetch-jds', 'found=11485', 'new=39', 'workday=2', 'ashby=1', 'free-rejected=12', 'jd-ok=6', 'jd-expired=1', 'jd-other=1', 'pending-left=8']) {
    check(`the log line mentions "${needle}"`, line.includes(needle), line);
  }
}

check('renderPrescanLogLine tolerates missing steps rather than throwing', typeof renderPrescanLogLine({}) === 'string');

// ── lock behaviour — reusing portal-health-lock.mjs's own protocol ─────────

{
  const box = mkdtempSync(join(tmpdir(), 'cops-prescan-lock-'));
  const target = join(box, 'prescan');
  try {
    const first = await acquirePortalHealthLock(target, { staleMs: 6 * 60 * 60 * 1000, timeoutMs: 500, retryMs: 50 });
    check('a first acquire on an unheld lock succeeds', Boolean(first));

    let secondThrew = false;
    try {
      await acquirePortalHealthLock(target, { staleMs: 6 * 60 * 60 * 1000, timeoutMs: 200, retryMs: 50 });
    } catch (err) {
      secondThrew = err instanceof LockTimeoutError;
    }
    check('a second acquire on a lock another (live) holder has is refused — this is prescan\'s "another prescan holds the lock" path', secondThrew);

    first.release();
    const third = await acquirePortalHealthLock(target, { staleMs: 6 * 60 * 60 * 1000, timeoutMs: 500, retryMs: 50 });
    check('after release(), the lock is free again', Boolean(third));
    third.release();
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}
