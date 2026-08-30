import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStaticHandler } from './staticFiles.js';

const assetRoot = mkdtempSync(join(tmpdir(), 'diffops-static-'));

const writeAsset = (relativePath: string, content: string): void => {
  const fullPath = join(assetRoot, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
};

writeAsset('index.html', '<!doctype html><title>DiffOps</title>');
writeAsset('assets/app.js', 'console.log("app")');
writeAsset('lg2_workerfs.wasm', 'wasm-bytes');
writeAsset('icons/icon-192.png', 'png-bytes');

const serveStaticFile = createStaticHandler(assetRoot);

const documentRequest = (pathname: string): Request =>
  new Request(`http://localhost${pathname}`, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  });

const assetRequest = (pathname: string): Request => new Request(`http://localhost${pathname}`);

afterAll(() => {
  rmSync(assetRoot, { recursive: true, force: true });
});

// Bodies are Bun blobs, which happy-dom's Response cannot stringify, so byte fidelity is verified live (curl against `bun run serve`) rather than here.
describe('static handler', () => {
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

  it('rejects encoded path traversal with 403', async () => {
    // new URL keeps %2F encoded in the pathname; the handler decodes it only after parsing, so the escape attempt reaches the containment guard.
    const response = await serveStaticFile(assetRequest('/..%2F..%2Fsecret.txt'));
    expect(response.status).toBe(403);
  });
});
