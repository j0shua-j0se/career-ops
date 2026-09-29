// tests/scan-loop-finish-inbox.test.mjs — `scan-loop.mjs finish` reconciles the
// inbox (data/pipeline.md) with the loop's own verdicts.
//
// Before this, `finish` promoted the qualified candidates and left every
// loop-rejected one `- [ ]` pending (112 rows on 2026-09-29), so the same
// postings were re-triaged by the next pass and the pending count stayed
// inflated until someone ticked them by hand with `triage-prefilter.mjs
// --mark-file`. `finish` now applies the verdicts through that same code path:
// rejected -> `- [x]` with the triage reason, unreachable -> `- [!]`, qualified
// stays pending, every discard is logged to data/discard.log, and a second run
// changes nothing.
//
// Everything runs against a temp inbox; nothing in the real repo is touched.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

console.log('\nscan-loop.mjs finish — inbox reconciliation');

const check = (desc, cond, details = '') => (cond ? pass(desc) : fail(`${desc}${details ? ` — ${details}` : ''}`));

try {
  const loopCore = await import(pathToFileURL(join(ROOT, 'loop-core.mjs')).href);
  const prefilter = await import(pathToFileURL(join(ROOT, 'triage-prefilter.mjs')).href);

  // ── pure layer: inboxVerdictRows + applyVerdictRows ────────────────────────
  {
    const s = loopCore.newState({ ...loopCore.DEFAULT_LOOP_CONFIG, minScore: 3.8, target: 5 }, '2026-09-29T00:00:00.000Z');
    loopCore.ingestOffers(s, [
      { url: 'https://www.acme.com/jobs/1?utm_source=x', company: 'Acme', title: 'A' },
      { url: 'https://beta.com/jobs/2', company: 'Beta', title: 'B' },
      { url: 'https://gamma.com/jobs/3', company: 'Gamma', title: 'C' },
      { url: 'https://delta.com/jobs/4', company: 'Delta', title: 'D' },
    ], 1);
    const keyOf = (u) => loopCore.candidateKey(u);
    loopCore.recordScores(s, [
      { key: keyOf('https://www.acme.com/jobs/1?utm_source=x'), score: 1.5, verdict: 'FAIL', reason: 'senior | full-time\nrole' },
      { key: keyOf('https://beta.com/jobs/2'), score: 4.4, verdict: 'PASS', reason: 'strong fit' },
      { key: keyOf('https://gamma.com/jobs/3'), score: 0, verdict: 'SKIP', reason: 'WAF wall' },
    ]); // delta stays pending

    // The inbox spells Acme's URL differently from the candidate: the row must
    // carry the INBOX's spelling, which is what the marker matches on.
    const pendingUrls = ['http://acme.com/jobs/1', 'https://beta.com/jobs/2', 'https://gamma.com/jobs/3', 'https://delta.com/jobs/4', 'https://other.com/jobs/9'];
    const rows = loopCore.inboxVerdictRows(s, pendingUrls);
    check('a rejected candidate becomes a discard row carrying the inbox URL spelling',
      rows.some((r) => r.url === 'http://acme.com/jobs/1' && r.decision === 'discard'), JSON.stringify(rows));
    check('an unreachable candidate becomes an unreachable row',
      rows.some((r) => r.url === 'https://gamma.com/jobs/3' && r.status === 'unreachable' && !r.decision));
    check('a qualified candidate produces no row (it stays pending for evaluation)', !rows.some((r) => r.url.includes('beta.com')));
    check('a still-unscored candidate produces no row', !rows.some((r) => r.url.includes('delta.com')));
    check('a candidate absent from the inbox produces no row', rows.length === 2, `got ${rows.length}`);

    const md = pendingUrls.map((u) => `- [ ] ${u} | Co | Title | Berlin`).join('\n') + '\n';
    const applied = prefilter.applyVerdictRows(md, rows);
    check('applyVerdictRows ticks the discard, marks the unreachable, leaves the rest',
      /^- \[x\] http:\/\/acme\.com\/jobs\/1/m.test(applied.text) && /^- \[!\] https:\/\/gamma\.com/m.test(applied.text)
      && /^- \[ \] https:\/\/beta\.com/m.test(applied.text) && /^- \[ \] https:\/\/delta\.com/m.test(applied.text)
      && /^- \[ \] https:\/\/other\.com/m.test(applied.text));
    check('the reason is kept on one line with no field separator in it',
      /skipped \(pre-screen mismatch: senior \/ full-time role\)/.test(applied.text), applied.text);
    check('applyVerdictRows reports what it marked and one log line per discard',
      applied.discardsMarked === 1 && applied.unreachableMarked === 1 && applied.logLines.length === 1);
    const again = prefilter.applyVerdictRows(applied.text, rows);
    check('applying the same verdicts twice marks nothing the second time (idempotent)',
      again.discardsMarked === 0 && again.unreachableMarked === 0 && again.logLines.length === 0 && again.text === applied.text);
  }

  // ── end to end: a real `finish` against a temp inbox ───────────────────────
  const box = mkdtempSync(join(tmpdir(), 'cops-finish-inbox-'));
  const paths = {
    state: join(box, 'data', 'loop-state.json'),
    shortlist: join(box, 'data', 'loop-shortlist.md'),
    runLog: join(box, 'data', 'loop-run-log.md'),
    pipeline: join(box, 'data', 'pipeline.md'),
    discardLog: join(box, 'data', 'discard.log'),
    profile: join(box, 'config', 'profile.yml'),
    tracker: join(box, 'data', 'applications.md'),
    additions: join(box, 'batch', 'tracker-additions'),
    batchState: join(box, 'batch', 'batch-state.tsv'),
    reports: join(box, 'reports'),
  };
  mkdirSync(join(box, 'data'), { recursive: true });
  mkdirSync(join(box, 'config'), { recursive: true });
  mkdirSync(paths.additions, { recursive: true });
  mkdirSync(paths.reports, { recursive: true });
  writeFileSync(paths.profile, 'loop:\n  target: 1\n  min_score: 3.8\n  score_batch: 12\n', 'utf-8');
  writeFileSync(paths.tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|', '',
  ].join('\n'), 'utf-8');

  const urls = {
    keep: 'https://boards.greenhouse.io/acme/jobs/1',
    junk: 'https://jobs.lever.co/beta/2',
    wall: 'https://jobs.ashbyhq.com/gamma/3',
    free: 'https://boards.greenhouse.io/delta/jobs/4',
    priority: 'https://boards.greenhouse.io/eps/jobs/5',
    bystander: 'https://example.com/not-in-the-loop',
  };
  const inbox = [
    '# Pipeline', '', '## Pending',
    `- [ ] ${urls.keep} | Acme | AI Engineer | Berlin`,
    `- [ ] ${urls.junk} | Beta | Data Engineer | Hamburg`,
    `- [ ] ${urls.wall} | Gamma | Backend Engineer | Munich`,
    `- [ ] ${urls.free} | Delta | Platform Lead | Remote`,
    `- [ ] ${urls.priority} | Eps | Analyst | Erlangen`,
    `- [ ] ${urls.bystander} | Other | Something | Erlangen`,
    '',
  ].join('\n');
  writeFileSync(paths.pipeline, inbox, 'utf-8');

  const env = {
    ...process.env,
    CAREER_OPS_LOOP_STATE: paths.state, CAREER_OPS_LOOP_SHORTLIST: paths.shortlist, CAREER_OPS_LOOP_RUN_LOG: paths.runLog,
    CAREER_OPS_PIPELINE_FILE: paths.pipeline, CAREER_OPS_DISCARD_LOG: paths.discardLog, CAREER_OPS_PROFILE: paths.profile,
    CAREER_OPS_TRACKER: paths.tracker, CAREER_OPS_ADDITIONS: paths.additions, CAREER_OPS_BATCH_STATE: paths.batchState,
    CAREER_OPS_REPORTS_DIR: paths.reports,
  };
  const loop = (...args) => {
    const r = spawnSync(NODE, [join(ROOT, 'scan-loop.mjs'), ...args], { env, encoding: 'utf-8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
  };
  const readState = () => JSON.parse(readFileSync(paths.state, 'utf-8'));
  const offersFile = join(box, 'offers.json');
  writeFileSync(offersFile, JSON.stringify(Object.entries(urls).filter(([k]) => k !== 'bystander').map(([k, url]) => (
    { url, company: k, title: 'Engineer', location: 'Berlin' }))), 'utf-8');

  check('start succeeds', loop('start').status === 0);
  check('ingest adds the loop candidates', loop('ingest', '--file', offersFile).json?.added === 5);
  const keyFor = (u) => Object.keys(readState().candidates).find((k) => readState().candidates[k].url === u);
  const scoresFile = join(box, 'scores.json');
  writeFileSync(scoresFile, JSON.stringify([
    { key: keyFor(urls.keep), score: 4.4, verdict: 'PASS', reason: 'archetype match' },
    { key: keyFor(urls.junk), score: 2.0, verdict: 'FAIL', reason: 'full-time senior role, cannot run alongside the MSc' },
    { key: keyFor(urls.wall), score: 0, verdict: 'SKIP', reason: 'AWS WAF human-verification wall' },
    { key: keyFor(urls.free), score: 1, verdict: 'FAIL', reason: 'zero-token prefilter (title + location only): seniority above entry level' },
    { key: keyFor(urls.priority), score: 2.8, verdict: 'PASS', reason: 'Priority employer, override applied' },
  ]), 'utf-8');
  const recorded = loop('record', '--file', scoresFile);
  check('record lands the verdicts (a priority PASS at 2.8 qualifies)', recorded.json?.scored === 5 && recorded.json?.qualified === 2,
    `${recorded.json?.scored} scored / ${recorded.json?.qualified} qualified ${recorded.stderr.trim()}`);

  check('the inbox is untouched before finish', readFileSync(paths.pipeline, 'utf-8') === inbox);

  const fin = loop('finish');
  check('finish exits 0', fin.status === 0, fin.stderr.trim());
  check('finish reports what it did to the inbox',
    fin.json?.inbox?.discarded === 2 && fin.json?.inbox?.unreachable === 1 && fin.json?.inbox?.logged === 2, JSON.stringify(fin.json?.inbox));

  const after = readFileSync(paths.pipeline, 'utf-8');
  const lineFor = (u) => after.split('\n').find((l) => l.includes(u)) ?? '';
  check('a rejected row is ticked with the triage reason',
    /^- \[x\] /.test(lineFor(urls.junk)) && /full-time senior role, cannot run alongside the MSc/.test(lineFor(urls.junk)), lineFor(urls.junk));
  check('a zero-token prefilter rejection is ticked too, with its own reason',
    /^- \[x\] /.test(lineFor(urls.free)) && /seniority above entry level/.test(lineFor(urls.free)), lineFor(urls.free));
  check('an unreachable row is marked [!], not discarded',
    /^- \[!\] /.test(lineFor(urls.wall)) && /unreachable \(AWS WAF/.test(lineFor(urls.wall)), lineFor(urls.wall));
  check('a qualified row stays pending for evaluation', /^- \[ \] /.test(lineFor(urls.keep)));
  check('a priority-override PASS row stays pending for evaluation', /^- \[ \] /.test(lineFor(urls.priority)));
  check('a row the loop never saw is left alone', /^- \[ \] /.test(lineFor(urls.bystander)));
  check('nothing else in the inbox changed', after.split('\n').filter((l) => !l.includes(urls.junk) && !l.includes(urls.free) && !l.includes(urls.wall)).join('\n')
    === inbox.split('\n').filter((l) => !l.includes(urls.junk) && !l.includes(urls.free) && !l.includes(urls.wall)).join('\n'));

  const discardLog = existsSync(paths.discardLog) ? readFileSync(paths.discardLog, 'utf-8').trim().split('\n') : [];
  check('each discard is logged to data/discard.log as timestamp, url, reason',
    discardLog.length === 2 && discardLog.every((l) => l.split('\t').length === 3)
    && discardLog.some((l) => l.includes(urls.junk)) && discardLog.some((l) => l.includes(urls.free)), discardLog.join(' // '));
  check('the unreachable row is not written to the discard log', !discardLog.some((l) => l.includes(urls.wall)));

  // Idempotence: run finish's reconciliation a second time on the same state.
  const runAgain = loop('finish');
  check('a second finish exits 0', runAgain.status === 0, runAgain.stderr.trim());
  check('a second finish changes nothing in the inbox', readFileSync(paths.pipeline, 'utf-8') === after);
  check('a second finish reports zero marks and logs nothing',
    runAgain.json?.inbox?.discarded === 0 && runAgain.json?.inbox?.unreachable === 0
    && readFileSync(paths.discardLog, 'utf-8').trim().split('\n').length === 2, JSON.stringify(runAgain.json?.inbox));

  // A missing inbox must not undo a finish that already promoted its candidates.
  const box2 = mkdtempSync(join(tmpdir(), 'cops-finish-noinbox-'));
  mkdirSync(join(box2, 'data'), { recursive: true });
  const env2 = { ...env, CAREER_OPS_LOOP_STATE: paths.state, CAREER_OPS_PIPELINE_FILE: join(box2, 'data', 'nope.md'), CAREER_OPS_DISCARD_LOG: join(box2, 'data', 'discard.log') };
  const r2 = spawnSync(NODE, [join(ROOT, 'scan-loop.mjs'), 'finish'], { env: env2, encoding: 'utf-8' });
  let j2 = null; try { j2 = JSON.parse(r2.stdout); } catch { /* */ }
  check('finish with no inbox file still succeeds and says why it skipped the inbox',
    r2.status === 0 && j2?.inbox?.skipped === 'no inbox file', `${r2.status} ${r2.stderr.trim()} ${r2.stdout.slice(0, 200)}`);
} catch (err) {
  fail(`scan-loop finish/inbox suite crashed: ${err.message}`);
}
