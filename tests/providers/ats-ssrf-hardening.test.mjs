// tests/providers/ats-ssrf-hardening.test.mjs
//
// _http.mjs now defaults to redirect:'error' and screens every URL through
// assertSafeUrl() before fetching. This file covers both halves of that:
// the central guard (protocol, loopback/private space, host allowlist) and
// the redirect default that every provider inherits by omission.
//
// The previous version hardcoded lever + ashby only, and asserted in a comment
// that "every other GET provider passes redirect:'error'". That was false —
// deutschebahn, hecklerkoch, radancy, rheinmetall and softgarden did not. The
// fix moved the guarantee into the transport, so the test targets it there.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readdirSync, readFileSync } from 'fs';

console.log('\nProvider — SSRF hardening (central transport guard)');

const httpUrl = pathToFileURL(join(ROOT, 'providers/_http.mjs')).href;
const { assertSafeUrl, fetchJson } = await import(httpUrl);

// ── assertSafeUrl: what must be rejected ──────────────────────────────
const BLOCKED = [
  ['http://localhost:8080/jobs', 'loopback hostname'],
  ['http://127.0.0.1/jobs', 'loopback IPv4'],
  ['http://10.0.0.5/jobs', 'RFC1918 10/8'],
  ['http://192.168.1.1/jobs', 'RFC1918 192.168/16'],
  ['http://172.16.0.1/jobs', 'RFC1918 172.16/12'],
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata / link-local'],
  ['http://[::1]/jobs', 'IPv6 loopback'],
  ['http://2130706433/jobs', 'decimal IP literal for 127.0.0.1'],
  ['http://api.internal/jobs', '.internal suffix'],
  ['file:///etc/passwd', 'non-http protocol'],
  ['not-a-url', 'unparseable URL'],
];

for (const [url, why] of BLOCKED) {
  try {
    assertSafeUrl(url);
    fail(`assertSafeUrl should reject ${url} (${why})`);
  } catch (e) {
    if (/^blocked:/.test(e.message)) pass(`assertSafeUrl rejects ${why}`);
    else fail(`assertSafeUrl threw the wrong error for ${url}: ${e.message}`);
  }
}

// ── assertSafeUrl: what must be allowed ───────────────────────────────
for (const url of ['https://api.lever.co/v0/postings/example', 'http://jobs.example.com/list?page=2']) {
  try {
    assertSafeUrl(url);
    pass(`assertSafeUrl allows ${url}`);
  } catch (e) {
    fail(`assertSafeUrl should allow ${url}, got: ${e.message}`);
  }
}

// ── assertSafeUrl: opt-in host pinning ────────────────────────────────
try {
  assertSafeUrl('https://api.lever.co/v0/postings/x', { allowHosts: ['lever.co'] });
  pass('assertSafeUrl allows a subdomain of an allowlisted host');
} catch (e) {
  fail(`allowHosts should accept a subdomain: ${e.message}`);
}
try {
  assertSafeUrl('https://evil.example.com/x', { allowHosts: ['lever.co'] });
  fail('assertSafeUrl should reject a host outside allowHosts');
} catch (e) {
  if (/not in the provider allowlist/.test(e.message)) pass('assertSafeUrl enforces allowHosts');
  else fail(`allowHosts rejection had the wrong message: ${e.message}`);
}

// ── assertSafeUrl: the loopback opt-in, and who may use it ────────────
// allowPrivateHosts exists solely so tests/providers/http-timeout.test.mjs can
// reach its own 127.0.0.1 server. It must work, and no provider may use it.
try {
  assertSafeUrl('http://127.0.0.1:8080/stall', { allowPrivateHosts: true });
  pass('assertSafeUrl allows loopback when allowPrivateHosts is explicitly passed');
} catch (e) {
  fail(`allowPrivateHosts should permit loopback: ${e.message}`);
}
try {
  assertSafeUrl('file:///etc/passwd', { allowPrivateHosts: true });
  fail('allowPrivateHosts must not disable the protocol check');
} catch (e) {
  if (/protocol file: is not http/.test(e.message)) pass('allowPrivateHosts relaxes only the host check, never the protocol check');
  else fail(`protocol check under allowPrivateHosts gave: ${e.message}`);
}

{
  // Source-level invariant: an accidental allowPrivateHosts in a provider would
  // reopen SSRF for every board that module fetches, and no runtime assertion
  // would notice. Grep the shipped provider modules instead of trusting review.
  const providerDir = join(ROOT, 'providers');
  const offenders = readdirSync(providerDir)
    .filter((f) => f.endsWith('.mjs') && f !== '_http.mjs')
    .filter((f) => /allowPrivateHosts/.test(readFileSync(join(providerDir, f), 'utf-8')));
  if (offenders.length === 0) pass('no provider module passes allowPrivateHosts (the opt-in stays test-only)');
  else fail(`allowPrivateHosts leaked into provider modules: ${offenders.join(', ')}`);
}

// ── the redirect default every provider inherits ──────────────────────
{
  const originalFetch = globalThis.fetch;
  let seenOpts = null;
  globalThis.fetch = async (_url, opts) => {
    seenOpts = opts;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await fetchJson('https://jobs.example.com/api');
    if (seenOpts?.redirect === 'error') pass('fetchJson defaults to redirect:"error" with no opts');
    else fail(`fetchJson default redirect should be "error", got ${JSON.stringify(seenOpts?.redirect)}`);

    await fetchJson('https://jobs.example.com/api', { redirect: 'follow' });
    if (seenOpts?.redirect === 'follow') pass('an explicit redirect:"follow" still wins (opt-in escape hatch)');
    else fail(`explicit redirect:"follow" was not honored, got ${JSON.stringify(seenOpts?.redirect)}`);
  } catch (e) {
    fail(`redirect-default test crashed: ${e.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── the two providers that pin their host by hand still do ────────────
console.log('\nProvider — SSRF redirect hardening (lever / ashby)');

try {
  const lever = (await import(pathToFileURL(join(ROOT, 'providers/lever.mjs')).href)).default;
  const ashby = (await import(pathToFileURL(join(ROOT, 'providers/ashby.mjs')).href)).default;

  // Each instance must hit its own host — a wrong host silently returns another
  // tenant's (or no) postings instead of erroring.
  let leverUrl = null, leverOpts = null;
  await lever.fetch(
    { name: 'L', careers_url: 'https://jobs.lever.co/example' },
    { transport: 'http', fetchJson: async (u, opts) => { leverUrl = u; leverOpts = opts; return []; }, fetchText: async () => '' },
  );
  if (leverUrl === 'https://api.lever.co/v0/postings/example' && leverOpts?.redirect === 'error') {
    pass('lever.fetch() hits api.lever.co and passes redirect:"error"');
  } else {
    fail(`lever.fetch() default instance: url=${leverUrl}, opts=${JSON.stringify(leverOpts)}`);
  }

  let leverEuUrl = null, leverEuOpts = null;
  await lever.fetch(
    { name: 'L EU', careers_url: 'https://jobs.eu.lever.co/example-eu' },
    { transport: 'http', fetchJson: async (u, opts) => { leverEuUrl = u; leverEuOpts = opts; return []; }, fetchText: async () => '' },
  );
  if (leverEuUrl === 'https://api.eu.lever.co/v0/postings/example-eu' && leverEuOpts?.redirect === 'error') {
    pass('lever.fetch() hits api.eu.lever.co and passes redirect:"error"');
  } else {
    fail(`lever.fetch() EU instance: url=${leverEuUrl}, opts=${JSON.stringify(leverEuOpts)}`);
  }

  let ashbyOpts = null;
  await ashby.fetch(
    { name: 'A', careers_url: 'https://jobs.ashbyhq.com/example' },
    { transport: 'http', fetchJson: async (_u, opts) => { ashbyOpts = opts; return { jobs: [] }; }, fetchText: async () => '' },
  );
  if (ashbyOpts && ashbyOpts.redirect === 'error') pass('ashby.fetch() passes redirect:"error"');
  else fail(`ashby.fetch() should pass redirect:"error", got ${JSON.stringify(ashbyOpts)}`);
} catch (e) {
  fail(`SSRF redirect hardening tests crashed: ${e.message}`);
}
