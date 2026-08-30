import { describe, expect, it } from 'bun:test';

import { isNetworkOnlyPath } from './networkOnlyRoutes';

describe('isNetworkOnlyPath', () => {
  it('keeps API and AI gateway requests network-only', () => {
    expect(isNetworkOnlyPath('/api/diff')).toBe(true);
    expect(isNetworkOnlyPath('/api/comments-json?target=x')).toBe(true);
    expect(isNetworkOnlyPath('/ai-gateway/status')).toBe(true);
    expect(isNetworkOnlyPath('/ai-gateway/explain')).toBe(true);
  });

  it('lets shell and engine assets go through the cache', () => {
    expect(isNetworkOnlyPath('/')).toBe(false);
    expect(isNetworkOnlyPath('/index.html')).toBe(false);
    expect(isNetworkOnlyPath('/app-Ck5xJ1aP.js')).toBe(false);
    expect(isNetworkOnlyPath('/git-worker.js')).toBe(false);
    expect(isNetworkOnlyPath('/lg2_workerfs.wasm')).toBe(false);
    expect(isNetworkOnlyPath('/manifest.webmanifest')).toBe(false);
  });
});
