import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireBun } from './bunRuntime.js';
import {
  createDiskFileSource,
  createEmbeddedFileSource,
  createStaticHandler,
} from './staticFiles.js';

const assetRoot = mkdtempSync(join(tmpdir(), 'diffops-static-'));
const shellMarkup = '<!doctype html><title>diffops</title>';

const writeAsset = (relativePath: string, content: string): string => {
  const fullPath = join(assetRoot, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
};

const shellPath = writeAsset('index.html', shellMarkup);
const appJsPath = writeAsset('assets/app.js', 'console.log("app")');
const wasmPath = writeAsset('lg2_workerfs.wasm', 'wasm-bytes');
const iconPath = writeAsset('icons/icon-192.png', 'png-bytes');

const pathsByPathname = new Map([
  ['/index.html', shellPath],
  ['/assets/app.js', appJsPath],
  ['/lg2_workerfs.wasm', wasmPath],
  ['/icons/icon-192.png', iconPath],
]);

const bun = requireBun();
const serveFromDisk = createStaticHandler(createDiskFileSource(bun, assetRoot));
const serveFromEmbedded = createStaticHandler(createEmbeddedFileSource(bun, pathsByPathname));

const documentRequest = (pathname: string): Request =>
  new Request(`http://localhost${pathname}`, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  });

const assetRequest = (pathname: string): Request => new Request(`http://localhost${pathname}`);

afterAll(() => {
  rmSync(assetRoot, { recursive: true, force: true });
});

// Both file sources must answer identically — the compiled binary and
// `bun run serve` serve the same bytes with the same headers. Bodies are Bun
// blobs, which happy-dom's Response cannot stringify, so byte fidelity is
// verified live (curl against `bun run serve` and the binary).
const assertsSharedBehavior = (serveStaticFile: (request: Request) => Promise<Response>) => {
  it('serves the shell for the root path', async () => {
    const response = await serveStaticFile(documentRequest('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('serves assets with their MIME types', async () => {
    const jsResponse = await serveStaticFile(assetRequest('/assets/app.js'));
    expect(jsResponse.status).toBe(200);
    expect(jsResponse.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');

    const wasmResponse = await serveStaticFile(assetRequest('/lg2_workerfs.wasm'));
    expect(wasmResponse.headers.get('Content-Type')).toBe('application/wasm');

    const iconResponse = await serveStaticFile(assetRequest('/icons/icon-192.png'));
    expect(iconResponse.headers.get('Content-Type')).toBe('image/png');
  });

  it('falls back to the shell for unmatched document navigations', async () => {
    const response = await serveStaticFile(documentRequest('/some/deep/route'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('answers 404 for unmatched non-document requests', async () => {
    const response = await serveStaticFile(assetRequest('/missing.js'));
    expect(response.status).toBe(404);
  });
};

describe('static handler (disk source)', () => {
  assertsSharedBehavior(serveFromDisk);

  it('rejects encoded path traversal with 403', async () => {
    // new URL keeps %2F encoded in the pathname; the handler decodes it only
    // after parsing, so the escape attempt reaches the containment guard.
    const response = await serveFromDisk(assetRequest('/..%2F..%2Fsecret.txt'));
    expect(response.status).toBe(403);
  });
});

describe('static handler (embedded source)', () => {
  assertsSharedBehavior(serveFromEmbedded);
});
