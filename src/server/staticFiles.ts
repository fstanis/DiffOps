// Static-asset serving for the diffops server: the MIME map and the
// SPA-fallback handler over a directory on disk. The built app is entirely
// static — it talks to the AI gateway from the browser — so this is the whole
// server.
import { resolve, sep } from 'node:path';

// Service workers only install when served with a JavaScript MIME type, and
// Bun.file does not always set one through new Response(file), so map it here.
// The wasm engine streams-instantiates when it gets the wasm MIME type.
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Whether a resolved candidate path still sits inside its parent directory. */
const isPathInside = (candidate: string, parent: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`);

const contentTypeFor = (pathname: string): string => {
  const extension = pathname.slice(pathname.lastIndexOf('.'));
  return MIME_TYPES[extension] ?? 'application/octet-stream';
};

/** A static lookup: the backing file, 'forbidden' (403), or null when absent. */
type StaticFileLookup = Blob | 'forbidden' | null;

const staticFileResponse = (file: Blob, pathname: string): Response =>
  new Response(file, { headers: { 'Content-Type': contentTypeFor(pathname) } });

/** Builds the static request handler over a root directory, with SPA fallback. */
export const createStaticHandler = (root: string) => {
  const resolveFile = async (pathname: string): Promise<StaticFileLookup> => {
    const resolved = resolve(root, `.${pathname}`);
    if (!isPathInside(resolved, root)) {
      return 'forbidden';
    }
    const file = Bun.file(resolved);
    return (await file.exists()) ? file : null;
  };

  return async (request: Request): Promise<Response> => {
    // Type the resolved file, not the request path: "/" must be text/html.
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const lookup = await resolveFile(filePath);
    if (lookup && lookup !== 'forbidden') {
      return staticFileResponse(lookup, filePath);
    }
    if (lookup === 'forbidden') {
      return new Response('Forbidden', { status: 403 });
    }
    // SPA fallback: unmatched document navigations land on the shell.
    if (request.method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      const shell = await resolveFile('/index.html');
      if (shell && shell !== 'forbidden') {
        return staticFileResponse(shell, '/index.html');
      }
    }
    return new Response('Not found', { status: 404 });
  };
};
