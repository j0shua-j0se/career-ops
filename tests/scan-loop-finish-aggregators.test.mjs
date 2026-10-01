// tests/scan-loop-finish-aggregators.test.mjs — `scan-loop.mjs finish` resolves
// aggregator URLs before it writes anything, and reports the merge honestly.
//
// Observed on pass run-20261001T142311: an agent-ingested Siemens offer arrived
// as https://to.indeed.com/aamflg7vhdvk and qualified. `finish` wrote the tracker
// TSV, ran merge-tracker (which SKIPPED it: Siemens' own board is tracked in
// portals.yml, so an aggregator URL must be resolved first), saw exit code 0, filed
// the TSV under merged/ and told the user `trackerRows: 1, merged: true` — with no
// row 202 in data/applications.md. The qualifier had also been queued into
// data/pipeline.md still carrying the aggregator URL.
//
// Everything runs against temp files; `finish` runs in a CHILD process (scan-loop's
// path constants are read from the environment at import) through a harness that
// hands it a FAKE resolver, so no board is ever fetched. No network.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

console.log('\nscan-loop.mjs finish — aggregator resolution + honest merge report');

const check = (desc, cond, details = '') => (cond ? pass(desc) : fail(`${desc}${details ? ` — ${details}` : ''}`));

const loopCore = await import(pathToFileURL(join(ROOT, 'loop-core.mjs')).href);

const AGG = 'https://to.indeed.com/aamflg7vhdvk';
const SIEMENS = 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/524303';
const EMPLOYER_SITE = 'https://careers.beta.example/jobs/77';

// ── pure layer ──────────────────────────────────────────────────────────────
{
  const s = loopCore.newState({ ...loopCore.DEFAULT_LOOP_CONFIG, minScore: 3.8, target: 5 }, '2026-10-01T00:00:00.000Z');
  loopCore.ingestOffers(s, [
    { url: AGG, company: 'Siemens', title: 'Working Student', location: 'Erlangen' },
    { url: 'https://www.stepstone.de/stellenangebote--x--1.html', company: 'Beta', title: 'Analyst' },
    { url: 'https://boards.greenhouse.io/plain/jobs/1', company: 'Plain', title: 'Engineer' },
  ], 1);
  const k = (u) => loopCore.candidateKey(u);
  loopCore.recordScores(s, [AGG, 'https://www.stepstone.de/stellenangebote--x--1.html', 'https://boards.greenhouse.io/plain/jobs/1']
    .map((u) => ({ key: k(u), score: 4.2, verdict: 'PASS' })));

  const siemens = s.candidates[k(AGG)];
  siemens.resolvedFrom = AGG;
  siemens.url = SIEMENS;
  s.candidates[k('https://www.stepstone.de/stellenangebote--x--1.html')].aggregatorUnresolved = true;

  const rows = loopCore.inboxQualifierRows(s, '');
  const byCompany = Object.fromEntries(rows.map((r) => [r.company, r]));
  check('a resolved qualifier is queued under the employer URL, aggregator URL kept in the note',
    byCompany.Siemens.url === SIEMENS && byCompany.Siemens.note === `resolved from to.indeed.com lead: ${AGG}`, JSON.stringify(byCompany.Siemens));
  check('an unresolved aggregator qualifier is queued with the "aggregator-only, unresolved" note and its own URL',
    byCompany.Beta.url.includes('stepstone.de') && byCompany.Beta.note === 'aggregator-only, unresolved', JSON.stringify(byCompany.Beta));
  check('an ordinary qualifier carries no note', byCompany.Plain.note === undefined);

  const present = `## Pending\n- [ ] ${AGG} | Siemens | Working Student | Erlangen\n`;
  check('a resolved qualifier whose AGGREGATOR line is already in the inbox is not queued a second time',
    !loopCore.inboxQualifierRows(s, present).some((r) => r.company === 'Siemens'));
}

// ── end to end ──────────────────────────────────────────────────────────────

/**
 * A fresh temp workspace + the env that redirects every artifact `finish` and
 * merge-tracker touch into it. `portalsYml` is the user's portals.yml for the box.
 */
function makeBox(portalsYml) {
  const box = mkdtempSync(join(tmpdir(), 'cops-finish-agg-'));
  const p = {
    box,
    state: join(box, 'data', 'loop-state.json'), shortlist: join(box, 'data', 'loop-shortlist.md'),
    runLog: join(box, 'data', 'loop-run-log.md'), pipeline: join(box, 'data', 'pipeline.md'),
    discardLog: join(box, 'data', 'discard.log'), scanHistory: join(box, 'data', 'scan-history.tsv'),
    profile: join(box, 'config', 'profile.yml'), tracker: join(box, 'data', 'applications.md'),
    additions: join(box, 'batch', 'tracker-additions'), batchState: join(box, 'batch', 'batch-state.tsv'),
    reports: join(box, 'reports'), portals: join(box, 'portals.yml'),
  };
  for (const d of ['data', 'config', join('batch', 'tracker-additions'), 'reports']) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(p.profile, 'loop:\n  target: 5\n  min_score: 3.8\n  score_batch: 12\n', 'utf-8');
  writeFileSync(p.portals, portalsYml, 'utf-8');
  writeFileSync(p.tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|-----|', '',
  ].join('\n'), 'utf-8');
  const env = {
    ...process.env,
    CAREER_OPS_LOOP_STATE: p.state, CAREER_OPS_LOOP_SHORTLIST: p.shortlist, CAREER_OPS_LOOP_RUN_LOG: p.runLog,
    CAREER_OPS_PIPELINE_FILE: p.pipeline, CAREER_OPS_DISCARD_LOG: p.discardLog, CAREER_OPS_PROFILE: p.profile,
    CAREER_OPS_TRACKER: p.tracker, CAREER_OPS_ADDITIONS: p.additions, CAREER_OPS_BATCH_STATE: p.batchState,
    CAREER_OPS_REPORTS_DIR: p.reports, CAREER_OPS_PORTALS: p.portals, CAREER_OPS_SCAN_HISTORY: p.scanHistory,
  };
  // Runs the real cmdFinish with a fake resolver: CO_TEST_RESOLVE_MAP is
  // {company: employerUrl}; a company not in it does not resolve.
  const harness = join(box, 'finish-harness.mjs');
  writeFileSync(harness, [
    "import { pathToFileURL } from 'node:url';",
    "import { join } from 'node:path';",
    "const { cmdFinish } = await import(pathToFileURL(join(process.env.CO_TEST_REPO_ROOT, 'scan-loop.mjs')).href);",
    "const map = JSON.parse(process.env.CO_TEST_RESOLVE_MAP || '{}');",
    'const calls = [];',
    'const resolveFn = async (target, options) => {',
    '  calls.push({ company: target.company, urls: target.urls, probe: options?.probe });',
    '  const url = map[target.company];',
    "  return url ? { url, title: target.title, location: '', score: 1 } : null;",
    '};',
    'const out = await cmdFinish({}, { resolveFn });',
    'console.log(JSON.stringify({ out, calls }));',
  ].join('\n'), 'utf-8');
  const cli = (...args) => {
    const r = spawnSync(NODE, [join(ROOT, 'scan-loop.mjs'), ...args], { env, encoding: 'utf-8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stderr: r.stderr ?? '', json };
  };
  const finish = (resolveMap = {}) => {
    const r = spawnSync(NODE, [harness], {
      env: { ...env, CO_TEST_REPO_ROOT: ROOT, CO_TEST_RESOLVE_MAP: JSON.stringify(resolveMap) }, encoding: 'utf-8',
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stderr: r.stderr ?? '', out: json?.out ?? null, calls: json?.calls ?? [] };
  };
  /** start -> ingest -> record, every offer a PASS. */
  const qualify = (offers) => {
    cli('start');
    const file = join(box, 'offers.json');
    writeFileSync(file, JSON.stringify(offers), 'utf-8');
    cli('ingest', '--file', file);
    const state = JSON.parse(readFileSync(p.state, 'utf-8'));
    const scores = join(box, 'scores.json');
    writeFileSync(scores, JSON.stringify(Object.keys(state.candidates).map((key) => ({ key, score: 4.4, verdict: 'PASS', reason: 'fits' }))), 'utf-8');
    return cli('record', '--file', scores);
  };
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf-8') : '');
  const tsvs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tsv')) : []);
  return { p, cli, finish, qualify, read, tsvs };
}

const SIEMENS_PORTAL = 'tracked_companies:\n  - name: "Siemens"\n    provider: greenhouse\n    careers_url: https://boards.greenhouse.io/siemens\n';
const siemensOffer = { url: AGG, company: 'Siemens', title: 'Working Student Data', location: 'Erlangen', source: 'indeed' };

try {
  // ── 1. resolved before TSV and inbox ──────────────────────────────────────
  {
    const b = makeBox(SIEMENS_PORTAL);
    b.qualify([siemensOffer]);
    const r = b.finish({ Siemens: SIEMENS });
    check('resolved: finish exits cleanly', r.status === 0 && r.out, r.stderr.trim());
    check('resolved: the resolver was asked once, for the aggregator URL, with probing OFF',
      r.calls.length === 1 && r.calls[0].company === 'Siemens' && r.calls[0].urls[0] === AGG && r.calls[0].probe === false, JSON.stringify(r.calls));
    check('resolved: the row really landed — trackerRows 1, nothing skipped, merged',
      r.out?.trackerRows === 1 && r.out?.trackerSkipped.length === 0 && r.out?.merged === true && r.out?.mergeStatus === 'complete', JSON.stringify(r.out));
    check('resolved: finish reports the resolution', r.out?.aggregators?.resolved === 1 && r.out?.aggregators?.unresolved === 0);
    const tracker = b.read(b.p.tracker);
    const siemensRow = tracker.split('\n').find((l) => l.includes('Siemens')) ?? '';
    const urlCell = siemensRow.split('|').map((c) => c.trim()).filter(Boolean).pop();
    check('resolved: the tracker row\'s URL column is the EMPLOYER posting, never the aggregator one',
      urlCell === SIEMENS, siemensRow);
    check('resolved: the aggregator URL survives only as provenance in the notes',
      /resolved from to\.indeed\.com lead: https:\/\/to\.indeed\.com\/aamflg7vhdvk/.test(siemensRow), siemensRow);
    check('resolved: the TSV was merged and archived', b.tsvs(b.p.additions).length === 0 && b.tsvs(join(b.p.additions, 'merged')).length === 1);
    const inbox = b.read(b.p.pipeline);
    const line = inbox.split('\n').find((l) => l.includes('Siemens')) ?? '';
    check('resolved: the inbox line is the employer posting, aggregator URL in note:',
      line.startsWith(`- [ ] ${SIEMENS} | Siemens | Working Student Data`) && line.includes(`note: resolved from to.indeed.com lead: ${AGG}`), line);
    check('resolved: the aggregator URL is not an inbox line of its own', !inbox.split('\n').some((l) => l.startsWith(`- [ ] ${AGG}`)));
    const history = b.read(b.p.scanHistory).split('\n').filter((l) => l.startsWith('https://'));
    check('resolved: the employer URL is attributed to the same source as the lead it came from',
      history.some((l) => l.startsWith(SIEMENS) && l.split('\t')[2] === 'indeed'), history.join(' // '));
    check('resolved: the run log records the merge result and the resolution',
      /trackerRows=1 merged=true mergeStatus=complete aggregators=resolved:1,unresolved:0/.test(b.read(b.p.runLog)), b.read(b.p.runLog));
  }

  // ── 2. unresolvable, board tracked: merge skips it, finish says so ────────
  {
    const b = makeBox(SIEMENS_PORTAL);
    b.qualify([siemensOffer]);
    const r = b.finish({});
    check('unresolved: finish still exits 0 (the loop already promoted the candidate)', r.status === 0 && r.out, r.stderr.trim());
    check('unresolved: trackerRows is 0 — no row was written, so none is claimed', r.out?.trackerRows === 0, JSON.stringify(r.out));
    check('unresolved: the skipped TSV is listed with merge-tracker\'s reason',
      r.out?.trackerSkipped.length === 1 && /^\d+-siemens\.tsv$/.test(r.out.trackerSkipped[0].tsv)
      && /to\.indeed\.com aggregator listing for "Siemens"/.test(r.out.trackerSkipped[0].reason), JSON.stringify(r.out?.trackerSkipped));
    check('unresolved: merged is false and the status says nothing landed',
      r.out?.merged === false && r.out?.mergeStatus === 'failed', `${r.out?.merged} ${r.out?.mergeStatus}`);
    check('unresolved: the TSV stays in batch/tracker-additions, NOT in merged/',
      b.tsvs(b.p.additions).length === 1 && b.tsvs(join(b.p.additions, 'merged')).length === 0);
    check('unresolved: the tracker has no Siemens row', !/Siemens/.test(b.read(b.p.tracker)));
    const line = b.read(b.p.pipeline).split('\n').find((l) => l.includes('Siemens')) ?? '';
    check('unresolved: it is still queued in the inbox, aggregator URL kept, flagged as needing resolution',
      line.startsWith(`- [ ] ${AGG} | Siemens | Working Student Data`) && line.includes('note: aggregator-only, unresolved'), line);
    check('unresolved: the run log names the skipped TSV and why',
      /merged=false mergeStatus=failed/.test(b.read(b.p.runLog)) && /trackerSkipped=1: \d+-siemens\.tsv \(URL is a to\.indeed\.com aggregator listing/.test(b.read(b.p.runLog)), b.read(b.p.runLog));
    check('unresolved: stderr tells the human the TSV was not merged', /1 of 1 tracker TSV\(s\) were NOT merged/.test(r.stderr), r.stderr);

    // Resolution later picks the TSV up: a second finish with a resolver that now
    // finds the posting merges it and rewrites the SAME inbox line in place.
    const again = b.finish({ Siemens: SIEMENS });
    check('later resolution: a second finish merges the left-behind TSV',
      again.out?.trackerRows === 1 && again.out?.trackerSkipped.length === 0 && again.out?.merged === true, JSON.stringify(again.out));
    check('later resolution: the tracker now has the Siemens row on the employer URL',
      b.read(b.p.tracker).split('\n').some((l) => l.includes('Siemens') && l.includes(SIEMENS)));
    const lines = b.read(b.p.pipeline).split('\n').filter((l) => l.includes('Siemens'));
    check('later resolution: the inbox line was rewritten in place, not duplicated',
      lines.length === 1 && lines[0].startsWith(`- [ ] ${SIEMENS} |`) && lines[0].includes(`resolved from to.indeed.com lead: ${AGG}`) && !lines[0].includes('aggregator-only'), lines.join(' // '));
    check('later resolution: the reported queue/rewrite counts say so', again.out?.inbox?.aggregatorRewritten === 1, JSON.stringify(again.out?.inbox));
  }

  // ── 3. unresolved but the company has no tracked board: aggregator URL is allowed ──
  {
    const b = makeBox('tracked_companies: []\n');
    b.qualify([siemensOffer]);
    const r = b.finish({});
    check('no tracked board: merge-tracker accepts the aggregator URL, so the row is counted',
      r.out?.trackerRows === 1 && r.out?.trackerSkipped.length === 0 && r.out?.merged === true, JSON.stringify(r.out));
    const line = b.read(b.p.pipeline).split('\n').find((l) => l.includes('Siemens')) ?? '';
    check('no tracked board: the inbox line is still flagged aggregator-only, unresolved',
      line.startsWith(`- [ ] ${AGG} |`) && line.includes('note: aggregator-only, unresolved'), line);
  }

  // ── 4. mixed: one lands, one is skipped -> partial, counted per TSV ────────
  {
    const b = makeBox(SIEMENS_PORTAL);
    b.qualify([
      siemensOffer,
      { url: EMPLOYER_SITE, company: 'Beta', title: 'Analyst', location: 'Berlin' },
    ]);
    const r = b.finish({});
    check('mixed: trackerRows counts only the TSV that landed', r.out?.promoted === 2 && r.out?.trackerRows === 1, JSON.stringify(r.out));
    check('mixed: the skipped one is listed, so merged is false and the status is partial',
      r.out?.trackerSkipped.length === 1 && /siemens/.test(r.out.trackerSkipped[0].tsv) && r.out?.merged === false && r.out?.mergeStatus === 'partial',
      JSON.stringify(r.out));
    check('mixed: only the landed TSV was archived',
      b.tsvs(b.p.additions).length === 1 && /siemens/.test(b.tsvs(b.p.additions)[0]) && b.tsvs(join(b.p.additions, 'merged')).length === 1);
    check('mixed: the tracker holds the Beta row only', /Beta/.test(b.read(b.p.tracker)) && !/Siemens/.test(b.read(b.p.tracker)));
  }

  // ── 5. trackerRows counts a re-evaluated row as updated, still a real row ─
  {
    const b = makeBox('tracked_companies: []\n');
    b.qualify([{ url: EMPLOYER_SITE, company: 'Beta', title: 'Analyst', location: 'Berlin' }]);
    const first = b.finish({});
    const second = b.finish({});
    check('re-run: a second finish updates the existing row (counted once, not added twice)',
      first.out?.trackerRows === 1 && second.out?.trackerRows === 1
      && (b.read(b.p.tracker).match(/\| Beta \|/g) ?? []).length === 1, `${first.out?.trackerRows}/${second.out?.trackerRows}`);
  }
} catch (err) {
  fail(`scan-loop finish/aggregator suite crashed: ${err.message}`);
}
