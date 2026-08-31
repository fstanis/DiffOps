// Main-thread client for the git worker (git-worker.ts): request/response
// correlation over postMessage, a per-request timeout, and respawn + remount
// after a timeout kills a hung worker.
import type {
  GitRunResult,
  GitWorkerNotice,
  GitWorkerPayload,
  GitWorkerRequest,
  GitWorkerResponse,
  RepoFile,
} from './protocol';
import { isGitWorkerNotice } from './protocol';

const DEFAULT_TIMEOUT_MS = 120_000;

/** The worker boundary the engine talks to; tests substitute a fake. */
export interface GitWorkerClient {
  /** Mounts the walked files; resolves to warnings about unreadable entries. */
  mount(repoName: string, files: RepoFile[]): Promise<string[]>;
  run(args: string[]): Promise<GitRunResult>;
  readFile(path: string): Promise<Uint8Array | null>;
  dispose(): void;
}

interface PendingRequest {
  resolve: (payload: GitWorkerPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GitWorkerClientOptions {
  /** Worker script URL; defaults to the prebuilt bundle next to this module. */
  workerUrl?: URL;
  timeoutMs?: number;
  /** Receives engine log lines the worker posts alongside responses. */
  onLog?: (line: string) => void;
}

export const createWorkerGitClient = (options: GitWorkerClientOptions = {}): GitWorkerClient => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerUrl = options.workerUrl ?? new URL('./git-worker.js', import.meta.url);

  let worker: Worker | null = null;
  let nextRequestId = 1;
  let mountState: { repoName: string; files: RepoFile[] } | null = null;
  let isMounted = false;
  let mounting: Promise<string[]> | null = null;
  let latestMountId = 0;
  // A worker that errored before completing any request (e.g. the wasm asset
  // failed to load) is not worth respawning; one that served requests and then
  // timed out is.
  let hasServedRequest = false;
  const pending = new Map<number, PendingRequest>();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const killWorker = (): void => {
    worker?.terminate();
    worker = null;
    isMounted = false;
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }
    console.log(`[diffops git] spawning git worker: ${workerUrl.href}`);
    const spawned = new Worker(workerUrl, { type: 'module' });
    spawned.onmessage = (event: MessageEvent<GitWorkerResponse | GitWorkerNotice>) => {
      const response = event.data;
      if (isGitWorkerNotice(response)) {
        options.onLog?.(response.line);
        return;
      }
      const request = pending.get(response.id);
      if (!request) {
        console.warn(`[diffops git] response without pending request: ${response.id}`);
        return;
      }
      pending.delete(response.id);
      clearTimeout(request.timer);
      hasServedRequest = true;
      if (response.ok) {
        request.resolve(response.payload);
      } else {
        request.reject(new Error(response.error));
      }
    };
    spawned.onerror = (event) => {
      console.error(`[diffops git] worker error: ${event.message ?? 'unknown'}`);
      killWorker();
      rejectPending(
        new Error(`The git worker failed to load: ${event.message ?? 'unknown error'}`),
      );
    };
    spawned.onmessageerror = (event) => {
      console.error('[diffops git] worker message deserialization failed:', event.data);
    };
    worker = spawned;
    return spawned;
  };

  const send = (buildRequest: (id: number) => GitWorkerRequest): Promise<GitWorkerPayload> =>
    new Promise<GitWorkerPayload>((resolve, reject) => {
      const id = nextRequestId;
      nextRequestId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        console.error(
          `[diffops git] request timed out after ${timeoutMs}ms (type: ${buildRequest(0).type}, worker had served a request before: ${hasServedRequest})`,
        );
        killWorker();
        reject(
          hasServedRequest
            ? new Error('The git engine timed out and will restart on the next operation')
            : new Error('The git engine is unavailable'),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ensureWorker().postMessage(buildRequest(id));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  // A refresh queues behind an in-flight mount rather than adopting its
  // promise: adopting it reported success while the worker kept serving the
  // older snapshot, so the refreshed files never reached the reader.
  const mount = (repoName: string, files: RepoFile[]): Promise<string[]> => {
    mountState = { repoName, files };
    isMounted = false;
    latestMountId += 1;
    const mountId = latestMountId;
    const sendMount = async (): Promise<string[]> => {
      const payload = await send((id) => ({ id, type: 'mount', repoName, files }));
      if (payload.kind !== 'mount') {
        throw new Error('Unexpected response from the git worker');
      }
      if (mountId === latestMountId) {
        isMounted = true;
      }
      return payload.warnings;
    };
    const queued = mounting ? mounting.then(sendMount, sendMount) : sendMount();
    mounting = queued;
    void queued
      .catch(() => [])
      .then(() => {
        if (mounting === queued) {
          mounting = null;
        }
      });
    return queued;
  };

  const ensureMounted = async (): Promise<void> => {
    if (mounting) {
      await mounting;
      return;
    }
    if (isMounted) {
      return;
    }
    if (!mountState) {
      throw new Error('No repository mounted in the git engine');
    }
    await mount(mountState.repoName, mountState.files);
  };

  return {
    mount,
    run: async (args: string[]): Promise<GitRunResult> => {
      await ensureMounted();
      const payload = await send((id) => ({ id, type: 'run', args }));
      if (payload.kind !== 'run') {
        throw new Error('Unexpected response from the git worker');
      }
      return payload.run;
    },
    readFile: async (path: string): Promise<Uint8Array | null> => {
      await ensureMounted();
      const payload = await send((id) => ({ id, type: 'readFile', path }));
      if (payload.kind !== 'file') {
        throw new Error('Unexpected response from the git worker');
      }
      return payload.bytes ? new Uint8Array(payload.bytes) : null;
    },
    dispose: () => {
      killWorker();
      rejectPending(new Error('The git engine was closed'));
    },
  };
};
