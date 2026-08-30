#!/usr/bin/env bun
// Builds the git worker for the dev server: Bun's HTML dev server does not
// bundle Worker URLs, so the compiled artifact and the wasm engine are placed
// next to the client module that loads them (both gitignored, like the
// precompiled app.css). The production build emits the same pair into
// dist/pwa via scripts/build-pwa.mjs.
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const outDir = resolve(root, 'src/standalone/gitEngine');
const bun = process.execPath;

const result = Bun.spawnSync(
  [bun, 'build', '--target=browser', 'src/standalone/gitEngine/git-worker.ts', '--outdir', outDir],
  {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
if (result.exitCode !== 0) {
  throw new Error('Building the git worker failed');
}

// lg2_workerfs.js resolves its wasm relative to its own URL at runtime.
await cp(
  resolve(root, 'src/standalone/gitEngine/vendor/lg2_workerfs.wasm'),
  resolve(outDir, 'lg2_workerfs.wasm'),
);
