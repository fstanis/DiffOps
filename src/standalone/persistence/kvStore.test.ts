import { describe, expect, it, vi } from 'bun:test';

import { createMemoryKvStore, openIndexedDbKvStore } from './kvStore';

describe('createMemoryKvStore', () => {
  it('round-trips values by key within a store', async () => {
    const store = createMemoryKvStore();

    await store.put('things', 'a', { count: 1 });
    await store.put('things', 'b', { count: 2 });

    await expect(store.get<{ count: number }>('things', 'a')).resolves.toEqual({ count: 1 });
    await expect(store.get('things', 'missing')).resolves.toBeUndefined();
  });

  it('overwrites values for the same key', async () => {
    const store = createMemoryKvStore();

    await store.put('things', 'a', 1);
    await store.put('things', 'a', 2);

    await expect(store.get('things', 'a')).resolves.toBe(2);
  });

  it('lists all entries and deletes by key', async () => {
    const store = createMemoryKvStore();

    await store.put('things', 'a', 1);
    await store.put('things', 'b', 2);
    await store.delete('things', 'a');

    await expect(store.getAll<number>('things')).resolves.toEqual([{ key: 'b', value: 2 }]);
    await expect(store.getAll('empty')).resolves.toEqual([]);
  });

  it('keeps stores independent', async () => {
    const store = createMemoryKvStore();

    await store.put('one', 'a', 1);
    await store.put('two', 'a', 2);

    await expect(store.get('one', 'a')).resolves.toBe(1);
    await expect(store.get('two', 'a')).resolves.toBe(2);
  });
});

// A scripted IndexedDB double: tests drive each open request by hand to sequence blocked-upgrade and competing-tab scenarios.
interface FakeOpenRequest {
  result?: unknown;
  error?: unknown;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

interface FakeTransaction {
  objectStore: () => { get: (key: string) => FakeOpenRequest };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

interface FakeDatabase {
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string) => unknown;
  close: ReturnType<typeof vi.fn>;
  onversionchange: (() => void) | null;
  transaction: () => FakeTransaction;
}

const createFakeDatabase = (): FakeDatabase => {
  const names = new Set<string>();
  return {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore: (name) => {
      names.add(name);
      return {};
    },
    close: vi.fn(),
    onversionchange: null,
    transaction: () => {
      const transaction: FakeTransaction = {
        objectStore: () => ({
          get: (key: string) => {
            const request: FakeOpenRequest = {
              result: `value:${key}`,
              onupgradeneeded: null,
              onsuccess: null,
              onerror: null,
              onblocked: null,
            };
            queueMicrotask(() => {
              request.onsuccess?.();
              queueMicrotask(() => {
                transaction.oncomplete?.();
              });
            });
            return request;
          },
        }),
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      return transaction;
    },
  };
};

const createFakeIndexedDb = () => {
  const opens: Array<{ request: FakeOpenRequest; database: FakeDatabase }> = [];
  return {
    opens,
    open: () => {
      const entry = {
        request: {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        } as FakeOpenRequest,
        database: createFakeDatabase(),
      };
      opens.push(entry);
      return entry.request;
    },
  };
};

const completeOpen = (open: { request: FakeOpenRequest; database: FakeDatabase }): void => {
  open.request.result = open.database;
  open.request.onupgradeneeded?.();
  open.request.onsuccess?.();
};

describe('openIndexedDbKvStore', () => {
  it('rejects operations when the open never settles, then recovers once it does', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeIndexedDb();
      vi.stubGlobal('indexedDB', fake);
      const store = openIndexedDbKvStore('blocked-db', ['things'], { version: 3 });

      // Observed via then/catch rather than expect().rejects, which never settles under bun's fake timers.
      const blockedGet = store.get('things', 'a');
      const blockedOutcome = blockedGet.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      vi.advanceTimersByTime(6_000);
      expect(await blockedOutcome).toMatch(/timed out/u);

      completeOpen(fake.opens[0]!);
      await expect(store.get('things', 'a')).resolves.toBe('value:a');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('closes the connection on versionchange and reopens on the next operation', async () => {
    const fake = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    const store = openIndexedDbKvStore('shared-db', ['things'], { version: 3 });

    const firstGet = store.get('things', 'a');
    completeOpen(fake.opens[0]!);
    await expect(firstGet).resolves.toBe('value:a');
    expect(fake.opens).toHaveLength(1);

    fake.opens[0]!.database.onversionchange?.();
    expect(fake.opens[0]!.database.close).toHaveBeenCalledTimes(1);

    const secondGet = store.get('things', 'b');
    expect(fake.opens).toHaveLength(2);
    completeOpen(fake.opens[1]!);
    await expect(secondGet).resolves.toBe('value:b');
    vi.unstubAllGlobals();
  });

  it('warns when the upgrade is blocked by another tab', async () => {
    const fake = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = openIndexedDbKvStore('warn-db', ['things']);

    const pendingGet = store.get('things', 'a');
    fake.opens[0]!.request.onblocked?.();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked by another tab'));

    completeOpen(fake.opens[0]!);
    await expect(pendingGet).resolves.toBe('value:a');
    warn.mockRestore();
    vi.unstubAllGlobals();
  });
});
