// tests/lib/host-circuit.test.mjs — lib/host-circuit.mjs is the circuit
// breaker every aggregator-facing caller (providers/stepstone.mjs,
// providers/indeed.mjs, fetch-jds.mjs's PLAIN_HTTP + Playwright rungs,
// check-liveness.mjs) consults before sending a request to a host that has
// already refused this machine.
//
// Each test points CAREER_OPS_HOST_BLOCKS at its own throwaway file via
// re-importing the module with a fresh env var (module state is cached per
// resolved path, so each test gets an isolated file) — never the real
// data/host-blocks.json.
//
// Run:  node --test tests/lib/host-circuit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MODULE_PATH = pathToFileURL(join(ROOT, 'lib/host-circuit.mjs')).href;

let counter = 0;
/** Fresh module instance pointed at a throwaway state file. */
async function freshHostCircuit() {
  const dir = mkdtempSync(join(tmpdir(), 'co-hostcircuit-'));
  const file = join(dir, 'host-blocks.json');
  process.env.CAREER_OPS_HOST_BLOCKS = file;
  // Cache-bust: import()ing the same URL twice returns the same module
  // instance, so each test needs a distinct query string to force a fresh
  // top-level HOST_BLOCKS_PATH evaluation against its own env var.
  counter += 1;
  const mod = await import(`${MODULE_PATH}?t=${counter}`);
  return { mod, dir, file };
}

test('a host with no recorded block is not blocked', async () => {
  const { mod } = await freshHostCircuit();
  assert.equal(mod.isHostBlocked('stepstone.de'), null);
});

test('tripHost records a block; isHostBlocked sees it as active', async () => {
  const { mod, file } = await freshHostCircuit();
  const now = new Date('2026-09-23T12:00:00.000Z');
  const entry = mod.tripHost('www.stepstone.de', { status: 403, reason: 'HTTP 403', days: 14, now });
  assert.equal(entry.status, 403);
  assert.equal(entry.until, '2026-10-07T12:00:00.000Z');

  // Persisted to disk, not just held in memory.
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
  assert.ok(onDisk['stepstone.de'], 'the www. prefix is normalized away in the stored key');

  const blocked = mod.isHostBlocked('stepstone.de', new Date('2026-09-24T00:00:00.000Z'));
  assert.ok(blocked, 'still inside the 14-day window');
  assert.equal(blocked.host, 'stepstone.de');
});

test('a block expires after its window', async () => {
  const { mod } = await freshHostCircuit();
  const now = new Date('2026-09-23T00:00:00.000Z');
  mod.tripHost('stepstone.de', { status: 403, days: 14, now });
  const afterExpiry = mod.isHostBlocked('stepstone.de', new Date('2026-10-08T00:00:01.000Z'));
  assert.equal(afterExpiry, null);
});

test('isHostBlocked matches a subdomain of a blocked host, never the reverse', async () => {
  const { mod } = await freshHostCircuit();
  const now = new Date('2026-09-23T00:00:00.000Z');
  mod.tripHost('stepstone.de', { status: 403, days: 14, now });
  assert.ok(mod.isHostBlocked('aastat.stepstone.de', now), 'a subdomain of a blocked host is blocked too');
  assert.ok(mod.isHostBlocked('www.stepstone.de', now), 'www. is normalized, so this is the same host');

  const { mod: mod2 } = await freshHostCircuit();
  mod2.tripHost('aastat.stepstone.de', { status: 403, days: 14, now });
  assert.equal(mod2.isHostBlocked('stepstone.de', now), null, 'blocking a subdomain must not block its parent domain');
});

test('indeed is not tripped by default — only stepstone.de gets seeded in the real repo state', async () => {
  const { mod } = await freshHostCircuit();
  assert.equal(mod.isHostBlocked('de.indeed.com'), null);
});

test('clearHost removes a block early; a no-op clear reports false', async () => {
  const { mod } = await freshHostCircuit();
  mod.tripHost('stepstone.de', { status: 403, days: 14 });
  assert.equal(mod.clearHost('stepstone.de'), true);
  assert.equal(mod.isHostBlocked('stepstone.de'), null);
  assert.equal(mod.clearHost('stepstone.de'), false, 'nothing left to clear');
});

test('tripHost requires a host', async () => {
  const { mod } = await freshHostCircuit();
  assert.throws(() => mod.tripHost(''));
});

test('describeBlock renders a one-line summary with the date and reason', async () => {
  const { mod } = await freshHostCircuit();
  const line = mod.describeBlock({ until: '2026-10-07T00:00:00.000Z', reason: 'HTTP 403' });
  assert.match(line, /2026-10-07/);
  assert.match(line, /HTTP 403/);
});

test('listBlockedHosts flags expired entries as inactive but keeps them listed', async () => {
  const { mod } = await freshHostCircuit();
  mod.tripHost('stepstone.de', { status: 403, days: 14, now: new Date('2026-09-23T00:00:00.000Z') });
  const rows = mod.listBlockedHosts(new Date('2026-10-08T00:00:00.000Z'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, 'stepstone.de');
  assert.equal(rows[0].active, false);
});

test('a corrupt state file is treated as empty rather than throwing', async () => {
  const { mod, file } = await freshHostCircuit();
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'not json{{{', 'utf-8');
  assert.equal(mod.isHostBlocked('stepstone.de'), null);
});

test.after(() => {
  delete process.env.CAREER_OPS_HOST_BLOCKS;
});
