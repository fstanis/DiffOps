/**
 * Pathnames the service worker must never answer from its cache: for /api/*,
 * a stale or outage-masking cached response is worse than a failure the
 * client can reason about.
 */
export const isNetworkOnlyPath = (pathname: string): boolean => pathname.includes('/api/');
