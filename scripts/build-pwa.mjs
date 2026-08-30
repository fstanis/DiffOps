#!/usr/bin/env bun
// Builds the standalone PWA into dist/pwa: one bun build invocation bundles
// the whole graph (app shell, engine-check page, git worker, stylesheet,
// manifest, install favicons), and a second invocation builds the service
// worker — its cache name embeds a hash of every other artifact, so it cannot
// join the first. The wasm engine and install icons stay outside the bundle
// graph: both keep stable unhashed names the service worker precaches.
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const outDir = resolve(root, 'dist/pwa');
const bun = process.execPath;

const run = (args, env = {}) => {
  const result = Bun.spawnSync([bun, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: bun ${args.join(' ')}`);
  }
};

// Clear the output except the generated engine-check fixture and its log: a
// full wipe races any concurrently running fixture generator (its git
// commands die with "unable to write new index file") and would force a
// fixture rebuild on every dev watch cycle. Stale hashed bundles may linger
// in dev; remove dist/ for a clean production build.
if (existsSync(outDir)) {
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (entry.name === 'fixture' || entry.name === 'engine-check.log') {
      continue;
    }
    await rm(resolve(outDir, entry.name), { recursive: true, force: true });
  }
}

// The shell links the compiled Tailwind output; Bun bundles JS/TS/HTML/CSS
// but does not run PostCSS, so the stylesheet is built ahead of the bundle.
run(['scripts/build-pwa-css.mjs']);

// One entry per artifact: the shell and engine-check page are HTML entries,
// the git worker a TS entry the shell resolves at runtime by URL.
// --splitting keeps the git engine behind its dynamic import (StandaloneApp
// loads it only when a repository is opened), so a .diff-only session never
// downloads it. The flattened entry naming keeps git-worker.js at the root:
// the app loads it via new URL('./git-worker.js', import.meta.url) from its
// root-level chunks, while Bun's default [dir] naming would nest it under
// gitEngine/.
run([
  'build',
  '--target=browser',
  '--minify',
  '--sourcemap=linked',
  '--splitting',
  '--entry-naming=[name].[ext]',
  'src/standalone/index.html',
  'src/standalone/engine-check.html',
  'src/standalone/gitEngine/git-worker.ts',
  '--outdir',
  outDir,
]);

// The wasm engine resolves its binary relative to the worker's own URL at
// runtime; it is not part of the bundle graph so its name stays stable (and
// cache-refreshable) across builds.
await cp(
  resolve(root, 'src/standalone/gitEngine/vendor/lg2_workerfs.wasm'),
  resolve(outDir, 'lg2_workerfs.wasm'),
);

run(['scripts/generate-pwa-icons.mjs', resolve(outDir, 'icons')]);

// The service worker's cache name is stamped with a hash of the build so its
// bytes change whenever anything it precaches changes. The fixture and its
// log are generated test data, not build artifacts, and are skipped — hashing
// them would churn the build id (and hash megabytes) on every fixture touch.
const artifactPaths = [...new Bun.Glob('**/*').scanSync({ cwd: outDir })].filter(
  (artifactPath) => !artifactPath.startsWith('fixture/') && artifactPath !== 'engine-check.log',
);
const hasher = new Bun.CryptoHasher('sha256');
for (const artifactPath of artifactPaths.sort()) {
  hasher.update(artifactPath);
  hasher.update(await readFile(resolve(outDir, artifactPath)));
}
const buildId = hasher.digest('hex').slice(0, 16);
run(
  [
    'build',
    '--target=browser',
    '--minify',
    '--sourcemap=linked',
    '--env=DIFFOPS_*',
    'src/standalone/service-worker.ts',
    '--outdir',
    outDir,
  ],
  {
    DIFFOPS_BUILD_ID: buildId,
  },
);

console.log(`PWA build complete → ${dirname(outDir)}/pwa (build ${buildId})`);
