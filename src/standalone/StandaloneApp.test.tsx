import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import type { DiffCommentThread } from '../types/diff';

import StandaloneApp from './StandaloneApp';
import {
  buildGitIndex,
  FakeGitWorkerClient,
  runFail,
  runOk,
} from './gitEngine/fakeGitWorkerClient';
import { GitEngine } from './gitEngine/gitEngine';
import { resetStandaloneStoreForTests } from './persistence/standaloneStore';
import { resetStandaloneSettingsForTests } from './persistence/settingsStore';

const DIFF_TEXT = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-const version = 1;',
  '+const version = 2;',
].join('\n');

const makeFile = (name: string, content: string) =>
  new File([content], name, { type: 'text/plain' });

const IMPORTED_THREAD: DiffCommentThread = {
  id: 'imported-thread',
  filePath: 'src/app.ts',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  position: { side: 'new', line: 1 },
  messages: [
    {
      id: 'imported-thread-message',
      body: 'imported comment',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
  ],
};

const renderApp = () =>
  render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <StandaloneApp />
    </HotkeysProvider>,
  );

const openViaInput = async (file: File) => {
  const input = await screen.findByTestId('diff-file-input');
  fireEvent.change(input, { target: { files: [file] } });
};

const openDiff = async (name = 'changes.diff') => {
  await openViaInput(makeFile(name, DIFF_TEXT));
  await waitFor(() => {
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
  });
};

describe('StandaloneApp', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
  });

  it('shows the landing screen before any file is opened', () => {
    renderApp();

    expect(screen.getByText('Open diff file…')).toBeInTheDocument();
    expect(screen.getByText(/drop a diff file anywhere in this window/i)).toBeInTheDocument();
  });

  it('renders the diff from an opened file', async () => {
    renderApp();
    await openViaInput(makeFile('changes.diff', DIFF_TEXT));

    await waitFor(() => {
      expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    });
  });

  it('shows the file name as the review label', async () => {
    renderApp();
    await openViaInput(makeFile('changes.diff', DIFF_TEXT));

    await waitFor(() => {
      expect(screen.getByText('changes.diff')).toBeInTheDocument();
    });
  });

  it('does not render the revision selector without a repository', async () => {
    renderApp();
    await openViaInput(makeFile('changes.diff', DIFF_TEXT));

    await waitFor(() => {
      expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('diff-quick-menu')).not.toBeInTheDocument();
  });

  it('surfaces a parse error for malformed input and stays usable', async () => {
    renderApp();
    await openViaInput(makeFile('not-a-diff.txt', 'this is not a diff'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No unified diff content found');

    // The same session can still open a valid file afterwards.
    await openViaInput(makeFile('good.diff', DIFF_TEXT));
    await waitFor(() => {
      expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    });
  });

  it('replaces the rendered diff when another file is opened', async () => {
    renderApp();
    await openViaInput(makeFile('first.diff', DIFF_TEXT));
    await waitFor(() => {
      expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    });

    const secondDiff = DIFF_TEXT.replaceAll('src/app.ts', 'src/other.ts');
    await openViaInput(makeFile('second.diff', secondDiff));

    await waitFor(() => {
      expect(screen.getByText('src/other.ts')).toBeInTheDocument();
    });
    expect(screen.queryByText('src/app.ts')).not.toBeInTheDocument();
  });

  it('exports the current comment session as a JSON download', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:standalone-test');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderApp();
    await openDiff('changes.diff');

    await fetch('/api/comments?base=stdin&target=stdin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [IMPORTED_THREAD] }),
    });

    fireEvent.click(screen.getByTitle('Export comments as a JSON file'));

    await waitFor(() => {
      expect(anchorClick).toHaveBeenCalledTimes(1);
    });
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const payload = JSON.parse(await blob.text()) as {
      version: number;
      threads: DiffCommentThread[];
    };
    expect(payload.threads).toHaveLength(1);
    expect(payload.threads[0]?.id).toBe('imported-thread');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:standalone-test');
  });

  it('imports comments from a picked JSON file and renders them', async () => {
    renderApp();
    await openDiff('changes.diff');

    const importFile = new File(
      [JSON.stringify({ version: 1, threads: [IMPORTED_THREAD] })],
      'comments.json',
      { type: 'application/json' },
    );
    fireEvent.change(await screen.findByTestId('comment-import-input'), {
      target: { files: [importFile] },
    });

    // The bridge broadcasts commentsChanged; the viewer refetches and the
    // header's comments affordance reflects the imported thread.
    await waitFor(() => {
      expect(screen.getByText('Copy All Prompt (1)')).toBeInTheDocument();
    });

    const stored = await fetch('/api/comments-json?base=stdin&target=stdin');
    const storedData = (await stored.json()) as { threads: DiffCommentThread[] };
    expect(storedData.threads.map((thread) => thread.id)).toEqual(['imported-thread']);
  });

  it('surfaces a parse error for invalid import files', async () => {
    renderApp();
    await openDiff('changes.diff');

    const importFile = new File(['{not json'], 'broken.json', { type: 'application/json' });
    fireEvent.change(await screen.findByTestId('comment-import-input'), {
      target: { files: [importFile] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('is not valid JSON');
  });

  it('restores comments for a reopened diff after a reload', async () => {
    const { unmount } = renderApp();
    await openDiff('changes.diff');

    await fetch('/api/comments?base=stdin&target=stdin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [IMPORTED_THREAD] }),
    });
    unmount();

    renderApp();
    await openDiff('changes.diff');

    await waitFor(() => {
      expect(screen.getByText('Copy All Prompt (1)')).toBeInTheDocument();
    });
  });

  it('lists recently opened diffs on the landing screen', async () => {
    const { unmount } = renderApp();
    await openDiff('changes.diff');
    unmount();

    renderApp();
    const recent = await screen.findByTestId('recent-diffs');
    expect(recent.textContent).toContain('changes.diff');
    expect(recent.textContent).toContain('0 comments');

    fireEvent.click(screen.getByRole('button', { name: 'Forget changes.diff' }));
    await waitFor(() => {
      expect(screen.queryByTestId('recent-diffs')).not.toBeInTheDocument();
    });
  });

  it('never creates the git engine when only diff files are opened', async () => {
    const createEngine = vi.fn();
    render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <StandaloneApp createEngine={createEngine} />
      </HotkeysProvider>,
    );
    await openDiff('changes.diff');
    await openDiff('other.diff');

    expect(createEngine).not.toHaveBeenCalled();
  });
});

describe('StandaloneApp repository mode', () => {
  const HEAD_HASH = '5a29ad326040fd305c942e461bc78c8c642e5812';
  const ROOT_HASH = '864681f05278d072e0eae561a35858e2045330e5';

  type PickerWindow = Window & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;
  };

  const repoDiff = [
    'diff --git a/src/repo.ts b/src/repo.ts',
    'index 1111111..2222222 100644',
    '--- a/src/repo.ts',
    '+++ b/src/repo.ts',
    '@@ -1 +1 @@',
    '-const version = 1;',
    '+const version = 2;',
  ].join('\n');

  type TestHandle =
    | { kind: 'file'; name: string; getFile: () => Promise<File> }
    | {
        kind: 'directory';
        name: string;
        entries: () => AsyncIterableIterator<[string, TestHandle]>;
      };

  const pickerFile = (name: string, content: string): TestHandle => ({
    kind: 'file',
    name,
    getFile: () => Promise.resolve(new File([content], name)),
  });

  const pickerDir = (name: string, children: TestHandle[]): TestHandle => ({
    kind: 'directory',
    name,
    async *entries() {
      for (const child of children) {
        yield [child.name, child];
      }
    },
  });

  const repoHandle = pickerDir('repo', [
    pickerFile('README.md', 'readme\n'),
    pickerDir('.git', [
      pickerFile('HEAD', 'ref: refs/heads/main\n'),
      pickerDir('refs', [pickerDir('heads', [pickerFile('main', `${HEAD_HASH}\n`)])]),
    ]),
  ]);

  const makeFakeClient = () =>
    new FakeGitWorkerClient({
      files: {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/refs/heads/main': `${HEAD_HASH}\n`,
      },
      run: (args) => {
        const key = args.join(' ');
        if (key === 'rev-list HEAD') {
          return runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`);
        }
        if (key === 'rev-parse HEAD') {
          return runOk(HEAD_HASH);
        }
        if (key === 'diff HEAD -M50' || key === 'diff HEAD -M50 -w') {
          return runOk(repoDiff);
        }
        return runFail(`unexpected git command: ${key}`);
      },
    });

  const renderRepoApp = (client: FakeGitWorkerClient) =>
    render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <StandaloneApp createEngine={() => new GitEngine(client)} />
      </HotkeysProvider>,
    );

  const installPicker = (handle: unknown) => {
    (window as PickerWindow).showDirectoryPicker = vi.fn(async () => handle);
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
    delete (window as PickerWindow).showDirectoryPicker;
  });

  afterEach(() => {
    delete (window as PickerWindow).showDirectoryPicker;
  });

  it('opens a picked repository and renders its working diff', async () => {
    installPicker(repoHandle);
    const client = makeFakeClient();
    renderRepoApp(client);

    fireEvent.click(await screen.findByTestId('open-repo-button'));

    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    expect(client.mountedRepoNames).toEqual(['repo']);
  });

  it('clears the preparing overlay even when persistence never settles', async () => {
    // A blocked IndexedDB upgrade (another tab holding the old database
    // version) leaves the open pending forever; recording the last repo is
    // best-effort and must not keep the app "preparing".
    const hangingRequest: {
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked: (() => void) | null;
    } = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    vi.stubGlobal('indexedDB', { open: () => hangingRequest });
    try {
      installPicker(repoHandle);
      const client = makeFakeClient();
      renderRepoApp(client);

      fireEvent.click(await screen.findByTestId('open-repo-button'));

      await waitFor(() => {
        expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.queryByText('Preparing the git engine…')).not.toBeInTheDocument();
      });
      expect(client.mountedRepoNames).toEqual(['repo']);
    } finally {
      // Settle the hung open so its timeout timer does not outlive the test.
      hangingRequest.onerror?.();
      vi.unstubAllGlobals();
    }
  });

  it('shows engine warnings as a dismissible banner without blocking the diff', async () => {
    installPicker(repoHandle);
    const client = new FakeGitWorkerClient({
      files: {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/refs/heads/main': `${HEAD_HASH}\n`,
        '.git/index': buildGitIndex([
          { path: 'src/repo.ts', sha: '0'.repeat(40) },
          { path: 'link', sha: '0'.repeat(40), mode: 0o120000 },
        ]),
      },
      run: (args) => {
        const key = args.join(' ');
        if (key === 'rev-list HEAD') {
          return runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`);
        }
        if (key === 'rev-parse HEAD') {
          return runOk(HEAD_HASH);
        }
        if (key === 'diff HEAD -M50' || key === 'diff HEAD -M50 -w') {
          return runOk(repoDiff);
        }
        return runFail(`unexpected git command: ${key}`);
      },
    });
    renderRepoApp(client);

    fireEvent.click(await screen.findByTestId('open-repo-button'));

    const banner = await screen.findByTestId('warning-banner');
    expect(banner.textContent).toContain('symlink');
    // The file surfaces in both the sidebar and the diff header; a re-render
    // right after mount can detach whichever node resolves first, so assert
    // on the match count instead of a single element.
    expect((await screen.findAllByText('src/repo.ts')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    await waitFor(() => {
      expect(screen.queryByTestId('warning-banner')).not.toBeInTheDocument();
    });
  });

  it('clears stale warnings when a diff file is opened after a repository', async () => {
    installPicker(repoHandle);
    const client = makeFakeClient();
    client.setMountWarnings(['Could not read .git/index: busy']);
    renderRepoApp(client);

    fireEvent.click(await screen.findByTestId('open-repo-button'));
    await screen.findByTestId('warning-banner');

    await openViaInput(makeFile('changes.diff', repoDiff));
    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('warning-banner')).not.toBeInTheDocument();
    });
  });

  it('surfaces a clean error for a non-git folder', async () => {
    installPicker(pickerDir('plain', [pickerFile('notes.txt', 'hello\n')]));
    // The engine sees the same folder the walk produced: no .git at all.
    renderRepoApp(new FakeGitWorkerClient({ files: {} }));

    fireEvent.click(await screen.findByTestId('open-repo-button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('is not a git repository');
  });

  it('reopens the last repository after a reload', async () => {
    installPicker(repoHandle);
    const client = makeFakeClient();
    const first = renderRepoApp(client);
    fireEvent.click(await screen.findByTestId('open-repo-button'));
    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    first.unmount();

    const second = renderRepoApp(client);
    const reopen = await screen.findByTestId('reopen-repo-button');
    expect(reopen.textContent).toContain('repo');

    fireEvent.click(reopen);
    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    second.unmount();
  });

  it('refreshes the repository by re-walking and re-mounting', async () => {
    installPicker(repoHandle);
    const client = makeFakeClient();
    renderRepoApp(client);

    fireEvent.click(await screen.findByTestId('open-repo-button'));
    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('refresh-repo-button'));

    await waitFor(() => {
      expect(client.mountedRepoNames).toEqual(['repo', 'repo']);
    });
    // The viewer keeps its instance: the diff content stays on screen.
    expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
  });

  it('switches to another repository via the change button', async () => {
    const secondRepoHandle = pickerDir('other', [
      pickerFile('README.md', 'readme\n'),
      pickerDir('.git', [
        pickerFile('HEAD', 'ref: refs/heads/main\n'),
        pickerDir('refs', [pickerDir('heads', [pickerFile('main', `${HEAD_HASH}\n`)])]),
      ]),
    ]);
    let pickCount = 0;
    (window as PickerWindow).showDirectoryPicker = vi.fn(async () => {
      pickCount += 1;
      return pickCount === 1 ? repoHandle : secondRepoHandle;
    });
    const client = makeFakeClient();
    renderRepoApp(client);

    fireEvent.click(await screen.findByTestId('open-repo-button'));
    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });

    const changeButton = screen.getByTestId('open-repo-button');
    expect(changeButton.textContent).toContain('Change repository');

    fireEvent.click(changeButton);
    await waitFor(() => {
      expect(client.mountedRepoNames).toEqual(['repo', 'other']);
    });
  });
});
