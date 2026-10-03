// tests/triage-prefilter.test.mjs — cross-file drift guards for the prefilter.
//
// The behavioural assertions live in `node triage-prefilter.mjs --self-test`,
// which test-all.mjs spawns separately. What that self-test CANNOT catch is the
// failure mode this file exists for: the prefilter's regexes are a hand-written
// mirror of three lists the USER owns and edits —
//
//   config/profile.yml → student_constraints.study_field.reject
//   modes/_brief.md    → "Core stack outside the CV" (Hard DQ)
//   modes/_brief.md    → "Location Scoring"
//
// A self-test passes happily while those lists and the regexes say different
// things, because it asserts against titles the same author invented. Writing
// "Physik" into profile.yml and expecting the prefilter to honour it is a
// reasonable thing for the user to do, and until this file existed it silently
// did nothing. These checks fail loudly instead.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';

console.log('\nUtility - triage-prefilter drift guards');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'triage-prefilter.mjs')).href);
  const { DISCIPLINE_FLAG_RE, DEPT_FLAG_RE, STACK_FLAG_RE, REACH_SCORE } = mod;

  // ── Guard 1: study_field.reject ⟷ DISCIPLINE_FLAG_RE / DEPT_FLAG_RE ──
  //
  // Either regex satisfies the guard. The profile's reject list mixes study
  // FIELDS ("Maschinenbau") with what are, in a job title, DEPARTMENTS
  // ("Marketing", "Jura"), and the prefilter splits those across two regexes
  // because they carry different false-positive risks. The contract being pinned
  // is "the prefilter reacts to this term at all", not "in which regex".
  let profile = null;
  try {
    profile = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8'));
  } catch (e) {
    fail(`could not read config/profile.yml for the drift guard: ${e.message}`);
  }

  const reject = profile?.student_constraints?.study_field?.reject;
  if (!Array.isArray(reject) || reject.length === 0) {
    fail('config/profile.yml has no student_constraints.study_field.reject list — the drift guard has nothing to check');
  } else {
    for (const term of reject) {
      // The regexes are word-bounded, so a bare term is the right probe: if it
      // does not match on its own it will not match inside a title either.
      if (DISCIPLINE_FLAG_RE.test(term) || DEPT_FLAG_RE.test(term)) {
        pass(`study_field.reject "${term}" is recognised by the prefilter`);
      } else {
        fail(`study_field.reject "${term}" matches neither DISCIPLINE_FLAG_RE nor DEPT_FLAG_RE — the prefilter will not act on it (add the term, or drop it from config/profile.yml)`);
      }
    }
  }

  // ── Guard 2: "Core stack outside the CV" ⟷ STACK_FLAG_RE ──
  let brief = '';
  try {
    brief = readFileSync(join(ROOT, 'modes', '_brief.md'), 'utf-8');
  } catch (e) {
    fail(`could not read modes/_brief.md for the drift guard: ${e.message}`);
  }

  // The bullet wraps onto a continuation line, so take the bullet plus every
  // following indented line. Matching a fixed two-line shape would break the
  // moment someone reflows the paragraph.
  const briefLines = brief.split(/\r?\n/);
  const stackIdx = briefLines.findIndex((l) => /^[-*]\s+.*core stack outside the cv/i.test(l));
  if (stackIdx === -1) {
    fail('modes/_brief.md has no "Core stack outside the CV" bullet — the off-stack drift guard is dead, re-point it at the renamed section');
  } else {
    let raw = briefLines[stackIdx].replace(/^[-*]\s+.*core stack outside the cv\s*:?\s*/i, '');
    for (let i = stackIdx + 1; i < briefLines.length && /^\s+\S/.test(briefLines[i]); i++) {
      raw += ` ${briefLines[i].trim()}`;
    }
    const terms = raw
      .replace(/\s+$/, '')
      .replace(/\.$/, '')          // sentence-final period; ".NET" keeps its leading dot
      .split(/[,/]/)
      .map((t) => t.replace(/\*\*/g, '').trim())
      .filter(Boolean);

    if (terms.length < 5) {
      fail(`parsed only ${terms.length} off-stack terms from modes/_brief.md — the bullet's shape changed, so this guard is no longer reading it`);
    } else {
      for (const term of terms) {
        if (STACK_FLAG_RE.test(term)) pass(`off-stack "${term}" is recognised by STACK_FLAG_RE`);
        else fail(`modes/_brief.md lists "${term}" as an off-stack core, but STACK_FLAG_RE does not match it — postings naming it are ranked as if it were on-stack`);
      }
    }
  }

  // ── Guard 3: Location Scoring table ⟷ REACH_SCORE ──
  //
  // The prefilter's numbers are the same fact as the prose table, and a report
  // that scores a Munich role 4.0 while the brief says otherwise is worse than
  // one that scores nothing. Only the tiers the prefilter can actually tell
  // apart from a location string are pinned: it cannot see a hybrid split, so
  // "Munich hybrid 4.0 vs on-site 2.0" collapses to the optimistic 4.0. The 2.0
  // row and the split "hybrid 1.5; on-site 1.0" row therefore have no
  // counterpart here — REACH_SCORE.germany takes the 1.5 half unconditionally,
  // and a one-number regex cannot pin a two-number row without asserting a
  // reading of it that the prose does not make.
  const scoreOf = (label) => {
    const re = new RegExp(`^[-*]\\s+.*${label}.*?\\*\\*(\\d+(?:\\.\\d+)?)\\*\\*`, 'im');
    const m = re.exec(brief);
    return m ? Number(m[1]) : null;
  };
  const tiers = [
    ['home', 'Erlangen / N', 'the home-base row'],
    ['munich', 'Munich hybrid', 'the Munich hybrid row'],
    ['remote', 'fully remote', 'the remote-in-Germany row'],
    ['germany', 'Anywhere else in Germany', 'the elsewhere-in-Germany row (in scope since 2026-10-03)'],
    ['abroad', 'Outside Germany', 'the outside-Germany row'],
  ];
  for (const [key, label, human] of tiers) {
    const expected = scoreOf(label);
    if (expected === null) {
      fail(`could not find ${human} in the modes/_brief.md Location Scoring table — guard is stale`);
    } else if (REACH_SCORE[key] === expected) {
      pass(`REACH_SCORE.${key} = ${expected} matches ${human}`);
    } else {
      fail(`REACH_SCORE.${key} is ${REACH_SCORE[key]} but modes/_brief.md scores ${human} at ${expected}`);
    }
  }

  // ── Guard 4: importing the module must not run the CLI ──
  // Everything above depends on the entry-point guard at the bottom of
  // triage-prefilter.mjs holding. If it regresses, importing here would read
  // data/pipeline.md, print JSON, and call process.exit — killing the whole
  // in-process suite with a green-looking exit 0. Reaching this line at all
  // proves it held; assert it explicitly so the reason is recorded.
  if (typeof mod.rankEntry === 'function') pass('importing triage-prefilter.mjs exports its API without running the CLI');
  else fail('triage-prefilter.mjs does not export rankEntry');

  // An uninformative location must never be read as evidence a role is abroad.
  // 'abroad' scores 1.0 and hard-skips the posting, so a location cell nobody
  // filled in silently discards it. A DLR (German Aerospace Center) working
  // student ML posting was dropped as "outside Germany" purely because its cell
  // read "?". Not knowing where a role is is not knowing.
  const { classifyReach, rankEntry } = mod;
  for (const placeholder of ['', '?', '-', 'N/A', 'n/a', 'none', 'unknown', 'TBD', 'various']) {
    const got = classifyReach(placeholder);
    if (got === 'unknown') pass(`classifyReach(${JSON.stringify(placeholder)}) is "unknown", not "abroad"`);
    else fail(`classifyReach(${JSON.stringify(placeholder)}) returned "${got}"`);
  }
  // Real locations must be unaffected by the placeholder rule.
  for (const [loc, want] of [['Erlangen', 'home'], ['Cologne', 'germany'], ['Bangalore', 'abroad']]) {
    const got = classifyReach(loc);
    if (got === want) pass(`classifyReach("${loc}") is still "${want}"`);
    else fail(`classifyReach("${loc}") returned "${got}", expected "${want}"`);
  }
  const dlr = rankEntry({ url: 'https://jobs.dlr.de/job/x', company: 'DLR', title: 'Working student (f/m/d) Machine Learning', location: '?' });
  if (dlr.bucket === 'look') pass('a student ML posting with a placeholder location survives the pre-screen gate');
  else fail(`the DLR-shaped row bucketed as "${dlr.bucket}" (${dlr.reason})`);
} catch (e) {
  fail(`triage-prefilter drift guards crashed: ${e.message}`);
}
