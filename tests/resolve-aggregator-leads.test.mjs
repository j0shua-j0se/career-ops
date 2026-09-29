// tests/resolve-aggregator-leads.test.mjs — resolve-aggregator-leads.mjs
// resolves StepStone/Indeed pipeline leads to the employer's own posting
// before they reach the user, and never deletes an unresolved one.
//
// HERMETIC: every test injects a fake `resolveFn` (never the real, network-
// touching `resolveEmployerPosting`), so this suite makes zero network calls.
//
// Run:  node --test tests/resolve-aggregator-leads.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const mod = await import(pathToFileURL(join(ROOT, 'resolve-aggregator-leads.mjs')).href);
const {
  isAggregatorUrl, rewriteResolvedLine, rewriteUnresolvedLine, resolveAggregatorLeads, applyPipelineChanges,
} = mod;
const { parsePipeline } = await import(pathToFileURL(join(ROOT, 'triage-prefilter.mjs')).href);

// ── isAggregatorUrl ─────────────────────────────────────────────────────────

test('isAggregatorUrl matches stepstone.de and indeed.* (subdomain-inclusive), never an unrelated host', () => {
  assert.equal(isAggregatorUrl('https://www.stepstone.de/stellenangebote--x--1.html'), true);
  assert.equal(isAggregatorUrl('https://de.indeed.com/viewjob?jk=abc'), true);
  assert.equal(isAggregatorUrl('https://indeed.com/jobs?q=x'), true);
  assert.equal(isAggregatorUrl('https://jobs.ashbyhq.com/acme/1'), false);
  assert.equal(isAggregatorUrl('https://notstepstone.de/x'), false, 'must not match a host that merely CONTAINS the suffix as a substring');
  assert.equal(isAggregatorUrl('not a url'), false);
});

test('isAggregatorUrl honours a custom host list', () => {
  assert.equal(isAggregatorUrl('https://otherboard.example/x', ['otherboard.example']), true);
  assert.equal(isAggregatorUrl('https://www.stepstone.de/x', ['otherboard.example']), false);
});

// ── line rewriting (pure) ───────────────────────────────────────────────────

test('rewriteResolvedLine replaces the URL cell and keeps the aggregator URL as provenance in note:', () => {
  const line = '- [ ] https://www.stepstone.de/stellenangebote--x--1.html | Acme GmbH | Werkstudent Data Science | Erlangen';
  const out = rewriteResolvedLine(line, {
    employerUrl: 'https://jobs.ashbyhq.com/acme/data-science',
    aggregatorUrl: 'https://www.stepstone.de/stellenangebote--x--1.html',
    host: 'stepstone.de',
  });
  assert.match(out, /^- \[ \] https:\/\/jobs\.ashbyhq\.com\/acme\/data-science \|/);
  assert.match(out, /Acme GmbH \| Werkstudent Data Science \| Erlangen/);
  assert.match(out, /note: resolved from stepstone\.de lead: https:\/\/www\.stepstone\.de\/stellenangebote--x--1\.html/);
});

test('rewriteResolvedLine appends to an existing note rather than clobbering it', () => {
  const line = '- [ ] https://www.stepstone.de/x--1.html | Acme | Role | Erlangen | note: curated shortlist';
  const out = rewriteResolvedLine(line, { employerUrl: 'https://jobs.ashbyhq.com/acme/1', aggregatorUrl: 'https://www.stepstone.de/x--1.html', host: 'stepstone.de' });
  assert.match(out, /note: curated shortlist; resolved from stepstone\.de lead:/);
});

test('rewriteUnresolvedLine marks the line, is idempotent, and never touches the URL', () => {
  const line = '- [ ] https://de.indeed.com/viewjob?jk=abc | Acme | Role | Munich';
  const once = rewriteUnresolvedLine(line);
  assert.match(once, /^- \[ \] https:\/\/de\.indeed\.com\/viewjob\?jk=abc \|/, 'URL cell is untouched for an unresolved lead');
  assert.match(once, /note: aggregator-only, unresolved/);
  const twice = rewriteUnresolvedLine(once);
  assert.equal(twice, once, 're-marking an already-marked line must be a no-op, not a growing note');
});

test('a line that does not parse is returned unchanged', () => {
  assert.equal(rewriteResolvedLine('not a pipeline line', { employerUrl: 'x', aggregatorUrl: 'y', host: 'z' }), 'not a pipeline line');
  assert.equal(rewriteUnresolvedLine('not a pipeline line'), 'not a pipeline line');
});

// ── resolveAggregatorLeads (fake resolver, no network) ──────────────────────

function entry(overrides) {
  return {
    company: 'Acme GmbH', title: 'Werkstudent Data Science', location: 'Erlangen', url: 'https://www.stepstone.de/x--1.html', raw: null, ...overrides,
  };
}

test('resolveAggregatorLeads only considers aggregator-host entries — an employer URL entry is ignored entirely', async () => {
  const calls = [];
  const resolveFn = async (target) => { calls.push(target); return null; };
  const { results, resolvedCount, total } = await resolveAggregatorLeads(
    [entry(), entry({ url: 'https://jobs.ashbyhq.com/acme/1' })],
    { resolveFn },
  );
  assert.equal(total, 1);
  assert.equal(resolvedCount, 0);
  assert.equal(calls.length, 1, 'the resolver must never be called for a non-aggregator entry');
  assert.equal(results[0].resolved, false);
});

test('resolveAggregatorLeads reports a match as resolved, with the employer URL attached', async () => {
  const resolveFn = async () => ({ url: 'https://jobs.ashbyhq.com/acme/ds', title: 'Werkstudent Data Science', location: 'Erlangen', score: 0.9 });
  const { results, resolvedCount, total } = await resolveAggregatorLeads([entry()], { resolveFn });
  assert.equal(total, 1);
  assert.equal(resolvedCount, 1);
  assert.equal(results[0].resolved, true);
  assert.equal(results[0].employerUrl, 'https://jobs.ashbyhq.com/acme/ds');
  assert.equal(results[0].host, 'stepstone.de');
});

test('resolveAggregatorLeads reports a null match as unresolved, never throwing', async () => {
  const resolveFn = async () => null;
  const { results, resolvedCount, total } = await resolveAggregatorLeads([entry()], { resolveFn });
  assert.equal(total, 1);
  assert.equal(resolvedCount, 0);
  assert.equal(results[0].resolved, false);
});

test('resolveAggregatorLeads survives a resolver that throws — reported as unresolved with the error, not a crash', async () => {
  const resolveFn = async () => { throw new Error('discover-ats probe timed out'); };
  const { results, resolvedCount, total } = await resolveAggregatorLeads([entry()], { resolveFn });
  assert.equal(total, 1);
  assert.equal(resolvedCount, 0);
  assert.equal(results[0].resolved, false);
  assert.match(results[0].error, /timed out/);
});

test('resolveAggregatorLeads coverage is exactly resolvedCount/total across a mixed batch', async () => {
  const resolveFn = async (target) => (target.company === 'Acme GmbH' ? { url: 'https://jobs.ashbyhq.com/acme/1' } : null);
  const { resolvedCount, total } = await resolveAggregatorLeads(
    [entry({ company: 'Acme GmbH' }), entry({ company: 'Beta AG', url: 'https://de.indeed.com/viewjob?jk=x' })],
    { resolveFn },
  );
  assert.equal(total, 2);
  assert.equal(resolvedCount, 1);
});

test('resolveAggregatorLeads passes probe and portals through to the resolver unchanged', async () => {
  let seenOpts;
  const resolveFn = async (_target, opts) => { seenOpts = opts; return null; };
  const portals = { tracked_companies: [] };
  await resolveAggregatorLeads([entry()], {
    resolveFn, probe: true, portals,
  });
  assert.equal(seenOpts.probe, true);
  assert.equal(seenOpts.portals, portals);
});

// ── applyPipelineChanges (keyed by URL, prescan.mjs's markExpiredInPipeline technique) ──

test('applyPipelineChanges rewrites only the matching, non-done line(s), leaving everything else byte-identical', () => {
  const md = [
    '## Pending',
    '- [ ] https://www.stepstone.de/x--1.html | Acme | Role A | Erlangen',
    '- [ ] https://boards.greenhouse.io/other/jobs/1 | Other Co | Role B | Munich',
    '',
    '## Processed',
    '- [x] #001 | https://www.stepstone.de/x--1.html | Acme | Role A (already done, must not be touched)',
  ].join('\n');

  const transformByUrl = new Map([
    ['https://www.stepstone.de/x--1.html', (line) => rewriteResolvedLine(line, {
      employerUrl: 'https://jobs.ashbyhq.com/acme/a', aggregatorUrl: 'https://www.stepstone.de/x--1.html', host: 'stepstone.de',
    })],
  ]);
  const { text, applied } = applyPipelineChanges(md, transformByUrl);
  assert.equal(applied, 1);
  assert.match(text, /jobs\.ashbyhq\.com\/acme\/a \| Acme \| Role A \| Erlangen \| note: resolved from stepstone\.de/);
  assert.match(text, /boards\.greenhouse\.io\/other\/jobs\/1 \| Other Co \| Role B \| Munich/, 'an unrelated line is untouched');
  assert.match(text, /- \[x\] #001 \| https:\/\/www\.stepstone\.de\/x--1\.html \| Acme \| Role A \(already done, must not be touched\)/, 'a [x] row sharing the same URL is never rewritten');

  // The rewritten pending line still parses cleanly.
  const { pending } = parsePipeline(text);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].url, 'https://jobs.ashbyhq.com/acme/a');
});

test('applyPipelineChanges with an empty map is a true no-op (same string back)', () => {
  const md = '## Pending\n- [ ] https://x/1 | A | B\n';
  const { text, applied } = applyPipelineChanges(md, new Map());
  assert.equal(text, md);
  assert.equal(applied, 0);
});
