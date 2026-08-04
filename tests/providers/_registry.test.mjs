// tests/providers/_registry.test.mjs — direct tests for the provider registry
// (E3: the provider layer's untested modules).
//
// _registry.mjs is the routing core: every tracked_companies entry that the
// scanner and verify-portals.mjs handle is dispatched through loadProviders() +
// resolveProvider(). A regression here misroutes whole boards silently — the
// scan still exits 0, it just quietly returns nothing for the affected
// companies. The individual providers each have a test file; the thing that
// chooses between them had none.
//
// loadProviders() is exercised against a temp directory of fixture provider
// modules (real dynamic imports, real malformed modules) rather than a mock, so
// the skip/duplicate/import-failure paths are covered end to end. The
// fine-grained routing rules use hand-built Maps so detect() call counts are
// observable.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nProvider — _registry');

let fixtureDir = null;

try {
  const { loadProviders, resolveProvider } =
    await import(pathToFileURL(join(ROOT, 'providers/_registry.mjs')).href);

  // ── Fixture provider directory ──────────────────────────────────
  // Filenames are chosen so the alphabetical load order is explicit:
  //   aaa-first, bad-shape, bbb-second, broken-import, local-parser,
  //   no-default, no-id, thrower, zzz-after-thrower, zzz-duplicate
  // leaving an insertion order of:
  //   aaa-first → bbb-second → local-parser → thrower → zzz-after
  fixtureDir = mkdtempSync(join(tmpdir(), 'career-ops-registry-'));

  const provider = (id, detectBody) => `
export default {
  id: ${JSON.stringify(id)},
  detect(entry) { ${detectBody} },
  async fetch() { return []; },
};
`;

  writeFileSync(join(fixtureDir, 'aaa-first.mjs'), provider('aaa-first', 'return entry.claimedByBoth ? { url: "https://a.example" } : null;'));
  writeFileSync(join(fixtureDir, 'bbb-second.mjs'), provider('bbb-second', 'return entry.claimedByBoth ? { url: "https://b.example" } : null;'));
  writeFileSync(join(fixtureDir, 'local-parser.mjs'), provider('local-parser', 'if (entry.localThrows) throw new Error("local boom"); return entry.parser ? { url: "local" } : null;'));
  writeFileSync(join(fixtureDir, 'thrower.mjs'), provider('thrower', 'if (entry.throwOnDetect) throw new Error("detect boom"); return null;'));
  writeFileSync(join(fixtureDir, 'zzz-after-thrower.mjs'), provider('zzz-after', 'return entry.claimAfter ? { url: "https://after.example" } : null;'));

  // Underscore-prefixed helper: must never be loaded as a provider. Throws on
  // import so a regression that stops filtering `_` is loud, not silent.
  writeFileSync(join(fixtureDir, '_hidden.mjs'), 'throw new Error("_ files must never be imported as providers");\n');
  // Malformed modules — each must be logged and skipped, never fatal.
  writeFileSync(join(fixtureDir, 'broken-import.mjs'), 'throw new Error("import exploded");\n');
  writeFileSync(join(fixtureDir, 'no-default.mjs'), 'export const notDefault = 1;\n');
  writeFileSync(join(fixtureDir, 'bad-shape.mjs'), 'export default { id: "bad-shape" };\n');
  writeFileSync(join(fixtureDir, 'no-id.mjs'), 'export default { async fetch() { return []; } };\n');
  // Duplicate id, sorting last — the first registration must win.
  writeFileSync(join(fixtureDir, 'zzz-duplicate.mjs'), provider('aaa-first', 'return { url: "https://dupe.example" };'));
  // Non-.mjs files and subdirectories must be ignored outright.
  writeFileSync(join(fixtureDir, 'notes.txt'), 'not a provider\n');
  writeFileSync(join(fixtureDir, 'legacy.js'), 'throw new Error(".js must not be loaded");\n');
  mkdirSync(join(fixtureDir, 'nested'));

  // ── loadProviders() ─────────────────────────────────────────────
  const { result: providers, errors: loadErrors } =
    await captureConsoleErrors(() => loadProviders(fixtureDir));

  const ids = [...providers.keys()];
  if (ids.join(',') === 'aaa-first,bbb-second,local-parser,thrower,zzz-after')
    pass('loadProviders() registers valid modules in alphabetical filename order');
  else fail(`loadProviders() ids = ${JSON.stringify(ids)}`);

  if (!ids.includes('bad-shape') && !ids.includes('no-id') && providers.size === 5)
    pass('loadProviders() skips modules missing a default export, a fetch(), or an id');
  else fail(`loadProviders() kept a malformed module: ${JSON.stringify(ids)}`);

  // The duplicate sorts last and exports id "aaa-first"; the first file's
  // module object must still be the one registered.
  if (providers.get('aaa-first')?.detect({ claimedByBoth: true })?.url === 'https://a.example')
    pass('loadProviders() keeps the FIRST module registered for a duplicate id');
  else fail(`loadProviders() duplicate id resolved to ${JSON.stringify(providers.get('aaa-first')?.detect({ claimedByBoth: true }))}`);

  const errorText = loadErrors.map(String).join('\n');
  const namesWarned = ['broken-import.mjs', 'no-default.mjs', 'bad-shape.mjs', 'no-id.mjs', 'zzz-duplicate.mjs'];
  const unwarned = namesWarned.filter((n) => !errorText.includes(n));
  if (unwarned.length === 0)
    pass('loadProviders() logs the offending filename for every skipped module');
  else fail(`loadProviders() skipped silently: ${JSON.stringify(unwarned)} — got ${JSON.stringify(loadErrors.map(String))}`);

  if (errorText.includes('duplicate provider id "aaa-first"'))
    pass('loadProviders() names the duplicate id in its warning');
  else fail(`loadProviders() duplicate warning missing from ${JSON.stringify(loadErrors.map(String))}`);

  // _hidden.mjs and legacy.js both throw on import; neither may be reached.
  if (!errorText.includes('_hidden') && !errorText.includes('legacy.js'))
    pass('loadProviders() never imports _-prefixed helpers or non-.mjs files');
  else fail(`loadProviders() touched a file it should have filtered: ${JSON.stringify(loadErrors.map(String))}`);

  const missing = await loadProviders(join(fixtureDir, 'does-not-exist'));
  if (missing instanceof Map && missing.size === 0)
    pass('loadProviders() returns an empty Map for a missing directory');
  else fail(`loadProviders(missing dir) = ${JSON.stringify([...missing])}`);

  // ── resolveProvider(): explicit provider: field ─────────────────
  let detectCalls = 0;
  const counted = new Map([
    ['pinned', { id: 'pinned', detect: () => { detectCalls++; return null; }, fetch: async () => [] }],
  ]);

  const explicit = resolveProvider({ name: 'Acme', provider: 'pinned' }, counted);
  if (explicit?.provider === counted.get('pinned') && detectCalls === 0)
    pass('resolveProvider() honors an explicit provider: field without calling detect()');
  else fail(`resolveProvider(explicit) = ${JSON.stringify(explicit)}, detectCalls=${detectCalls}`);

  const unknown = resolveProvider({ name: 'Acme', provider: 'nope' }, counted);
  if (unknown?.error === 'unknown provider: nope')
    pass('resolveProvider() returns a typed error for an unknown provider: id');
  else fail(`resolveProvider(unknown) = ${JSON.stringify(unknown)}`);

  // ── resolveProvider(): local-parser precedence ──────────────────
  // local-parser must be tried BEFORE the detect() loop, so a company with both
  // a configured local command and a recognisable ATS URL uses the local one.
  const lpOrder = [];
  const withLocal = new Map([
    ['aaa-api', { id: 'aaa-api', detect: () => { lpOrder.push('aaa-api'); return { url: 'https://api.example' }; }, fetch: async () => [] }],
    ['local-parser', { id: 'local-parser', detect: () => { lpOrder.push('local-parser'); return { url: 'local' }; }, fetch: async () => [] }],
  ]);
  const localHit = resolveProvider({ name: 'Acme', parser: { command: 'x' } }, withLocal);
  if (localHit?.provider === withLocal.get('local-parser') && lpOrder[0] === 'local-parser')
    pass('resolveProvider() tries local-parser before any API detect()');
  else fail(`resolveProvider(local) = ${JSON.stringify(localHit?.provider?.id)}, order=${JSON.stringify(lpOrder)}`);

  // skipIds: the network-only health check must never exec a local command.
  let localCalled = false;
  const skipMap = new Map([
    ['local-parser', { id: 'local-parser', detect: () => { localCalled = true; return { url: 'local' }; }, fetch: async () => [] }],
    ['api', { id: 'api', detect: () => ({ url: 'https://api.example' }), fetch: async () => [] }],
  ]);
  const skipped = resolveProvider({ name: 'Acme', parser: { command: 'x' } }, skipMap, { skipIds: ['local-parser'] });
  if (!localCalled && skipped?.provider === skipMap.get('api'))
    pass('resolveProvider() with skipIds:["local-parser"] never calls it and falls through to the API provider');
  else fail(`resolveProvider(skipIds) localCalled=${localCalled}, provider=${JSON.stringify(skipped?.provider?.id)}`);

  // ── resolveProvider(): detect() order and failure isolation ─────
  const bothClaim = resolveProvider({ name: 'Both', claimedByBoth: true }, providers);
  if (bothClaim?.provider === providers.get('aaa-first'))
    pass('resolveProvider() gives the first provider in load order priority when two claim an entry');
  else fail(`resolveProvider(both) = ${JSON.stringify(bothClaim?.provider?.id)}`);

  // A throwing detect() must be logged and stepped over — the sweep continues
  // to later providers instead of losing the entry.
  const { result: afterThrow, errors: throwErrors } = await captureConsoleErrors(
    () => resolveProvider({ name: 'AfterThrow', throwOnDetect: true, claimAfter: true }, providers),
  );
  if (afterThrow?.provider === providers.get('zzz-after'))
    pass('resolveProvider() continues past a throwing detect() and resolves a later provider');
  else fail(`resolveProvider(afterThrow) = ${JSON.stringify(afterThrow?.provider?.id)}`);

  if (throwErrors.map(String).some((e) => /thrower: detect\(\) threw for "AfterThrow" — detect boom/.test(e)))
    pass('resolveProvider() logs the provider id, entry name, and cause when detect() throws');
  else fail(`resolveProvider() throw warning = ${JSON.stringify(throwErrors.map(String))}`);

  // A throwing local-parser detect() must not abort resolution either.
  const { result: localThrew, errors: localErrors } = await captureConsoleErrors(
    () => resolveProvider({ name: 'LocalBoom', localThrows: true, claimedByBoth: true }, providers),
  );
  if (localThrew?.provider === providers.get('aaa-first')
      && localErrors.map(String).some((e) => /local-parser: detect\(\) threw for "LocalBoom" — local boom/.test(e)))
    pass('resolveProvider() survives a throwing local-parser detect() and still reaches the API providers');
  else fail(`resolveProvider(localThrew) = ${JSON.stringify(localThrew?.provider?.id)}, errors=${JSON.stringify(localErrors.map(String))}`);

  // ── resolveProvider(): no match ─────────────────────────────────
  if (resolveProvider({ name: 'Unclaimed' }, providers) === null)
    pass('resolveProvider() returns null when no provider claims the entry');
  else fail(`resolveProvider(unclaimed) = ${JSON.stringify(resolveProvider({ name: 'Unclaimed' }, providers))}`);

  if (resolveProvider({ name: 'Anything', claimedByBoth: true }, new Map()) === null)
    pass('resolveProvider() returns null for an empty provider Map');
  else fail('resolveProvider() should return null when there are no providers at all');

  // A provider with no detect() at all (fetch-only, driven by an explicit
  // provider: field) must be stepped over by optional chaining, not crash.
  const noDetect = new Map([['fetch-only', { id: 'fetch-only', fetch: async () => [] }]]);
  if (resolveProvider({ name: 'Acme' }, noDetect) === null)
    pass('resolveProvider() tolerates a provider that exposes no detect()');
  else fail('resolveProvider() should skip a detect-less provider rather than throw');

} catch (e) {
  fail(`_registry tests crashed: ${e.stack || e.message}`);
} finally {
  if (fixtureDir) {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
}
