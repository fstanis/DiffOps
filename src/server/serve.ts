// The diffops server: hosts the built PWA from dist/pwa and exposes /ai-gateway
// as its only dynamic surface (`bun run serve`). Set DIFFOPS_FIXTURE_DIR to expose
// a generated fixture repository (see scripts/make-engine-fixture-repo.mjs)
// under /fixture/ for engine-check.html.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { handleAiGatewayRequest } from './ai-gateway.js';
import { requireBun } from './bunRuntime.js';
import { resolveServerListenOptions } from './serverOptions.js';
import {
  createDiskFileSource,
  createStaticHandler,
  isPathInside,
  staticFileResponse,
} from './staticFiles.js';

const bun = requireBun();

const root = resolve(process.cwd(), 'dist/pwa');
const engineCheckLogPath = resolve(root, 'engine-check.log');
const fixtureDir = process.env.DIFFOPS_FIXTURE_DIR
  ? resolve(process.env.DIFFOPS_FIXTURE_DIR)
  : null;
const { port, hostname } = resolveServerListenOptions();
const serveStaticFile = createStaticHandler(createDiskFileSource(bun, root));

// Crash-surviving log sink for engine-check.html (best-effort diagnostics).
const engineCheckLogResponse = async (request: Request): Promise<Response> => {
  if (request.method === 'POST') {
    appendFileSync(engineCheckLogPath, `${await request.text()}\n`);
    return new Response(null, { status: 204 });
  }
  // The build wipes dist/pwa (log included); an absent log reads as empty.
  const logText = existsSync(engineCheckLogPath) ? readFileSync(engineCheckLogPath, 'utf8') : '';
  if (logText) {
    writeFileSync(engineCheckLogPath, '');
  }
  return new Response(logText, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};

// Without DIFFOPS_FIXTURE_DIR the generated dist/pwa/fixture (bun run
// fixture:engine) is served like any other static file; the env var only
// exists to point at a fixture living outside the build.
const fixtureResponse = async (pathname: string): Promise<Response | null> => {
  if (!fixtureDir) {
    return null;
  }
  const relativePath = pathname.slice('/fixture/'.length);
  const resolved = resolve(fixtureDir, `.${relativePath}`);
  if (!isPathInside(resolved, fixtureDir)) {
    return new Response('Forbidden', { status: 403 });
  }
  const fixtureFile = bun.file(resolved);
  if (await fixtureFile.exists()) {
    return staticFileResponse(fixtureFile, pathname);
  }
  return new Response('Not found', { status: 404 });
};

if (!existsSync(root)) {
  console.warn(`warning: ${root} does not exist yet — run bun run build first`);
}

bun.serve({
  port,
  hostname,
  async fetch(request) {
    const gatewayResponse = await handleAiGatewayRequest(request);
    if (gatewayResponse) {
      return gatewayResponse;
    }

    const requestUrl = new URL(request.url);
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === '/engine-check/log') {
      return engineCheckLogResponse(request);
    }
    if (pathname.startsWith('/fixture/')) {
      const fixtureFileResponse = await fixtureResponse(pathname);
      if (fixtureFileResponse) {
        return fixtureFileResponse;
      }
    }
    return serveStaticFile(request);
  },
});

console.log(
  `serving ${root} at http://${hostname}:${port}${fixtureDir ? ` (fixture at /fixture/ from ${fixtureDir})` : ''}`,
);
