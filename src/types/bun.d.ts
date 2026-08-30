// Narrow Bun declarations instead of @types/bun: the server runs only under
// Bun, and only touches these two APIs. Extend here rather than adopting the
// full package (see AGENTS.md).

/** A Bun-backed file handle: a Blob that can also be probed for existence. */
interface BunFile extends Blob {
  exists(): Promise<boolean>;
}

declare const Bun: {
  file(path: string): BunFile;
  serve(options: {
    port: number | string;
    hostname: string;
    fetch(request: Request): Response | Promise<Response>;
  }): void;
};
