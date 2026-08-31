// Git worker: hosts the wasm-git (lg2) engine. The picked repository's work
// tree is mirrored lazily into a read-only WORKERFS mount at /repo, while .git
// is copied into writable MEMFS at /gitdir — libgit2 reads packfiles and refs
// through mmap, which WORKERFS cannot back, so the object database must live
// on MEMFS (see docs/plans/pwa-port.md stage 3). The two are wired together
// with lg2's --git-dir flag plus a core.worktree entry, and the index lg2
// writes stays on MEMFS via --index-file, seeded from the repo's real index.
//
// CRITICAL ordering: a message handler must be installed synchronously,
// before the top-level awaits below. This is a module worker whose script
// suspends during initialization; messages the main thread posts in that
// window are dropped before any handler exists otherwise, and every request
// silently times out (the handler-installed-after-await bug).
import type { GitRunResult, GitWorkerRequest, GitWorkerResponse } from './protocol';
import { isMirroredGitPath } from './gitDirPaths';
import type { Lg2Module, Lg2ModuleOptions, Lg2Stream } from './vendor/lg2_workerfs.js';

// The workspace tsconfig uses the DOM lib, whose global postMessage expects a
// targetOrigin; the dedicated-worker overload takes a transfer list instead.
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<GitWorkerRequest>) => void) | null;
};

const WORKTREE_ROOT = '/repo';
const GIT_DIR_ROOT = '/gitdir';
// A `.git` that is a file (a worktree or submodule pointer) is mirrored
// verbatim so verifyRepository can read it and explain itself.
const GIT_FILE_ROOT = '/gitfile';
// The emulated-FS stat data never matches the real index, so diffs must fall
// back to content comparison. `git status` would "fix" that by refreshing the
// stat cache INTO this file, after which worktree diffs silently come back
// empty — never run status (or any index-writing command) in this engine.
const INDEX_FILE = '/gitindex';
// Emscripten's errno numbering: EIO.
const ERRNO_IO = 29;

// Emscripten throws plain objects (FS.ErrnoError without message strings) and
// callWithOutput throws strings; format anything into a readable line.
const formatError = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error) ?? Object.prototype.toString.call(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
};

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

// What libgit2 actually reads from .git for our read-only operations. The
// rest (hooks, reflogs, editor droppings) is skipped: mirroring cost scales
// with .git size, which is dominated by objects. Kept as defence in depth —
// the repository walker filters with the same predicate (gitDirPaths.ts).

// Worker console output is invisible to automated browser runs (and dies with
// a crashed renderer), so every milestone is also posted to the main thread.
const notify = (line: string): void => {
  console.log(`[diffops git] ${line}`);
  workerScope.postMessage({ type: 'log', line: `[diffops git] ${line}` });
};

const notifyError = (line: string): void => {
  console.error(`[diffops git] ${line}`);
  workerScope.postMessage({ type: 'log', line: `[diffops git] ERROR: ${line}` });
};

const isGitPath = (path: string): boolean => path === '.git' || path.startsWith('.git/');

// lg2's default stdout hooks echo every git command's output (diffs, hashes,
// the lot) to console.log/console.error while callWithOutput also captures it.
// Providing print/printErr skips that default entirely; the capture machinery
// and callWithOutput semantics are reimplemented here echo-free (upstream's
// module options are the supported seam — the vendor file stays untouched).
//
// libgit2 never flushes its stdout buffer at exit: a command whose last line
// lacks a newline (raw `cat-file -p` blob content is the common case) leaves
// that fragment buffered, and it glues itself onto the next command's first
// captured line. callWithOutput drains that residue by running one
// newline-terminated command while the capture buffers are still live, so
// the residue is discarded along with the drain's own output.
const createQuietOutputHooks = () => {
  let capturedOutput: string[] | null = null;
  let capturedError: string[] | null = null;
  let quitStatus: number | null = null;
  const drainDanglingStdout = (): void => {
    try {
      // callMain mutates the array it receives (it unshifts the program
      // name), so every drain builds a fresh one.
      lg.callMain(['--index-file', INDEX_FILE, '--git-dir', GIT_DIR_ROOT, 'rev-parse', 'HEAD']);
    } catch {
      // Repos without commits cannot drain; they have no blob output to
      // leave dangling.
    }
  };
  return {
    print: (message: string): void => {
      capturedOutput?.push(message);
    },
    printErr: (message: string): void => {
      capturedError?.push(message);
    },
    quit: (status: number): void => {
      quitStatus = status;
    },
    callWithOutput: (args: string[]): string => {
      capturedOutput = [];
      capturedError = [];
      quitStatus = null;
      const exitCode = lg.callMain(args);
      const output = capturedOutput.join('\n');
      const errorText = capturedError.join('\n');
      drainDanglingStdout();
      capturedOutput = null;
      capturedError = null;
      if (exitCode !== 0) {
        throw `${exitCode}: ${errorText}`;
      }
      if (quitStatus) {
        throw `${quitStatus}: ${errorText}`;
      }
      return output;
    },
  };
};

// Requests that arrive before the engine finished initializing. The handler
// below is live from the first synchronous statement, so nothing is dropped.
const earlyRequests: GitWorkerRequest[] = [];
let handleRequest: ((request: GitWorkerRequest) => void) | null = null;

self.onmessage = (event: MessageEvent<GitWorkerRequest>): void => {
  const request = event.data;
  if (handleRequest) {
    handleRequest(request);
    return;
  }
  earlyRequests.push(request);
};

const initEngine = async (): Promise<Lg2Module> => {
  notify('worker starting');
  // Import the engine dynamically so "worker starting" is logged even when
  // the wasm module itself fails to load.
  let createLg2Module: (options?: Lg2ModuleOptions) => Promise<Lg2Module>;
  try {
    ({ default: createLg2Module } = await import('./vendor/lg2_workerfs.js'));
  } catch (error) {
    notifyError(
      `engine module failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  const initStartedAt = performance.now();
  let lg: Lg2Module;
  try {
    lg = await createLg2Module(createQuietOutputHooks());
  } catch (error) {
    notifyError(
      `wasm-git failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  notify(`wasm-git ready in ${Math.round(performance.now() - initStartedAt)}ms`);
  return lg;
};

const lg = await initEngine();
const FS = lg.FS;

// A picked File is a point-in-time snapshot: the moment the file changes on
// disk the browser refuses to read it, and WORKERFS reads worktree files
// lazily, from inside libgit2's read syscall. Left alone that throws a
// DOMException clean through the wasm frames, killing the whole command with
// an opaque message; answering the syscall with EIO instead keeps the failure
// inside libgit2, and the recorded paths tell the main thread which files a
// fresh walk has to replace.
const stalePaths = new Set<string>();

const worktreeRelativePath = (path: string): string =>
  path.startsWith(`${WORKTREE_ROOT}/`) ? path.slice(WORKTREE_ROOT.length + 1) : path;

const installStaleFileGuard = (): void => {
  const readChunk = lg.WORKERFS.stream_ops.read;
  lg.WORKERFS.stream_ops.read = (
    stream: Lg2Stream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number => {
    try {
      return readChunk(stream, buffer, offset, length, position);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'ErrnoError') {
        throw error;
      }
      stalePaths.add(worktreeRelativePath(stream.path));
      throw new FS.ErrnoError(ERRNO_IO);
    }
  };
};

installStaleFileGuard();

// libgit2 refuses repositories owned by other users; the mirror's synthetic
// ownership always differs from the emulated home, so allow every directory.
FS.writeFile(
  '/home/web_user/.gitconfig',
  [
    '[user]',
    'name = diffops',
    'email = diffops@standalone.local',
    '[safe]',
    'directory = *',
    '',
  ].join('\n'),
);

const removeTree = (path: string): void => {
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') {
      continue;
    }
    const child = `${path}/${name}`;
    if (FS.analyzePath(child).object?.isFolder) {
      removeTree(child);
    } else {
      FS.unlink(child);
    }
  }
  FS.rmdir(path);
};

const dropPreviousRepository = (): void => {
  // The cwd sits inside the worktree after the first mount; rmdir('/repo')
  // refuses while it is the cwd, the stale directory survives the swallowed
  // error, and the fresh mkdir on remount dies with ErrnoError 20.
  try {
    FS.chdir('/');
  } catch {
    // Fresh worker: cwd is already outside the worktree.
  }
  // The worktree mount must come off before its directory can be deleted.
  try {
    FS.unmount(WORKTREE_ROOT);
  } catch {
    // No previous mount.
  }
  try {
    removeTree(WORKTREE_ROOT);
  } catch {
    // No previous worktree.
  }
  try {
    removeTree(GIT_DIR_ROOT);
  } catch {
    // No previous git directory.
  }
  try {
    FS.unlink(GIT_FILE_ROOT);
  } catch {
    // No previous .git file.
  }
};

const mountRepository = async (files: { path: string; file: File }[]): Promise<string[]> => {
  const startedAt = performance.now();
  notify(`mounting ${files.length} files…`);
  const warnings: string[] = [];

  const gitFiles: { path: string; file: File }[] = [];
  const worktreeBlobs: { name: string; data: File }[] = [];
  for (const entry of files) {
    if (isGitPath(entry.path)) {
      gitFiles.push(entry);
    } else {
      worktreeBlobs.push({ name: entry.path, data: entry.file });
    }
  }
  if (gitFiles.length === 0) {
    throw new Error(
      'No .git directory found in the picked folder — pick the repository root (the folder that directly contains .git).',
    );
  }
  dropPreviousRepository();

  // Read in parallel batches; the serial await-per-file loop dominated mount
  // time for repos with many loose objects. A file that fails to read mid-
  // mount (moved on disk, permission edge) is skipped with a warning — the
  // rest of the repository still works, which beats failing the whole open.
  const mirrorTarget = (path: string): string | null => {
    if (path === '.git') {
      return GIT_FILE_ROOT;
    }
    const pathUnderGit = path.slice('.git/'.length);
    return isMirroredGitPath(pathUnderGit) ? `${GIT_DIR_ROOT}/${pathUnderGit}` : null;
  };
  const READ_BATCH_SIZE = 16;
  let gitFileCount = 0;
  let skippedFileCount = 0;
  let mirroredBytes = 0;
  for (let offset = 0; offset < gitFiles.length; offset += READ_BATCH_SIZE) {
    const batch = gitFiles
      .slice(offset, offset + READ_BATCH_SIZE)
      .map(({ path, file }) => ({ target: mirrorTarget(path), path, file }))
      .filter(
        (entry): entry is { target: string; path: string; file: File } => entry.target !== null,
      );
    const read = await Promise.all(
      batch.map(async ({ target, path, file }) => {
        try {
          return {
            target,
            bytes: new Uint8Array(await file.arrayBuffer()),
          };
        } catch (error) {
          warnings.push(`Could not read ${path}: ${formatError(error)}`);
          return null;
        }
      }),
    );
    for (const entry of read) {
      if (!entry) {
        continue;
      }
      const parent = entry.target.slice(0, entry.target.lastIndexOf('/'));
      if (parent) {
        FS.mkdirTree(parent);
      }
      FS.writeFile(entry.target, entry.bytes);
      gitFileCount += 1;
      mirroredBytes += entry.bytes.byteLength;
    }
  }
  skippedFileCount = gitFiles.length - gitFileCount - warnings.length;
  if (warnings.length > 0) {
    notifyError(`${warnings.length} .git file(s) could not be read and were skipped`);
  }

  // The gitdir lives outside the worktree mount, so point the copied config
  // back at it; without core.worktree libgit2 would treat /gitdir's parent
  // as the work tree. filemode stays off because WORKERFS presents every
  // file as mode 0100777, and symlinks stay off because WORKERFS cannot
  // represent them at all — the same declarations git makes on FAT32. The
  // tree must exist before the write: when `.git` is a file nothing under
  // /gitdir was mirrored, and the write would die with ENOENT.
  FS.mkdirTree(GIT_DIR_ROOT);
  const configPath = `${GIT_DIR_ROOT}/config`;
  const existingConfig = FS.analyzePath(configPath).exists
    ? FS.readFile(configPath, { encoding: 'utf8' })
    : '';
  FS.writeFile(
    configPath,
    `${existingConfig}\n[core]\n\tworktree = ${WORKTREE_ROOT}\n\tfilemode = false\n\tsymlinks = false\n`,
  );

  FS.mkdir(WORKTREE_ROOT);
  FS.mount(lg.WORKERFS, { blobs: worktreeBlobs }, WORKTREE_ROOT);

  // WORKERFS is read-only, so every lg2 call gets --index-file pointed at
  // MEMFS. Seed it from the repo's real index so status/diff reflect the
  // picked state; drop the seed when the repo has no index yet.
  if (FS.analyzePath(`${GIT_DIR_ROOT}/index`).exists) {
    FS.writeFile(INDEX_FILE, FS.readFile(`${GIT_DIR_ROOT}/index`));
  } else {
    try {
      FS.unlink(INDEX_FILE);
    } catch {
      // Nothing to drop.
    }
  }

  FS.chdir(WORKTREE_ROOT);
  notify(
    `mounted ${worktreeBlobs.length} worktree files + .git ${gitFileCount} files (${formatBytes(mirroredBytes)}, ${skippedFileCount} irrelevant skipped) in ${Math.round(performance.now() - startedAt)}ms`,
  );
  return warnings;
};

// callWithOutput throws `<exitCode>: <stderr>` on failure; recover both parts.
const runGit = (args: string[]): GitRunResult => {
  const startedAt = performance.now();
  stalePaths.clear();
  const reportStalePaths = (): string[] => {
    if (stalePaths.size > 0) {
      notifyError(
        `${stalePaths.size} worktree file(s) changed on disk since they were read (e.g. "${[...stalePaths][0]}")`,
      );
    }
    return [...stalePaths];
  };
  try {
    const stdout = lg.callWithOutput([
      '--index-file',
      INDEX_FILE,
      '--git-dir',
      GIT_DIR_ROOT,
      ...args,
    ]);
    return { stdout, stderr: '', exitCode: 0, stalePaths: reportStalePaths() };
  } catch (error) {
    const message = formatError(error);
    const exitCodeMatch = message.match(/^(-?\d+):/);
    notifyError(
      `git ${args.join(' ')} failed (${Math.round(performance.now() - startedAt)}ms): ${message.slice(0, 200)}`,
    );
    return {
      stdout: '',
      stderr: message.replace(/^(-?\d+):\s?/, ''),
      exitCode: exitCodeMatch?.[1] ? Number(exitCodeMatch[1]) : 1,
      stalePaths: reportStalePaths(),
    };
  }
};

const readRepositoryFile = (path: string): ArrayBuffer | null => {
  const cleanPath = path.replace(/^\/+/, '');
  const full =
    cleanPath === '.git'
      ? GIT_FILE_ROOT
      : isGitPath(cleanPath)
        ? `${GIT_DIR_ROOT}/${cleanPath.slice('.git/'.length)}`
        : `${WORKTREE_ROOT}/${cleanPath}`;
  const entry = FS.analyzePath(full);
  if (!entry.exists || entry.object?.isFolder) {
    return null;
  }
  const data = FS.readFile(full);
  return data.slice().buffer;
};

const respond = (response: GitWorkerResponse): void => {
  workerScope.postMessage(response);
};

const processRequest = async (request: GitWorkerRequest): Promise<void> => {
  try {
    if (request.type === 'mount') {
      const warnings = await mountRepository(request.files);
      respond({ id: request.id, ok: true, payload: { kind: 'mount', warnings } });
    } else if (request.type === 'run') {
      respond({ id: request.id, ok: true, payload: { kind: 'run', run: runGit(request.args) } });
    } else {
      const bytes = readRepositoryFile(request.path);
      const response: GitWorkerResponse = {
        id: request.id,
        ok: true,
        payload: { kind: 'file', bytes },
      };
      // Transfer the buffer so a large blob never clones.
      if (bytes) {
        workerScope.postMessage(response, [bytes]);
      } else {
        respond(response);
      }
    }
  } catch (error) {
    notifyError(`request failed: ${formatError(error)}`);
    respond({
      id: request.id,
      ok: false,
      error: formatError(error),
    });
  }
};

handleRequest = (request: GitWorkerRequest): void => {
  void processRequest(request);
};
for (const request of earlyRequests.splice(0)) {
  handleRequest(request);
}
