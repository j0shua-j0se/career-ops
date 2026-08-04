// tests/providers/http-timeout.test.mjs — the abort timeout must cover the
// BODY read, not just the header phase. A server that sends headers and then
// stalls the body used to hang fetchJson forever, which could silently freeze
// a full-directory sweep partway through with no error output.
import { createServer } from 'node:http';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from '../helpers.mjs';

console.log('\nProvider — _http timeout');

const { fetchJson, fetchText } = await import(pathToFileURL(join(ROOT, 'providers/_http.mjs')).href);

// The SSRF guard in _http.mjs blocks loopback by default, so this suite's local
// server is only reachable with an explicit per-call opt-in. Passing it is what
// makes the timeout assertions below test the timeout instead of the guard.
const LOOPBACK = { allowPrivateHosts: true };

// A guard rejection is instant; a real abort takes ~the request timeout. Without
// a lower bound, any error at all satisfies "it rejected" and the stalled-body
// regression this suite exists to catch goes unnoticed — which is exactly what
// happened when the guard first landed and these checks passed in 0ms.
const MIN_ABORT_MS = 200;

// Independent upper bound: if the mechanism under test regresses and the call
// never settles, this makes the test fail fast (hitting the elapsed assertion)
// instead of reintroducing the very silent hang this suite guards against.
// Set well above the 300ms request timeout but bounded far below a real hang.
function hardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: hard test timeout after ${ms}ms — regression suspected`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));  // else the loser keeps the loop alive to `ms`
}

// Bounded allowance over the 300ms request timeout: loose enough for a slow CI
// runner, tight enough that a multi-second stalled-body regression still fails.
const MAX_ABORT_MS = 1_500;

const sockets = new Set();
const server = createServer((req, res) => {
  if (req.url === '/stall') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"jobs": [');   // headers + partial body, then silence forever
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 1. Stalled body must abort within the timeout window, not hang.
{
  const t0 = Date.now();
  try {
    await hardTimeout(fetchJson(`${base}/stall`, { timeoutMs: 300, ...LOOPBACK }), 8_000, 'fetchJson /stall');
    fail('fetchJson resolved on a stalled body');
  } catch (e) {
    const elapsed = Date.now() - t0;
    if (elapsed < MIN_ABORT_MS) fail(`fetchJson rejected in ${elapsed}ms — too fast to be the abort timer: ${e.message}`);
    else if (elapsed < MAX_ABORT_MS) pass(`fetchJson aborted stalled body read in ${elapsed}ms`);
    else fail(`fetchJson took ${elapsed}ms to abort a stalled body (timeout not covering body read)`);
  }
}

// 2. Same for fetchText.
{
  const t0 = Date.now();
  try {
    await hardTimeout(fetchText(`${base}/stall`, { timeoutMs: 300, ...LOOPBACK }), 8_000, 'fetchText /stall');
    fail('fetchText resolved on a stalled body');
  } catch (e) {
    const elapsed = Date.now() - t0;
    if (elapsed < MIN_ABORT_MS) fail(`fetchText rejected in ${elapsed}ms — too fast to be the abort timer: ${e.message}`);
    else if (elapsed < MAX_ABORT_MS) pass(`fetchText aborted stalled body read in ${elapsed}ms`);
    else fail(`fetchText took ${elapsed}ms to abort a stalled body`);
  }
}

// 3. Happy path still works after the refactor.
{
  try {
    const ok = await fetchJson(`${base}/ok`, { timeoutMs: 2_000, ...LOOPBACK });
    if (ok && ok.ok === true) pass('fetchJson still parses a completed body');
    else fail(`fetchJson happy path broken: ${JSON.stringify(ok)}`);
  } catch (e) {
    // Never let this throw out of the module: discovered suites are imported
    // in-process by test-all.mjs, so an unhandled rejection here kills the
    // whole run and every later section silently never executes.
    fail(`fetchJson happy path threw: ${e.message}`);
  }
}

// 4. The opt-in is the ONLY thing making the above reachable — without it the
//    SSRF guard must still refuse loopback.
{
  try {
    await fetchJson(`${base}/ok`, { timeoutMs: 2_000 });
    fail('fetchJson reached a loopback address without allowPrivateHosts — the SSRF guard is not firing');
  } catch (e) {
    if (/private, loopback or link-local/.test(e.message)) pass('fetchJson still blocks loopback when allowPrivateHosts is not passed');
    else fail(`fetchJson loopback rejection had the wrong cause: ${e.message}`);
  }
}

for (const s of sockets) s.destroy();
server.close();
