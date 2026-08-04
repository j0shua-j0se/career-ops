// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

import './_dns-cache.mjs'; // memoize dns.lookup process-wide (see that file)

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

/**
 * Browser-like User-Agent for providers that must clear WAF/CDN bot
 * management blocking the default career-ops UA outright (seen live:
 * Glints' firewall, Geico's Cloudflare-gated Workday tenant). Shared so
 * every provider working around such a block bumps one constant instead
 * of drifting Chrome versions independently per file.
 */
export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * SSRF guard. Providers fetch public job boards, so any request aimed at
 * loopback, link-local, RFC1918 or cloud-metadata space is either a
 * misconfigured portals.yml entry or an attack — both should fail loudly.
 *
 * This checks the URL as written. A public hostname that *resolves* to a
 * private address (DNS rebinding) is NOT caught here; closing that needs
 * resolve-then-pin against `_dns-cache.mjs`, which is a separate change.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']);
const PRIVATE_IPV4 = /^(?:10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./;

/** @param {string} hostname */
function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/** @param {string} host */
function isBlockedHost(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (PRIVATE_IPV4.test(host)) return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(host)) return true; // IPv6 unique-local
  if (/^fe80:/.test(host)) return true; // IPv6 link-local
  if (/^\d+$/.test(host)) return true; // decimal IP literal (2130706433 === 127.0.0.1)
  if (/^0x[0-9a-f]+$/.test(host)) return true; // hex IP literal
  return false;
}

/** @param {string} host @param {string[]} allowHosts */
function hostAllowed(host, allowHosts) {
  return allowHosts.some((allowed) => {
    const a = String(allowed).toLowerCase().replace(/^\*?\./, '');
    return host === a || host.endsWith(`.${a}`);
  });
}

/**
 * Validate a URL before it is fetched. Exported so providers can pin their own
 * hosts (`assertSafeUrl(url, { allowHosts: ['lever.co'] })`) and so tests can
 * exercise the guard directly.
 *
 * `allowPrivateHosts` exists for ONE caller: the loopback HTTP server in
 * tests/providers/http-timeout.test.mjs, which has to bind 127.0.0.1 to prove
 * the abort timer covers the body read. It is opt-in per call — never an env
 * var, never a module-level flag — so it cannot leak into another test in the
 * same process, and it can never be reached from portals.yml data. No provider
 * may pass it; test-all.mjs asserts that (section 1) rather than trusting
 * review to catch it.
 *
 * @param {string} rawUrl
 * @param {{ allowHosts?: string[] | null, allowPrivateHosts?: boolean }} [opts]
 * @returns {URL}
 */
export function assertSafeUrl(rawUrl, { allowHosts = null, allowPrivateHosts = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`blocked: not a valid absolute URL (${String(rawUrl).slice(0, 120)})`);
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new Error(`blocked: protocol ${u.protocol} is not http(s) — ${u.href}`);
  }
  const host = normalizeHost(u.hostname);
  if (!allowPrivateHosts && isBlockedHost(host)) {
    throw new Error(`blocked: ${host} is a private, loopback or link-local address`);
  }
  if (allowHosts && !hostAllowed(host, allowHosts)) {
    throw new Error(`blocked: ${host} is not in the provider allowlist [${allowHosts.join(', ')}]`);
  }
  return u;
}

// `redirect` defaults to 'error', not 'follow': a 3xx from a job board to an
// internal address is an SSRF vector, and 61 of 67 providers were already
// passing 'error' by hand. Making it the default means a new provider is safe
// by omission; the few sources that genuinely need to follow a hop must now
// opt in with an explicit `redirect: 'follow'`.
async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'error', allowHosts = null, allowPrivateHosts = false } = {}, consume) {
  assertSafeUrl(url, { allowHosts, allowPrivateHosts });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
      // text — HTML markup or a generic interstitial message, not worth
      // parsing or displaying. The status code and its standard reason
      // phrase are what a log line needs; the raw body is still attached as
      // err.body for callers that want to inspect it.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.body = responseText;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    // Body consumption must stay inside the timer window: a server that sends
    // headers and then stalls the body otherwise hangs the caller forever
    // (this froze full-directory sweeps silently — 20 workers all stuck on
    // stalled reads with the abort timer already cleared).
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.json());
}

export async function fetchText(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.text());
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
