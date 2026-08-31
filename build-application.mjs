#!/usr/bin/env node

/**
 * build-application.mjs — one command for one application's artifacts.
 *
 * Usage:
 *   node build-application.mjs --report 010 --cv payloads/cv-moresophy.json
 *   node build-application.mjs --report 010 --cv cv.json --cover cover.json
 *   node build-application.mjs --report 010 --cv cv.json --dry-run
 *
 * Runs, in order:
 *   1. liveness  — check-liveness.mjs against the report's **URL:** header
 *   2. CV        — build-cv-html.mjs -> clean-artifacts.mjs -> verify-cv-facts.mjs
 *                  -> generate-pdf.mjs -> clean-artifacts.mjs -> verify-pdf-ats.mjs
 *   3. cover     — generate-cover-letter.mjs -> clean-artifacts.mjs (only with --cover)
 *
 * The ATS gate at the end of step 2 asks a question none of the earlier steps
 * can: the fact gate reads the HTML and checks whether every claim is true;
 * verify-pdf-ats reads the *rendered PDF's text layer* and checks whether a
 * parser can read any of it at all. A CSS regression that pushes the CV to a
 * third page, or a font that renders visibly but extracts as (cid:N), passes
 * every other step in this chain untouched and reaches the recruiter broken.
 *
 * Why this exists: the chain above was reassembled by hand for every
 * application, which is both tedious and easy to get subtly wrong — most
 * expensively by skipping the liveness check. A full CV and cover letter were
 * once built for a Fraunhofer posting that had already closed, because nothing
 * in the apply path ever asked whether the job still existed.
 *
 * The liveness check runs FIRST and aborts the build on failure. That ordering
 * is the point: a dead posting should cost one HTTP round trip, not two PDFs.
 * check-liveness.mjs exits non-zero for "uncertain" as well as "expired", and
 * uncertain is treated as a stop here — the cost of asking the user to look is
 * far below the cost of applying into a void.
 *
 * The clean step runs in two places, and the ordering of the first one matters
 * more than it looks. Cleaning the HTML *before* verify-cv-facts is not
 * cosmetic: the fact gate matches metrics against the CV's visible text, and a
 * zero-width character sitting inside "40%" makes that metric invisible to the
 * regex while a human reader still sees it. An unsupported claim would sail
 * through the gate. Stripping invisible Unicode first means the gate reads the
 * same characters the reader does.
 *
 * The second pass scrubs the rendered PDFs, where the payload is metadata
 * rather than text: Chromium stamps every PDF it prints with `/Creator
 * (Chromium)` and `/Producer (Skia/PDF ...)`, which is a toolchain fingerprint
 * on a document that is supposed to read as the candidate's own.
 *
 * `--stage` files the build directly into output/'s subfolders (to-apply/,
 * applied/, archive-closed/, general/ — see output/README.md) instead of the
 * flat root. It exists because output/ was reorganised into those subfolders
 * but nothing that writes into output/ was made folder-aware, so every build
 * landed back in the root and had to be filed by hand — a layout that only
 * survives through manual discipline is not really a layout. The flag is
 * opt-in and the default is unchanged: this script ships to every career-ops
 * user, most of whom have no such subfolders, so omitting --stage must be
 * byte-identical to the old behaviour.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { resolveCoverOutputPath } from './generate-cover-letter.mjs';
import { classifyLanguage } from './language-loss.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'reports');
const LIVENESS_LOG = join(ROOT, 'data', 'liveness-log.tsv');
const LIVENESS_LOG_HEADER = 'checked_on\treport\tstatus\turl\n';
export const STAGES = ['to-apply', 'applied', 'archive-closed', 'general'];

/**
 * Where generate-cover-letter.mjs will write this payload's PDF.
 *
 * Delegated to that script's own resolver rather than reimplemented, so the
 * scrub step cannot end up pointed at a path the renderer never wrote. Pinned
 * to ROOT/output because the resolver's default is relative to the working
 * directory, and this script may be invoked from anywhere.
 */
export function resolveCoverPdfPath(coverPayloadPath, outOverride = '', root = ROOT) {
  try {
    const payload = JSON.parse(readFileSync(coverPayloadPath, 'utf-8'));
    return resolveCoverOutputPath(payload, outOverride ? resolve(outOverride) : '', join(root, 'output'));
  } catch {
    return '';
  }
}

/**
 * Same resolution, re-rooted into a stage subfolder.
 *
 * An explicit --out-cover always wins outright (own path, own directory —
 * --stage never relocates it). Otherwise this takes the basename
 * resolveCoverPdfPath would have produced — including a payload's own
 * output_path, if it set one — and re-roots it under output/<stage>/, so the
 * naming stays whatever generate-cover-letter.mjs would have chosen; only the
 * directory moves.
 */
export function resolveStagedCoverPdfPath(coverPayloadPath, outOverride = '', stage = '', root = ROOT) {
  if (outOverride) return resolveCoverPdfPath(coverPayloadPath, outOverride, root);
  const unstaged = resolveCoverPdfPath(coverPayloadPath, '', root);
  if (!unstaged || !stage) return unstaged;
  return join(root, 'output', stage, basename(unstaged));
}

/** Locate reports/NNN-*.md for a report number, tolerating unpadded input. */
export function findReport(reportNum, reportsDir = REPORTS_DIR) {
  const padded = String(reportNum).padStart(3, '0');
  if (!existsSync(reportsDir)) return '';
  const match = readdirSync(reportsDir)
    .filter(name => name.endsWith('.md'))
    .find(name => name.startsWith(`${padded}-`));
  return match ? join(reportsDir, match) : '';
}

/** Read the **URL:** header a report is required to carry (see AGENTS.md). */
export function readReportUrl(reportPath) {
  const match = readFileSync(reportPath, 'utf-8').match(/^\*\*URL:\*\*\s*(\S+)/m);
  return match ? match[1].trim() : '';
}

/**
 * Append one liveness observation.
 *
 * Nothing else in the pipeline records *when* a posting was last seen alive,
 * which makes "re-verify before sending" unenforceable: a posting verified at
 * scoring time can close within the day, and did.
 */
function logLiveness(reportNum, status, url) {
  mkdirSync(dirname(LIVENESS_LOG), { recursive: true });
  if (!existsSync(LIVENESS_LOG)) appendFileSync(LIVENESS_LOG, LIVENESS_LOG_HEADER, 'utf-8');
  const today = new Date().toISOString().slice(0, 10);
  appendFileSync(LIVENESS_LOG, `${today}\t${reportNum}\t${status}\t${url}\n`, 'utf-8');
}

function usage() {
  return `Usage: node build-application.mjs --report NNN --cv <payload.json> [options]

  --report NNN      Report number; supplies the URL for the liveness check
  --cv PATH         CV payload JSON (required)
  --cover PATH      Cover-letter payload JSON (optional)
  --out-cv PATH     CV PDF path (default: output/<cv-payload-name>.pdf)
  --out-cover PATH  Cover PDF path (default: generate-cover-letter's own default)
  --stage NAME      to-apply | applied | archive-closed | general
                     Files CV HTML/PDF and cover PDF into output/<NAME>/ instead
                     of output/'s root. Opt-in; omitted = today's behaviour.
                     --out-cv / --out-cover still win when also given.
  --format FMT      letter | a4 (default: a4)
  --skip-liveness   Do not check whether the posting is still open
  --skip-clean      Do not strip invisible Unicode / scrub PDF toolchain metadata
  --skip-ats        Do not verify the rendered PDF's ATS text layer / page count
  --allow-language-gap  Build even when the report states a German requirement A2 cannot meet
  --max-pages N     Fail the ATS gate above N pages (default 2; 0 disables)
  --allow-reorder   Pass through to generate-pdf.mjs
  --allow-stale     Pass through to generate-pdf.mjs
  --dry-run         Print the commands without running them`;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        report: { type: 'string' },
        cv: { type: 'string' },
        cover: { type: 'string' },
        'out-cv': { type: 'string' },
        'out-cover': { type: 'string' },
        stage: { type: 'string' },
        format: { type: 'string', default: 'a4' },
        'skip-liveness': { type: 'boolean', default: false },
        'skip-clean': { type: 'boolean', default: false },
        'skip-ats': { type: 'boolean', default: false },
        'allow-language-gap': { type: 'boolean', default: false },
        'max-pages': { type: 'string' },
        'allow-reorder': { type: 'boolean', default: false },
        'allow-stale': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`build-application: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (values.help || !values.report || !values.cv) {
    console.log(usage());
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (!['a4', 'letter'].includes(values.format)) {
    console.error(`build-application: invalid --format "${values.format}" (use a4 or letter)`);
    process.exitCode = 1;
    return;
  }
  if (values.stage && !STAGES.includes(values.stage)) {
    console.error(`build-application: invalid --stage "${values.stage}" (use ${STAGES.join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const dryRun = values['dry-run'];
  const reportNum = String(values.report).padStart(3, '0');
  const cvPayload = resolve(values.cv);
  if (!existsSync(cvPayload)) {
    console.error(`build-application: CV payload not found: ${cvPayload}`);
    process.exitCode = 1;
    return;
  }
  const coverPayload = values.cover ? resolve(values.cover) : '';
  if (coverPayload && !existsSync(coverPayload)) {
    console.error(`build-application: cover payload not found: ${coverPayload}`);
    process.exitCode = 1;
    return;
  }

  const stem = basename(cvPayload).replace(/\.json$/i, '');
  const outputDir = values.stage ? join(ROOT, 'output', values.stage) : join(ROOT, 'output');
  const htmlPath = join(outputDir, `${stem}.html`);
  const cvPdfPath = values['out-cv'] ? resolve(values['out-cv']) : join(outputDir, `${stem}.pdf`);

  // Only created when --stage is given, and never on a dry run — --dry-run's
  // whole point is to print the plan without touching the filesystem.
  if (values.stage && !dryRun) mkdirSync(outputDir, { recursive: true });

  const run = (label, args) => {
    console.log(`\n▶ ${label}`);
    console.log(`  node ${args.join(' ')}`);
    if (dryRun) return true;
    return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
  };

  // ── 0. Language gate ──────────────────────────────────────────────────────
  //
  // A stated hard German requirement is not a scoring penalty, it is a refusal
  // the employer has already written down — and applying into one has a
  // measured 0% success rate here.
  //
  // Four roles carried "sehr gute Deutschkenntnisse" or "verhandlungssicheres
  // Deutsch", scored 3.8-4.3, cleared the pursue floor on their own merits, had
  // kits built, were applied to, and were ALL FOUR rejected: #8 DATEV, #90
  // Thieme, #43 ZEISS, #64 MTU. That is 4 of 14 rejections spent on a filter
  // that was visible in the JD before a single PDF was rendered.
  //
  // The rule already existed in modes/_custom.md and nothing enforced it, which
  // is why it kept being scored, noted, and then ignored at build time. It is
  // enforced here because this is the one command that produces a kit.
  //
  // Overridable on purpose: the candidate may know the bar is soft, may have a
  // contact inside, or may simply choose to spend the application. It stops the
  // DEFAULT, not the decision.
  {
    const reportPath = findReport(reportNum);
    if (reportPath && !values['allow-language-gap']) {
      const { tier, quote } = classifyLanguage(readFileSync(reportPath, 'utf-8'));
      if (tier === 'hard_stop') {
        console.error(`\n⛔ LANGUAGE HARD STOP in ${basename(reportPath)}: "${quote}"`);
        console.error('   config/profile.yml puts German at A2; this posting states a requirement A2 cannot carry.');
        console.error('   Every application sent into this tier so far has been rejected (4 of 4: #8, #90, #43, #64).');
        console.error('\n   Nothing was built. Re-run with --allow-language-gap to build it anyway,');
        console.error('   and if you do, have the letter address the gap rather than leave it to be discovered.');
        process.exitCode = 1;
        return;
      }
    }
  }

  // ── 1. Liveness ───────────────────────────────────────────────────────────
  if (values['skip-liveness']) {
    console.log('\n⚠️  Liveness check skipped (--skip-liveness). Confirm the posting is open before sending.');
  } else {
    const reportPath = findReport(reportNum);
    if (!reportPath) {
      console.error(`build-application: no report found for ${reportNum} in reports/.`);
      console.error('Pass --skip-liveness only if you have already confirmed the posting is open.');
      process.exitCode = 1;
      return;
    }
    const url = readReportUrl(reportPath);
    if (!url) {
      console.error(`build-application: ${basename(reportPath)} has no **URL:** header, so liveness cannot be checked.`);
      console.error('Every report is required to carry one (AGENTS.md, Pipeline Integrity).');
      process.exitCode = 1;
      return;
    }
    const live = run(`Liveness check — ${url}`, ['check-liveness.mjs', url]);
    if (!dryRun) logLiveness(reportNum, live ? 'live' : 'not-live', url);
    if (!live) {
      console.error('\n❌ Posting is expired or could not be confirmed. Nothing was built.');
      console.error('   Re-check by hand, then re-run with --skip-liveness if it is genuinely open.');
      process.exitCode = 1;
      return;
    }
  }

  // ── 2. CV ─────────────────────────────────────────────────────────────────
  const pdfArgs = ['generate-pdf.mjs', htmlPath, cvPdfPath, `--format=${values.format}`, `--report=${reportNum}`];
  if (values['allow-reorder']) pdfArgs.push('--allow-reorder');
  if (values['allow-stale']) pdfArgs.push('--allow-stale');

  const skipClean = values['skip-clean'];
  const cleanStep = (label, target) =>
    skipClean ? null : [label, ['clean-artifacts.mjs', target]];

  // The ATS gate runs LAST, on the finished artifact. The fact gate reads the
  // HTML and answers "is every claim true"; this reads the rendered PDF's text
  // layer and answers "can a parser read any of it". A CSS regression that
  // pushes the CV to three pages, or a font that renders visibly but extracts
  // as (cid:N), passes every earlier step in this chain untouched.
  const atsArgs = ['verify-pdf-ats.mjs', cvPdfPath, '--payload', cvPayload];
  if (values['max-pages']) atsArgs.push('--max-pages', values['max-pages']);

  const cvSteps = [
    ['Build CV HTML', ['build-cv-html.mjs', cvPayload, htmlPath]],
    // Before the gate, not after: an invisible character inside a metric hides
    // that metric from the fact gate but not from the reader.
    cleanStep('Clean CV HTML', htmlPath),
    ['Fact gate', ['verify-cv-facts.mjs', htmlPath]],
    ['Render CV PDF', pdfArgs],
    cleanStep('Scrub CV PDF metadata', cvPdfPath),
    // After the scrub: clean-artifacts rewrites PDF bytes, so anything checked
    // before it would be checking a file that no longer exists on disk.
    values['skip-ats'] ? null : ['ATS gate', atsArgs],
  ].filter(Boolean);
  for (const [label, args] of cvSteps) {
    if (!run(label, args)) {
      console.error(`\n❌ ${label} failed. Nothing further was built.`);
      process.exitCode = 1;
      return;
    }
  }

  // ── 3. Cover letter ───────────────────────────────────────────────────────
  let coverBuilt = false;
  if (coverPayload) {
    const coverArgs = ['generate-cover-letter.mjs', '--payload', coverPayload, '--format', values.format, '--report', reportNum];
    if (values['out-cover']) {
      coverArgs.push('--out', resolve(values['out-cover']));
    } else if (values.stage) {
      // No explicit --out-cover, but --stage is set: tell the renderer itself
      // to write into the stage folder, so the scrub step below (which reads
      // the same staged path via resolveStagedCoverPdfPath) finds the file it
      // expects instead of one left behind in output/'s root.
      const stagedOut = resolveStagedCoverPdfPath(coverPayload, '', values.stage);
      if (stagedOut) coverArgs.push('--out', stagedOut);
    }
    if (!run('Cover letter', coverArgs)) {
      console.error('\n❌ Cover letter failed. The CV above was still built.');
      process.exitCode = 1;
      return;
    }
    coverBuilt = true;

    if (!skipClean) {
      const coverPdfPath = resolveStagedCoverPdfPath(coverPayload, values['out-cover'], values.stage);
      if (!coverPdfPath) {
        console.error('\n⚠️  Cover PDF path could not be resolved, so its metadata was not scrubbed.');
        console.error('   Run: node clean-artifacts.mjs <cover.pdf>');
      } else if (!run('Scrub cover PDF metadata', ['clean-artifacts.mjs', coverPdfPath])) {
        console.error('\n❌ Cover PDF metadata scrub failed. Both PDFs above were still built.');
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log('\n================== SUMMARY ==================');
  if (dryRun) console.log('  (dry run — nothing was built)');
  console.log(`  report      : ${reportNum}`);
  console.log(`  liveness    : ${values['skip-liveness'] ? 'SKIPPED' : 'live'}`);
  console.log(`  cleaned     : ${skipClean ? 'SKIPPED' : 'invisible Unicode + PDF toolchain metadata'}`);
  console.log(`  ats gate    : ${values['skip-ats'] ? 'SKIPPED' : 'text layer + page count verified'}`);
  console.log(`  stage       : ${values.stage || 'output/ (root)'}`);
  console.log(`  cv pdf      : ${cvPdfPath}`);
  console.log(`  cover pdf   : ${coverBuilt ? (resolveStagedCoverPdfPath(coverPayload, values['out-cover'], values.stage) || 'generate-cover-letter default') : 'none'}`);
  console.log('=============================================');
  console.log('\nReview both PDFs before sending. Nothing here submits anything.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`build-application: ${error.message}`);
    process.exitCode = 1;
  });
}
