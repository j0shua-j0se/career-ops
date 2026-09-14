#!/usr/bin/env node

/**
 * robots-gate.mjs — may we retry this URL as a browser?
 *
 * `user-agent.mjs` ships two identities: an honest `career-ops/1.0` agent and a
 * `BROWSER_LIKE_USER_AGENT` that looks like Chrome. Escalating from the first to the
 * second is sometimes right and sometimes not, and until now nothing in this
 * repo decided which. On 2026-08-31 five Siemens requisitions were re-probed
 * with the browser UA on judgement alone, without anyone reading
 * jobs.siemens.com/robots.txt.
 *
 * The distinction that matters (from the ai-job-search framework's
 * tools/robots_check.py, MIT — github.com/MadsLorentzen/ai-job-search):
 *
 *   - A WAF default on a site whose PUBLISHED POLICY allows access. The policy
 *     says yes; a firewall rejects any client that does not look like a browser.
 *     Retrying overrides a firewall default, not an expressed preference. Allow.
 *
 *   - A site that has ACTUALLY DECLINED. robots.txt disallows the path. Retrying
 *     with browser headers circumvents the exact mechanism the site was told it
 *     could rely on. Refuse — find the employer's own posting instead.
 *
 * Deliberately fails CLOSED. RFC 9309 rules, on the cautious side:
 *   - longest matching rule wins; on equal length Disallow wins
 *   - a Disallow for either `*` or our own token blocks the retry
 *   - a blank line does NOT end a record (Node has no robotparser, but this is
 *     the bug that makes Python's fail OPEN on real files, so it is pinned here)
 *   - 404 (or an empty body) means no published policy, which is permission
 *   - a 200 whose body is not recognisably robots.txt is UNREADABLE, not empty:
 *     a soft-404 HTML error page parses to zero rules, and zero rules would
 *     otherwise read as "allowed" — permission that was never given
 *   - any other failure to read the policy leaves permission unconfirmed, and
 *     the retry does not happen
 *
 * Usage:
 *   node robots-gate.mjs <url> [--agent NAME] [--json]
 *   exit 0 = the browser-UA retry may proceed
 *   exit 1 = do not retry
 */

import { pathToFileURL } from 'url';
import { DEFAULT_USER_AGENT, BROWSER_LIKE_USER_AGENT } from './user-agent.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

/** Our own robots token. Matched case-insensitively against User-agent lines. */
export const OWN_AGENT_TOKEN = 'career-ops';

const DIRECTIVES = new Set(['user-agent', 'allow', 'disallow', 'crawl-delay', 'sitemap', 'host']);

/**
 * Does this body actually look like a robots.txt?
 *
 * A misconfigured host can answer /robots.txt with 200 and an HTML error page.
 * That parses to zero rules, and zero rules read as "allowed" — so a soft-200
 * would grant permission nobody gave. An empty body IS a valid allow-all under
 * RFC 9309 and stays allowed; a non-empty body with no recognised directive is
 * treated as unreadable.
 */
export function isRobotsBody(text) {
  const s = String(text ?? '');
  if (!s.trim()) return true;
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim().toLowerCase();
    if (line.includes(':') && DIRECTIVES.has(line.split(':')[0].trim())) return true;
  }
  return false;
}

/**
 * Parse robots.txt into { [agentToken]: [{allow, path}] }.
 *
 * A blank line inside a record does NOT end it. Python's `urllib.robotparser`
 * ends a record at a blank line and matches in file order, which reads a real
 * file with blank lines between `User-agent: *` and its rules as "everything
 * allowed" — failing open, in the one direction that matters here.
 */
export function parseRobots(text) {
  const groups = new Map();
  let current = [];
  let expectingAgents = false;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || !line.includes(':')) continue;
    const field = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    const value = line.slice(line.indexOf(':') + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) { current = []; expectingAgents = true; }
      const token = value.toLowerCase();
      current.push(token);
      if (!groups.has(token)) groups.set(token, []);
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      expectingAgents = false;
      if (current.length === 0) continue; // rules before any User-agent: ignore
      for (const token of current) {
        groups.get(token).push({ allow: field === 'allow', path: value });
      }
    }
  }
  return groups;
}

/** RFC 9309 path match: `*` is any run, a trailing `$` anchors the end. */
export function pathMatches(rule, path) {
  if (rule === '') return false; // an empty Disallow means "allow everything"
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/**
 * Decide for one agent token. Longest match wins; on a tie, Disallow wins.
 * Returns true when the path is allowed for that token.
 */
export function allowedFor(groups, token, path) {
  const rules = groups.get(token.toLowerCase());
  if (!rules || rules.length === 0) return true; // no rules for this agent
  let best = null;
  for (const rule of rules) {
    if (!pathMatches(rule.path, path)) continue;
    if (best === null
      || rule.path.length > best.path.length
      || (rule.path.length === best.path.length && !rule.allow)) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

/**
 * The verdict, given a policy body and status. Pure — no network.
 *
 * @returns {{retry: boolean, reason: string, code: string}}
 */
export function decide({ status, body, path, agentToken = OWN_AGENT_TOKEN }) {
  if (status === 404 || status === 410) {
    return { retry: true, code: 'no_policy', reason: 'no robots.txt published (404) — no expressed preference' };
  }
  if (status !== 200) {
    return { retry: false, code: 'unreadable', reason: `robots.txt returned HTTP ${status} — permission unconfirmed` };
  }
  if (!isRobotsBody(body)) {
    return { retry: false, code: 'not_robots', reason: 'robots.txt body is not a policy file (soft-200) — permission unconfirmed' };
  }
  const groups = parseRobots(body);
  for (const token of [agentToken, '*']) {
    if (!allowedFor(groups, token, path)) {
      return {
        retry: false,
        code: 'disallowed',
        reason: `robots.txt disallows ${path} for "${token}" — the site declined; do not retry with browser headers`,
      };
    }
  }
  return { retry: true, code: 'allowed', reason: `robots.txt permits ${path}` };
}

/**
 * Fetch the policy and decide.
 *
 * Read as a browser if the honest request is refused: the WAF usually blocks
 * robots.txt too, and a policy you are prevented from reading cannot be
 * honoured. robots.txt is not the protected resource — but the decision it
 * yields is then obeyed strictly.
 */
export async function checkRobots(url, { agentToken = OWN_AGENT_TOKEN, fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { retry: false, code: 'bad_url', reason: `not a parseable URL: ${url}` };
  }
  if (!/^https?:$/.test(target.protocol)) {
    return { retry: false, code: 'bad_url', reason: `unsupported scheme: ${target.protocol}` };
  }
  const policyUrl = `${target.protocol}//${target.host}/robots.txt`;
  const path = target.pathname + (target.search || '');

  const read = async (ua) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(policyUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': ua, Accept: 'text/plain,*/*' },
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  let attempt;
  try {
    attempt = await read(DEFAULT_USER_AGENT);
    if (attempt.status === 403 || attempt.status === 401) attempt = await read(BROWSER_LIKE_USER_AGENT);
  } catch (error) {
    return { retry: false, code: 'unreadable', reason: `could not read robots.txt: ${error.message}` };
  }
  return { ...decide({ ...attempt, path, agentToken }), policyUrl };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const agentIdx = args.indexOf('--agent');
  const agentToken = agentIdx >= 0 ? args[agentIdx + 1] : OWN_AGENT_TOKEN;
  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (!url) {
    console.error('Usage: node robots-gate.mjs <url> [--agent NAME] [--json]');
    process.exitCode = 1;
    return;
  }
  const verdict = await checkRobots(url, { agentToken });
  if (json) console.log(JSON.stringify(verdict, null, 2));
  else console.log(`${verdict.retry ? '✅ retry permitted' : '⛔ do not retry'} — ${verdict.reason}`);
  process.exitCode = verdict.retry ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`robots-gate: ${error.message}`);
    process.exitCode = 1;
  });
}
