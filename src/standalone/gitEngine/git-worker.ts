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
import type { Lg2Module, Lg2ModuleOptions } from './vendor/lg2_workerfs.js';

// The workspace tsconfig uses the DOM lib, whose global postMessage expects a
// targetOrigin; the dedicated-worker overload takes a transfer list instead.
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<GitWorkerRequest>) => void) | null;
};

const WORKTREE_ROOT = '/repo';
const GIT_DIR_ROOT = '/gitdir';
// The emulated-FS stat data never matches the real index, so diffs must fall
// back to content comparison. `git status` would "fix" that by refreshing the
// stat cache INTO this file, after which worktree diffs silently come back
// empty — never run status (or any index-writing command) in this engine.
const INDEX_FILE = '/gitindex';

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
// with .git size, which is dominated by objects — and those are required,
// because libgit2 mmaps packfiles and MEMFS is the only mmap-capable mount.
const MIRRORED_GIT_ROOT_FILES = new Set(['HEAD', 'config', 'index', 'packed-refs', 'shallow']);

const isMirroredGitPath = (pathUnderGit: string): boolean => {
  const topSegment = pathUnderGit.split('/')[0] ?? '';
  return (
    topSegment === 'objects' || topSegment === 'refs' || MIRRORED_GIT_ROOT_FILES.has(pathUnderGit)
  );
};

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
  const READ_BATCH_SIZE = 16;
  let gitFileCount = 0;
  let skippedFileCount = 0;
  let mirroredBytes = 0;
  for (let offset = 0; offset < gitFiles.length; offset += READ_BATCH_SIZE) {
    const batch = gitFiles
      .slice(offset, offset + READ_BATCH_SIZE)
      .filter(({ path }) => isMirroredGitPath(path.slice('.git/'.length)));
    const read = await Promise.all(
      batch.map(async ({ path, file }) => {
        try {
          return {
            target: `${GIT_DIR_ROOT}/${path.slice('.git/'.length)}`,
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
      FS.mkdirTree(entry.target.slice(0, entry.target.lastIndexOf('/')));
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
  // represent them at all — the same declarations git makes on FAT32.
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
  try {
    const stdout = lg.callWithOutput([
      '--index-file',
      INDEX_FILE,
      '--git-dir',
      GIT_DIR_ROOT,
      ...args,
    ]);
    return { stdout, stderr: '', exitCode: 0 };
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
    };
  }
};

const readRepositoryFile = (path: string): ArrayBuffer | null => {
  const cleanPath = path.replace(/^\/+/, '');
  const full = isGitPath(cleanPath)
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
