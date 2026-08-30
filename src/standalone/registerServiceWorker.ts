/**
 * Registers the cache-first service worker (service-worker.ts), which
 * precaches the shell so the app works fully offline after the first visit.
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
