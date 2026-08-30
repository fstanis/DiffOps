// Serves the built PWA from dist/pwa (`bun run serve`). Static files are the
// whole surface: the app reaches Vercel's AI Gateway from the browser with the
// key entered in Settings, so nothing dynamic is left here.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createStaticHandler } from './staticFiles.js';

const root = resolve(process.cwd(), 'dist/pwa');
const port = process.argv[2] ?? process.env.PORT ?? '4173';
const hostname = process.env.DIFFOPS_HOST ?? '127.0.0.1';

if (!existsSync(root)) {
  console.warn(`warning: ${root} does not exist yet — run bun run build first`);
}

Bun.serve({ port, hostname, fetch: createStaticHandler(root) });

console.log(`serving ${root} at http://${hostname}:${port}`);
