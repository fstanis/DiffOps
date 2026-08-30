import { afterEach, describe, expect, it, vi } from 'bun:test';

import type { PickedDirectoryHandle } from './walkDirectory';
import { watchRepository } from './watchRepository';

interface StubRecord {
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
  relativePathComponents?: string[];
  relativePathMovedFrom?: string[];
}

interface ObserverStub {
  created: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  emit: (records: StubRecord[]) => void;
  uninstall: () => void;
}

const installObserverStub = (observeResult: Promise<void> = Promise.resolve()): ObserverStub => {
  let recordCallback: ((records: StubRecord[], observer: unknown) => void) | null = null;
  const created: ObserverStub['created'] = [];
  class StubObserver {
    observe = vi.fn(() => observeResult);
    disconnect = vi.fn();
    constructor(callback: (records: StubRecord[], observer: unknown) => void) {
      recordCallback = callback;
      created.push(this);
    }
  }
  const globalWithObserver = globalThis as { FileSystemObserver?: unknown };
  globalWithObserver.FileSystemObserver = StubObserver;
  return {
    created,
    emit: (records) => {
      recordCallback?.(records, null);
    },
    uninstall: () => {
      delete globalWithObserver.FileSystemObserver;
    },
  };
};

const repoHandle: PickedDirectoryHandle = {
  kind: 'directory',
  name: 'repo',
  async *entries() {},
};

const record = (type: StubRecord['type'], path: string[], movedFrom?: string[]): StubRecord => ({
  type,
  relativePathComponents: path,
  relativePathMovedFrom: movedFrom,
});

describe('watchRepository', () => {
  let stub: ObserverStub | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    stub?.uninstall();
    stub = null;
  });

  it('resolves to null when FileSystemObserver is unavailable', async () => {
    expect(await watchRepository(repoHandle, { onChanged: () => {} })).toBeNull();
  });

  it('resolves to null when observing the handle rejects', async () => {
    stub = installObserverStub(Promise.reject(new Error('permission')));

    expect(await watchRepository(repoHandle, { onChanged: () => {} })).toBeNull();
    expect(stub.created[0]?.observe).toHaveBeenCalledWith(repoHandle, { recursive: true });
  });

  it('fires once for a burst of records and again after the debounce window', async () => {
    stub = installObserverStub();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onChanged = vi.fn();
    await watchRepository(repoHandle, { onChanged });

    stub.emit([record('modified', ['src', 'app.ts'])]);
    stub.emit([record('modified', ['src', 'app.ts'])]);
    stub.emit([record('appeared', ['README.md'])]);

    expect(onChanged).toHaveBeenCalledTimes(1);

    now += 5_000;
    stub.emit([record('disappeared', ['old.txt'])]);

    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('ignores git lock files, reflogs, and the commit-message scratch file', async () => {
    stub = installObserverStub();
    const onChanged = vi.fn();
    await watchRepository(repoHandle, { onChanged });

    stub.emit([record('modified', ['.git', 'index.lock'])]);
    stub.emit([record('disappeared', ['.git', 'refs', 'heads', 'main.lock'])]);
    stub.emit([record('modified', ['.git', 'COMMIT_EDITMSG'])]);
    stub.emit([record('appeared', ['.git', 'logs', 'HEAD'])]);

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('counts a moved record by its destination, never its source', async () => {
    stub = installObserverStub();
    const onChanged = vi.fn();
    await watchRepository(repoHandle, { onChanged });

    stub.emit([record('moved', ['.git', 'index'], ['.git', 'index.lock'])]);
    stub.emit([
      record('moved', ['.git', 'refs', 'heads', 'main'], ['.git', 'refs', 'heads', 'main.lock']),
    ]);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('treats unknown records as changes', async () => {
    stub = installObserverStub();
    const onChanged = vi.fn();
    await watchRepository(repoHandle, { onChanged });

    stub.emit([{ type: 'unknown' }]);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('fires once on a terminal errored record and stops watching', async () => {
    stub = installObserverStub();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onChanged = vi.fn();
    await watchRepository(repoHandle, { onChanged });

    stub.emit([{ type: 'errored' }]);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(stub.created[0]?.disconnect).toHaveBeenCalledTimes(1);

    now += 5_000;
    stub.emit([record('modified', ['src', 'app.ts'])]);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('silences the watcher after disconnect', async () => {
    stub = installObserverStub();
    const onChanged = vi.fn();
    const watcher = await watchRepository(repoHandle, { onChanged });
    if (!watcher) {
      throw new Error('watcher expected');
    }

    watcher.disconnect();
    stub.emit([record('modified', ['src', 'app.ts'])]);

    expect(onChanged).not.toHaveBeenCalled();
    expect(stub.created[0]?.disconnect).toHaveBeenCalledTimes(1);
  });
});
