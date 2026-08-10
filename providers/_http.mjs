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

// Returns the raw Response (after the timeout + non-2xx guard) so providers that
// need response headers — e.g. startup.ch reads Set-Cookie to prime a session —
// can route through ctx instead of re-implementing fetch. Pass redirect:'error'
// like every other provider call so a 3xx can't be followed to a private IP.
export async function fetchResponse(url, opts = {}) {
  return await fetchWithTimeout(url, opts);
}

/** Jitter added to a backoff so concurrent retries don't re-collide in lockstep. */
const JITTER_MS = 250;

/**
 * Retry policy shared by providers that paginate a large board.
 *
 * Two retries = three total attempts, matching what #2506 asked for. workday's
 * private copy used three (four attempts); it can pass `{ retries: 3 }`
 * explicitly if it converges onto this helper, which is exactly why the policy
 * is a parameter rather than baked in.
 */
const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

/** Awaitable sleep that honours a ctx-supplied clock, so tests never wall-clock wait. */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Milliseconds from a Retry-After header, in either permitted form (delta
 * seconds or an HTTP-date). Null when absent or unparseable.
 */
export function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * Whether a failed request is worth retrying: 429, any 5xx, or a transport
 * error (no status — timeout/abort/DNS). A 4xx other than 429 is the server
 * telling us the request itself is wrong, and retrying it just burns time.
 */
export function isRetryableError(err) {
  const status = err?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return status === undefined; // network error / timeout / abort — no status set
}

/**
 * Fetch JSON with bounded retry on transient failures.
 *
 * Lifted out of providers/workday.mjs, which had carried this logic privately
 * since it was the only paginating provider. It isn't any more: a16z-speedrun
 * paginates ~350 pages, and one transient 5xx anywhere in that range aborted
 * the whole run and returned nothing (#2506). oraclecloud.mjs grew a third
 * copy. Shared here so a provider gets the mature semantics — exponential
 * backoff, jitter, and a Retry-After that is honoured but CLAMPED so a hostile
 * or misconfigured `Retry-After: 86400` cannot stall a sweep — instead of each
 * one re-deriving them.
 *
 * Deliberately does NOT decide what happens when retries are exhausted: it
 * rethrows, and the caller chooses. That policy genuinely differs per provider
 * — workday truncates the tenant with a warning and keeps the pages it has,
 * while a16z must fail loudly rather than return a silent partial board.
 *
 * @param {{fetchJson: Function, sleep?: Function}} ctx - Transport context.
 * @param {string} url - Absolute URL.
 * @param {object} [opts] - Passed through to ctx.fetchJson.
 * @param {{retries?: number, baseDelayMs?: number, maxDelayMs?: number}} [policy]
 * @returns {Promise<any>} Parsed JSON.
 */
export async function fetchJsonWithRetry(ctx, url, opts = {}, policy = {}) {
  const { retries, baseDelayMs, maxDelayMs } = { ...RETRY_DEFAULTS, ...policy };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ctx.fetchJson(url, opts);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableError(err)) throw err;
      // Cap the backoff at maxDelayMs MINUS the jitter, so the jittered total
      // still honours the policy limit. Clamping the sum instead would erase
      // the jitter exactly at the cap — where every retry has converged on the
      // same delay and de-synchronising them matters most.
      //
      // The jitter itself is clamped to maxDelayMs first: a caller passing a
      // maxDelayMs below JITTER_MS would otherwise drive the backoff negative
      // and hand ctx.sleep a negative delay.
      const jitterMs = Math.min(JITTER_MS, Math.max(0, maxDelayMs));
      const ceiling = Math.max(0, maxDelayMs - jitterMs);
      const backoff = Math.min(baseDelayMs * 2 ** attempt, ceiling);
      const retryAfterMs = parseRetryAfterMs(err?.retryAfter);
      const delayMs = retryAfterMs !== null
        ? Math.min(retryAfterMs, maxDelayMs * 4)
        : backoff + Math.random() * jitterMs;
      await sleep(delayMs, ctx);
    }
  }
  throw lastErr;
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
    fetchResponse,
  };
}
