// Narrow declarations instead of @types/bun: the server runs only under Bun.

/** A Bun-backed file handle; a Blob that can also be probed for existence. */
export interface BunFile extends Blob {
  exists(): Promise<boolean>;
}

interface BunServeOptions {
  port: number | string;
  hostname: string;
  fetch(request: Request): Response | Promise<Response>;
}

export interface BunGlobal {
  serve(options: BunServeOptions): void;
  file(path: string): BunFile;
  /** Path of the entry file: the script under `bun run`, the virtual binary path when compiled. */
  readonly main: string;
}

/** The Bun runtime global, or null outside Bun. */
export const getBun = (): BunGlobal | null =>
  (globalThis as unknown as { Bun?: BunGlobal }).Bun ?? null;

/** The Bun runtime global; server entries refuse to start without it. */
export const requireBun = (): BunGlobal => {
  const bun = getBun();
  if (!bun) {
    throw new Error('The diffops server runs under Bun only — start it with `bun run serve`');
  }
  return bun;
};
