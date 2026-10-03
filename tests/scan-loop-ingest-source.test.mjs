// tests/scan-loop-ingest-source.test.mjs — an agent-ingested offer's `source`
// (indeed, apify-linkedin, apify-xing, ...) survives `scan-loop.mjs ingest` and
// reaches run-retro.mjs, so those leads stop showing up as "(unattributed)".
//
// A scanner wave's postings are attributed through data/scan-history.tsv — its
// `portal` column carries the provider's `<id>-api` label, and run-retro joins
// discards, reports, kits and tracker status back to it by URL. `ingest` wrote
// only loop state, so every Indeed/Apify lead had no scan-history row and no
// source anywhere. It now keeps `source` on the loop candidate and records a
// scan-history row carrying it. An offer WITHOUT a source behaves exactly as
// before (no key on the candidate, no history row, still unattributed).
//
// Everything runs against temp files; nothing in the real repo is touched.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

console.log('\nscan-loop.mjs ingest — source attribution reaches run-retro');

const check = (desc, cond, details = '') => (cond ? pass(desc) : fail(`${desc}${details ? ` — ${details}` : ''}`));

try {
  const loopCore = await import(pathToFileURL(join(ROOT, 'loop-core.mjs')).href);
  const retro = await import(pathToFileURL(join(ROOT, 'run-retro.mjs')).href);

  // ── pure layer ────────────────────────────────────────────────────────────
  {
    const s = loopCore.newState(loopCore.DEFAULT_LOOP_CONFIG, '2026-10-01T00:00:00.000Z');
    loopCore.ingestOffers(s, [
      { url: 'https://a.example/1', source: 'apify-linkedin' },
      { url: 'https://b.example/2' },
      { url: 'https://c.example/3', source: '  ' },
      { url: 'https://d.example/4', source: 42 },
      { url: 'https://e.example/5', source: 'in\tdeed\nx' },
    ], 1);
    const cand = (u) => s.candidates[loopCore.candidateKey(u)];
    check('a source is kept on the candidate', cand('https://a.example/1').source === 'apify-linkedin');
    check('an offer without a source has no `source` key at all (backward compatible)', !('source' in cand('https://b.example/2')));
    check('a blank or non-string source counts as no source',
      !('source' in cand('https://c.example/3')) && !('source' in cand('https://d.example/4')));
    check('a source is flattened to one tab-free line so it can sit in scan-history\'s portal column',
      cand('https://e.example/5').source === 'in deed x', JSON.stringify(cand('https://e.example/5').source));
  }

  // ── end to end: a real `ingest` against temp files ────────────────────────
  const box = mkdtempSync(join(tmpdir(), 'cops-ingest-source-'));
  const p = {
    state: join(box, 'data', 'loop-state.json'), shortlist: join(box, 'data', 'loop-shortlist.md'),
    runLog: join(box, 'data', 'loop-run-log.md'), pipeline: join(box, 'data', 'pipeline.md'),
    discardLog: join(box, 'data', 'discard.log'), scanHistory: join(box, 'data', 'scan-history.tsv'),
    profile: join(box, 'config', 'profile.yml'), tracker: join(box, 'data', 'applications.md'),
    additions: join(box, 'batch', 'tracker-additions'), reports: join(box, 'reports'),
  };
  for (const d of ['data', 'config', join('batch', 'tracker-additions'), 'reports']) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(p.profile, 'loop:\n  target: 5\n  min_score: 3.8\n  score_batch: 12\n', 'utf-8');
  const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
  const KNOWN = 'https://boards.greenhouse.io/known/jobs/9';
  writeFileSync(p.scanHistory, `${HISTORY_HEADER}\n${KNOWN}\t2026-09-30\tgreenhouse-api\tKnown\tKnown Co\tadded\tBerlin\t\t\t\t\tknownco\n`, 'utf-8');

  const env = {
    ...process.env,
    CAREER_OPS_LOOP_STATE: p.state, CAREER_OPS_LOOP_SHORTLIST: p.shortlist, CAREER_OPS_LOOP_RUN_LOG: p.runLog,
    CAREER_OPS_PIPELINE_FILE: p.pipeline, CAREER_OPS_DISCARD_LOG: p.discardLog, CAREER_OPS_PROFILE: p.profile,
    CAREER_OPS_TRACKER: p.tracker, CAREER_OPS_ADDITIONS: p.additions, CAREER_OPS_REPORTS_DIR: p.reports,
    CAREER_OPS_SCAN_HISTORY: p.scanHistory,
  };
  const loop = (...args) => {
    const r = spawnSync(NODE, [join(ROOT, 'scan-loop.mjs'), ...args], { env, encoding: 'utf-8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stderr: r.stderr ?? '', json };
  };

  const offers = [
    { url: 'https://to.indeed.com/aamflg7vhdvk', company: 'Siemens', title: 'Working Student', location: 'Erlangen', source: 'indeed', postedAt: '2026-09-28' },
    { url: 'https://www.xing.com/jobs/erlangen-analyst-123', company: 'Beta', title: 'Analyst', location: 'Erlangen', source: 'apify-xing' },
    { url: 'https://example.org/jobs/plain', company: 'Gamma', title: 'Engineer', location: 'Munich' },
    { url: KNOWN, company: 'Known Co', title: 'Known', location: 'Berlin', source: 'apify-hiringcafe' },
  ];
  const offersFile = join(box, 'offers.json');
  writeFileSync(offersFile, JSON.stringify(offers), 'utf-8');
  check('start succeeds', loop('start').status === 0);
  const ingested = loop('ingest', '--file', offersFile);
  check('ingest succeeds and adds all four offers', ingested.status === 0 && ingested.json?.added === 4, ingested.stderr.trim());
  check('ingest says how many offers it recorded a source for (the two new ones carrying one; the third is already in scan-history)', ingested.json?.sourced === 2, JSON.stringify(ingested.json));

  const state = JSON.parse(readFileSync(p.state, 'utf-8'));
  const cand = (u) => Object.values(state.candidates).find((c) => c.url === u);
  check('the source is on the loop candidate', cand(offers[0].url).source === 'indeed' && cand(offers[1].url).source === 'apify-xing');
  check('an offer with no source has no source on its candidate', !('source' in cand(offers[2].url)));

  const historyLines = readFileSync(p.scanHistory, 'utf-8').split('\n').filter((l) => l.startsWith('http'));
  const rowFor = (u) => historyLines.filter((l) => l.startsWith(u));
  check('each sourced offer gets a scan-history row whose portal column is that source',
    rowFor(offers[0].url)[0]?.split('\t')[2] === 'indeed' && rowFor(offers[1].url)[0]?.split('\t')[2] === 'apify-xing',
    historyLines.join(' // '));
  check('the row carries the title, company, location, status `added` and the posted date',
    (() => { const c = rowFor(offers[0].url)[0].split('\t'); return c[3] === 'Working Student' && c[4] === 'Siemens' && c[5] === 'added' && c[6] === 'Erlangen' && c[8] === '2026-09-28'; })(),
    rowFor(offers[0].url)[0]);
  check('an offer with no source gets no scan-history row (stays unattributed, as before)', rowFor(offers[2].url).length === 0);
  check('a URL scan-history already holds is not recorded twice (the first row stays authoritative)',
    rowFor(KNOWN).length === 1 && rowFor(KNOWN)[0].split('\t')[2] === 'greenhouse-api', rowFor(KNOWN).join(' // '));
  check('the run log notes how many sources were recorded', /ingest · .*new=4 sourced=2/.test(readFileSync(p.runLog, 'utf-8')));

  // Re-ingesting the same offers adds nothing and writes nothing more.
  const before = readFileSync(p.scanHistory, 'utf-8');
  const again = loop('ingest', '--file', offersFile);
  check('a second ingest of the same offers records no further scan-history rows',
    again.json?.added === 0 && !('sourced' in again.json) && readFileSync(p.scanHistory, 'utf-8') === before, JSON.stringify(again.json));

  // Wave timing: an ingest only knows when the wave ENDED. Without --started the
  // duration is unknown (null start), never a fabricated ~1 ms.
  {
    const waves = JSON.parse(readFileSync(p.state, 'utf-8')).waves;
    check('an ingest without --started records no start time (duration unknown, not ~0)',
      waves[0].started_at === null && typeof waves[0].finished_at === 'string', JSON.stringify(waves[0]));
    check('the ingest log line leads with the strategy, so run-retro can name the wave',
      /ingest · wave=1 · .*· (portals|manual|[a-z-]+) wave=1 found=4 new=4/.test(readFileSync(p.runLog, 'utf-8')),
      readFileSync(p.runLog, 'utf-8').split('\n').find((l) => l.includes('ingest')));
    const timed = loop('ingest', '--file', offersFile, '--started', '2026-10-03T07:00:00.000Z');
    const last = JSON.parse(readFileSync(p.state, 'utf-8')).waves.at(-1);
    check('ingest --started <iso> records the real start', timed.status === 0 && last.started_at === '2026-10-03T07:00:00.000Z', JSON.stringify(last));
    const bad = loop('ingest', '--file', offersFile, '--started', 'yesterday');
    check('ingest --started with a non-date is refused, not silently dropped', bad.status !== 0 && /--started must be an ISO timestamp/.test(bad.stderr), bad.stderr.trim());
  }

  // ── run-retro attributes them ──────────────────────────────────────────────
  const scanHistoryRows = retro.parseTsv(readFileSync(p.scanHistory, 'utf-8'));
  const t = (ms) => new Date(Date.parse(state.run_id) + ms).toISOString();
  const runLogText = [
    `- ${t(-3600_000)} · run-20261001T000000 · start · stage=scan · skip=[] kitThreshold=3.7`,
    `- ${t(3600_000)} · run-20261001T000000 · stage-complete · stage=pipeline · scan — scan loop finished`,
    `- ${t(7200_000)} · run-20261001T000000 · sync · stage=done · ok=true steps=merge-tracker:ok`,
  ].join('\n');
  const window = retro.computePassWindow(retro.parseRunLogText(runLogText), 'run-20261001T000000');
  const build = (loopState, rows) => retro.buildPassRetro({
    window, scanHistoryRows: rows, discardEntries: [], reportFiles: [], readReportText: () => '',
    pdfIndexRows: [], trackerRows: [], loopState, loopRunLogText: '',
  });
  // Candidates attributed to a source, whether the zero-token prefilter rejected them
  // (free_rejected) or they went to triage (llm_triaged) — one of the four offers is
  // prefiltered on title + location alone, which is irrelevant to attribution.
  const llm = (retroResult, source) => {
    const row = retroResult.sourceRows.find((r) => r.source === source);
    return row ? (row.llmTriaged ?? 0) + (row.freeRejected ?? 0) : undefined;
  };

  const attributed = build(state, scanHistoryRows);
  check('run-retro attributes the agent-ingested leads to their source (via scan-history)',
    llm(attributed, 'indeed') === 1 && llm(attributed, 'apify-xing') === 1, JSON.stringify(attributed.sourceRows.map((r) => [r.source, r.llmTriaged])));
  check('only the offer that never carried a source is left "(unattributed)"', llm(attributed, '(unattributed)') === 1);
  check('the candidate the scanner had already seen keeps the scanner\'s attribution, not the ingest label',
    llm(attributed, 'greenhouse-api') === 1 && llm(attributed, 'apify-hiringcafe') === undefined);

  // A loop state written by a run whose history rows are gone (or never written)
  // still attributes through the candidate's own `source`.
  const noHistory = build(state, []);
  check('with no scan-history row at all, the candidate\'s own source still attributes it',
    llm(noHistory, 'indeed') === 1 && llm(noHistory, 'apify-xing') === 1 && llm(noHistory, 'apify-hiringcafe') === 1
    && llm(noHistory, '(unattributed)') === 1, JSON.stringify(noHistory.sourceRows.map((r) => [r.source, r.llmTriaged])));

  // Backward compatibility: a loop state with no `source` fields anywhere.
  const legacy = JSON.parse(JSON.stringify(state));
  for (const c of Object.values(legacy.candidates)) delete c.source;
  const legacyRetro = build(legacy, []);
  check('a loop state with no source fields attributes nothing, exactly as before (all "(unattributed)")',
    llm(legacyRetro, '(unattributed)') === 4 && legacyRetro.sourceRows.length === 1, JSON.stringify(legacyRetro.sourceRows.map((r) => [r.source, r.llmTriaged])));

  // A resolved aggregator lead: `url` is now the employer's posting, `resolvedFrom` the
  // aggregator URL the scan-history row was written under.
  const resolved = JSON.parse(JSON.stringify(state));
  const siemens = Object.values(resolved.candidates).find((c) => c.company === 'Siemens');
  siemens.resolvedFrom = siemens.url;
  siemens.url = 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/524303';
  delete siemens.source;
  const resolvedRetro = build(resolved, scanHistoryRows);
  check('a lead resolved to the employer\'s posting is still attributed through the aggregator URL it arrived as',
    llm(resolvedRetro, 'indeed') === 1, JSON.stringify(resolvedRetro.sourceRows.map((r) => [r.source, r.llmTriaged])));

  check('the driver wrote nothing into the real repo while under test', !existsSync(join(ROOT, 'data', 'scan-history.tsv'))
    || !readFileSync(join(ROOT, 'data', 'scan-history.tsv'), 'utf-8').includes('aamflg7vhdvk'));
} catch (err) {
  fail(`scan-loop ingest/source suite crashed: ${err.message}\n${err.stack}`);
}
