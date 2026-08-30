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
  /** Repository files (including .git/*) served by readFile, as text or bytes. */
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

/** Builds a git index v2 file with stage-0 entries for the given paths. */
export const buildGitIndex = (
  entries: { path: string; sha: string; mode?: number }[],
): Uint8Array => {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('DIRC'));
  const headerView = new DataView(header.buffer);
  headerView.setUint32(4, 2);
  headerView.setUint32(8, entries.length);
  const chunks: Uint8Array[] = [header];

  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path);
    // The fixed part is stat(40) + sha(20) + flags(2); the whole entry pads
    // to a multiple of 8 with at least one NUL after the path.
    const fixed = new Uint8Array(62);
    new DataView(fixed.buffer).setUint32(24, entry.mode ?? 0o100644);
    for (let index = 0; index < 20; index += 1) {
      fixed[40 + index] = Number.parseInt(entry.sha.slice(index * 2, index * 2 + 2), 16);
    }
    new DataView(fixed.buffer).setUint16(60, entry.path.length);
    const paddedLength = Math.ceil((62 + entry.path.length + 1) / 8) * 8;
    const padding = new Uint8Array(paddedLength - 62 - entry.path.length);
    chunks.push(fixed, pathBytes, padding);
  }

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
