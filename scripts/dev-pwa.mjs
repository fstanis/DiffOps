#!/usr/bin/env bun
// Dev loop for the standalone app: watch the sources, rebuild the real PWA
// (scripts/build-pwa.mjs), and serve dist/pwa on :3000. This deliberately
// serves the production artifact instead of Bun's HTML dev server: that
// pipeline serves nothing statically and hands modules a bun://
// import.meta.url, which breaks the git worker (and every dev/prod drift it
// causes lands in the dev loop too). Reload the browser after each rebuild.
//
// The engine-check fixture (`bun run fixture:engine`) survives rebuilds —
// regenerate it manually when its generator changes.
import { spawn } from 'node:child_process';
import { watch as watchFs } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2] ?? 3000);
const bun = process.execPath;

const server = spawn(bun, ['src/server/serve.ts', String(port)], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
});
server.on('exit', (code) => {
  process.exit(code ?? 0);
});

const run = (args) =>
  new Promise((resolveDone, reject) => {
    const child = spawn(bun, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
      if (code === 0) {
        resolveDone();
        return;
      }
      reject(new Error(`bun ${args.join(' ')} exited with ${code}`));
    });
  });

// Rebuilds are serialized: concurrent `bun build` runs both rm -rf the output
// directory and stomp each other. A change during a rebuild re-runs once more.
let isRebuilding = false;
let isRebuildQueued = false;
const rebuild = async (reason) => {
  if (isRebuilding) {
    isRebuildQueued = true;
    return;
  }
  isRebuilding = true;
  const startedAt = performance.now();
  try {
    await run(['scripts/build-pwa.mjs']);
    console.log(
      `dev: rebuilt after ${reason} (${Math.round(performance.now() - startedAt)}ms) — reload the browser`,
    );
  } catch (error) {
    console.error(`dev: rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    isRebuilding = false;
    if (isRebuildQueued) {
      isRebuildQueued = false;
      void rebuild(reason);
    }
  }
};

let rebuildTimer = null;
// Build outputs that live inside the watched tree (the prebuilt stylesheet
// is written to src/ by build-pwa-css.mjs); rebuilding on them loops forever.
// The engine filenames match at any depth so the vendored wasm is covered.
const isGeneratedArtifact = (path) =>
  /(?:^|\/)standalone\/styles\/app\.css$/.test(path) ||
  /(?:^|\/)standalone\/gitEngine\/(?:[^/]+\/)*(?:git-worker\.js|lg2_workerfs\.wasm)$/.test(path);
const scheduleRebuild = (event, path) => {
  if (isGeneratedArtifact(path)) {
    return;
  }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    void rebuild(`${event} ${path}`);
  }, 200);
};

await rebuild('initial');
console.log(`dev server (standalone) → http://localhost:${port}`);

// Bun.watch exists from Bun 1.3; node:fs watch covers older Bun releases.
const startWatch = (dir) => {
  if (typeof Bun.watch === 'function') {
    Bun.watch(dir, { recursive: true }).onChange(scheduleRebuild);
    return;
  }
  watchFs(dir, { recursive: true }, (event, filename) => {
    scheduleRebuild(event, String(filename ?? ''));
  });
};
startWatch(resolve(root, 'src'));
startWatch(resolve(root, 'public'));
