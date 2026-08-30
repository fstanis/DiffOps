// Narrow Bun declarations instead of @types/bun: the server only touches these two APIs. Extend here rather than adopting the full package (see AGENTS.md).

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
