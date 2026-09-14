// tests/build-application.test.mjs — unit + CLI tests for build-application.mjs.
//
// build-application.mjs exists to make one ordering non-optional: the liveness
// check runs BEFORE any PDF is rendered. That ordering is the whole value of the
// script — a closed posting should cost one HTTP round trip, not two PDFs — and
// it is exactly the kind of property that silently rots, because the happy path
// looks identical whether the check ran first, ran last, or was quietly dropped.
// So the order of the emitted command plan is pinned here, not just its contents.
//
// Every CLI assertion runs through --dry-run, which prints the plan and executes
// nothing: no Playwright, no network, no writes to output/ or data/. The one
// exception is the liveness step, which --dry-run also suppresses (`if (dryRun)
// return true`), so these tests never touch a real job posting either.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - build-application (one command per application)');

const SCRIPT = join(ROOT, 'build-application.mjs');

/**
 * Run the CLI and capture stdout, stderr and exit code without throwing.
 * Every caller passes --dry-run, so nothing is built.
 */
function cli(args) {
  try {
    const stdout = execFileSync(NODE, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e?.status ?? null,
      stdout: e?.stdout == null ? '' : String(e.stdout),
      stderr: e?.stderr == null ? '' : String(e.stderr),
    };
  }
}

let tmp = '';
try {
  tmp = mkdtempSync(join(tmpdir(), 'build-application-'));

  // ── Unit: findReport / readReportUrl ───────────────────────────────────────
  const mod = await import(pathToFileURL(SCRIPT).href);
  const { findReport, readReportUrl, resolveCoverPdfPath, resolveStagedCoverPdfPath } = mod;

  if (typeof findReport !== 'function' || typeof readReportUrl !== 'function') {
    fail('build-application.mjs does not export findReport and readReportUrl');
  } else {
    const reportsDir = join(tmp, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, '010-acme-2026-08-01.md');
    writeFileSync(
      reportPath,
      '# 010 — Acme — AI Engineer\n\n**Score:** 4.4/5\n**URL:** https://acme.example/jobs/42\n**PDF:** ✅\n',
      'utf-8'
    );
    // A decoy whose number *contains* the query, to prove prefix matching is
    // anchored: startsWith('010-') must not be satisfied by 1010- or 0100-.
    writeFileSync(join(reportsDir, '0100-decoy-2026-08-01.md'), '**URL:** https://decoy.example\n', 'utf-8');

    const cases = [
      { name: 'a zero-padded report number finds its report', arg: '010', want: reportPath },
      { name: 'an unpadded report number is padded before matching', arg: '10', want: reportPath },
      { name: 'a numeric (non-string) report number is accepted', arg: 10, want: reportPath },
      { name: 'a report number with no file returns an empty string', arg: '999', want: '' },
    ];
    for (const c of cases) {
      const got = findReport(c.arg, reportsDir);
      if (got === c.want) pass(c.name);
      else fail(`${c.name} — expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`);
    }

    // A missing reports/ directory must return '' rather than throw ENOENT: the
    // CLI turns '' into an actionable "no report found" message, and a raw
    // readdirSync throw would surface as an unhandled crash instead.
    const got = findReport('010', join(tmp, 'no-such-dir'));
    if (got === '') pass('a missing reports/ directory returns an empty string instead of throwing');
    else fail(`a missing reports/ directory returned ${JSON.stringify(got)}`);

    const url = readReportUrl(reportPath);
    if (url === 'https://acme.example/jobs/42') pass('readReportUrl extracts the **URL:** header');
    else fail(`readReportUrl returned ${JSON.stringify(url)}`);

    // A report with no **URL:** header must yield '' so the CLI can refuse to
    // build. Returning anything truthy here would send a bare word to the
    // liveness checker as if it were a URL.
    const noUrl = join(reportsDir, '011-nourl-2026-08-01.md');
    writeFileSync(noUrl, '# 011 — NoUrl\n\n**Score:** 4.0/5\n', 'utf-8');
    const missing = readReportUrl(noUrl);
    if (missing === '') pass('a report with no **URL:** header yields an empty string');
    else fail(`readReportUrl on a header-less report returned ${JSON.stringify(missing)}`);

    // The header must be matched at line start, not anywhere in the body: prose
    // quoting "**URL:**" mid-sentence must not win over the real header.
    const inline = join(reportsDir, '012-inline-2026-08-01.md');
    writeFileSync(
      inline,
      '# 012 — Inline\n\n**URL:** https://real.example/job\n\nThe posting said **URL:** https://wrong.example/x in passing.\n',
      'utf-8'
    );
    const first = readReportUrl(inline);
    if (first === 'https://real.example/job') pass('the line-anchored **URL:** header wins over a mid-sentence mention');
    else fail(`readReportUrl on an inline-mention report returned ${JSON.stringify(first)}`);
  }

  // ── CLI: argument validation ───────────────────────────────────────────────
  const payload = join(tmp, 'cv-acme.json');
  writeFileSync(payload, '{}', 'utf-8');

  const help = cli(['--help']);
  if (help.code === 0 && /Usage: node build-application\.mjs/.test(help.stdout)) {
    pass('--help prints usage and exits 0');
  } else {
    fail(`--help exited ${help.code} with stdout ${JSON.stringify(help.stdout.slice(0, 200))}`);
  }

  const noArgs = cli([]);
  if (noArgs.code === 1 && /Usage:/.test(noArgs.stdout)) {
    pass('no arguments prints usage and exits 1');
  } else {
    fail(`no arguments exited ${noArgs.code}`);
  }

  const noCv = cli(['--report', '010']);
  if (noCv.code === 1) pass('--report without --cv exits 1');
  else fail(`--report without --cv exited ${noCv.code}`);

  // strict:true in parseArgs — an unknown flag must be a hard error, never a
  // silently ignored typo that produces a differently-configured build.
  const unknown = cli(['--report', '010', '--cv', payload, '--dry-run', '--no-such-flag']);
  if (unknown.code === 1 && /Unknown option|--no-such-flag/.test(unknown.stderr)) {
    pass('an unknown flag is a hard error, not a silent no-op');
  } else {
    fail(`unknown flag exited ${unknown.code} with stderr ${JSON.stringify(unknown.stderr.slice(0, 200))}`);
  }

  const badFormat = cli(['--report', '010', '--cv', payload, '--format', 'legal', '--dry-run']);
  if (badFormat.code === 1 && /invalid --format/.test(badFormat.stderr)) {
    pass('an unsupported --format is rejected before anything is built');
  } else {
    fail(`--format legal exited ${badFormat.code} with stderr ${JSON.stringify(badFormat.stderr.slice(0, 200))}`);
  }

  const missingPayload = cli(['--report', '010', '--cv', join(tmp, 'nope.json'), '--dry-run']);
  if (missingPayload.code === 1 && /CV payload not found/.test(missingPayload.stderr)) {
    pass('a missing CV payload is caught before the liveness check');
  } else {
    fail(`missing CV payload exited ${missingPayload.code}`);
  }

  const missingCover = cli(['--report', '010', '--cv', payload, '--cover', join(tmp, 'nope.json'), '--dry-run']);
  if (missingCover.code === 1 && /cover payload not found/.test(missingCover.stderr)) {
    pass('a missing cover payload is caught before the liveness check');
  } else {
    fail(`missing cover payload exited ${missingCover.code}`);
  }

  // ── CLI: the liveness gate ─────────────────────────────────────────────────
  // Report 999 does not exist in reports/, so the run must stop at step 1 with a
  // message that names the escape hatch. Crucially it must NOT fall through to
  // building a CV for a posting whose status is unknown.
  const noReport = cli(['--report', '999', '--cv', payload, '--dry-run']);
  if (noReport.code === 1 && /no report found/.test(noReport.stderr)) {
    pass('an unknown report number stops the build at the liveness step');
  } else {
    fail(`unknown report number exited ${noReport.code} with stderr ${JSON.stringify(noReport.stderr.slice(0, 200))}`);
  }
  if (noReport.code === 1 && !/build-cv-html\.mjs/.test(noReport.stdout)) {
    pass('no CV step is planned when the liveness gate fails');
  } else {
    fail('a failed liveness gate still planned the CV build');
  }
  if (/--skip-liveness/.test(noReport.stderr)) {
    pass('the liveness failure names --skip-liveness as the explicit override');
  } else {
    fail('the liveness failure message does not mention the --skip-liveness override');
  }

  // ── CLI: the dry-run plan and its ordering ─────────────────────────────────
  const plan = cli(['--report', '010', '--cv', payload, '--cover', payload, '--skip-liveness', '--dry-run']);
  if (plan.code === 0) pass('a complete --dry-run exits 0');
  else fail(`--dry-run exited ${plan.code} with stderr ${JSON.stringify(plan.stderr.slice(0, 300))}`);

  const steps = ['build-cv-html.mjs', 'verify-cv-facts.mjs', 'generate-pdf.mjs', 'generate-cover-letter.mjs'];
  const positions = steps.map((s) => plan.stdout.indexOf(s));
  if (positions.every((p) => p !== -1)) {
    pass('the plan contains every step: CV HTML, fact gate, PDF, cover letter');
  } else {
    const absent = steps.filter((_, i) => positions[i] === -1);
    fail(`the plan is missing ${absent.join(', ')}`);
  }
  if (positions.every((p, i) => i === 0 || (p !== -1 && p > positions[i - 1]))) {
    pass('the steps are planned in order: HTML -> fact gate -> PDF -> cover');
  } else {
    fail(`the steps are out of order (offsets ${positions.join(', ')})`);
  }

  // The fact gate is the only thing standing between a hallucinated metric and a
  // PDF that gets emailed to a recruiter. It must never be planned after render.
  if (positions[1] !== -1 && positions[2] !== -1 && positions[1] < positions[2]) {
    pass('verify-cv-facts runs before the PDF is rendered, not after');
  } else {
    fail('verify-cv-facts is not planned before generate-pdf');
  }

  // The HTML clean step has to sit between build and gate. Cleaning after the
  // gate would leave the gate reading characters the reader never sees: a
  // zero-width space inside "40%" hides that metric from the metric regex while
  // the rendered PDF still shows it, which is exactly the claim the gate exists
  // to catch. Cleaning after the render would be worse still — too late.
  const cleanHtmlAt = plan.stdout.indexOf('clean-artifacts.mjs');
  if (cleanHtmlAt !== -1 && cleanHtmlAt > positions[0] && cleanHtmlAt < positions[1]) {
    pass('the CV HTML is cleaned after it is built and before the fact gate reads it');
  } else {
    fail(`the HTML clean step is not planned between build and gate (offset ${cleanHtmlAt})`);
  }

  // Both rendered PDFs carry Chromium's /Creator + /Producer stamp, so both need
  // scrubbing — a clean CV beside an unscrubbed cover letter is not a clean set.
  const cleanCalls = plan.stdout.match(/clean-artifacts\.mjs/g) || [];
  if (cleanCalls.length === 3) {
    pass('three clean steps are planned: CV HTML, CV PDF, cover PDF');
  } else {
    fail(`expected 3 clean steps, planned ${cleanCalls.length}`);
  }
  if (/clean-artifacts\.mjs\s+\S+-cover\.pdf/.test(plan.stdout)) {
    pass('the cover PDF path is resolved for scrubbing, not left to a default');
  } else {
    fail('no cover PDF path was resolved for the scrub step');
  }

  const noClean = cli(['--report', '010', '--cv', payload, '--cover', payload, '--skip-liveness', '--skip-clean', '--dry-run']);
  if (!/clean-artifacts\.mjs/.test(noClean.stdout)) {
    pass('--skip-clean plans no clean steps at all');
  } else {
    fail('--skip-clean still planned a clean step');
  }
  if (/cleaned\s*:\s*SKIPPED/.test(noClean.stdout)) {
    pass('the summary reports cleaning as SKIPPED rather than staying silent');
  } else {
    fail('--skip-clean is not reported in the summary');
  }

  if (/nothing was built/.test(plan.stdout)) pass('the dry-run summary says nothing was built');
  else fail('the dry-run summary does not state that nothing was built');

  if (/liveness\s*:\s*SKIPPED/.test(plan.stdout)) {
    pass('the summary reports liveness as SKIPPED rather than implying it passed');
  } else {
    fail('the summary does not report the skipped liveness check');
  }

  // --skip-liveness must be loud. It is the one flag that can put a CV in front
  // of a recruiter for a job that no longer exists.
  if (/Liveness check skipped/.test(plan.stdout)) {
    pass('--skip-liveness prints an explicit warning');
  } else {
    fail('--skip-liveness is silent — no warning printed');
  }

  // Nothing in this script may submit an application (AGENTS.md, Ethical Use).
  if (/Nothing here submits anything/.test(plan.stdout)) {
    pass('the summary states that nothing is submitted');
  } else {
    fail('the summary does not state that nothing is submitted');
  }

  // Without --cover, the cover-letter step must not be planned at all.
  const cvOnly = cli(['--report', '010', '--cv', payload, '--skip-liveness', '--dry-run']);
  if (cvOnly.code === 0 && !/generate-cover-letter\.mjs/.test(cvOnly.stdout)) {
    pass('omitting --cover plans no cover-letter step');
  } else {
    fail('a cover-letter step was planned without --cover');
  }
  if (/cover pdf\s*:\s*none/.test(cvOnly.stdout)) {
    pass('the summary reports "none" for the cover PDF when none was requested');
  } else {
    fail('the summary does not report an absent cover PDF as none');
  }

  // The report number reaches generate-pdf.mjs, which needs it to stamp the PDF
  // index; an unpadded --report must be padded on the way through.
  const padded = cli(['--report', '7', '--cv', payload, '--skip-liveness', '--dry-run']);
  if (/--report=007/.test(padded.stdout)) {
    pass('an unpadded --report is zero-padded before being passed to generate-pdf');
  } else {
    fail('--report 7 did not reach generate-pdf as --report=007');
  }

  const fmt = cli(['--report', '010', '--cv', payload, '--format', 'letter', '--skip-liveness', '--dry-run']);
  if (/--format=letter/.test(fmt.stdout)) pass('--format letter is passed through to generate-pdf');
  else fail('--format letter did not reach generate-pdf');

  const passthrough = cli([
    '--report', '010', '--cv', payload, '--skip-liveness', '--dry-run',
    '--allow-reorder', '--allow-stale',
  ]);
  if (/--allow-reorder/.test(passthrough.stdout) && /--allow-stale/.test(passthrough.stdout)) {
    pass('--allow-reorder and --allow-stale are passed through to generate-pdf');
  } else {
    fail('the generate-pdf passthrough flags did not reach generate-pdf');
  }

  // ── CLI: --stage ────────────────────────────────────────────────────────────
  // output/ was split into subfolders (to-apply/, applied/, archive-closed/,
  // general/), but every build script still defaulted to output/'s flat root.
  // --stage is the opt-in fix; these tests pin both the opt-in default (no
  // regression for the thousands of users with no such subfolders) and the
  // staged behaviour.

  // No --stage at all: the planned CV HTML and PDF paths must carry no
  // subfolder under output/ — this is the default-behaviour regression guard.
  const noStage = cli(['--report', '010', '--cv', payload, '--skip-liveness', '--dry-run']);
  const cvHtmlLine = (noStage.stdout.match(/build-cv-html\.mjs.*$/m) || [''])[0];
  const cvPdfLine = (noStage.stdout.match(/generate-pdf\.mjs.*$/m) || [''])[0];
  if (
    cvHtmlLine &&
    !/output[\\/](to-apply|applied|archive-closed|general)[\\/]/.test(cvHtmlLine) &&
    cvPdfLine &&
    !/output[\\/](to-apply|applied|archive-closed|general)[\\/]/.test(cvPdfLine)
  ) {
    pass('omitting --stage plans the CV HTML and PDF straight into output/\'s root');
  } else {
    fail(`omitting --stage put a stage subfolder in the plan (html: ${cvHtmlLine}, pdf: ${cvPdfLine})`);
  }

  // --stage to-apply: CV HTML, CV PDF and cover PDF all sit under
  // output/to-apply/.
  const stageToApply = cli([
    '--report', '010', '--cv', payload, '--cover', payload, '--skip-liveness', '--stage', 'to-apply', '--dry-run',
  ]);
  const stageSep = '[\\\\/]'; // Windows and POSIX path separators
  const toApplyPattern = new RegExp(`output${stageSep}to-apply${stageSep}`);
  if (stageToApply.code === 0) pass('--stage to-apply exits 0');
  else fail(`--stage to-apply exited ${stageToApply.code} with stderr ${JSON.stringify(stageToApply.stderr.slice(0, 200))}`);
  const toApplyHtmlLine = (stageToApply.stdout.match(/build-cv-html\.mjs.*$/m) || [''])[0];
  const toApplyPdfLine = (stageToApply.stdout.match(/generate-pdf\.mjs.*$/m) || [''])[0];
  const toApplyCoverLine = (stageToApply.stdout.match(/generate-cover-letter\.mjs.*$/m) || [''])[0];
  if (toApplyPattern.test(toApplyHtmlLine) && toApplyPattern.test(toApplyPdfLine) && toApplyPattern.test(toApplyCoverLine)) {
    pass('--stage to-apply routes CV HTML, CV PDF and cover PDF under output/to-apply/');
  } else {
    fail(
      `--stage to-apply did not route all three artifacts under output/to-apply/ ` +
      `(html: ${toApplyHtmlLine}, pdf: ${toApplyPdfLine}, cover: ${toApplyCoverLine})`
    );
  }

  // --stage applied: same check, different folder.
  const stageApplied = cli([
    '--report', '010', '--cv', payload, '--cover', payload, '--skip-liveness', '--stage', 'applied', '--dry-run',
  ]);
  const appliedPattern = new RegExp(`output${stageSep}applied${stageSep}`);
  const appliedHtmlLine = (stageApplied.stdout.match(/build-cv-html\.mjs.*$/m) || [''])[0];
  const appliedPdfLine = (stageApplied.stdout.match(/generate-pdf\.mjs.*$/m) || [''])[0];
  const appliedCoverLine = (stageApplied.stdout.match(/generate-cover-letter\.mjs.*$/m) || [''])[0];
  if (appliedPattern.test(appliedHtmlLine) && appliedPattern.test(appliedPdfLine) && appliedPattern.test(appliedCoverLine)) {
    pass('--stage applied routes CV HTML, CV PDF and cover PDF under output/applied/');
  } else {
    fail(
      `--stage applied did not route all three artifacts under output/applied/ ` +
      `(html: ${appliedHtmlLine}, pdf: ${appliedPdfLine}, cover: ${appliedCoverLine})`
    );
  }

  // An invalid --stage is rejected before anything is planned, and the error
  // names the valid values — same contract as the existing --format check.
  const badStage = cli(['--report', '010', '--cv', payload, '--stage', 'bogus', '--dry-run']);
  if (
    badStage.code === 1 &&
    /invalid --stage/.test(badStage.stderr) &&
    ['to-apply', 'applied', 'archive-closed', 'general'].every((s) => badStage.stderr.includes(s))
  ) {
    pass('an invalid --stage is rejected and names the valid values');
  } else {
    fail(`--stage bogus exited ${badStage.code} with stderr ${JSON.stringify(badStage.stderr.slice(0, 300))}`);
  }

  // --out-cv combined with --stage: the explicit --out-cv path must win, not
  // be silently relocated into the stage folder.
  const explicitOutCv = join(tmp, 'explicit-cv.pdf');
  const outCvWithStage = cli([
    '--report', '010', '--cv', payload, '--skip-liveness', '--stage', 'to-apply', '--out-cv', explicitOutCv, '--dry-run',
  ]);
  const outCvPdfLine = (outCvWithStage.stdout.match(/generate-pdf\.mjs.*$/m) || [''])[0];
  // The line is `generate-pdf.mjs <html> <cv-pdf> --format=... --report=...`;
  // the CV PDF argument (not the HTML argument, which --out-cv never touches)
  // must be the explicit path verbatim, not one rewritten into the stage folder.
  const outCvPdfArg = outCvPdfLine.split(/\s+/)[2] || '';
  if (outCvPdfArg === explicitOutCv) {
    pass('--out-cv wins over --stage instead of being relocated into the stage folder');
  } else {
    fail(`--out-cv was not honoured over --stage (pdf arg: ${JSON.stringify(outCvPdfArg)}, expected ${JSON.stringify(explicitOutCv)})`);
  }

  // The SUMMARY reports the stage, so a staged build is visible in the output
  // rather than something the user has to infer.
  if (/stage\s*:\s*to-apply/.test(stageToApply.stdout)) {
    pass('the summary reports the stage');
  } else {
    fail('the summary does not report --stage to-apply');
  }
  if (/stage\s*:\s*output\/ \(root\)/.test(noStage.stdout)) {
    pass('the summary reports output/ root when --stage is omitted');
  } else {
    fail('the summary does not report the default (no-stage) location');
  }

  // With --stage, the cover PDF basename must still match what
  // resolveCoverPdfPath (generate-cover-letter.mjs's own resolver) derives —
  // only the directory should differ, never the naming.
  if (typeof resolveCoverPdfPath === 'function' && typeof resolveStagedCoverPdfPath === 'function') {
    const unstagedCoverPath = resolveCoverPdfPath(payload);
    const stagedCoverPath = resolveStagedCoverPdfPath(payload, '', 'to-apply');
    const unstagedBase = unstagedCoverPath.split(/[\\/]/).pop();
    const stagedBase = stagedCoverPath.split(/[\\/]/).pop();
    if (unstagedCoverPath && stagedCoverPath && unstagedBase === stagedBase && toApplyPattern.test(stagedCoverPath)) {
      pass('the staged cover PDF keeps the same basename as resolveCoverPdfPath, only re-rooted under output/to-apply/');
    } else {
      fail(
        `staged cover naming diverged from resolveCoverPdfPath ` +
        `(unstaged: ${JSON.stringify(unstagedCoverPath)}, staged: ${JSON.stringify(stagedCoverPath)})`
      );
    }
  } else {
    fail('build-application.mjs does not export resolveCoverPdfPath and resolveStagedCoverPdfPath');
  }
} catch (e) {
  fail(`build-application tests crashed: ${e.message}`);
} finally {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── staged cover letters must land in the stage folder ──────────────────────
// generate-cover-letter.mjs confined output paths by taking only the basename,
// which is a correct traversal guard and a wrong path policy: a --stage build
// rendered the cover to output/<name>.pdf while build-application looked for
// output/<stage>/<name>.pdf. The render reported success and the scrub failed
// with "file not found". Subfolders inside output/ are now preserved.
//
// [CALL] The two escape cases below were updated from "still confined to
// output/<basename>" to "throws". Upstream's #2940 fix (tests/cover-letter-
// output-path.test.mjs, merged from career-ops v1.32.0) redesigned
// safeOutputPath() to REFUSE an escaping path outright instead of silently
// rewriting it into output/ under its basename — the merge kept an older
// local safeOutputPath() body that still did the silent rewrite, which is
// what this file originally pinned. generate-cover-letter.mjs now uses
// upstream's throwing implementation (cited in its own file history), and
// every caller of resolveCoverOutputPath() already tolerates the throw:
// build-application.mjs's resolveCoverPdfPath() catches it and returns '',
// and generate-cover-letter.mjs's own main() catches it and exits 1.
{
  const { resolveCoverOutputPath } = await import('../generate-cover-letter.mjs');
  const root = join(ROOT, 'output');
  const staged = resolveCoverOutputPath({}, join(root, 'to-apply', 'x-cover.pdf'), root);
  if (staged.includes('to-apply')) pass('a staged cover path keeps its subfolder');
  else fail(`staged cover path was flattened: ${staged}`);

  try {
    const escaped = resolveCoverOutputPath({}, '../../etc/passwd', root);
    fail(`traversal was not refused, resolved to: ${escaped}`);
  } catch (err) {
    if (/refus/i.test(err.message)) pass('a traversal attempt is refused, not silently confined');
    else fail(`traversal threw the wrong error: ${err.message}`);
  }

  try {
    const inner = resolveCoverOutputPath({}, join(root, 'to-apply', '..', '..', '..', 'evil.pdf'), root);
    fail(`nested traversal was not refused, resolved to: ${inner}`);
  } catch (err) {
    if (/refus/i.test(err.message)) pass('a traversal nested inside output/ is refused, not silently confined');
    else fail(`nested traversal threw the wrong error: ${err.message}`);
  }
}
