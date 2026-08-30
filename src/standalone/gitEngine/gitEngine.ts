// The standalone app's git backend: drives the wasm-git worker and turns its
// lg2 output into the API shapes the client renders. Deviations from git's
// own diff semantics come from lg2's libgit2 command surface (see
// docs/plans/pwa-port.md stage 3):
// - rename detection is always requested via -M50 (git's default, lg2's opt-in)
// - merge-base is approximated by the first rev-list(target) entry reachable
//   from base (lg2 has no merge-base command)
// - generated-file status uses path + content heuristics only (no check-attr)
import type {
  DiffResponse,
  DiffSelection,
  GeneratedStatusResponse,
  RevisionsResponse,
} from '../../types/diff';
import {
  createDiffSelection,
  getMergeBaseTargetRef,
  normalizeBaseMode,
} from '../../utils/diffSelection';
import { isGeneratedFile } from '../../utils/generated-file-check';
import { parseUnifiedDiff } from '../../utils/unifiedDiff';
import { createWorkerGitClient, type GitWorkerClient } from './gitWorkerClient';
import {
  findUnsupportedIndexEntries,
  parseGitIndex,
  parseHeadRef,
  parseLg2ForEachRef,
  parseLg2Log,
  parseLooseObjectHeader,
  parseOriginHeadRef,
} from './lg2OutputParsers';
import type { WalkedFile } from './walkDirectory';

const SHORT_HASH_LENGTH = 7;
const COMMIT_LIMIT = 20;
const GENERATED_HEADER_SCAN_BYTES = 4096;
const GENERATED_HEADER_LINE_LIMIT = 20;
const SPECIAL_TARGETS = new Set(['working', 'staged', '.']);

const SPECIAL_OPTIONS: RevisionsResponse['specialOptions'] = [
  { value: '.', label: 'All Uncommitted Changes' },
  { value: 'staged', label: 'Staging Area' },
  { value: 'working', label: 'Working Directory' },
];

const DEFAULT_SELECTION: DiffSelection = createDiffSelection('HEAD', '.');

const shortHash = (hash: string): string => hash.substring(0, SHORT_HASH_LENGTH);

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Text captured from lg2 stdout decodes lossily; these markers flag binary content. */
const looksBinary = (text: string): boolean => text.includes('\u0000') || text.includes('\uFFFD');

const inflate = async (compressed: Uint8Array): Promise<Uint8Array> => {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const pump = (async () => {
    // Copy into a plain ArrayBuffer-backed view; the source may be typed over
    // a shared buffer the stream writer rejects.
    await writer.write(new Uint8Array(compressed));
    await writer.close();
  })();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  await pump;
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const inflated = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    inflated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return inflated;
};

/** A repository blob as text (the common review case) or raw bytes. */
export type GitBlob = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Uint8Array };

/** What the diff endpoint receives from a request's query parameters. */
export interface DiffSelectionParams {
  base?: string;
  target?: string;
  baseMode?: string;
}

export interface RepositoryInfo {
  repoName: string;
  repositoryId: string;
  /** Non-fatal problems: unreadable .git entries, symlinks the FS can't show. */
  warnings: string[];
}

/**
 * The engine surface the API bridge consumes; GitEngine satisfies it and
 * tests substitute focused doubles.
 */
export interface RepositoryEngine {
  readonly currentSelection: DiffSelection;
  diff(request?: DiffSelectionParams, ignoreWhitespace?: boolean): Promise<DiffResponse>;
  revisions(): Promise<RevisionsResponse>;
  blob(path: string, ref: string): Promise<GitBlob>;
  lineCount(path: string, ref: string): Promise<number>;
  generatedStatus(path: string, ref: string): Promise<GeneratedStatusResponse>;
  /** Re-mounts freshly walked files; resolves to new mount warnings. */
  refresh(files: WalkedFile[]): Promise<string[]>;
}

export class GitEngine implements RepositoryEngine {
  private readonly client: GitWorkerClient;
  private files = new Map<string, File>();
  private repoName = '';
  private repositoryIdValue = '';
  private selection = DEFAULT_SELECTION;

  constructor(client: GitWorkerClient) {
    this.client = client;
  }

  get repositoryId(): string | null {
    return this.repositoryIdValue || null;
  }

  /** The selection a bare /api/diff serves; mirrors the server's currentSelection. */
  get currentSelection(): DiffSelection {
    return this.selection;
  }

  async open(files: WalkedFile[], repoName: string): Promise<RepositoryInfo> {
    const startedAt = performance.now();
    console.log(`[diffops git] opening "${repoName}" (${files.length} files)`);
    this.files = new Map(files.map(({ path, file }) => [path, file]));
    this.repoName = repoName;
    const warnings = await this.client.mount(repoName, files);
    await this.verifyRepository();

    const rootCommit = await this.findRootCommit();
    this.repositoryIdValue = `repo-${(await sha256Hex(`${rootCommit}|${repoName}`)).slice(0, 16)}`;
    this.selection = DEFAULT_SELECTION;
    warnings.push(...(await this.unsupportedEntriesWarnings()));
    console.log(
      `[diffops git] repository ready: ${this.repositoryIdValue} (${Math.round(performance.now() - startedAt)}ms)`,
    );
    return { repoName, repositoryId: this.repositoryIdValue, warnings };
  }

  /** Re-mounts freshly walked files; the reader sees a new point-in-time snapshot. */
  async refresh(files: WalkedFile[]): Promise<string[]> {
    this.files = new Map(files.map(({ path, file }) => [path, file]));
    return this.client.mount(this.repoName, files);
  }

  async diff(request?: DiffSelectionParams, ignoreWhitespace = false): Promise<DiffResponse> {
    const selection = this.mergeSelection(request);
    this.selection = selection;
    const { targetCommitish: target, baseCommitish: requestedBase } = selection;
    const requestedBaseMode =
      normalizeBaseMode(selection.baseMode) === 'merge-base' ? ('merge-base' as const) : undefined;

    try {
      const effectiveBase = await this.resolveBase(selection);
      let commit: string;
      let diffArgs: string[];
      let resolvedBaseCommitish = effectiveBase;
      let resolvedTargetCommitish = target;

      if (target === 'working') {
        commit = 'Working Directory (unstaged changes)';
        diffArgs = [];
      } else if (target === 'staged') {
        const baseHash = await this.resolveHash(effectiveBase);
        commit = `${shortHash(baseHash)} vs Staging Area (staged changes)`;
        resolvedBaseCommitish = shortHash(baseHash);
        diffArgs = ['--cached', effectiveBase];
      } else if (target === '.') {
        const baseHash = await this.resolveHash(effectiveBase);
        commit = `${shortHash(baseHash)} vs Working Directory (all uncommitted changes)`;
        resolvedBaseCommitish = shortHash(baseHash);
        diffArgs = [effectiveBase];
      } else {
        const targetHash = await this.resolveHash(target);
        const baseHash = await this.resolveHash(effectiveBase);
        commit = `${shortHash(baseHash)}...${shortHash(targetHash)}`;
        resolvedBaseCommitish = shortHash(baseHash);
        resolvedTargetCommitish = shortHash(targetHash);
        diffArgs = [baseHash, targetHash];
      }

      const result = await this.mustRun([
        'diff',
        ...diffArgs,
        '-M50',
        ...(ignoreWhitespace ? ['-w'] : []),
      ]);
      const files = parseUnifiedDiff(result.stdout);

      return {
        commit,
        files,
        isEmpty: files.length === 0,
        baseCommitish: resolvedBaseCommitish,
        targetCommitish: resolvedTargetCommitish,
        requestedBaseCommitish: requestedBase,
        requestedTargetCommitish: target,
        requestedBaseMode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to compute diff for ${target} vs ${requestedBase}: ${message}`);
    }
  }

  async revisions(): Promise<RevisionsResponse> {
    const refsResult = await this.mustRun(['for-each-ref']);
    const refs = parseLg2ForEachRef(refsResult.stdout);
    const headContent = await this.readRepositoryText('.git/HEAD');
    const headRef = headContent !== null ? parseHeadRef(headContent) : null;
    const branches = refs
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({
        name: ref.name.replace(/^refs\/heads\//, ''),
        current: ref.name === headRef,
      }));

    const originHeadContent = await this.readRepositoryText('.git/refs/remotes/origin/HEAD');
    const originHeadBranch = originHeadContent ? parseOriginHeadRef(originHeadContent) : null;
    const remoteNames = refs
      .filter((ref) => ref.name.startsWith('refs/remotes/origin/'))
      .map((ref) => ref.name.replace(/^refs\/remotes\/origin\//, ''));
    const originDefaultBranchName =
      originHeadBranch ??
      (remoteNames.includes('main') ? 'main' : remoteNames.includes('master') ? 'master' : null);
    const originDefaultBranch = originDefaultBranchName
      ? `origin/${originDefaultBranchName}`
      : undefined;

    const currentBranchName = branches.find((branch) => branch.current)?.name ?? '';
    const defaultBranchName =
      [...(originDefaultBranchName ? [originDefaultBranchName] : []), 'main', 'master'].find(
        (name) => branches.some((branch) => branch.name === name),
      ) ?? '';
    const sortedBranches = [...branches].sort((left, right) => {
      const rank = (name: string): number =>
        name === defaultBranchName ? 0 : name === currentBranchName ? 1 : 2;
      return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name);
    });

    const logResult = await this.mustRun(['log', '-n', String(COMMIT_LIMIT)]);
    const commits = parseLg2Log(logResult.stdout).map((parsed) => ({
      hash: parsed.hash,
      shortHash: shortHash(parsed.hash),
      message: parsed.message.split('\n')[0] ?? '',
    }));

    const resolvedBase = await this.resolveShortOrNull(this.selection.baseCommitish);
    const resolvedTarget = await this.resolveShortOrNull(this.selection.targetCommitish);

    return {
      specialOptions: SPECIAL_OPTIONS,
      branches: sortedBranches,
      commits,
      originDefaultBranch,
      resolvedBase,
      resolvedTarget,
    };
  }

  async blob(path: string, ref: string): Promise<GitBlob> {
    const cleanPath = this.normalizeRepositoryPath(path);
    if (ref === 'working' || ref === '.') {
      const file = this.files.get(cleanPath);
      if (!file) {
        throw new Error('File not found');
      }
      return { kind: 'bytes', bytes: new Uint8Array(await file.arrayBuffer()) };
    }

    const sha =
      ref === 'staged'
        ? await this.stagedBlobSha(cleanPath)
        : await this.refBlobSha(cleanPath, ref);

    const textResult = await this.client.run(['cat-file', '-p', sha]);
    if (textResult.exitCode !== 0) {
      throw new Error('File not found');
    }
    if (looksBinary(textResult.stdout)) {
      return { kind: 'bytes', bytes: await this.looseObjectBytes(sha) };
    }
    return { kind: 'text', text: textResult.stdout };
  }

  async lineCount(path: string, ref: string): Promise<number> {
    try {
      const content = await this.blob(path, ref);
      if (content.kind === 'text') {
        return countNewlines(content.text);
      }
      return countNewlines(content.bytes);
    } catch {
      // Server parity: line-count failures resolve to 0.
      return 0;
    }
  }

  async generatedStatus(path: string, ref: string): Promise<GeneratedStatusResponse> {
    if (isGeneratedFile(path).isGenerated) {
      return { path, ref, isGenerated: true, source: 'path' };
    }
    try {
      const content = await this.blob(path, ref);
      if (content.kind === 'text') {
        const header = content.text.slice(0, GENERATED_HEADER_SCAN_BYTES);
        const headerLines = header.split('\n').slice(0, GENERATED_HEADER_LINE_LIMIT);
        if (isGeneratedFile(path, () => headerLines).isGenerated) {
          return { path, ref, isGenerated: true, source: 'content' };
        }
      }
    } catch {
      // Content unavailable (binary/deleted): fall through to the path answer.
    }
    return { path, ref, isGenerated: false, source: 'path' };
  }

  dispose(): void {
    this.client.dispose();
  }

  private mergeSelection(request?: DiffSelectionParams): DiffSelection {
    const hasAny =
      request !== undefined &&
      (request.base !== undefined ||
        request.target !== undefined ||
        request.baseMode !== undefined);
    if (!hasAny) {
      return this.selection;
    }
    const base = request.base ?? this.selection.baseCommitish;
    const target = request.target ?? this.selection.targetCommitish;
    // Server parity: explicit base/target without a mode resets the mode.
    const baseMode =
      request.baseMode ??
      (request.base !== undefined || request.target !== undefined
        ? undefined
        : this.selection.baseMode);
    return createDiffSelection(base, target, baseMode === 'merge-base' ? 'merge-base' : undefined);
  }

  private async resolveBase(selection: DiffSelection): Promise<string> {
    if (normalizeBaseMode(selection.baseMode) !== 'merge-base') {
      return selection.baseCommitish;
    }
    return this.mergeBase(
      getMergeBaseTargetRef(selection.targetCommitish),
      selection.baseCommitish,
    );
  }

  // First commit of rev-list(target) reachable from base; lg2 has no
  // merge-base command. Correct for ordinary divergent histories.
  private async mergeBase(targetRef: string, base: string): Promise<string> {
    const targetHistory = (await this.mustRun(['rev-list', targetRef])).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const baseHistory = new Set(
      (await this.mustRun(['rev-list', base])).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const commonAncestor = targetHistory.find((hash) => baseHistory.has(hash));
    if (!commonAncestor) {
      throw new Error(`No common ancestor between ${targetRef} and ${base}`);
    }
    return commonAncestor;
  }

  private async resolveHash(commitish: string): Promise<string> {
    const result = await this.client.run(['rev-parse', commitish]);
    const hash = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(hash)) {
      throw new Error(result.stderr.trim() || `Unknown revision "${commitish}"`);
    }
    return hash;
  }

  private async resolveShortOrNull(commitish: string): Promise<string | undefined> {
    if (!commitish || SPECIAL_TARGETS.has(commitish)) {
      return undefined;
    }
    try {
      return shortHash(await this.resolveHash(commitish));
    } catch {
      return undefined;
    }
  }

  private async verifyRepository(): Promise<void> {
    const headBytes = await this.client.readFile('.git/HEAD');
    if (!headBytes) {
      const gitFileBytes = await this.client.readFile('.git');
      if (gitFileBytes) {
        throw new Error(
          `"${this.repoName}" uses a .git file (a worktree or submodule); pick the main repository folder instead`,
        );
      }
      throw new Error(`"${this.repoName}" is not a git repository (no .git/HEAD found)`);
    }

    const headRef = parseHeadRef(new TextDecoder().decode(headBytes));
    if (!headRef) {
      return;
    }
    const refBytes = await this.client.readFile(`.git/${headRef}`);
    if (refBytes) {
      return;
    }
    const packedRefs = await this.readRepositoryText('.git/packed-refs');
    if (!packedRefs?.includes(headRef)) {
      throw new Error(`"${this.repoName}" has no commits yet`);
    }
  }

  private async findRootCommit(): Promise<string> {
    const result = await this.client.run(['rev-list', 'HEAD']);
    const hashes = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const rootCommit = hashes.at(-1);
    if (result.exitCode !== 0 || !rootCommit) {
      throw new Error('Unable to read the repository history');
    }
    return rootCommit;
  }

  // WORKERFS cannot represent symlinks or submodule gitlinks. Chromium's file
  // system access hides symlinks outright, so they diff as deleted; a moved
  // submodule pointer (`.git`-file layout) diffs to nothing at all. The index
  // still records their true modes; surface them as warnings instead of
  // letting the diff misrender silently.
  private async unsupportedEntriesWarnings(): Promise<string[]> {
    const indexBytes = await this.client.readFile('.git/index');
    if (!indexBytes) {
      return [];
    }
    const countLabel = (count: number, noun: string): string =>
      `${count} ${noun}${count === 1 ? '' : 's'}`;
    try {
      const { symlinkPaths, gitlinkPaths } = findUnsupportedIndexEntries(indexBytes);
      const warnings: string[] = [];
      if (symlinkPaths.length > 0) {
        warnings.push(
          `Browsers cannot represent the ${countLabel(symlinkPaths.length, 'symlink')} in this repository (e.g. "${symlinkPaths[0]}"); ${symlinkPaths.length === 1 ? 'it shows' : 'they show'} as deleted.`,
        );
      }
      if (gitlinkPaths.length > 0) {
        warnings.push(
          `This repository contains ${countLabel(gitlinkPaths.length, 'submodule')} (e.g. "${gitlinkPaths[0]}") whose contents a browser cannot read; submodule pointer changes are not reported.`,
        );
      }
      return warnings;
    } catch {
      // An index we cannot parse is not itself a review problem.
      return [];
    }
  }

  private async stagedBlobSha(path: string): Promise<string> {
    const indexBytes = await this.client.readFile('.git/index');
    if (!indexBytes) {
      throw new Error('File not found');
    }
    const index = parseGitIndex(indexBytes);
    const sha = index.get(path);
    if (!sha) {
      throw new Error('File not found');
    }
    return sha;
  }

  private async refBlobSha(path: string, ref: string): Promise<string> {
    const result = await this.client.run(['rev-parse', `${ref}:${path}`]);
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('File not found');
    }
    return sha;
  }

  private async looseObjectBytes(sha: string): Promise<Uint8Array> {
    const objectBytes = await this.client.readFile(
      `.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`,
    );
    if (!objectBytes) {
      throw new Error('Binary blob content is unavailable (the object is packed)');
    }
    const inflated = await inflate(objectBytes);
    const header = parseLooseObjectHeader(inflated);
    return inflated.subarray(header.contentStart, header.contentStart + header.size);
  }

  private normalizeRepositoryPath(path: string): string {
    const normalized = path.replace(/^\/+/, '');
    const segments = normalized.split('/');
    if (!normalized || segments.includes('..')) {
      throw new Error('Invalid repository path');
    }
    return normalized;
  }

  private async mustRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.client.run(args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    }
    return result;
  }

  private async readRepositoryText(path: string): Promise<string | null> {
    const bytes = await this.client.readFile(path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }
}

const countNewlines = (content: string | Uint8Array): number => {
  let newlines = 0;
  if (typeof content === 'string') {
    for (const character of content) {
      if (character === '\n') {
        newlines += 1;
      }
    }
    return content.length > 0 && !content.endsWith('\n') ? newlines + 1 : newlines;
  }
  for (const byte of content) {
    if (byte === 0x0a) {
      newlines += 1;
    }
  }
  return content.byteLength > 0 && content.at(-1) !== 0x0a ? newlines + 1 : newlines;
};

/** Builds the engine over the real git worker; tests inject their own client. */
export const createGitEngine = (): GitEngine => new GitEngine(createWorkerGitClient());
