// Static-asset serving shared by the server entries: the MIME map, the
// SPA-fallback handler, and the two file sources behind it — disk-rooted
// (`bun run serve`) and embedded in the compiled diffops-serve binary.
import { resolve, sep } from 'node:path';

import type { BunFile, BunGlobal } from './bunRuntime.js';

// Service workers only install when served with a JavaScript MIME type, and
// Bun.file does not always set one through new Response(file), so map it here.
// The wasm engine streams-instantiates when it gets the wasm MIME type.
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Whether a resolved candidate path still sits inside its parent directory. */
export const isPathInside = (candidate: string, parent: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`);

const contentTypeFor = (pathname: string): string => {
  const extension = pathname.slice(pathname.lastIndexOf('.'));
  return MIME_TYPES[extension] ?? 'application/octet-stream';
};

export const staticFileResponse = (file: BunFile, pathname: string): Response =>
  new Response(file, { headers: { 'Content-Type': contentTypeFor(pathname) } });

/** A static lookup: the backing file, 'forbidden' (403), or null when absent. */
type StaticFileLookup = BunFile | 'forbidden' | null;

export interface StaticFileSource {
  resolveFile(pathname: string): Promise<StaticFileLookup>;
}

/** Serves files from a directory on disk, guarding against path escape. */
export const createDiskFileSource = (bun: BunGlobal, root: string): StaticFileSource => ({
  async resolveFile(pathname) {
    const resolved = resolve(root, `.${pathname}`);
    if (!isPathInside(resolved, root)) {
      return 'forbidden';
    }
    const file = bun.file(resolved);
    return (await file.exists()) ? file : null;
  },
});

/** Serves files embedded in the binary: URL path → bundled bunfs path. */
export const createEmbeddedFileSource = (
  bun: BunGlobal,
  pathsByPathname: ReadonlyMap<string, string>,
): StaticFileSource => ({
  resolveFile(pathname) {
    const embeddedPath = pathsByPathname.get(pathname);
    return Promise.resolve(embeddedPath ? bun.file(embeddedPath) : null);
  },
});

/** Builds the static request handler over a file source, with SPA fallback. */
export const createStaticHandler =
  (source: StaticFileSource) =>
  async (request: Request): Promise<Response> => {
    // Type the resolved file, not the request path: "/" must be text/html.
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const lookup = await source.resolveFile(filePath);
    if (lookup && lookup !== 'forbidden') {
      return staticFileResponse(lookup, filePath);
    }
    if (lookup === 'forbidden') {
      return new Response('Forbidden', { status: 403 });
    }
    // SPA fallback: unmatched document navigations land on the shell.
    if (request.method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      const shell = await source.resolveFile('/index.html');
      if (shell && shell !== 'forbidden') {
        return staticFileResponse(shell, '/index.html');
      }
    }
    return new Response('Not found', { status: 404 });
  };
