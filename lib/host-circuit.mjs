#!/usr/bin/env node
// @ts-check
/**
 * lib/host-circuit.mjs — circuit breaker for job-board hosts that have started
 * refusing this machine.
 *
 * WHY: providers/stepstone.mjs and providers/indeed.mjs used to route around a
 * 403 with `scrapling stealthy-fetch` (bot-detection evasion). That is exactly
 * the kind of request a job board's own policy exists to stop, and on
 * 2026-09-23 StepStone started answering HTTP 403 to both this machine AND the
 * user's own browser on the same IP — very likely triggered by that stealth
 * traffic. The fix is not a stealthier fetch; it's fetching honestly (plain
 * HTTP, honest UA, robots.txt respected — see providers/stepstone.mjs and
 * providers/indeed.mjs) and, when a host still refuses, STOPPING rather than
 * escalating: no more requests to that host for a cooldown window, so a single
 * pass never turns into a hundred retries against a site that has already said
 * no.
 *
 * State lives at `data/host-blocks.json` (user layer — matches every other
 * `data/*` file's data-contract tier, gitignored via the blanket `data/*`
 * rule). Every caller resolves the SAME path through `getCareerOpsRoot()`
 * (`path-resolver.mjs`), so a trip recorded by one script is seen by every
 * other consumer without a second config layer to keep in sync.
 *
 * API:
 *   tripHost(host, {status, reason, days=14, now?})  — record a block, returns the entry
 *   isHostBlocked(host, now?)                        — the active entry for `host` (or any of
 *                                                        its parent domains it is a subdomain
 *                                                        of), or null when nothing is blocking it
 *   clearHost(host)                                  — remove a block; true if one existed
 *   listBlockedHosts(now?)                            — every recorded entry, `active` flagged
 *
 * `host` and the state keys are stored NORMALIZED (lowercase, `www.` prefix
 * stripped — see normalizeHost()) so `tripHost('www.StepStone.de', ...)` and
 * `isHostBlocked('m.stepstone.de')` agree with each other and with
 * `isHostBlocked('stepstone.de')`. Matching is by exact host OR by the queried
 * host being a SUBDOMAIN of a blocked one (`aastat.stepstone.de` is blocked by
 * a `stepstone.de` trip) — never the other way around, so blocking a narrow
 * subdomain never silently blocks its parent domain's other traffic.
 *
 * CLI:
 *   node lib/host-circuit.mjs --list
 *   node lib/host-circuit.mjs --clear <host>
 *   node lib/host-circuit.mjs --help
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from './is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

// CAREER_OPS_HOST_BLOCKS overrides the state file path — same override
// convention as CAREER_OPS_TRACKER / CAREER_OPS_PROFILE, so tests never touch
// a real user's data/host-blocks.json.
export const HOST_BLOCKS_PATH = process.env.CAREER_OPS_HOST_BLOCKS?.trim()
  ? resolve(CAREER_OPS, process.env.CAREER_OPS_HOST_BLOCKS.trim())
  : join(CAREER_OPS, 'data', 'host-blocks.json');

export const DEFAULT_TRIP_DAYS = 14;

const USAGE = `Usage:
  node lib/host-circuit.mjs --list             # show every recorded host block
  node lib/host-circuit.mjs --clear <host>     # remove a block early
  node lib/host-circuit.mjs --help             # print this usage block and exit`;

/** @param {string} host @returns {string} */
function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

/** @returns {Record<string, {status:any, reason:string, trippedAt:string, until:string, days:number}>} */
function readState() {
  if (!existsSync(HOST_BLOCKS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(HOST_BLOCKS_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt or hand-edited file is not this module's problem to fail
    // loudly over — every caller here is a safety guard, and a guard that
    // throws on bad state is worse than one that fails open to "no known
    // block" and lets a request through (the request itself still goes
    // through the site's own refusal if it is in fact still blocked).
    return {};
  }
}

/** @param {Record<string, any>} state */
function writeState(state) {
  mkdirSync(dirname(HOST_BLOCKS_PATH), { recursive: true });
  writeFileSync(HOST_BLOCKS_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/**
 * Record that `host` refused this machine — no request to it (or a subdomain
 * of it) should be made again until the cooldown elapses.
 *
 * @param {string} host
 * @param {{status?: number|string|null, reason?: string, days?: number, now?: Date}} [opts]
 * @returns {{status: any, reason: string, trippedAt: string, until: string, days: number}}
 */
export function tripHost(host, { status = null, reason = '', days = DEFAULT_TRIP_DAYS, now = new Date() } = {}) {
  const key = normalizeHost(host);
  if (!key) throw new Error('tripHost: host is required');
  const safeDays = Number.isFinite(Number(days)) && Number(days) >= 0 ? Number(days) : DEFAULT_TRIP_DAYS;
  const state = readState();
  const entry = {
    status,
    reason: String(reason || ''),
    trippedAt: now.toISOString(),
    until: new Date(now.getTime() + safeDays * 86_400_000).toISOString(),
    days: safeDays,
  };
  state[key] = entry;
  writeState(state);
  return entry;
}

/**
 * Is `host` (or is it a subdomain of a host that is) currently blocked?
 *
 * @param {string} host
 * @param {Date} [now]
 * @returns {{host: string, status: any, reason: string, trippedAt: string, until: string, days: number}|null}
 */
export function isHostBlocked(host, now = new Date()) {
  const key = normalizeHost(host);
  if (!key) return null;
  const state = readState();
  const nowMs = now.getTime();
  for (const [blockedHost, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || !entry.until) continue;
    if (key !== blockedHost && !key.endsWith(`.${blockedHost}`)) continue;
    const untilMs = Date.parse(entry.until);
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) continue;
    return { host: blockedHost, ...entry };
  }
  return null;
}

/**
 * Remove a recorded block early (e.g. the user confirms access is restored).
 * Only removes an EXACT key match — clearing `stepstone.de` does not touch an
 * independently-tripped `foo.stepstone.de` entry, mirroring tripHost's own
 * per-key granularity.
 *
 * @param {string} host
 * @returns {boolean} true if a block existed and was removed.
 */
export function clearHost(host) {
  const key = normalizeHost(host);
  if (!key) return false;
  const state = readState();
  if (!(key in state)) return false;
  delete state[key];
  writeState(state);
  return true;
}

/**
 * Every recorded entry, each flagged with whether it is still active.
 * @param {Date} [now]
 * @returns {Array<{host: string, status: any, reason: string, trippedAt: string, until: string, days: number, active: boolean}>}
 */
export function listBlockedHosts(now = new Date()) {
  const state = readState();
  return Object.entries(state)
    .map(([host, entry]) => {
      const untilMs = Date.parse(entry?.until ?? '');
      const active = Number.isFinite(untilMs) && untilMs > now.getTime();
      return { host, ...entry, active };
    })
    .sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Human-readable one-line summary for a blocked entry, e.g. for a status
 * message that must not issue the request it is describing.
 * @param {{host: string, until: string, reason?: string}} entry
 * @returns {string}
 */
export function describeBlock(entry) {
  const until = entry?.until ? entry.until.slice(0, 10) : 'unknown';
  const reason = entry?.reason ? ` (${entry.reason})` : '';
  return `host blocked until ${until}${reason}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (args.includes('--list')) {
    const rows = listBlockedHosts();
    if (rows.length === 0) {
      console.log('host-circuit: no hosts recorded.');
      return;
    }
    for (const r of rows) {
      const state = r.active ? 'BLOCKED' : 'expired';
      console.log(`${r.host}\t${state}\tuntil ${r.until}\tstatus=${r.status ?? '-'}\treason=${r.reason || '-'}`);
    }
    return;
  }
  const clearIdx = args.indexOf('--clear');
  if (clearIdx !== -1) {
    const host = args[clearIdx + 1];
    if (!host) {
      console.error('host-circuit: --clear requires a host, e.g. --clear stepstone.de');
      process.exitCode = 1;
      return;
    }
    const removed = clearHost(host);
    console.log(removed ? `host-circuit: cleared ${normalizeHost(host)}` : `host-circuit: ${normalizeHost(host)} was not recorded`);
    return;
  }
  console.error(`host-circuit: unrecognized arguments: ${args.join(' ')}`);
  console.error(USAGE);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
