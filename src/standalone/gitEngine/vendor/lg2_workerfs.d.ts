/** Structural types for the vendored wasm-git WORKERFS build (see README.md). */
export interface Lg2FileSystem {
  mount(filesystem: unknown, options: unknown, mountPoint: string): void;
  unmount(mountPoint: string): void;
  mkdir(path: string): void;
  mkdirTree(path: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  readFile(path: string, options: { encoding: 'utf8' }): string;
  analyzePath(path: string): { exists: boolean; object?: { isFolder?: boolean } };
  chdir(path: string): void;
  /** Emscripten's syscall failure; the layer above turns it into `-errno`. */
  ErrnoError: new (errno: number) => { name: string; errno: number };
}

/** An open file in the emulated FS, addressed by its absolute mount path. */
export interface Lg2Stream {
  path: string;
}

/** The lazily-read File mount; its stream ops are the seam for read failures. */
export interface Lg2WorkerFileSystem {
  stream_ops: {
    read(
      this: void,
      stream: Lg2Stream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number;
  };
}

export interface Lg2Module {
  FS: Lg2FileSystem & { filesystems: Record<string, unknown> };
  WORKERFS: Lg2WorkerFileSystem;
  /** The wasm entry point, the one export the module names for itself. */
  _main: unknown;
  callMain(args: string[]): number;
  /** Runs lg2 with stdout/stderr captured; throws `<exitCode>: <stderr>` on failure. */
  callWithOutput(args: string[]): string;
}

/**
 * Module options (Emscripten's documented seam). Providing print/printErr
 * skips wasm-git's default hooks — which echo captured git output to the
 * console — so a caller passing them also provides callWithOutput (see
 * createQuietOutputHooks in git-worker.ts).
 */
export type Lg2ModuleOptions = Partial<Lg2Module> & Record<string, unknown>;

declare const createLg2WorkerFsModule: (options?: Lg2ModuleOptions) => Promise<Lg2Module>;

export default createLg2WorkerFsModule;
