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

  // ── pure layer: inboxQualifierRows ─────────────────────────────────────────
  // A qualifier that came in through `ingest` was never an inbox row, so `finish`
  // promoted it to the tracker as "full evaluation pending" while nothing queued
  // that evaluation (pass run-20260929T193517, tracker row #201).
  {
    const s = loopCore.newState({ ...loopCore.DEFAULT_LOOP_CONFIG, minScore: 3.8, target: 5 }, '2026-09-29T00:00:00.000Z');
    loopCore.ingestOffers(s, [
      { url: 'https://agent.example/jobs/1', company: 'Agent Co', title: 'Werkstudent Data', location: 'Nürnberg', postedAt: '2026-09-20' },
      { url: 'https://www.pending.example/jobs/2?utm_source=x', company: 'Pending Co', title: 'B' },
      { url: 'https://done.example/jobs/3', company: 'Done Co', title: 'C' },
      { url: 'https://wall.example/jobs/4', company: 'Wall Co', title: 'D' },
      { url: 'https://low.example/jobs/5', company: 'Low Co', title: 'E' },
    ], 2);
    const k = (u) => loopCore.candidateKey(u);
    loopCore.recordScores(s, [
      { key: k('https://agent.example/jobs/1'), score: 4.4, verdict: 'PASS' },
      { key: k('https://www.pending.example/jobs/2?utm_source=x'), score: 4.1, verdict: 'PASS' },
      { key: k('https://done.example/jobs/3'), score: 4.0, verdict: 'PASS' },
      { key: k('https://wall.example/jobs/4'), score: 4.0, verdict: 'PASS' },
      { key: k('https://low.example/jobs/5'), score: 2.0, verdict: 'FAIL' },
    ]);
    const md = [
      '## Pending', '- [ ] http://pending.example/jobs/2 | Pending Co | B | Berlin',
      '## Processed', '- [x] #12 | https://done.example/jobs/3 | Done Co | C | 4.0/5 | PDF ❌',
      '- [!] https://wall.example/jobs/4 | Wall Co | D | unreachable (WAF)', '',
    ].join('\n');
    const missing = loopCore.inboxQualifierRows(s, md);
    check('an ingested qualifier the inbox lacks is returned for queuing',
      missing.length === 1 && missing[0].url === 'https://agent.example/jobs/1' && missing[0].company === 'Agent Co', JSON.stringify(missing));
    check('its posted date rides along as epoch ms for the scanner line format',
      missing[0]?.postedAt === Date.parse('2026-09-20'), String(missing[0]?.postedAt));
    check('a qualifier already pending (under a different URL spelling) is not queued twice',
      !missing.some((r) => r.url.includes('pending.example')));
    check('a qualifier whose line is already processed - [x] is not resurrected',
      !missing.some((r) => r.url.includes('done.example')));
    check('a qualifier already marked - [!] is not re-queued either', !missing.some((r) => r.url.includes('wall.example')));
    check('a rejected candidate is never queued', !missing.some((r) => r.url.includes('low.example')));
    check('with an absent inbox every qualifier is queued',
      loopCore.inboxQualifierRows(s, '').length === 4);
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
  check('finish with no inbox file queues its qualifiers into a fresh one',
    j2?.inbox?.queued === 2 && existsSync(join(box2, 'data', 'nope.md'))
    && /^- \[ \] .*\/acme\/jobs\/1 \| keep \| Engineer \| Berlin$/m.test(readFileSync(join(box2, 'data', 'nope.md'), 'utf-8')),
    existsSync(join(box2, 'data', 'nope.md')) ? readFileSync(join(box2, 'data', 'nope.md'), 'utf-8') : 'no file');

  // ── ingest-sourced qualifiers reach the inbox ──────────────────────────────
  // Same shape as the 2026-09-29 pass: an agent-sourced offer arrives through
  // `ingest`, is triaged PASS, and `finish` must leave a PENDING inbox line for it
  // so the pipeline stage evaluates it — without duplicating a row that is already
  // there or resurrecting one already processed.
  const box3 = mkdtempSync(join(tmpdir(), 'cops-finish-queue-'));
  const p3 = {
    state: join(box3, 'data', 'loop-state.json'), shortlist: join(box3, 'data', 'loop-shortlist.md'),
    runLog: join(box3, 'data', 'loop-run-log.md'), pipeline: join(box3, 'data', 'pipeline.md'),
    discardLog: join(box3, 'data', 'discard.log'), profile: join(box3, 'config', 'profile.yml'),
    tracker: join(box3, 'data', 'applications.md'), additions: join(box3, 'batch', 'tracker-additions'),
    batchState: join(box3, 'batch', 'batch-state.tsv'), reports: join(box3, 'reports'),
  };
  for (const d of ['data', 'config', join('batch', 'tracker-additions'), 'reports']) mkdirSync(join(box3, d), { recursive: true });
  writeFileSync(p3.profile, 'loop:\n  target: 1\n  min_score: 3.8\n  score_batch: 12\n', 'utf-8');
  writeFileSync(p3.tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|', '',
  ].join('\n'), 'utf-8');
  const u3 = {
    agent: 'https://apply.example.com/indeed/4711',
    pending: 'https://boards.greenhouse.io/pending/jobs/2',
    done: 'https://boards.greenhouse.io/done/jobs/3',
  };
  const inbox3 = [
    '# Pipeline', '', '## Pending',
    `- [ ] ${u3.pending} | pending | Engineer | Berlin`,
    '', '## Processed',
    `- [x] #12 | ${u3.done} | done | Engineer | 4.0/5 | PDF ❌`, '',
  ].join('\n');
  writeFileSync(p3.pipeline, inbox3, 'utf-8');
  const env3 = {
    ...process.env,
    CAREER_OPS_LOOP_STATE: p3.state, CAREER_OPS_LOOP_SHORTLIST: p3.shortlist, CAREER_OPS_LOOP_RUN_LOG: p3.runLog,
    CAREER_OPS_PIPELINE_FILE: p3.pipeline, CAREER_OPS_DISCARD_LOG: p3.discardLog, CAREER_OPS_PROFILE: p3.profile,
    CAREER_OPS_TRACKER: p3.tracker, CAREER_OPS_ADDITIONS: p3.additions, CAREER_OPS_BATCH_STATE: p3.batchState,
    CAREER_OPS_REPORTS_DIR: p3.reports,
  };
  const loop3 = (...args) => {
    const r = spawnSync(NODE, [join(ROOT, 'scan-loop.mjs'), ...args], { env: env3, encoding: 'utf-8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stderr: r.stderr ?? '', json };
  };
  const offers3 = join(box3, 'offers.json');
  writeFileSync(offers3, JSON.stringify([
    { url: u3.agent, company: 'Agent Co', title: 'Werkstudent Data | Analytics', location: 'Nürnberg', postedAt: '2026-09-20' },
    { url: u3.pending, company: 'pending', title: 'Engineer', location: 'Berlin' },
    { url: u3.done, company: 'done', title: 'Engineer', location: 'Berlin' },
  ]), 'utf-8');
  check('queue suite: start succeeds', loop3('start').status === 0);
  check('queue suite: ingest adds the three offers', loop3('ingest', '--file', offers3).json?.added === 3);
  const state3 = JSON.parse(readFileSync(p3.state, 'utf-8'));
  writeFileSync(join(box3, 'scores.json'), JSON.stringify(Object.keys(state3.candidates).map((key) => (
    { key, score: 4.5, verdict: 'PASS', reason: 'fits' }))), 'utf-8');
  check('queue suite: all three qualify', loop3('record', '--file', join(box3, 'scores.json')).json?.qualified === 3);

  const fin3 = loop3('finish');
  check('queue suite: finish exits 0 and reports one queued row',
    fin3.status === 0 && fin3.json?.inbox?.queued === 1, `${fin3.status} ${fin3.stderr.trim()} ${JSON.stringify(fin3.json?.inbox)}`);
  const after3 = readFileSync(p3.pipeline, 'utf-8');
  const count3 = (needle) => after3.split('\n').filter((l) => l.includes(needle)).length;
  const agentLine = after3.split('\n').find((l) => l.includes(u3.agent)) ?? '';
  check('the ingested qualifier is a pending line in the shape scan.mjs writes',
    agentLine === `- [ ] ${u3.agent} | Agent Co | Werkstudent Data / Analytics | Nürnberg | posted: 2026-09-20`, agentLine);
  check('it sits in the Pending section, above Processed', after3.indexOf(u3.agent) < after3.indexOf('## Processed'));
  check('an already-pending qualifier is not duplicated', count3(u3.pending) === 1);
  check('an already-processed - [x] qualifier is not resurrected',
    count3(u3.done) === 1 && /^- \[x\] #12 \| /m.test(after3), after3);
  const prefilter3 = await import(pathToFileURL(join(ROOT, 'triage-prefilter.mjs')).href);
  check('parsePipeline sees the ingested qualifier as pending',
    prefilter3.parsePipeline(after3).pending.some((e) => e.url === u3.agent));
  const again3 = loop3('finish');
  check('a second finish queues nothing and leaves the inbox byte-identical',
    again3.status === 0 && again3.json?.inbox?.queued === 0 && readFileSync(p3.pipeline, 'utf-8') === after3, JSON.stringify(again3.json?.inbox));
} catch (err) {
  fail(`scan-loop finish/inbox suite crashed: ${err.message}`);
}
