// Preload for `bun test` (registered from bunfig.toml): installs happy-dom as
// the DOM for every test file, the jest-dom matchers, and the global stubs the
// suite grew up with under vitest. Runs once per test file — `bun test
// --isolate` gives each file a fresh global object, replacing vitest's
// per-file forks.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import '@testing-library/jest-dom';
import { vi } from 'bun:test';

GlobalRegistrator.register({ url: 'http://localhost:3000/' });

// Mock fetch globally for component tests (vi.fn's absent implementation
// returns undefined; tests install per-test behavior through mockFetch below).
const globalFetchMock = vi.fn<typeof fetch>();
globalThis.fetch = globalFetchMock as unknown as typeof fetch;

// Suppress error logs during tests
globalThis.console.error = vi.fn() as unknown as typeof console.error;

// Mock window.getComputedStyle
Object.defineProperty(window, 'getComputedStyle', {
  value: () => ({
    getPropertyValue: () => '',
  }),
});

interface MockFetchResponse {
  ok: boolean;
  json: () => Promise<unknown>;
  blob?: () => Promise<{ size: number }>;
}

const emptyRevisionsResponse = {
  specialOptions: [],
  branches: [],
  commits: [],
};

/** Programs the global fetch mock for a successful diff-style API session. */
export const mockFetch = (response: unknown, revisionsResponse?: unknown) => {
  globalFetchMock.mockImplementation(((url: RequestInfo | URL) => {
    const urlString = String(url);
    const fetchResponse: MockFetchResponse = urlString.includes('/api/revisions')
      ? {
          ok: revisionsResponse !== null,
          json: () => Promise.resolve(revisionsResponse ?? emptyRevisionsResponse),
        }
      : {
          ok: true,
          json: () => Promise.resolve(response),
          blob: () => Promise.resolve({ size: 1024 }),
        };
    return Promise.resolve(fetchResponse);
  }) as unknown as typeof fetch);
};

/** Programs the global fetch mock to reject with the given message. */
export const mockFetchError = (error: string) => {
  globalFetchMock.mockImplementation((() =>
    Promise.reject(new Error(error))) as unknown as typeof fetch);
};

type GlobalPropertyRecord = { name: string; hadProperty: boolean; original: unknown };

const viCompat = vi as unknown as Record<string, unknown>;
const stubbedGlobals: GlobalPropertyRecord[] = [];
const stubbedEnvs: GlobalPropertyRecord[] = [];

// vitest APIs bun:test lacks; each shim defers to a native implementation if
// bun grows one.
viCompat.mocked ??= (item: unknown) => item;

// vitest tolerates clearAllTimers with real timers active; bun throws.
const clearAllTimers = vi.clearAllTimers.bind(vi);
viCompat.clearAllTimers = () => {
  if (vi.isFakeTimers()) {
    clearAllTimers();
  }
};

viCompat.stubGlobal ??= (name: string, value: unknown) => {
  stubbedGlobals.push({
    name,
    hadProperty: Object.hasOwn(globalThis, name),
    original: (globalThis as Record<string, unknown>)[name],
  });
  (globalThis as Record<string, unknown>)[name] = value;
};

viCompat.unstubAllGlobals ??= () => {
  for (let record = stubbedGlobals.pop(); record; record = stubbedGlobals.pop()) {
    const globals = globalThis as Record<string, unknown>;
    if (record.hadProperty) {
      globals[record.name] = record.original;
    } else {
      delete globals[record.name];
    }
  }
};

viCompat.stubEnv ??= (name: string, value: string) => {
  stubbedEnvs.push({
    name,
    hadProperty: Object.hasOwn(process.env, name),
    original: process.env[name],
  });
  process.env[name] = value;
};

viCompat.unstubAllEnvs ??= () => {
  for (let record = stubbedEnvs.pop(); record; record = stubbedEnvs.pop()) {
    if (record.hadProperty) {
      process.env[record.name] = record.original as string | undefined;
    } else {
      delete process.env[record.name];
    }
  }
};

const drainMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
};

viCompat.runAllTimersAsync ??= async () => {
  vi.runAllTimers();
  await drainMicrotasks();
};
