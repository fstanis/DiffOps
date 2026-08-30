import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import StandaloneApp from './StandaloneApp';
import {
  FakeGitWorkerClient,
  buildGitIndex,
  runFail,
  runOk,
} from './gitEngine/fakeGitWorkerClient';
import { GitEngine } from './gitEngine/gitEngine';
import type { AppearanceSettings } from './components/SettingsModal';
import { broadcastAppearanceSettings } from './hooks/useAppearanceSettings';
import { resetStandaloneStoreForTests } from './persistence/standaloneStore';
import { resetStandaloneSettingsForTests } from './persistence/settingsStore';

const HEAD_HASH = '5a29ad326040fd305c942e461bc78c8c642e5812';
const PARENT_HASH = '2f1d3c4b5a69788796a5b4c3d2e1f0091a2b3c4d';
const ROOT_HASH = '864681f05278d072e0eae561a35858e2045330e5';
const BLOB_HASH = '0123456789abcdef0123456789abcdef01234567';

const REPO_DIFF = [
  'diff --git a/src/repo.ts b/src/repo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/repo.ts',
  '+++ b/src/repo.ts',
  '@@ -1 +1 @@',
  '-const version = 1;',
  '+const version = 2;',
].join('\n');

type PermissionAnswers = {
  query?: PermissionState;
  request?: PermissionState;
};

type TestHandle =
  | { kind: 'file'; name: string; getFile: () => Promise<File> }
  | {
      kind: 'directory';
      name: string;
      entries: () => AsyncIterableIterator<[string, TestHandle]>;
      queryPermission?: () => Promise<PermissionState>;
      requestPermission?: () => Promise<PermissionState>;
    };

const pickerFile = (name: string, content: string | Uint8Array): TestHandle => ({
  kind: 'file',
  name,
  getFile: () => Promise.resolve(new File([content as BlobPart], name)),
});

const pickerDir = (
  name: string,
  children: TestHandle[],
  permissions: PermissionAnswers = {},
): TestHandle => ({
  kind: 'directory',
  name,
  async *entries() {
    for (const child of children) {
      yield [child.name, child];
    }
  },
  queryPermission: () => Promise.resolve(permissions.query ?? 'granted'),
  requestPermission: () => Promise.resolve(permissions.request ?? 'granted'),
});

/** A folder whose stored access still needs re-granting, as after a browser restart. */
const pendingRepoHandle = (name = 'repo'): TestHandle =>
  makeRepoHandle(name, { query: 'prompt', request: 'granted' });

const makeRepoHandle = (name = 'repo', permissions: PermissionAnswers = {}): TestHandle =>
  pickerDir(
    name,
    [
      pickerFile('README.md', 'readme\n'),
      pickerDir('.git', [
        pickerFile('HEAD', 'ref: refs/heads/main\n'),
        pickerFile('index', buildGitIndex([{ path: 'README.md', sha: BLOB_HASH }])),
        pickerDir('refs', [pickerDir('heads', [pickerFile('main', `${HEAD_HASH}\n`)])]),
      ]),
    ],
    permissions,
  );

const makeFakeClient = () =>
  new FakeGitWorkerClient({
    files: {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': `${HEAD_HASH}\n`,
      '.git/index': buildGitIndex([{ path: 'README.md', sha: BLOB_HASH }]),
    },
    run: (args) => {
      const [command, ...rest] = args;
      if (command === 'diff') {
        return runOk(REPO_DIFF);
      }
      if (command === 'rev-list') {
        return runOk(`${HEAD_HASH}\n${ROOT_HASH}\n`);
      }
      if (command === 'rev-parse') {
        return runOk(rest[0] === 'HEAD^' ? PARENT_HASH : HEAD_HASH);
      }
      if (command === 'for-each-ref') {
        return runOk(`${HEAD_HASH} commit\trefs/heads/main`);
      }
      if (command === 'log') {
        return runOk(`commit ${HEAD_HASH}\n\n    bump the version\n`);
      }
      return runFail(`unexpected git command: ${args.join(' ')}`);
    },
  });

interface FakeWindow {
  location: { href: string };
  focus: () => void;
  focusCount: number;
  closed: boolean;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;
};

const openedWindows = new Map<string, FakeWindow>();
const windowOpenCalls: string[] = [];
let permissionRequests: string[] = [];
let isPopupBlocked = false;

const originalWindowOpen = window.open;
const originalWindowClose = window.close;
const originalConfirm = window.confirm;
let confirmAnswer = true;
let closeCount = 0;

const installPicker = (handle: TestHandle) => {
  (window as PickerWindow).showDirectoryPicker = vi.fn(() => Promise.resolve(handle));
};

/** Tags the handle so which stored registration was used is observable. */
const trackPermissions = (handle: TestHandle, tag: string): TestHandle => {
  if (handle.kind !== 'directory') {
    return handle;
  }
  const requestPermission = handle.requestPermission;
  return {
    ...handle,
    requestPermission: async () => {
      permissionRequests.push(tag);
      return (await requestPermission?.()) ?? 'granted';
    },
  };
};

const renderApp = (createEngine?: () => GitEngine) =>
  render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <StandaloneApp createEngine={createEngine} />
    </HotkeysProvider>,
  );

const renderRepoApp = (client = makeFakeClient()) => ({
  client,
  ...renderApp(() => new GitEngine(client)),
});

/** Registers a folder through the launcher, then leaves the launcher mounted. */
const registerViaLauncher = async (handle: TestHandle, tag = handle.name) => {
  installPicker(trackPermissions(handle, tag));
  fireEvent.click(await screen.findByTestId('register-repo-button'));
  await screen.findByRole('button', { name: handle.name });
};

describe('StandaloneApp launcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    openedWindows.clear();
    windowOpenCalls.length = 0;
    permissionRequests = [];
    isPopupBlocked = false;
    confirmAnswer = true;
    closeCount = 0;
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
    delete (window as PickerWindow).showDirectoryPicker;

    window.open = ((_url: string, name: string) => {
      windowOpenCalls.push(name);
      if (isPopupBlocked) {
        return null;
      }
      let target = openedWindows.get(name);
      if (!target) {
        target = {
          location: { href: 'about:blank' },
          focusCount: 0,
          focus() {
            this.focusCount += 1;
          },
          closed: false,
        };
        openedWindows.set(name, target);
      }
      return target as unknown as Window;
    }) as typeof window.open;
    window.close = () => {
      closeCount += 1;
    };
    window.confirm = () => confirmAnswer;
  });

  afterEach(() => {
    delete (window as PickerWindow).showDirectoryPicker;
    window.open = originalWindowOpen;
    window.close = originalWindowClose;
    window.confirm = originalConfirm;
  });

  it('explains what to do before anything is registered', async () => {
    installPicker(makeRepoHandle());
    renderApp();

    expect(await screen.findByTestId('register-repo-button')).toBeInTheDocument();
    expect(screen.getByText(/No repositories yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('registered-repos')).not.toBeInTheDocument();
  });

  it('states the desktop-Chromium requirement when the directory picker is absent', async () => {
    renderApp();

    expect(await screen.findByText(/desktop Chromium browser/i)).toBeInTheDocument();
    expect(screen.queryByTestId('register-repo-button')).not.toBeInTheDocument();
  });

  it('registers a picked folder and stays on the launcher', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle());

    expect(screen.getByRole('button', { name: 'repo' })).toBeInTheDocument();
    // Registering does not open anything.
    expect(windowOpenCalls).toEqual([]);
    expect(screen.getByTestId('register-repo-button')).toBeInTheDocument();
  });

  it('lists the registered repositories by name across a remount', async () => {
    const first = renderApp();
    await registerViaLauncher(makeRepoHandle('alpha'));
    await registerViaLauncher(makeRepoHandle('beta'));
    first.unmount();

    renderApp();
    const rows = await screen.findByRole('list', { name: 'Registered repositories' });
    expect(Array.from(rows.querySelectorAll('li')).map((row) => row.textContent?.trim())).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('forgets a repository', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle());

    fireEvent.click(screen.getByRole('button', { name: 'Forget repo' }));

    await waitFor(() => {
      expect(screen.queryByTestId('registered-repos')).not.toBeInTheDocument();
    });
  });

  it('replaces a same-named registration once confirmed', async () => {
    renderApp();
    await registerViaLauncher(pendingRepoHandle(), 'first');

    confirmAnswer = true;
    await registerViaLauncher(pendingRepoHandle(), 'second');

    expect(screen.getAllByRole('button', { name: 'repo' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'repo' }));
    await waitFor(() => {
      expect(permissionRequests).toEqual(['second']);
    });
  });

  it('keeps the existing registration when the replacement is cancelled', async () => {
    renderApp();
    await registerViaLauncher(pendingRepoHandle(), 'first');

    confirmAnswer = false;
    installPicker(trackPermissions(pendingRepoHandle(), 'second'));
    fireEvent.click(screen.getByTestId('register-repo-button'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'repo' })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'repo' }));
    await waitFor(() => {
      expect(permissionRequests).toEqual(['first']);
    });
  });

  it('opens the window on a single press once the folder is already granted', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle());

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    await waitFor(() => {
      expect(windowOpenCalls).toEqual(['diffops-repo']);
    });
    // Nothing is awaited on this path, so the press's activation still covers the pop-up.
    expect(permissionRequests).toEqual([]);
    expect(openedWindows.get('diffops-repo')?.location.href).toContain('#/r/repo');
    expect(openedWindows.get('diffops-repo')?.focusCount).toBe(1);
  });

  it('grants on the first press and opens on the second when access is pending', async () => {
    renderApp();
    await registerViaLauncher(pendingRepoHandle());

    expect(await screen.findByText('needs access')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    // The folder-access dialog outlives the press, so the first one only grants.
    expect(await screen.findByText('press again to open')).toBeInTheDocument();
    expect(permissionRequests).toEqual(['repo']);
    expect(windowOpenCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    await waitFor(() => {
      expect(windowOpenCalls).toEqual(['diffops-repo']);
    });
    expect(permissionRequests).toEqual(['repo']);
    expect(openedWindows.get('diffops-repo')?.location.href).toContain('#/r/repo');
  });

  it('opens no window when permission is refused', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle('repo', { query: 'prompt', request: 'denied' }));

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/was not granted/i);
    expect(windowOpenCalls).toEqual([]);
    expect(screen.getByText('needs access')).toBeInTheDocument();
  });

  it('focuses an already-open window instead of navigating it again', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle());

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));
    await waitFor(() => {
      expect(openedWindows.get('diffops-repo')?.location.href).toContain('#/r/repo');
    });
    const openedHref = openedWindows.get('diffops-repo')?.location.href;

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    await waitFor(() => {
      expect(openedWindows.get('diffops-repo')?.focusCount).toBe(2);
    });
    expect(windowOpenCalls).toEqual(['diffops-repo', 'diffops-repo']);
    expect(openedWindows.get('diffops-repo')?.location.href).toBe(openedHref as string);
  });

  it('reports a blocked pop-up instead of failing silently', async () => {
    renderApp();
    await registerViaLauncher(makeRepoHandle());

    isPopupBlocked = true;
    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Allow pop-ups/i);
  });
});

describe('StandaloneApp repository window', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    openedWindows.clear();
    windowOpenCalls.length = 0;
    permissionRequests = [];
    confirmAnswer = true;
    closeCount = 0;
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
    delete (window as PickerWindow).showDirectoryPicker;
    window.close = () => {
      closeCount += 1;
    };
    window.confirm = () => confirmAnswer;
  });

  afterEach(() => {
    delete (window as PickerWindow).showDirectoryPicker;
    window.close = originalWindowClose;
    window.confirm = originalConfirm;
    Object.defineProperty(window, 'opener', { configurable: true, writable: true, value: null });
  });

  /** Registers the folder through the launcher, then routes to its repository window. */
  const openRepositoryWindow = async (handle: TestHandle = makeRepoHandle()) => {
    const launcher = renderApp();
    await registerViaLauncher(handle);
    launcher.unmount();

    window.history.pushState({}, '', `/#/r/${encodeURIComponent(handle.name)}`);
    return renderRepoApp();
  };

  it('mounts the repository named in the hash and renders its diff', async () => {
    const { client } = await openRepositoryWindow();

    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    expect(client.mountedRepoNames).toEqual(['repo']);
    expect(document.title).toBe('repo');
  });

  it('offers no way to change the folder from inside the window', async () => {
    await openRepositoryWindow();
    await screen.findByText('src/repo.ts');

    expect(screen.queryByTestId('register-repo-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /repository…/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('refresh-repo-button')).toBeInTheDocument();
    expect(screen.getByTestId('close-repo-button')).toBeInTheDocument();
  });

  it('writes the resolved selection into the hash and pushes later changes', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await openRepositoryWindow();
    await screen.findByText('src/repo.ts');

    await waitFor(() => {
      expect(window.location.hash).toBe('#/r/repo?base=HEAD&target=.');
    });
    expect(replaceState).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: /^Revision menu:/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'HEAD' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/r/repo?base=HEAD%5E&target=HEAD');
    });
    // The bootstrap write replaced; the reviewer's change pushed, so Back reaches the previous diff.
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('restores the diff named by a bookmarked hash', async () => {
    const launcher = renderApp();
    await registerViaLauncher(makeRepoHandle());
    launcher.unmount();

    window.history.pushState({}, '', '/#/r/repo?base=HEAD%5E&target=HEAD');
    const { client } = renderRepoApp();

    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    const diffCall = client.runCalls.find((args) => args[0] === 'diff');
    expect(diffCall).toEqual(['diff', PARENT_HASH, HEAD_HASH, '-M50', '-w']);
  });

  it('routes home from a hash naming an unregistered folder', async () => {
    window.history.pushState({}, '', '/#/r/missing');
    installPicker(makeRepoHandle());
    renderRepoApp();

    expect(await screen.findByText(/not a registered repository/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the launcher' }));

    expect(await screen.findByTestId('register-repo-button')).toBeInTheDocument();
  });

  it('gates on permission for a stored handle that needs re-granting', async () => {
    const { client } = await openRepositoryWindow(
      makeRepoHandle('repo', { query: 'prompt', request: 'granted' }),
    );

    const gate = await screen.findByTestId('grant-permission-button');
    expect(client.mountedRepoNames).toEqual([]);

    fireEvent.click(gate);

    await waitFor(() => {
      expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
    });
    expect(client.mountedRepoNames).toEqual(['repo']);
  });

  it('refreshes by re-walking and re-mounting the folder', async () => {
    const { client } = await openRepositoryWindow();
    await screen.findByText('src/repo.ts');

    fireEvent.click(screen.getByTestId('refresh-repo-button'));

    await waitFor(() => {
      expect(client.mountedRepoNames).toEqual(['repo', 'repo']);
    });
    expect(screen.getByText('src/repo.ts')).toBeInTheDocument();
  });

  it('closes by focusing the opener that launched the window', async () => {
    let openerFocusCount = 0;
    Object.defineProperty(window, 'opener', {
      configurable: true,
      writable: true,
      value: {
        closed: false,
        focus: () => {
          openerFocusCount += 1;
        },
      },
    });
    await openRepositoryWindow();
    await screen.findByText('src/repo.ts');

    fireEvent.click(screen.getByTestId('close-repo-button'));

    expect(openerFocusCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it('routes to the launcher when no opener is left to focus', async () => {
    Object.defineProperty(window, 'opener', { configurable: true, writable: true, value: null });
    await openRepositoryWindow();
    await screen.findByText('src/repo.ts');

    fireEvent.click(screen.getByTestId('close-repo-button'));

    expect(closeCount).toBe(0);
    expect(await screen.findByTestId('register-repo-button')).toBeInTheDocument();
  });
});

interface ObserverStub {
  created: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  emit: (records: { type: string; relativePathComponents?: string[] }[]) => void;
  uninstall: () => void;
}

const installObserverStub = (): ObserverStub => {
  let recordCallback: ((records: unknown[], observer: unknown) => void) | null = null;
  const created: ObserverStub['created'] = [];
  class StubObserver {
    observe = vi.fn(() => Promise.resolve());
    disconnect = vi.fn();
    constructor(callback: (records: unknown[], observer: unknown) => void) {
      recordCallback = callback;
      created.push(this);
    }
  }
  const globalWithObserver = globalThis as { FileSystemObserver?: unknown };
  globalWithObserver.FileSystemObserver = StubObserver;
  return {
    created,
    emit: (records) => {
      recordCallback?.(records, null);
    },
    uninstall: () => {
      delete globalWithObserver.FileSystemObserver;
    },
  };
};

const appearanceSettingsWith = (watchRepository: boolean): AppearanceSettings => ({
  fontSize: 14,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
  theme: 'dark',
  syntaxTheme: 'vsDark',
  colorVision: 'normal',
  autoViewedPatterns: [],
  watchRepository,
});

describe('StandaloneApp repository watcher', () => {
  const installedObservers: ObserverStub[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    openedWindows.clear();
    windowOpenCalls.length = 0;
    permissionRequests = [];
    resetStandaloneStoreForTests();
    resetStandaloneSettingsForTests();
    vi.restoreAllMocks();
    delete (window as PickerWindow).showDirectoryPicker;
    window.close = () => {};
    window.confirm = () => true;
  });

  afterEach(() => {
    for (const observer of installedObservers.splice(0)) {
      observer.uninstall();
    }
    Object.defineProperty(window, 'opener', { configurable: true, writable: true, value: null });
  });

  const openWatchedRepository = async () => {
    const launcher = renderApp();
    await registerViaLauncher(makeRepoHandle());
    launcher.unmount();

    window.history.pushState({}, '', '/#/r/repo');
    return renderRepoApp();
  };

  it('lights the Refresh button when the watched folder changes and clears it on refresh', async () => {
    const observer = installObserverStub();
    installedObservers.push(observer);
    const { client } = await openWatchedRepository();

    const refreshButton = await screen.findByTestId('refresh-repo-button');
    await waitFor(() => {
      expect(observer.created).toHaveLength(1);
    });
    expect(refreshButton).toHaveAccessibleName('Refresh');

    await act(() => {
      observer.emit([{ type: 'modified', relativePathComponents: ['README.md'] }]);
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('refresh-repo-button')).toHaveAccessibleName(
        'Refresh · changes on disk',
      );
    });

    fireEvent.click(screen.getByTestId('refresh-repo-button'));

    await waitFor(() => {
      expect(client.mountedRepoNames).toEqual(['repo', 'repo']);
    });
    expect(screen.getByTestId('refresh-repo-button')).toHaveAccessibleName('Refresh');
  });

  it('constructs no observer while watching is disabled in settings', async () => {
    window.localStorage.setItem(
      'reviewit-appearance-settings',
      JSON.stringify(appearanceSettingsWith(false)),
    );
    const observer = installObserverStub();
    installedObservers.push(observer);
    await openWatchedRepository();

    await screen.findByText('src/repo.ts');

    expect(screen.getByTestId('refresh-repo-button')).toBeInTheDocument();
    expect(observer.created).toHaveLength(0);
  });

  it('starts watching without a reload once the setting is switched on', async () => {
    window.localStorage.setItem(
      'reviewit-appearance-settings',
      JSON.stringify(appearanceSettingsWith(false)),
    );
    const observer = installObserverStub();
    installedObservers.push(observer);
    await openWatchedRepository();
    await screen.findByText('src/repo.ts');
    expect(observer.created).toHaveLength(0);

    await act(() => {
      broadcastAppearanceSettings(appearanceSettingsWith(true));
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(observer.created).toHaveLength(1);
    });
    expect(observer.created[0]?.observe).toHaveBeenCalledWith(expect.anything(), {
      recursive: true,
    });
  });

  it('disconnects the watcher when the setting is switched off', async () => {
    const observer = installObserverStub();
    installedObservers.push(observer);
    await openWatchedRepository();

    await waitFor(() => {
      expect(observer.created).toHaveLength(1);
    });

    await act(() => {
      broadcastAppearanceSettings(appearanceSettingsWith(false));
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(observer.created[0]?.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
