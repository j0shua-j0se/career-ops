#!/usr/bin/env node
// build-dashboard.mjs — cross-platform build for the Go TUI dashboard.
//
// `go build -o career-dashboard .` writes an extension-less binary on Windows
// (Go only auto-appends .exe when -o is omitted), which breaks bare-name/PATH
// lookup there. This wrapper picks the platform-correct output name instead:
// dashboard/career-dashboard on Unix, dashboard/career-dashboard.exe on Windows.
//
// The build is behind a main-guard. Without one, merely importing this module
// ran `go build` and wrote a 6.6 MB binary as a side effect — which is how a
// stray dashboard/career-dashboard.exe~ appeared in the working tree. Any
// tooling that enumerates and imports modules (a test harness, a doc scanner,
// a dependency graph) would trigger a compile. Same reasoning as the guard on
// merge-tracker.mjs: an import must never do the thing the CLI does.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = process.platform === 'win32' ? 'career-dashboard.exe' : 'career-dashboard';

function main() {
const result = spawnSync('go', ['build', '-o', out, '.'], {
  cwd: join(root, 'dashboard'),
  stdio: 'inherit',
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('Go toolchain not found. Install Go 1.24+ from https://go.dev/dl/ and retry.');
  } else {
    console.error(`Build failed to start: ${result.error.message}`);
  }
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built dashboard/${out} — run it with: npm run serve:dashboard (or dashboard/${out} --path .)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
