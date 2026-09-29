// tests/providers/stepstone-fetch.test.mjs — providers/stepstone.mjs's fetch()
// no longer shells out to `scrapling stealthy-fetch`. It makes a plain HTTP
// request (providers/_http.mjs's fetchText) and, on a refusal (403/429, or a
// recognisable bot-challenge page even on a 200), trips
// lib/host-circuit.mjs's breaker instead of retrying harder — see
// providers/stepstone.mjs's file doc for why (StepStone 403ing this machine's
// whole IP since 2026-09-23, very likely from exactly this kind of traffic).
//
// Every dependency (fetchTextFn, checkRobotsFn, isHostBlockedFn, tripHostFn)
// is injected through fetch()'s second argument, so these run with NO network
// and NO real circuit-breaker state file.
//
// Run:  node --test tests/providers/stepstone-fetch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { default: stepstone } = await import(pathToFileURL(join(ROOT, 'providers/stepstone.mjs')).href);

const HOST = 'www.stepstone.de';

function entry(queries) {
  return { name: 'Test board', stepstone: { queries, city: 'erlangen', radius: 50 } };
}

const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const SEARCH_HTML = `<div data-at="job-item"><a data-at="job-item-title" href="/stellenangebote--x--1">Werkstudent Data Science</a>`
  + `<span data-at="job-item-company-name">Acme GmbH</span><span data-at="job-item-location">Erlangen</span></div>`;

const ALLOW_ALL = async () => ({ retry: true, code: 'allowed', reason: 'permits' });
const DISALLOW = async () => ({ retry: false, code: 'disallowed', reason: 'robots.txt disallows' });
const NEVER_BLOCKED = () => null;

test('circuit-broken host: zero requests, zero jobs, no throw', async () => {
  let fetchCalls = 0;
  const blockedEntry = { host: HOST, until: '2026-10-07T00:00:00.000Z', reason: 'HTTP 403' };
  const jobs = await stepstone.fetch(entry(['werkstudent-data-science']), {
    fetchTextFn: async () => { fetchCalls++; return SEARCH_HTML; },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: () => blockedEntry,
    tripHostFn: () => { throw new Error('must not trip an already-tripped breaker'); },
  });
  assert.deepEqual(jobs, []);
  assert.equal(fetchCalls, 0, 'a blocked host must receive zero requests');
});

test('a 403 trips the breaker, returns zero jobs, does not throw, and stops the loop', async () => {
  let fetchCalls = 0;
  const trips = [];
  const jobs = await stepstone.fetch(entry(['q1', 'q2']), {
    fetchTextFn: async () => { fetchCalls++; throw httpErr(403); },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: (host, opts) => { trips.push({ host, ...opts }); return {}; },
  });
  assert.deepEqual(jobs, []);
  assert.equal(fetchCalls, 1, 'must stop after the first refusal instead of trying the second query');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].host, HOST);
  assert.equal(trips[0].status, 403);
  assert.equal(trips[0].days, 14);
});

test('a 429 also trips the breaker', async () => {
  const trips = [];
  await stepstone.fetch(entry(['q1']), {
    fetchTextFn: async () => { throw httpErr(429); },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: (host, opts) => { trips.push({ host, ...opts }); return {}; },
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].status, 429);
});

test('a bot-challenge page on HTTP 200 also trips the breaker', async () => {
  const trips = [];
  const jobs = await stepstone.fetch(entry(['q1']), {
    fetchTextFn: async () => '<html><body>Pardon Our Interruption... please verify you are a human</body></html>',
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: (host, opts) => { trips.push({ host, ...opts }); return {}; },
  });
  assert.deepEqual(jobs, []);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].status, 200);
});

test('robots.txt disallow skips the query without a request, and never trips the breaker', async () => {
  let fetchCalls = 0;
  const trips = [];
  await assert.rejects(() => stepstone.fetch(entry(['q1']), {
    fetchTextFn: async () => { fetchCalls++; return SEARCH_HTML; },
    checkRobotsFn: DISALLOW,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: (host, opts) => { trips.push({ host, ...opts }); return {}; },
  }));
  assert.equal(fetchCalls, 0);
  assert.equal(trips.length, 0, 'a policy refusal is not the same as a live host block');
});

test('a normal successful fetch parses jobs and makes one request per query', async () => {
  let fetchCalls = 0;
  const jobs = await stepstone.fetch(entry(['q1']), {
    fetchTextFn: async () => { fetchCalls++; return SEARCH_HTML; },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: () => { throw new Error('must not trip on a clean 200'); },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'Acme GmbH');
});
