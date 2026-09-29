// tests/skill-frontmatter.test.mjs — the career-ops skill's frontmatter is
// well-formed in every per-CLI copy.
//
// The skill shipped with both `user_invocable` and `user-invocable`. Claude Code
// reads the hyphenated key, so the underscore twin only duplicated it and made
// the copies look inconsistent with the documented frontmatter. `arguments: mode`
// stays because the router body reads the mode through `$mode`.
//
// Run:  node --test tests/skill-frontmatter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const COPIES = [
  '.agents', '.antigravitycli', '.claude', '.cursor', '.grok', '.kimi', '.opencode', '.qwen',
].map((dir) => `${dir}/skills/career-ops/SKILL.md`);

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(m, 'SKILL.md must start with a frontmatter block');
  return m[1];
}

function keys(fm) {
  return fm.split(/\r?\n/).map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter(Boolean);
}

for (const rel of COPIES) {
  test(`${rel} carries one invocability key and the router arguments`, () => {
    const path = join(ROOT, rel);
    if (!existsSync(path)) return; // not every CLI's copy ships in every fork
    const text = readFileSync(path, 'utf-8');
    const fm = frontmatter(text);
    const found = keys(fm);
    assert.ok(!found.includes('user_invocable'), 'the underscore twin of user-invocable must be gone');
    assert.equal(found.filter((k) => k === 'user-invocable').length, 1);
    assert.match(fm, /^user-invocable:\s*true\s*$/m);
    assert.ok(found.includes('argument-hint'), 'argument-hint is the documented Claude Code key');
    assert.equal(new Set(found).size, found.length, 'no frontmatter key may appear twice');
    if (found.includes('arguments')) {
      assert.match(text, /\$mode\b/, '`arguments: mode` is only justified while the body reads `$mode`');
    }
  });
}

test('every per-CLI copy is identical', () => {
  const present = COPIES.filter((rel) => existsSync(join(ROOT, rel)));
  assert.ok(present.length > 0);
  const [first, ...rest] = present.map((rel) => readFileSync(join(ROOT, rel), 'utf-8'));
  for (const other of rest) assert.equal(other, first);
});
