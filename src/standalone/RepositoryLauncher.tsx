import { FolderGit2, FolderPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Logo } from './components/Logo';
import { MessageBanner } from './components/MessageBanner';
import {
  queryReadPermission,
  requestReadPermission,
  type PermissionName,
  type PickedDirectoryHandle,
} from './gitEngine/walkDirectory';
import { getStandaloneStore, type RegisteredRepository } from './persistence/standaloneStore';
import { buildRepositoryHash } from './repositoryRoute';

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<PickedDirectoryHandle>;
};

const DESKTOP_CHROMIUM_MESSAGE =
  'DiffOps reads repository folders through the File System Access API, so it needs a desktop Chromium browser such as Chrome or Edge.';

// Window names outlive the launcher, so re-pressing a repository after a reload still finds its window.
const REPOSITORY_WINDOW_NAME_PREFIX = 'diffops-';
const repositoryWindowName = (folderName: string): string =>
  `${REPOSITORY_WINDOW_NAME_PREFIX}${folderName}`;

const isBlankWindow = (candidate: Window): boolean => {
  try {
    return !candidate.location.href || candidate.location.href === 'about:blank';
  } catch {
    // A window mid-navigation can refuse the read; treating it as live avoids re-walking its folder.
    return false;
  }
};

const toMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** The home screen: the registered repositories, each openable in its own window. */
export function RepositoryLauncher() {
  const [repositories, setRepositories] = useState<RegisteredRepository[]>([]);
  const [permissionByFolder, setPermissionByFolder] = useState<Record<string, PermissionName>>({});
  const [grantedFolderName, setGrantedFolderName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  // Windows opened during this launcher session, so a re-press can reuse one
  // without navigating it. Empty after a launcher reload, which just means the
  // repository is opened by URL and re-read.
  const openedWindowsRef = useRef(new Map<string, Window>());

  const isDirectoryPickerSupported =
    typeof window !== 'undefined' && Boolean((window as PickerWindow).showDirectoryPicker);

  const reloadRepositories = useCallback(async () => {
    try {
      const registered = await getStandaloneStore().listRegisteredRepositories();
      setRepositories(registered);
      // Queried up front so pressing a granted repository can open its window
      // synchronously — see pressRepository.
      const permissions = await Promise.all(
        registered.map(
          async (repository) =>
            [repository.folderName, await queryReadPermission(repository.handle)] as const,
        ),
      );
      setPermissionByFolder(Object.fromEntries(permissions));
    } catch (loadError) {
      setErrorMessage(toMessage(loadError, 'Failed to read the registered repositories'));
    }
  }, []);

  useEffect(() => {
    void reloadRepositories();
  }, [reloadRepositories]);

  // A repository window that falls back to the launcher (Home with no opener,
  // or the browser's Back) keeps the name window.open gave it, so opening that
  // same repository again would target this very window and load it inline.
  // Dropping the name makes every open a real new window again.
  useEffect(() => {
    if (window.name.startsWith(REPOSITORY_WINDOW_NAME_PREFIX)) {
      window.name = '';
    }
  }, []);

  const registerRepository = useCallback(async () => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) {
      setErrorMessage(DESKTOP_CHROMIUM_MESSAGE);
      return;
    }

    setErrorMessage('');
    let handle: PickedDirectoryHandle;
    try {
      handle = await picker({ mode: 'read' });
    } catch (pickerError) {
      if ((pickerError as { name?: string } | null)?.name === 'AbortError') {
        return;
      }
      setErrorMessage(toMessage(pickerError, 'Failed to pick a repository folder'));
      return;
    }

    try {
      const store = getStandaloneStore();
      const existing = await store.loadRegisteredRepository(handle.name);
      // Folder name is the identity, so a same-named registration replaces the old one.
      if (
        existing &&
        !window.confirm(
          `"${handle.name}" is already registered. Replace the registered folder with this one?`,
        )
      ) {
        return;
      }
      await store.registerRepository(handle.name, handle);
      await reloadRepositories();
    } catch (registerError) {
      setErrorMessage(toMessage(registerError, `Failed to register "${handle.name}"`));
    }
  }, [reloadRepositories]);

  // Nothing may be awaited before window.open: the press's transient activation
  // is what lets the pop-up through, and it does not survive a round trip.
  const openRepositoryWindow = useCallback((folderName: string) => {
    const windowName = repositoryWindowName(folderName);
    const repositoryUrl = new URL(
      buildRepositoryHash(folderName, null),
      window.location.href,
    ).toString();
    // Chrome picks app window vs. browser window from the URL handed to
    // window.open, and never revisits that choice: opening about:blank always
    // lands in the browser, so navigating it afterwards only earns the
    // "Open in DiffOps" banner. A first open therefore goes straight to the
    // in-scope URL. Windows this launcher opened itself are reused with an
    // empty URL instead, so re-pressing a repository does not re-read it.
    const known = openedWindowsRef.current.get(windowName);
    const isReusable = known !== undefined && !known.closed;
    const target = window.open(isReusable ? '' : repositoryUrl, windowName);
    if (!target) {
      setErrorMessage(`Allow pop-ups for DiffOps to open "${folderName}" in its own window.`);
      return;
    }
    openedWindowsRef.current.set(windowName, target);
    // A window named by an earlier launcher session is unknown to this one, so
    // it is opened by URL and Chrome reuses it; a genuinely blank one still
    // needs the navigation.
    if (isReusable && isBlankWindow(target)) {
      target.location.href = repositoryUrl;
    }
    target.focus();
  }, []);

  const grantAccess = useCallback(async (repository: RegisteredRepository) => {
    try {
      const permission = await requestReadPermission(repository.handle);
      setPermissionByFolder((previous) => ({
        ...previous,
        [repository.folderName]: permission,
      }));
      if (permission === 'granted') {
        setGrantedFolderName(repository.folderName);
        return;
      }
      setErrorMessage(
        `Permission to read "${repository.folderName}" was not granted. Press it again to retry.`,
      );
    } catch (permissionError) {
      setErrorMessage(toMessage(permissionError, `Failed to read "${repository.folderName}"`));
    }
  }, []);

  /**
   * Granting and opening cannot share one press: Chrome's folder-access dialog
   * outlives the click's transient activation, so a window opened after it is
   * blocked. An ungranted repository therefore takes two presses.
   */
  const pressRepository = useCallback(
    (repository: RegisteredRepository) => {
      setErrorMessage('');
      setGrantedFolderName('');
      if (permissionByFolder[repository.folderName] === 'granted') {
        openRepositoryWindow(repository.folderName);
        return;
      }
      void grantAccess(repository);
    },
    [grantAccess, openRepositoryWindow, permissionByFolder],
  );

  const forgetRepository = useCallback(
    async (folderName: string) => {
      try {
        await getStandaloneStore().forgetRegisteredRepository(folderName);
        await reloadRepositories();
      } catch (forgetError) {
        setErrorMessage(toMessage(forgetError, `Failed to forget "${folderName}"`));
      }
    },
    [reloadRepositories],
  );

  return (
    <div className="h-screen bg-github-bg-primary flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-6 max-w-lg w-full text-center">
        <Logo style={{ height: '28px', color: 'var(--color-github-text-secondary)' }} />
        <div>
          <h1 className="text-xl text-github-text-primary font-semibold">
            Review a local repository — no server needed
          </h1>
          <p className="text-sm text-github-text-secondary mt-1">
            Register a git repository folder, then open it in its own window.
          </p>
        </div>

        {isDirectoryPickerSupported ? (
          <button
            type="button"
            onClick={() => void registerRepository()}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-github-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
            data-testid="register-repo-button"
          >
            <FolderPlus size={16} />
            Add repository…
          </button>
        ) : (
          <p className="text-sm text-github-text-muted">{DESKTOP_CHROMIUM_MESSAGE}</p>
        )}

        <MessageBanner
          tone="error"
          messages={errorMessage ? [errorMessage] : []}
          isFloating={false}
          onDismiss={() => setErrorMessage('')}
        />

        {repositories.length === 0 ? (
          isDirectoryPickerSupported && (
            <p className="text-xs text-github-text-muted">
              No repositories yet. Pick a folder to register it; opening it comes after.
            </p>
          )
        ) : (
          <div className="w-full text-left" data-testid="registered-repos">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-github-text-muted mb-2">
              Repositories
            </h2>
            <ul
              className="border border-github-border rounded-md divide-y divide-github-border bg-github-bg-secondary max-h-72 overflow-y-auto"
              aria-label="Registered repositories"
            >
              {repositories.map((repository) => {
                const isGranted = permissionByFolder[repository.folderName] === 'granted';
                const hint = !isGranted
                  ? 'needs access'
                  : grantedFolderName === repository.folderName
                    ? 'press again to open'
                    : '';
                return (
                  <li
                    key={repository.folderName}
                    className="flex items-center gap-2 px-3 py-2 text-sm"
                  >
                    <button
                      type="button"
                      onClick={() => pressRepository(repository)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-github-text-primary hover:text-github-accent text-left"
                      title={
                        isGranted
                          ? `Open ${repository.folderName} in its own window`
                          : `Grant DiffOps access to ${repository.folderName}`
                      }
                    >
                      <FolderGit2 size={15} className="text-github-text-secondary shrink-0" />
                      <span className="truncate">{repository.folderName}</span>
                    </button>
                    {hint && (
                      <span className="text-xs text-github-text-muted shrink-0 whitespace-nowrap">
                        {hint}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void forgetRepository(repository.folderName)}
                      className="p-1 text-github-text-muted hover:text-github-text-primary rounded shrink-0"
                      aria-label={`Forget ${repository.folderName}`}
                    >
                      <X size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
