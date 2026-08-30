/**
 * Pathnames the service worker must never answer from its cache: /api/* and
 * /ai-gateway/* are dynamic, where a stale cached response — or an outage
 * masked as a success — is worse than a failure the client can reason about.
 */
export const isNetworkOnlyPath = (pathname: string): boolean =>
  pathname.includes('/api/') || pathname.includes('/ai-gateway/');
