// Test doubles for the git engine: a scripted GitWorkerClient and builders
// for the git metadata files the engine parses. Imported by *.test.ts files
// only.
import { deflateSync } from 'node:zlib';

import type { GitWorkerClient } from './gitWorkerClient';
import type { GitRunResult, RepoFile } from './protocol';

export const runOk = (stdout: string): GitRunResult => ({ stdout, stderr: '', exitCode: 0 });

export const runFail = (stderr: string, exitCode = 1): GitRunResult => ({
  stdout: '',
  stderr,
  exitCode,
});

export type FakeRunHandler = (args: string[]) => GitRunResult;

export interface FakeGitWorkerClientOptions {
  /** Repository files (including .git/*) served by readFile. */
  files?: Record<string, string | Uint8Array>;
  run?: FakeRunHandler;
  /** Warnings mount() resolves with (unreadable-entry messages). */
  mountWarnings?: string[];
}

export class FakeGitWorkerClient implements GitWorkerClient {
  readonly runCalls: string[][] = [];
  mountedRepoNames: string[] = [];
  private readonly repositoryFiles: Map<string, Uint8Array>;
  private mountWarnings: string[];
  private handler: FakeRunHandler;

  constructor(options: FakeGitWorkerClientOptions = {}) {
    this.repositoryFiles = new Map(
      Object.entries(options.files ?? {}).map(([path, content]) => [
        path,
        typeof content === 'string' ? new TextEncoder().encode(content) : content,
      ]),
    );
    this.mountWarnings = options.mountWarnings ?? [];
    this.handler = options.run ?? (() => runFail('no handler for this git command'));
  }

  onRun(handler: FakeRunHandler): void {
    this.handler = handler;
  }

  setMountWarnings(warnings: string[]): void {
    this.mountWarnings = warnings;
  }

  mount(repoName: string, files: RepoFile[]): Promise<string[]> {
    this.mountedRepoNames.push(repoName);
    void files;
    return Promise.resolve([...this.mountWarnings]);
  }

  run(args: string[]): Promise<GitRunResult> {
    this.runCalls.push(args);
    return Promise.resolve(this.handler(args));
  }

  readFile(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.repositoryFiles.get(path) ?? null);
  }

  dispose(): void {}
}

export interface BuildGitIndexEntry {
  path: string;
  sha: string;
  mode?: number;
  /** Conflict stage (0-3) recorded in the entry flags. */
  stage?: number;
  /** Extended flags; when set the entry carries the v3 two-byte extension. */
  extendedFlags?: number;
}

export interface BuildGitIndexOptions {
  version?: 2 | 3 | 4;
  /** Append `<signature><u32 size><payload>` extensions after the entries. */
  extensions?: { signature: string; payload: Uint8Array }[];
}

// git's offset varint (varint.c): 7 bits per byte, big-endian, with every
// continuation byte adding one to the shifted accumulator.
const encodeOffsetVarint = (value: number): number[] => {
  const bytes: number[] = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
};

/** Builds a git index file (v2/v3/v4) with the given entries and extensions. */
export const buildGitIndex = (
  entries: BuildGitIndexEntry[],
  options?: BuildGitIndexOptions,
): Uint8Array => {
  const version = options?.version ?? 2;
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('DIRC'));
  const headerView = new DataView(header.buffer);
  headerView.setUint32(4, version);
  headerView.setUint32(8, entries.length);
  const chunks: Uint8Array[] = [header];

  let previousPath = '';
  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path);
    // The fixed part is stat(40) + sha(20) + flags(2); a v2/v3 entry pads to
    // a multiple of 8 with at least one NUL after the path, while v4 stores
    // the path prefix-compressed with no padding at all.
    const fixed = new Uint8Array(62);
    const fixedView = new DataView(fixed.buffer);
    fixedView.setUint32(24, entry.mode ?? 0o100644);
    for (let index = 0; index < 20; index += 1) {
      fixed[40 + index] = Number.parseInt(entry.sha.slice(index * 2, index * 2 + 2), 16);
    }
    // The flags length field counts path bytes, not UTF-16 code units.
    const flags =
      Math.min(pathBytes.byteLength, 0xfff) |
      ((entry.stage ?? 0) << 12) |
      (entry.extendedFlags !== undefined ? 0x4000 : 0);
    fixedView.setUint16(60, flags);
    const extended = new Uint8Array(entry.extendedFlags !== undefined ? 2 : 0);
    if (entry.extendedFlags !== undefined) {
      new DataView(extended.buffer).setUint16(0, entry.extendedFlags);
    }
    chunks.push(fixed, extended);

    if (version === 4) {
      let commonPrefix = 0;
      while (
        commonPrefix < previousPath.length &&
        commonPrefix < entry.path.length &&
        previousPath[commonPrefix] === entry.path[commonPrefix]
      ) {
        commonPrefix += 1;
      }
      chunks.push(
        new Uint8Array(encodeOffsetVarint(commonPrefix)),
        pathBytes.subarray(commonPrefix),
        new Uint8Array([0]),
      );
    } else {
      const lengthWithNul = 62 + extended.byteLength + entry.path.length + 1;
      const paddedLength = Math.ceil(lengthWithNul / 8) * 8;
      chunks.push(
        pathBytes,
        new Uint8Array(paddedLength - 62 - extended.byteLength - entry.path.length),
      );
    }
    previousPath = entry.path;
  }

  for (const extension of options?.extensions ?? []) {
    const extensionHeader = new Uint8Array(8);
    extensionHeader.set(new TextEncoder().encode(extension.signature));
    new DataView(extensionHeader.buffer).setUint32(4, extension.payload.byteLength);
    chunks.push(extensionHeader, extension.payload);
  }
  chunks.push(new Uint8Array(20));

  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const index = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    index.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return index;
};

/** Builds a zlib-compressed loose object (`<type> <size>\0<content>`). */
export const buildLooseObject = (type: string, content: Uint8Array): Uint8Array => {
  const header = new TextEncoder().encode(`${type} ${content.byteLength}\0`);
  const store = new Uint8Array(header.byteLength + content.byteLength);
  store.set(header);
  store.set(content, header.byteLength);
  return new Uint8Array(deflateSync(store));
};
