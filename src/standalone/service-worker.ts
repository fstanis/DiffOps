// Cache-first shell for the standalone PWA. The app is fully local after the
// first visit: the shell (HTML + its hashed assets + manifest) is precached
// on install, and every later same-origin GET is served from the cache with
// the network only as a fill-in for entries not seen yet — except the
// network-only routes (see networkOnlyRoutes.ts), which bypass the worker.

import { isNetworkOnlyPath } from './networkOnlyRoutes';

// The workspace tsconfig uses the DOM lib, which has no ServiceWorker types;
// these narrow declarations cover everything this worker touches.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface ServiceWorkerFetchEvent extends Event {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface ServiceWorkerScope {
  location: URL;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: ServiceWorkerFetchEvent) => void): void;
}

const scope = self as unknown as ServiceWorkerScope;

// The build stamps DIFFOPS_BUILD_ID (a hash of the artifacts) into the cache
// name: any artifact change changes the SW bytes, forcing a reinstall with a
// fresh precache, and activation drops the previous cache. Without this, a
// byte-identical SW would keep serving the originally precached shell across
// builds (stable-named assets like git-worker.js would never refresh).
const BUILD_ID = process.env.DIFFOPS_BUILD_ID ?? 'dev';
const CACHE_NAME = `diffops-standalone-${BUILD_ID}`;
const SHELL_URL = './';
const SHELL_DOCUMENT_URL = './index.html';
// Not referenced from the shell HTML, so discovery cannot see them: the git
// engine's worker and its wasm binary (stable, unhashed names by design).
const ENGINE_ASSET_URLS = ['./git-worker.js', './lg2_workerfs.wasm'];

const openShellCache = (): Promise<Cache> => caches.open(CACHE_NAME);

const precacheUrl = async (cache: Cache, url: string): Promise<void> => {
  try {
    const response = await fetch(url, { cache: 'reload' });
    if (response.ok) {
      await cache.put(url, response);
    }
  } catch {
    // Offline or unavailable during install; runtime caching fills the gap.
  }
};

// The build hashes asset filenames, so discover them from the shell document
// instead of hardcoding a list: every ./-relative href/src gets precached.
const discoverShellAssets = async (cache: Cache): Promise<string[]> => {
  const documentResponse = await cache.match(SHELL_DOCUMENT_URL);
  if (!documentResponse) {
    return [];
  }
  const html = await documentResponse.clone().text();
  const refs = new Set<string>();
  for (const match of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
    refs.add(match[1] as string);
  }
  return [...refs];
};

scope.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openShellCache();
      await precacheUrl(cache, SHELL_URL);
      await precacheUrl(cache, SHELL_DOCUMENT_URL);
      for (const assetUrl of await discoverShellAssets(cache)) {
        await precacheUrl(cache, assetUrl);
      }
      for (const assetUrl of ENGINE_ASSET_URLS) {
        await precacheUrl(cache, assetUrl);
      }
      await scope.skipWaiting();
    })(),
  );
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await scope.clients.claim();
    })(),
  );
});

const cacheFirst = async (request: Request): Promise<Response> => {
  const cache = await openShellCache();
  const isNavigation = request.mode === 'navigate';
  const cached =
    (await cache.match(request)) ??
    (isNavigation
      ? ((await cache.match(SHELL_DOCUMENT_URL)) ?? (await cache.match(SHELL_URL)))
      : null);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (isNavigation) {
      return new Response('diffops is offline and this page is not cached yet.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
};

scope.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== scope.location.origin || isNetworkOnlyPath(requestUrl.pathname)) {
    return;
  }

  event.respondWith(cacheFirst(request));
});
