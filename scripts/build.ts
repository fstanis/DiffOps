#!/usr/bin/env bun
// Builds the standalone PWA into dist/pwa. Two Bun.build calls: one bundles
// the whole graph (app shell, engine-check page, git worker, stylesheet,
// manifest, install favicons), and a second builds the service worker — its
// cache name embeds a hash of every other artifact, so it cannot join the
// first. The wasm engine and install icons stay outside the bundle graph:
// both keep stable unhashed names the service worker precaches.
//
// `--watch` adds the dev loop: rebuild on change and serve dist/pwa on :3000.
// It deliberately serves the production artifact instead of Bun's HTML dev
// server, which serves nothing statically and hands modules a bun://
// import.meta.url that breaks the git worker.
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createStaticHandler } from '../src/server/staticFiles.ts';

const root = process.cwd();
const outDir = resolve(root, 'dist/pwa');
const standalone = resolve(root, 'src/standalone');
const isWatch = process.argv.includes('--watch');

const build = async (options: Parameters<typeof Bun.build>[0]): Promise<void> => {
  const result = await Bun.build({
    target: 'browser',
    minify: true,
    sourcemap: 'linked',
    outdir: outDir,
    // React ships both builds behind this check and picks one at runtime;
    // without the substitution the development copy is bundled too (and used).
    define: { 'process.env.NODE_ENV': '"production"' },
    ...options,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error('bun build failed');
  }
};

// Bun bundles JS/TS/HTML/CSS but does not compile Tailwind, so the stylesheet
// the shell links is built ahead of the bundle.
const buildStylesheet = (): void => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      '@tailwindcss/cli',
      '--input',
      resolve(standalone, 'styles/standalone.css'),
      '--output',
      resolve(standalone, 'styles/app.css'),
      '--minify',
    ],
    { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.exitCode !== 0) {
    throw new Error('Building the stylesheet failed');
  }
};

// Clear the output except the generated engine-check fixture: a full wipe
// races any concurrently running fixture generator (its git commands die with
// "unable to write new index file") and would force a fixture rebuild on every
// dev watch cycle. Stale hashed bundles may linger in dev; remove dist/ for a
// clean production build.
const cleanOutput = async (): Promise<void> => {
  if (!existsSync(outDir)) {
    return;
  }
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (entry.name !== 'fixture') {
      await rm(resolve(outDir, entry.name), { recursive: true, force: true });
    }
  }
};

// The service worker's cache name is stamped with a hash of the build so its
// bytes change whenever anything it precaches changes. The fixture is
// generated test data, not a build artifact, and is skipped — hashing it would
// churn the build id (and hash megabytes) on every fixture touch.
const hashArtifacts = async (): Promise<string> => {
  const artifactPaths = [...new Bun.Glob('**/*').scanSync({ cwd: outDir })]
    .filter((artifactPath) => !artifactPath.startsWith('fixture/'))
    .sort();
  const hasher = new Bun.CryptoHasher('sha256');
  for (const artifactPath of artifactPaths) {
    hasher.update(artifactPath);
    hasher.update(await readFile(resolve(outDir, artifactPath)));
  }
  return hasher.digest('hex').slice(0, 16);
};

const buildPwa = async (): Promise<string> => {
  await cleanOutput();
  buildStylesheet();

  // One entry per artifact: the shell and engine-check page are HTML entries,
  // the git worker a TS entry the shell resolves at runtime by URL. Code
  // splitting stays off: every dynamic import here names a static specifier,
  // so each entry bundles into a single file and the app is three requests
  // (shell script, worker, wasm) instead of a chunk graph. The flattened entry
  // naming keeps git-worker.js at the root, where the app loads it via
  // new URL('./git-worker.js', import.meta.url); Bun's default [dir] naming
  // would nest it under gitEngine/.
  await build({
    entrypoints: [
      resolve(standalone, 'index.html'),
      resolve(standalone, 'engine-check.html'),
      resolve(standalone, 'gitEngine/git-worker.ts'),
    ],
    naming: { entry: '[name].[ext]' },
  });

  // Both resolve their own URL at runtime and are not part of the bundle
  // graph, so their names stay stable (and cache-refreshable) across builds.
  await cp(
    resolve(standalone, 'gitEngine/vendor/lg2_workerfs.wasm'),
    resolve(outDir, 'lg2_workerfs.wasm'),
  );
  await cp(resolve(root, 'public/icons'), resolve(outDir, 'icons'), { recursive: true });

  const buildId = await hashArtifacts();
  await build({
    entrypoints: [resolve(standalone, 'service-worker.ts')],
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.DIFFOPS_BUILD_ID': JSON.stringify(buildId),
    },
  });
  return buildId;
};

console.log(`PWA build complete → dist/pwa (build ${await buildPwa()})`);

if (isWatch) {
  // Build outputs that live inside the watched tree (the compiled stylesheet
  // is written to src/); rebuilding on them loops forever.
  const isGeneratedArtifact = (path: string): boolean =>
    /(?:^|\/)standalone\/styles\/app\.css$/.test(path);

  let isRebuilding = false;
  let isRebuildQueued = false;
  const rebuild = async (reason: string): Promise<void> => {
    if (isRebuilding) {
      isRebuildQueued = true;
      return;
    }
    isRebuilding = true;
    const startedAt = performance.now();
    try {
      await buildPwa();
      console.log(
        `dev: rebuilt after ${reason} (${Math.round(performance.now() - startedAt)}ms) — reload the browser`,
      );
    } catch (error) {
      console.error(
        `dev: rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      isRebuilding = false;
      if (isRebuildQueued) {
        isRebuildQueued = false;
        void rebuild(reason);
      }
    }
  };

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRebuild = (event: string, path: string): void => {
    if (isGeneratedArtifact(path)) {
      return;
    }
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      void rebuild(`${event} ${path}`);
    }, 200);
  };

  for (const dir of ['src', 'public']) {
    Bun.watch(resolve(root, dir), { recursive: true }).onChange(scheduleRebuild);
  }

  const port = 3000;
  Bun.serve({ port, hostname: '127.0.0.1', fetch: createStaticHandler(outDir) });
  console.log(`dev server (standalone) → http://localhost:${port}`);
}
