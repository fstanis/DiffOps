/**
 * Offline shell caching for the standalone PWA: registers the cache-first
 * service worker (see service-worker.ts), which precaches the shell at install
 * so the app is fully local after the first visit.
 */

export const registerServiceWorker = async (): Promise<void> => {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (error) {
    console.warn('diffops: service worker registration failed:', error);
  }
};
