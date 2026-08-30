// The server behind the compiled diffops-serve binary
// (scripts/build-diffops-serve.mjs): the Stage 4 surface — /ai-gateway plus
// the PWA embedded into the executable — with no filesystem and nothing to
// install. The generated launcher imports every dist/pwa asset with
// `with { type: 'file' }` and passes the URL→file map here.
import { handleAiGatewayRequest } from './ai-gateway.js';
import { requireBun } from './bunRuntime.js';
import { resolveServerListenOptions } from './serverOptions.js';
import { createEmbeddedFileSource, createStaticHandler } from './staticFiles.js';

/** Starts the server over an embedded PWA (URL path → bundled bunfs path). */
export function startEmbeddedServer(pathsByPathname: ReadonlyMap<string, string>): void {
  const bun = requireBun();
  const { port, hostname } = resolveServerListenOptions();
  const serveStaticFile = createStaticHandler(createEmbeddedFileSource(bun, pathsByPathname));

  bun.serve({
    port,
    hostname,
    async fetch(request) {
      const gatewayResponse = await handleAiGatewayRequest(request);
      if (gatewayResponse) {
        return gatewayResponse;
      }
      return serveStaticFile(request);
    },
  });

  console.log(
    `serving the embedded PWA (${pathsByPathname.size} files) at http://${hostname}:${port}`,
  );
}
