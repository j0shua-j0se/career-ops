// tests/providers/indeed-fetch.test.mjs — providers/indeed.mjs's fetch() no
// longer shells out to `scrapling stealthy-fetch`. It makes a plain HTTP
// request (providers/_http.mjs's fetchText) and, on a refusal (403/429, or a
// recognisable bot-challenge page even on a 200), trips
// lib/host-circuit.mjs's breaker instead of retrying harder — see
// providers/indeed.mjs's file doc.
//
// Every dependency (fetchTextFn, checkRobotsFn, isHostBlockedFn, tripHostFn)
// is injected through fetch()'s second argument, so these run with NO network
// and NO real circuit-breaker state file.
//
// Run:  node --test tests/providers/indeed-fetch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { default: indeed } = await import(pathToFileURL(join(ROOT, 'providers/indeed.mjs')).href);

const DOMAIN = 'de.indeed.com';

function entry(queries) {
  return { name: 'Test board', indeed: { queries, domain: DOMAIN, city: 'Erlangen', radius: 50 } };
}

const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const SEARCH_HTML = `<script>window.mosaic.providerData["mosaic-provider-jobcards"]=`
  + `${JSON.stringify({
    metaData: {
      mosaicProviderJobCardsModel: {
        results: [{
          jobkey: 'abc123', title: 'Werkstudent Data Science', company: 'Acme GmbH', formattedLocation: 'Erlangen',
        }],
      },
    },
  })};</script>`;

const ALLOW_ALL = async () => ({ retry: true, code: 'allowed', reason: 'permits' });
const DISALLOW = async () => ({ retry: false, code: 'disallowed', reason: 'robots.txt disallows' });
const NEVER_BLOCKED = () => null;

test('circuit-broken domain: zero requests, zero jobs, no throw', async () => {
  let fetchCalls = 0;
  const blockedEntry = { host: DOMAIN, until: '2026-10-07T00:00:00.000Z', reason: 'HTTP 403' };
  const jobs = await indeed.fetch(entry(['werkstudent data science']), {
    fetchTextFn: async () => { fetchCalls++; return SEARCH_HTML; },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: () => blockedEntry,
    tripHostFn: () => { throw new Error('must not trip an already-tripped breaker'); },
  });
  assert.deepEqual(jobs, []);
  assert.equal(fetchCalls, 0, 'a blocked domain must receive zero requests');
});

test('a 403 trips the breaker, returns zero jobs, does not throw, and stops the loop', async () => {
  let fetchCalls = 0;
  const trips = [];
  const jobs = await indeed.fetch(entry(['q1', 'q2']), {
    fetchTextFn: async () => { fetchCalls++; throw httpErr(403); },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: (host, opts) => { trips.push({ host, ...opts }); return {}; },
  });
  assert.deepEqual(jobs, []);
  assert.equal(fetchCalls, 1, 'must stop after the first refusal instead of trying the second query');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].host, DOMAIN);
  assert.equal(trips[0].status, 403);
  assert.equal(trips[0].days, 14);
});

test('a 429 also trips the breaker', async () => {
  const trips = [];
  await indeed.fetch(entry(['q1']), {
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
  const jobs = await indeed.fetch(entry(['q1']), {
    fetchTextFn: async () => '<html><body>Additional Verification Required — are you a human?</body></html>',
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
  await assert.rejects(() => indeed.fetch(entry(['q1']), {
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
  const jobs = await indeed.fetch(entry(['q1']), {
    fetchTextFn: async () => { fetchCalls++; return SEARCH_HTML; },
    checkRobotsFn: ALLOW_ALL,
    isHostBlockedFn: NEVER_BLOCKED,
    tripHostFn: () => { throw new Error('must not trip on a clean 200'); },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'Acme GmbH');
});
