// In-browser smoke test for the standalone git engine. Run: bun run build &&
// bun run fixture:engine && bun run serve, then open
// http://localhost:4173/engine-check.html. Regenerate the fixture after every
// build — the build wipes dist/pwa.
import { GitEngine } from './gitEngine/gitEngine';
import { createWorkerGitClient } from './gitEngine/gitWorkerClient';
import type { WalkedFile } from './gitEngine/walkDirectory';
import { registerServiceWorker } from './registerServiceWorker';

interface FixtureExpectations {
  pairBase: string;
  pairTarget: string;
  pairChangedFiles: number;
  renameBase: string;
  renameTarget: string;
  renamedFrom: string;
  renamedTo: string;
  whitespaceBase: string;
  whitespaceTarget: string;
  whitespaceFile: string;
  revCount: number;
  headHash: string;
  branch: string;
  originDefaultBranch: string;
  originMainHash: string;
  workingChangedFiles: number;
  stagedChangedFiles: number;
  workingModifiedPath: string;
  workingMarker: string;
  packageJsonLineCount: number;
  committedHead: string;
}

interface FixtureManifest {
  repoName: string;
  files: string[];
  /** `.git` paths of the post-commit snapshot, served under `committed/`. */
  committedFiles: string[];
  expected: FixtureExpectations;
}

interface CheckResult {
  name: string;
  isPass: boolean;
  durationMs: number;
  detail: string;
}

interface EngineCheckReport {
  isDone: boolean;
  failedCount: number;
  total: number;
}

declare global {
  interface Window {
    __ENGINE_CHECK__?: EngineCheckReport;
  }
}

const FETCH_BATCH_SIZE = 16;
// More git commands than the wasm stack survived before callMain's leak was
// balanced (it died around the 115th), so the check fails on a regression
// instead of only on a repository the engine cannot read.
const LONG_SESSION_COMMANDS = 400;
const REQUEST_TIMEOUT_MS = 60_000;

const appElement = document.createElement('main');
appElement.style.fontFamily = 'ui-monospace, monospace';
appElement.style.fontSize = '13px';
appElement.style.padding = '16px';
appElement.style.maxWidth = '900px';
document.body.appendChild(appElement);

const renderLine = (text: string): HTMLElement => {
  const line = document.createElement('div');
  line.textContent = text;
  appElement.appendChild(line);
  return line;
};

const logElement = document.createElement('pre');
logElement.style.fontFamily = 'ui-monospace, monospace';
logElement.style.fontSize = '11px';
logElement.style.whiteSpace = 'pre-wrap';
logElement.style.maxHeight = '260px';
logElement.style.overflow = 'auto';
logElement.style.margin = '8px 0 16px';
document.body.appendChild(logElement);

const renderLogLine = (line: string): void => {
  const row = document.createElement('div');
  row.textContent = line;
  logElement.appendChild(row);
  while (logElement.childElementCount > 400) {
    logElement.firstElementChild?.remove();
  }
  logElement.scrollTop = logElement.scrollHeight;
};

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

// IAB exposes no console to automation; its RUM monitoring floods console.warn, so those lines stay console-only.
const isInjectedTelemetryLine = (line: string): boolean => /RUM|ArmsEventBridge/.test(line);

const patchConsole = (method: 'log' | 'warn' | 'error'): void => {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args);
    const line = `[page ${method}] ${args.map(formatValue).join(' ')}`;
    if (isInjectedTelemetryLine(line)) {
      return;
    }
    renderLogLine(line);
  };
};
patchConsole('log');
patchConsole('warn');
patchConsole('error');

// Heartbeat so the server-side log shows when the page stops being alive.
const runStartedAt = performance.now();
setInterval(() => {
  console.log(`heartbeat ${Math.round((performance.now() - runStartedAt) / 1000)}s`);
}, 5000);

const log = (text: string): void => {
  console.log(`[engine-check] ${text}`);
};

const renderCheck = (result: CheckResult): void => {
  const line = renderLine(
    `${result.isPass ? 'PASS' : 'FAIL'}  ${result.name} (${result.durationMs}ms)`,
  );
  line.style.color = result.isPass ? '#1a7f37' : '#cf222e';
  if (!result.isPass && result.detail) {
    const detail = renderLine(`      ${result.detail}`);
    detail.style.color = '#cf222e';
    detail.style.whiteSpace = 'pre-wrap';
  }
};

const runCheck = async (name: string, assertion: () => Promise<void>): Promise<boolean> => {
  const startedAt = performance.now();
  try {
    await assertion();
    renderCheck({
      name,
      isPass: true,
      durationMs: Math.round(performance.now() - startedAt),
      detail: '',
    });
    log(`${name}: pass`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    renderCheck({
      name,
      isPass: false,
      durationMs: Math.round(performance.now() - startedAt),
      detail,
    });
    log(`${name}: FAIL — ${detail}`);
    return false;
  }
};

const expect = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const encodeFixturePath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');

const fetchFixtureFiles = async (paths: string[], prefix = ''): Promise<WalkedFile[]> => {
  const files: WalkedFile[] = [];
  for (let offset = 0; offset < paths.length; offset += FETCH_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + FETCH_BATCH_SIZE);
    const entries = await Promise.all(
      batch.map(async (path) => {
        const response = await fetch(`./fixture/${prefix}${encodeFixturePath(path)}`);
        expect(
          response.ok,
          `fixture fetch failed for "${path}" (HTTP ${response.status}) — is DIFFOPS_FIXTURE_DIR set on the preview server?`,
        );
        const bytes = await response.arrayBuffer();
        return { path, file: new File([bytes], path.split('/').pop() ?? path) };
      }),
    );
    files.push(...entries);
    if (files.length % 160 === 0) {
      log(`fetched ${files.length}/${paths.length} fixture files…`);
    }
  }
  return files;
};

void (async () => {
  const banner = renderLine('diffops engine check — loading fixture…');
  banner.style.fontWeight = 'bold';

  // Registers the shell's service worker so this page behaves like the app.
  await registerServiceWorker();

  try {
    const manifestResponse = await fetch('./fixture/manifest.json');
    expect(
      manifestResponse.ok,
      `manifest fetch failed (HTTP ${manifestResponse.status}) — start the preview server with DIFFOPS_FIXTURE_DIR pointing at the generated fixture`,
    );
    const manifest = (await manifestResponse.json()) as FixtureManifest;
    log(
      `manifest loaded: ${manifest.files.length} files, ${manifest.expected.revCount} commits expected`,
    );

    const files = await fetchFixtureFiles(manifest.files);
    log(`fetched ${files.length} fixture files`);

    const client = createWorkerGitClient({
      timeoutMs: REQUEST_TIMEOUT_MS,
      onLog: renderLogLine,
    });
    const engine = new GitEngine(client);
    const { expected } = manifest;
    const results: boolean[] = [];

    results.push(
      await runCheck('engine.open mounts and verifies the repository', async () => {
        const info = await engine.open(files, manifest.repoName);
        expect(
          info.repositoryId.startsWith('repo-'),
          `unexpected repository id: ${info.repositoryId}`,
        );
      }),
    );

    results.push(
      await runCheck('packed history is fully reachable (rev-list)', async () => {
        const result = await client.run(['rev-list', 'HEAD']);
        expect(result.exitCode === 0, `rev-list HEAD exited ${result.exitCode}: ${result.stderr}`);
        const count = result.stdout.split('\n').filter(Boolean).length;
        expect(
          count === expected.revCount,
          `rev-list found ${count} commits, expected ${expected.revCount}`,
        );
      }),
    );

    results.push(
      await runCheck('packed refs resolve: symbolic origin/HEAD and branches', async () => {
        const refResult = await client.run(['for-each-ref']);
        expect(
          refResult.exitCode === 0,
          `for-each-ref exited ${refResult.exitCode}: ${refResult.stderr}`,
        );
        expect(
          refResult.stdout.includes('refs/remotes/origin/main'),
          `origin/main missing from for-each-ref output:\n${refResult.stdout}`,
        );
        const revResult = await client.run(['rev-parse', 'origin/main']);
        expect(
          revResult.exitCode === 0 && revResult.stdout.trim() === expected.originMainHash,
          `rev-parse origin/main exited ${revResult.exitCode} with "${revResult.stdout.trim()}", expected ${expected.originMainHash}`,
        );
      }),
    );

    results.push(
      await runCheck('revisions(): commits, branches, origin default', async () => {
        const revisions = await engine.revisions();
        expect(revisions.commits.length > 0, 'no commits returned');
        expect(
          revisions.commits[0]?.hash === expected.headHash,
          `HEAD commit is ${revisions.commits[0]?.hash}, expected ${expected.headHash}`,
        );
        const current = revisions.branches.find((branch) => branch.current);
        expect(
          current?.name === expected.branch,
          `current branch is "${current?.name}", expected "${expected.branch}"`,
        );
        expect(
          revisions.originDefaultBranch === expected.originDefaultBranch,
          `origin default is "${revisions.originDefaultBranch}", expected "${expected.originDefaultBranch}"`,
        );
      }),
    );

    results.push(
      await runCheck('working-changes diff (HEAD vs ".")', async () => {
        const diff = await engine.diff(undefined, true);
        expect(
          diff.files.length === expected.workingChangedFiles,
          `working diff has ${diff.files.length} files, expected ${expected.workingChangedFiles}`,
        );
        expect(
          diff.commit.includes('Working Directory'),
          `unexpected commit label: ${diff.commit}`,
        );
      }),
    );

    results.push(
      await runCheck('staged diff', async () => {
        const diff = await engine.diff({ target: 'staged' }, true);
        expect(
          diff.files.length === expected.stagedChangedFiles,
          `staged diff has ${diff.files.length} files, expected ${expected.stagedChangedFiles}`,
        );
      }),
    );

    results.push(
      await runCheck('commit-to-commit diff over packed objects', async () => {
        const diff = await engine.diff(
          { base: expected.pairBase, target: expected.pairTarget },
          true,
        );
        expect(
          diff.files.length === expected.pairChangedFiles,
          `pair diff has ${diff.files.length} files, expected ${expected.pairChangedFiles}`,
        );
        expect(
          diff.baseCommitish === expected.pairBase.slice(0, 7),
          `resolved base is ${diff.baseCommitish}`,
        );
      }),
    );

    results.push(
      await runCheck('rename detection (-M50)', async () => {
        const diff = await engine.diff(
          { base: expected.renameBase, target: expected.renameTarget },
          true,
        );
        const renamed = diff.files.find((file) => file.status === 'renamed');
        expect(
          Boolean(renamed),
          `no renamed file in:\n${diff.files.map((file) => `${file.status} ${file.path}`).join('\n')}`,
        );
        expect(
          renamed?.path === expected.renamedTo,
          `renamed to ${renamed?.path}, expected ${expected.renamedTo}`,
        );
        expect(
          renamed?.oldPath === expected.renamedFrom,
          `renamed from ${renamed?.oldPath}, expected ${expected.renamedFrom}`,
        );
      }),
    );

    results.push(
      await runCheck('ignoreWhitespace hides whitespace-only changes', async () => {
        const selection = { base: expected.whitespaceBase, target: expected.whitespaceTarget };
        const withWhitespace = await engine.diff(selection, false);
        const withoutWhitespace = await engine.diff(selection, true);
        expect(
          withWhitespace.files.some((file) => file.path === expected.whitespaceFile),
          'whitespace change not detected without -w',
        );
        expect(
          !withoutWhitespace.files.some((file) => file.path === expected.whitespaceFile),
          'whitespace-only change still reported with -w',
        );
      }),
    );

    results.push(
      await runCheck('blob: text from HEAD', async () => {
        const blob = await engine.blob('package.json', 'HEAD');
        expect(blob.kind === 'text', `expected text blob, got ${blob.kind}`);
        expect(
          blob.kind === 'text' && blob.text.includes('"name"'),
          'package.json blob lacks the name field',
        );
        const lineCount = await engine.lineCount('package.json', 'HEAD');
        expect(
          lineCount === expected.packageJsonLineCount,
          `package.json has ${lineCount} lines, expected ${expected.packageJsonLineCount}`,
        );
      }),
    );

    results.push(
      await runCheck('blob: working-tree file serves edited bytes', async () => {
        const blob = await engine.blob(expected.workingModifiedPath, 'working');
        expect(blob.kind === 'bytes', `expected bytes blob, got ${blob.kind}`);
        const text = blob.kind === 'bytes' ? new TextDecoder().decode(blob.bytes) : '';
        expect(
          text.includes(expected.workingMarker),
          'working blob does not contain the unstaged marker edit',
        );
      }),
    );

    results.push(
      await runCheck('generated-file status flags the lockfile', async () => {
        const status = await engine.generatedStatus('package-lock.json', 'HEAD');
        expect(
          status.isGenerated,
          `package-lock.json not flagged as generated: ${JSON.stringify(status)}`,
        );
      }),
    );

    results.push(
      await runCheck('refresh re-mounts and keeps serving the repository', async () => {
        await engine.refresh(files);
        const revisions = await engine.revisions();
        expect(
          revisions.commits[0]?.hash === expected.headHash,
          `HEAD after refresh is ${revisions.commits[0]?.hash}, expected ${expected.headHash}`,
        );
        // Explicit base/target avoids the sticky selection left by the earlier whitespace check.
        const diff = await engine.diff({ base: 'HEAD', target: '.' }, true);
        expect(
          diff.files.length === expected.workingChangedFiles,
          `working diff after refresh has ${diff.files.length} files, expected ${expected.workingChangedFiles}`,
        );
      }),
    );

    results.push(
      await runCheck('refresh onto a commit made outside the app', async () => {
        // Everything the fixture left uncommitted is committed in the served
        // `committed/` snapshot, so the refreshed mount pairs the same working
        // tree with a `.git` whose objects, branch ref and index the engine
        // has never seen — what the reader hits after committing in a terminal.
        const committedGitFiles = await fetchFixtureFiles(manifest.committedFiles, 'committed/');
        const worktreeFiles = files.filter(
          (entry) => entry.path !== '.git' && !entry.path.startsWith('.git/'),
        );
        await engine.refresh([...worktreeFiles, ...committedGitFiles]);
        const revisions = await engine.revisions();
        expect(
          revisions.commits[0]?.hash === expected.committedHead,
          `HEAD after the commit is ${revisions.commits[0]?.hash}, expected ${expected.committedHead}`,
        );
        const diff = await engine.diff({ base: 'HEAD', target: '.' }, true);
        expect(
          diff.files.length === 0,
          `the committed working tree still diffs against HEAD: ${diff.files.map((file) => file.path).join(', ')}`,
        );
        // The snapshot the remaining checks expect.
        await engine.refresh(files);
      }),
    );

    results.push(
      await runCheck(`the engine survives ${LONG_SESSION_COMMANDS} git commands`, async () => {
        // Every command runs lg2's main again; a session that reads blobs,
        // line counts and generated status per file reaches these numbers
        // quickly, and the engine used to die mid-command once the leaked
        // stack ran out — taking every later request with it.
        for (let index = 0; index < LONG_SESSION_COMMANDS; index += 1) {
          const result = await client.run(['rev-parse', 'HEAD']);
          expect(
            result.exitCode === 0 && result.stdout.trim() === expected.headHash,
            `command ${index + 1}/${LONG_SESSION_COMMANDS} returned "${result.stdout.trim()}" (exit ${result.exitCode}): ${result.stderr}`,
          );
        }
        // A diff exercises far more of the engine than rev-parse does, so it
        // is the honest proof the instance is still whole.
        const diff = await engine.diff({ base: 'HEAD', target: '.' }, true);
        expect(
          diff.files.length === expected.workingChangedFiles,
          `the diff after ${LONG_SESSION_COMMANDS} commands has ${diff.files.length} files, expected ${expected.workingChangedFiles}`,
        );
      }),
    );

    results.push(
      await runCheck('a file changed on disk is re-read instead of failing the diff', async () => {
        // A picked File is invalidated the moment its file changes on disk, and
        // the fixture's in-memory Files never can be; an OPFS file rewritten
        // under the mount reproduces what editing the repository under review
        // does to the reader.
        const stalePath = 'docs/note.md';
        const original = files.find((entry) => entry.path === stalePath);
        if (!original) {
          throw new Error(`the fixture has no "${stalePath}" to invalidate`);
        }
        const opfsRoot = await navigator.storage.getDirectory();
        const opfsHandle = await opfsRoot.getFileHandle('engine-check-stale', { create: true });
        const writeOnDisk = async (text: string): Promise<void> => {
          const writable = await opfsHandle.createWritable();
          await writable.write(text);
          await writable.close();
        };
        const mountWith = (file: File): WalkedFile[] =>
          files.map((entry) => (entry.path === stalePath ? { path: stalePath, file } : entry));

        await writeOnDisk(await original.file.text());
        await engine.refresh(mountWith(await opfsHandle.getFile()));
        let walkCount = 0;
        engine.setFileSupplier(async () => {
          walkCount += 1;
          return mountWith(await opfsHandle.getFile());
        });

        await writeOnDisk('rewritten after the walk\n');
        const diff = await engine.diff({ base: 'HEAD', target: '.' }, true);

        expect(walkCount === 1, `the folder was re-read ${walkCount} times, expected once`);
        expect(
          diff.files.some((file) => file.path === stalePath),
          `"${stalePath}" is missing from the re-read diff: ${diff.files.map((file) => file.path).join(', ')}`,
        );
      }),
    );

    client.dispose();

    const failedCount = results.filter((isPass) => !isPass).length;
    window.__ENGINE_CHECK__ = { isDone: true, failedCount, total: results.length };
    const summary = renderLine(
      failedCount === 0
        ? `ALL ${results.length} CHECKS PASSED`
        : `${failedCount}/${results.length} CHECKS FAILED`,
    );
    summary.style.fontWeight = 'bold';
    summary.style.color = failedCount === 0 ? '#1a7f37' : '#cf222e';
    log(`done: ${results.length - failedCount}/${results.length} passed`);
  } catch (error) {
    window.__ENGINE_CHECK__ = { isDone: true, failedCount: 1, total: 0 };
    const message = error instanceof Error ? error.message : String(error);
    renderLine(`FATAL — ${message}`).style.color = '#cf222e';
    log(`fatal: ${message}`);
  }
})();
