import { describe, expect, it, vi } from 'bun:test';

import { createWorkerGitClient } from './gitWorkerClient';
import type { GitWorkerPayload, GitWorkerRequest, RepoFile } from './protocol';

const WORKER_URL = new URL('https://diffops.test/git-worker.js');

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  readonly requests: GitWorkerRequest[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: ((event: { data: unknown }) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: GitWorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {}

  respond(id: number, payload: GitWorkerPayload): void {
    this.onmessage?.({ data: { id, ok: true, payload } });
  }
}

const repoFile = (path: string): RepoFile => ({ path, file: new File([path], path) });

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const withFakeWorker = async (assertions: (worker: () => FakeWorker) => Promise<void>) => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
  try {
    await assertions(() => FakeWorker.instances[0]!);
  } finally {
    vi.unstubAllGlobals();
  }
};

describe('createWorkerGitClient mounting', () => {
  it('sends a refresh queued behind an in-flight mount instead of dropping it', async () => {
    await withFakeWorker(async (worker) => {
      const client = createWorkerGitClient({ workerUrl: WORKER_URL });
      const opened = client.mount('repo', [repoFile('old.txt')]);
      const refreshed = client.mount('repo', [repoFile('new.txt')]);
      expect(worker().requests).toHaveLength(1);

      worker().respond(1, { kind: 'mount', warnings: [] });
      await opened;
      await flushMicrotasks();

      expect(worker().requests).toHaveLength(2);
      expect(worker().requests[1]).toMatchObject({
        type: 'mount',
        files: [{ path: 'new.txt' }],
      });
      worker().respond(2, { kind: 'mount', warnings: ['stale entry skipped'] });
      await expect(refreshed).resolves.toEqual(['stale entry skipped']);
      client.dispose();
    });
  });

  it('holds commands until the queued mount finishes', async () => {
    await withFakeWorker(async (worker) => {
      const client = createWorkerGitClient({ workerUrl: WORKER_URL });
      void client.mount('repo', [repoFile('old.txt')]);
      void client.mount('repo', [repoFile('new.txt')]);
      const run = client.run(['diff']);

      worker().respond(1, { kind: 'mount', warnings: [] });
      await flushMicrotasks();
      expect(worker().requests.map((request) => request.type)).toEqual(['mount', 'mount']);

      worker().respond(2, { kind: 'mount', warnings: [] });
      await flushMicrotasks();
      expect(worker().requests.at(-1)).toMatchObject({ type: 'run', args: ['diff'] });

      worker().respond(3, {
        kind: 'run',
        run: { stdout: 'diff output', stderr: '', exitCode: 0, stalePaths: [] },
      });
      await expect(run).resolves.toMatchObject({ stdout: 'diff output' });
      client.dispose();
    });
  });
});
