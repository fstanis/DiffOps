// Launch options shared by the server entries: `bun run serve` and the compiled
// diffops-serve binary read the same argv/env contract.
import { getBun } from './bunRuntime.js';

const DEFAULT_PORT = '4173';
const DEFAULT_HOSTNAME = '127.0.0.1';

export interface ServerListenOptions {
  readonly port: string;
  readonly hostname: string;
}

export interface ServerEnv {
  readonly PORT?: string;
  readonly DIFFOPS_HOST?: string;
}

// Bun.main is the entry path in argv under both launch modes — the script
// for `bun serve.ts 3000`, the virtual /$bunfs binary path once compiled
// (where every bundled module shares the entry's path) — so the user's
// arguments are whatever follows it.
const positionalArgs = (argv: readonly string[], entryPath: string | null): readonly string[] => {
  const entryIndex = entryPath === null ? -1 : argv.indexOf(entryPath);
  return argv.slice(entryIndex >= 0 ? entryIndex + 1 : 1);
};

/** The address to bind: first positional arg wins, then PORT/DIFFOPS_HOST, then the defaults. */
export const resolveServerListenOptions = (
  argv: readonly string[] = process.argv,
  entryPath: string | null = getBun()?.main ?? null,
  env: ServerEnv = process.env,
): ServerListenOptions => ({
  port: positionalArgs(argv, entryPath)[0] ?? env.PORT ?? DEFAULT_PORT,
  hostname: env.DIFFOPS_HOST ?? DEFAULT_HOSTNAME,
});
