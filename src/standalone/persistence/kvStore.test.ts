import { describe, expect, it } from 'bun:test';

import { createMemoryKvStore } from './kvStore';

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
