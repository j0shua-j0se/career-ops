// tests/run-retro.test.mjs — zero-token post-pass review (run-retro.mjs).
//
// Covers: source attribution by normalized URL, pass-window filtering,
// idempotent re-run (same run_id replaces rather than duplicates), graceful
// degradation when a data file is missing/partial (the metric is OMITTED,
// never coerced to 0), and that the sync step is wired into run-all.mjs as
// non-fatal, right after verify-pipeline and before the dashboard.
//
// Style follows analyze-patterns-outcomes.test.mjs: pure functions imported
// directly, plus one end-to-end run over a fixture data root via
// CAREER_OPS_ROOT (mirroring how other tests redirect data — see
// tests/scan-data-paths-under-data-root.test.mjs / tests/portal-health-path.test.mjs).
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nrun-retro — zero-token post-pass review');

const mod = await import(pathToFileURL(join(ROOT, 'run-retro.mjs')).href);
const {
  parseRunLogText, listRecoverableRunIds, computePassWindow,
  parseLoopRunLogText, findLoopRunId, computeLoopWavesFromLog,
  parseTsv, parsePdfIndexTsv, buildScanHistoryIndex, sourceScanCounts, kitsInWindow,
  parseReportFilenames, parseReportHeader, reportsInWindow,
  attributeSource, buildPassRetro, renderPassRetroRows, mergeRetroTsv,
  renderSummary, RETRO_TSV_COLUMNS, buildPassRetroForRoot,
} = mod;

const check = (label, cond) => (cond ? pass(label) : fail(label));

// ── parseRunLogText / computePassWindow ──────────────────────────────────

const RUN_LOG_FIXTURE = [
  '# End-to-end run log', '', 'Append-only.', '',
  '- 2026-09-15T11:34:12.374Z · run-20260915T113412 · start · stage=scan · skip=[] kitThreshold=3.7',
  '- 2026-09-16T03:08:20.150Z · run-20260915T113412 · stage-complete · stage=pipeline · scan — scan loop finished with 1 qualified posting(s)',
  '- 2026-09-16T03:34:57.756Z · run-20260915T113412 · stage-complete · stage=kits · pipeline — the URL inbox is empty',
  '- 2026-09-16T03:58:18.844Z · run-20260915T113412 · sync · stage=kits · ok=true steps=merge-tracker:ok',
  '- 2026-09-16T03:58:38.355Z · run-20260915T113412 · stage-complete · stage=sync · kits — no tracker row is at or above 3.7 without a PDF',
  '- 2026-09-16T03:58:46.007Z · run-20260915T113412 · sync · stage=done · ok=true steps=merge-tracker:ok',
  '- 2026-09-16T04:10:00.000Z · run-20260915T113412 · sync · stage=done · ok=true steps=merge-tracker:ok',
  '- 2026-08-15T03:16:11.889Z · run-20260815T031611 · start · stage=scan · skip=[] kitThreshold=3.8',
  '- 2026-08-15T03:16:25.518Z · run-20260815T031611 · abort · stage=scan · user cancelled the pass mid-scan',
].join('\n');

const runLogEntries = parseRunLogText(RUN_LOG_FIXTURE);
check('parseRunLogText parses every well-formed line', runLogEntries.length === 9);
check('listRecoverableRunIds finds both passes, in order', JSON.stringify(listRecoverableRunIds(runLogEntries)) === JSON.stringify(['run-20260915T113412', 'run-20260815T031611']));

const window = computePassWindow(runLogEntries, 'run-20260915T113412');
check('computePassWindow recovers the start time', window.startTime.toISOString() === '2026-09-15T11:34:12.374Z');
check('computePassWindow marks the pass completed at the FIRST stage=done line', window.completed === true && window.endTime.toISOString() === '2026-09-16T03:58:46.007Z');
check('a repeated stage=done line after completion does not re-extend the window', window.endTime.toISOString() !== '2026-09-16T04:10:00.000Z');
check('stage durations are recovered for all four stages', Object.keys(window.stageWindows).sort().join(',') === 'kits,pipeline,scan,sync');
check('scan duration runs from start to the pipeline stage-complete line', window.stageWindows.scan.ms === new Date('2026-09-16T03:08:20.150Z') - new Date('2026-09-15T11:34:12.374Z'));
check('the mid-pass non-advancing sync line does not shorten the kits stage', window.stageWindows.kits.ms === new Date('2026-09-16T03:58:38.355Z') - new Date('2026-09-16T03:34:57.756Z'));

const abortedWindow = computePassWindow(runLogEntries, 'run-20260815T031611');
check('an aborted pass is marked aborted, not completed, and carries the halted reason', abortedWindow.aborted === true && abortedWindow.completed === false && abortedWindow.haltedReason === 'user cancelled the pass mid-scan');

check('computePassWindow returns null for a run_id with no start line', computePassWindow(runLogEntries, 'run-nonexistent') === null);

// ── parseLoopRunLogText / findLoopRunId / computeLoopWavesFromLog ────────

const LOOP_LOG_FIXTURE = [
  '- 2026-09-15T11:34:17.878Z · 2026-09-15T11:34:17.878Z · start · wave=0 · discovered=0 · scored=0 · qualified=0/10 · target=10 minScore=3.7',
  '- 2026-09-15T11:37:50.909Z · 2026-09-15T11:34:17.878Z · wave · wave=1 · discovered=39 · scored=2 · qualified=0/10 · portals exit=0 found=39 new=39',
  '- 2026-09-15T11:44:43.583Z · 2026-09-15T11:34:17.878Z · score · wave=1 · discovered=39 · scored=39 · qualified=1/10 · scored=37 qualified=1',
  '- 2026-09-15T11:46:10.874Z · 2026-09-15T11:34:17.878Z · wave · wave=2 · discovered=45 · scored=40 · qualified=1/10 · interamt exit=0 found=6 new=6',
  '- 2026-09-15T11:49:08.030Z · 2026-09-15T11:34:17.878Z · score · wave=2 · discovered=45 · scored=45 · qualified=1/10 · scored=5 qualified=0',
  '- 2026-09-16T03:07:41.314Z · 2026-09-15T11:34:17.878Z · finish · wave=2 · discovered=45 · scored=45 · qualified=1/10 · promoted=1 tsv=1 merged=true',
].join('\n');

const loopEntries = parseLoopRunLogText(LOOP_LOG_FIXTURE);
check('parseLoopRunLogText parses every wave line', loopEntries.length === 6);

const scanWindow = { startTime: new Date('2026-09-15T11:34:00.000Z'), endTime: new Date('2026-09-16T04:00:00.000Z'), stageWindows: { scan: { end: new Date('2026-09-16T03:08:20.150Z') } } };
const loopRunId = findLoopRunId(loopEntries, scanWindow);
check('findLoopRunId matches the loop start line inside the scan-stage window', loopRunId === '2026-09-15T11:34:17.878Z');
check('findLoopRunId returns null when no loop start falls in the window', findLoopRunId(loopEntries, { startTime: new Date('2020-01-01'), endTime: new Date('2020-01-02'), stageWindows: {} }) === null);

const waveInfo = computeLoopWavesFromLog(loopEntries, loopRunId);
check('computeLoopWavesFromLog recovers minScore/target from the start line', waveInfo.minScore === 3.7 && waveInfo.target === 10);
check('computeLoopWavesFromLog recovers strategy + found + new per wave', waveInfo.waves.length === 2
  && waveInfo.waves[0].strategy === 'portals' && waveInfo.waves[0].found === 39 && waveInfo.waves[0].new === 39
  && waveInfo.waves[1].strategy === 'interamt' && waveInfo.waves[1].found === 6 && waveInfo.waves[1].new === 6);
check('each wave gets a positive duration', waveInfo.waves.every((w) => w.durationMs > 0));

// Older-style log: 'ingest' with no leading strategy word ("wave=1 found=3 new=3").
const OLD_STYLE_LOOP_LOG = [
  '- 2026-08-31T21:46:10.779Z · 2026-08-31T21:46:10.775Z · start · wave=0 · discovered=0 · scored=0 · qualified=0/5 · target=5 minScore=3.5',
  '- 2026-08-31T21:46:11.059Z · 2026-08-31T21:46:10.775Z · ingest · wave=1 · discovered=3 · scored=0 · qualified=0/5 · wave=1 found=3 new=3',
  '- 2026-08-31T21:46:35.755Z · 2026-08-31T21:46:10.775Z · score · wave=1 · discovered=3 · scored=3 · qualified=3/5 · scored=3 qualified=3',
].join('\n');
const oldWaves = computeLoopWavesFromLog(parseLoopRunLogText(OLD_STYLE_LOOP_LOG), '2026-08-31T21:46:10.775Z');
check('an old-style ingest line with no strategy word does not fabricate one', oldWaves.waves.length === 1 && oldWaves.waves[0].strategy === 'wave1' && oldWaves.waves[0].found === 3 && oldWaves.waves[0].new === 3);

// ── scan-history.tsv / source attribution ─────────────────────────────────

const SCAN_HISTORY_FIXTURE = [
  'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company',
  'https://boards.greenhouse.io/co/jobs/1?utm_source=x\t2026-09-15\tgreenhouse-api\tSWE\tCo\tadded\tBerlin\t\t\t\t\tco',
  'https://boards.greenhouse.io/co/jobs/2\t2026-09-15\tgreenhouse-api\tSWE 2\tCo\tskipped_title\tBerlin\t\t\t\t\tco',
  'https://www.interamt.de/jobs/3\t2026-09-15\tinteramt\tSachbearbeiter\tGov\tadded\tMunich\t\t\t\t\tgov',
  'https://www.interamt.de/jobs/4\t2026-09-16\tinteramt\tSachbearbeiter 2\tGov\tskipped_location\tMunich\t\t\t\t\tgov',
  'https://stale.example.com/job\t2026-08-01\tancient-api\tOld\tOld Co\tadded\tBerlin\t\t\t\t\toldco',
].join('\n');
const scanHistoryRows = parseTsv(SCAN_HISTORY_FIXTURE);
check('parseTsv reads every data row', scanHistoryRows.length === 5);
check('parseTsv is header-driven (fields addressable by name)', scanHistoryRows[0].portal === 'greenhouse-api' && scanHistoryRows[0].status === 'added');

const passWindow2Days = { startTime: new Date('2026-09-15T00:00:00.000Z'), endTime: new Date('2026-09-16T23:59:59.000Z') };
const counts = sourceScanCounts(scanHistoryRows, passWindow2Days);
check('sourceScanCounts buckets found/new per portal within the window', counts.get('greenhouse-api').found === 2 && counts.get('greenhouse-api').new === 1);
check('sourceScanCounts excludes a row first-seen before the window', !counts.has('ancient-api'));
check('sourceScanCounts counts a skipped row toward found but not new', counts.get('interamt').found === 2 && counts.get('interamt').new === 1);

const historyIndex = buildScanHistoryIndex(scanHistoryRows);
check('attributeSource resolves a tracking-param URL to its portal via normalizeUrl', attributeSource('https://boards.greenhouse.io/co/jobs/1?utm_source=y', historyIndex) === 'greenhouse-api');
check('attributeSource returns null for a URL scan-history never saw', attributeSource('https://unknown.example.com/x', historyIndex) === null);
check('attributeSource returns null for an unusable URL (no key)', attributeSource('N/A', historyIndex) === null);

// ── reports/ + pdf-index.tsv windowing ────────────────────────────────────

const reportFilenames = ['192-atruvia-2026-09-16.md', '183-siemens-2026-09-13.md', 'scan-digests', 'not-a-report.txt'];
const reportFiles = parseReportFilenames(reportFilenames);
check('parseReportFilenames only matches the report naming convention', reportFiles.length === 2);
const inWindow = reportsInWindow(reportFiles, passWindow2Days);
check('reportsInWindow keeps only reports dated inside the window', inWindow.length === 1 && inWindow[0].reportNum === '192');

const header = parseReportHeader('# Evaluation\n\n**Date:** 2026-09-16\n**URL:** https://example.com/job\n**Via:** —\n**Score:** 3.9/5\n');
check('parseReportHeader extracts the URL and score fields', header.url === 'https://example.com/job' && header.score === 3.9);
check('parseReportHeader tolerates a report with neither field', parseReportHeader('no header here').url === null);

const PDF_INDEX_FIXTURE = [
  '# report\tpdf\thtml\tformat\tdate — comment',
  '192\toutput/atruvia-cv.pdf\toutput/atruvia-cv.html\ta4\t2026-09-16',
  '192\toutput/atruvia-cover.pdf\t\ta4\t2026-09-16',
  '009\toutput/old.pdf\t\ta4\t2026-08-06',
].join('\n');
const pdfRows = parsePdfIndexTsv(PDF_INDEX_FIXTURE);
const windowKits = kitsInWindow(pdfRows, passWindow2Days);
check('kitsInWindow collapses the CV+cover pair into ONE kit per report number', windowKits.size === 1 && windowKits.get('192').rowCount === 2);
check('kitsInWindow excludes a pdf-index row dated outside the window', !windowKits.has('009'));

// ── idempotent TSV merge ──────────────────────────────────────────────────

const firstRun = mergeRetroTsv('', 'run-A', ['run-A\tsource\tgreenhouse-api\t2\t1']);
check('mergeRetroTsv writes the header on the first call', firstRun.split('\n')[0] === RETRO_TSV_COLUMNS.join('\t'));
check('mergeRetroTsv appends the new rows', firstRun.includes('run-A\tsource\tgreenhouse-api\t2\t1'));

const secondPass = mergeRetroTsv(firstRun, 'run-B', ['run-B\tsource\tinteramt\t6\t0']);
check('mergeRetroTsv keeps rows from an earlier, different run_id', secondPass.includes('run-A\tsource\tgreenhouse-api') && secondPass.includes('run-B\tsource\tinteramt'));

const reRun = mergeRetroTsv(secondPass, 'run-A', ['run-A\tsource\tgreenhouse-api\t5\t3']);
const runALines = reRun.split('\n').filter((l) => l.startsWith('run-A\t'));
check('re-running for the SAME run_id replaces its rows rather than duplicating them', runALines.length === 1 && runALines[0].includes('\t5\t3'));
check('re-running run-A leaves run-B untouched', reRun.includes('run-B\tsource\tinteramt'));
check('the header is written exactly once across merges', reRun.split('\n').filter((l) => l === RETRO_TSV_COLUMNS.join('\t')).length === 1);

// ── buildPassRetro: end-to-end over an in-memory fixture pass ────────────

const fixtureWindow = computePassWindow(runLogEntries, 'run-20260915T113412');
const fixtureRetro = buildPassRetro({
  window: fixtureWindow,
  scanHistoryRows,
  discardEntries: [
    { timestamp: '2026-09-15T12:00:00.000Z', url: 'https://boards.greenhouse.io/co/jobs/1', reason: 'pre-screen: outside Germany' },
    { timestamp: '2026-08-01T00:00:00.000Z', url: 'https://stale.example.com/job', reason: 'pre-screen: too old, outside window' },
  ],
  reportFiles: [{ file: '192-atruvia-2026-09-16.md', reportNum: '192', date: '2026-09-16' }],
  readReportText: () => '**URL:** https://boards.greenhouse.io/co/jobs/1\n**Score:** 4.2\n',
  pdfIndexRows: [{ report: '192', date: '2026-09-16' }],
  trackerRows: [
    { num: 1, report: '[192](../reports/192-atruvia-2026-09-16.md)', notes: '', status: 'Applied', url: 'https://boards.greenhouse.io/co/jobs/1' },
  ],
  loopState: null,
  loopRunLogText: '',
});

check('buildPassRetro attributes evaluated + kit + Applied all to the same source via the URL join', (() => {
  const gh = fixtureRetro.sourceRows.find((r) => r.source === 'greenhouse-api');
  return gh && gh.evaluated === 1 && gh.kits === 1 && gh.Applied === 1 && gh.prescreenDiscards === 1;
})());
check('a discard entry outside the window is not counted', fixtureRetro.sourceRows.find((r) => r.source === 'ancient-api') === undefined);
check('with no matching loop-state or loop-run-log, free_rejected/llm_triaged/qualified are OMITTED (null), not zero', (() => {
  const gh = fixtureRetro.sourceRows.find((r) => r.source === 'greenhouse-api');
  return gh.freeRejected === null && gh.llmTriaged === null && gh.qualified === null;
})());
check('the omission is named in the pass notes, not silently dropped', fixtureRetro.omitted.some((o) => /loop-state\.json only holds the LATEST loop run/.test(o)));

const rows = renderPassRetroRows(fixtureRetro);
check('renderPassRetroRows emits a stage row for each recovered stage', rows.filter((r) => r.startsWith(`${fixtureRetro.runId}\tstage\t`)).length === 4);
check('renderPassRetroRows emits exactly one pass-level summary row', rows.filter((r) => r.startsWith(`${fixtureRetro.runId}\tpass\t`)).length === 1);
check('an omitted metric renders as an empty TSV cell, never "0"', rows.find((r) => r.includes('\tsource\tgreenhouse-api\t')).split('\t')[5] === ''); // free_rejected column

const summary = renderSummary(fixtureRetro);
check('renderSummary names the run_id and prints a per-source table', summary.includes(fixtureRetro.runId) && summary.includes('greenhouse-api'));
check('renderSummary surfaces the omission to a human reader too', /Omitted/.test(summary));

// ── loop-state.json coverage (latest pass) ────────────────────────────────

const loopStateFixture = {
  run_id: '2026-09-15T11:34:17.878Z',
  config: { minScore: 3.7, target: 10 },
  waves: [{ n: 1, strategy: 'portals', found: 1, added: 1, started_at: '2026-09-15T11:34:20.000Z', finished_at: '2026-09-15T11:35:00.000Z', degraded: false }],
  candidates: {
    a: { url: 'https://boards.greenhouse.io/co/jobs/1', score: 4.5, prefiltered: false },
    b: { url: 'https://www.interamt.de/jobs/3', score: 1, prefiltered: true },
  },
  halted_reason: null,
};
const coveredRetro = buildPassRetro({
  window: fixtureWindow, scanHistoryRows,
  discardEntries: [], reportFiles: [], readReportText: () => '',
  pdfIndexRows: [], trackerRows: [],
  loopState: loopStateFixture, loopRunLogText: '',
});
check('when loop-state.json run_id falls inside the scan window, it is used (loopStateCoversThisPass)', coveredRetro.loopStateCoversThisPass === true);
check('llm-scored (non-prefiltered) candidate above minScore counts as qualified for its source', coveredRetro.sourceRows.find((r) => r.source === 'greenhouse-api')?.qualified === 1);
check('a prefiltered candidate counts as free_rejected, not llm_triaged, for its source', coveredRetro.sourceRows.find((r) => r.source === 'interamt')?.freeRejected === 1);
check('no loop-state/loop-run-log omission note when loop-state covers the pass', !coveredRetro.omitted.some((o) => /LATEST loop run/.test(o)));

// ── run-all.mjs sync step: present, ordered, non-fatal ────────────────────

const runAllSource = readFileSync(join(ROOT, 'run-all.mjs'), 'utf-8');
const stepIds = [...runAllSource.matchAll(/id:\s*'([\w-]+)'/g)].map((m) => m[1]);
const verifyIdx = stepIds.indexOf('verify');
const dashboardIdx = stepIds.indexOf('dashboard');
const retroIdx = stepIds.indexOf('run-retro');
check('run-all.mjs SYNC_STEPS includes a run-retro step', retroIdx !== -1);
check('run-retro runs after verify-pipeline and before the dashboard build', retroIdx !== -1 && verifyIdx !== -1 && dashboardIdx !== -1 && verifyIdx < retroIdx && retroIdx < dashboardIdx);
const retroStepMatch = /\{\s*id:\s*'run-retro'[^}]*\}/.exec(runAllSource);
check('the run-retro step is declared required: false (non-fatal)', Boolean(retroStepMatch) && /required:\s*false/.test(retroStepMatch[0]));

// ── missing/partial files degrade gracefully (end-to-end over a real fixture root) ──

const work = mkdtempSync(join(tmpdir(), 'cops-run-retro-'));
mkdirSync(join(work, 'data'));
mkdirSync(join(work, 'reports'));
try {
  writeFileSync(join(work, 'data', 'run-log.md'), RUN_LOG_FIXTURE);
  // Deliberately NO scan-history.tsv, NO discard.log, NO pdf-index.tsv, NO
  // loop-state.json, NO loop-run-log.md, NO tracker, NO reports — every
  // dependency this file reads is either missing or empty.

  let out = null;
  try {
    out = execFileSync(NODE, [join(ROOT, 'run-retro.mjs'), '--run', 'run-20260915T113412', '--json'], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, CAREER_OPS_ROOT: work },
    });
  } catch (e) {
    fail(`run-retro.mjs crashed on a data root with every optional file missing: ${(e.stderr || e.message || '').toString().slice(0, 300)}`);
  }

  if (out) {
    const parsed = JSON.parse(out);
    check('a pass with every dependency missing still resolves (window comes from run-log.md alone)', Array.isArray(parsed) && parsed.length === 1 && parsed[0].runId === 'run-20260915T113412');
    check('the missing scan-history is named as an omission rather than silently reporting zero sources', parsed[0].omitted.some((o) => /scan-history/.test(o)));
    check('with no sources at all, sources is an empty array, not a fabricated one', parsed[0].sources.length === 0);
  }

  check('data/run-retro.tsv was written even in the fully-degraded case', existsSync(join(work, 'data', 'run-retro.tsv')));
  const retroText = existsSync(join(work, 'data', 'run-retro.tsv')) ? readFileSync(join(work, 'data', 'run-retro.tsv'), 'utf-8') : '';
  check('the written file has exactly one header line', retroText.split('\n').filter((l) => l === RETRO_TSV_COLUMNS.join('\t')).length === 1);

  // Re-run for the same run_id via the CLI itself — idempotency end to end.
  execFileSync(NODE, [join(ROOT, 'run-retro.mjs'), '--run', 'run-20260915T113412'], {
    encoding: 'utf-8', timeout: 30000, env: { ...process.env, CAREER_OPS_ROOT: work },
  });
  const retroTextAfterRerun = readFileSync(join(work, 'data', 'run-retro.tsv'), 'utf-8');
  const passRowsAfterRerun = retroTextAfterRerun.split('\n').filter((l) => l.startsWith('run-20260915T113412\tpass\t'));
  check('the CLI itself is idempotent on a second invocation for the same run_id', passRowsAfterRerun.length === 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
