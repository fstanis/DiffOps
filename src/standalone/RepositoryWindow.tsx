import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiffSelection } from '../types/diff';

import App from './App';
import { MessageBanner } from './components/MessageBanner';
import type { GitEngine } from './gitEngine/gitEngine';
import {
  queryReadPermission,
  requestReadPermission,
  walkDirectoryHandle,
  type PickedDirectoryHandle,
} from './gitEngine/walkDirectory';
import { installLocalApiBridge, type LocalApiBridge } from './localApiBridge';
import { getStandaloneStore } from './persistence/standaloneStore';
import { LAUNCHER_HASH } from './repositoryRoute';

interface RepositoryWindowProps {
  folderName: string;
  routeSelection: DiffSelection | null;
  onSelectionChange: (selection: DiffSelection) => void;
  /** Engine factory override for tests; defaults to the real git worker. */
  createEngine?: () => GitEngine;
}

type MountStatus =
  | { kind: 'checking' }
  | { kind: 'unregistered' }
  | { kind: 'permission-required' }
  | { kind: 'mounting' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

interface WalkProgressLabel {
  label: string;
  filesFound: number;
  bytesFound: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
};

const walkWarnings = (unreadablePaths: string[]): string[] => {
  if (unreadablePaths.length === 0) {
    return [];
  }
  const sample = unreadablePaths
    .slice(0, 3)
    .map((path) => `"${path}"`)
    .join(', ');
  const further = unreadablePaths.length > 3 ? `, +${unreadablePaths.length - 3} more` : '';
  return [
    `${unreadablePaths.length} entr${unreadablePaths.length === 1 ? 'y' : 'ies'} could not be read (${sample}${further}); the rest of the repository was opened.`,
  ];
};

const toMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const goToLauncher = (): void => {
  window.location.hash = LAUNCHER_HASH;
};

/** One window, one repository: mounts the registered folder and hosts the review. */
export function RepositoryWindow({
  folderName,
  routeSelection,
  onSelectionChange,
  createEngine,
}: RepositoryWindowProps) {
  const [status, setStatus] = useState<MountStatus>({ kind: 'checking' });
  const [errorMessage, setErrorMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<WalkProgressLabel | null>(null);
  const bridgeRef = useRef<LocalApiBridge | null>(null);
  const engineRef = useRef<GitEngine | null>(null);
  const handleRef = useRef<PickedDirectoryHandle | null>(null);

  useEffect(() => {
    document.title = folderName;
  }, [folderName]);

  const readFolder = useCallback(async (handle: PickedDirectoryHandle) => {
    setProgress({ label: `Reading "${handle.name}"…`, filesFound: 0, bytesFound: 0 });
    return walkDirectoryHandle(handle, (walkProgress) => {
      setProgress({
        label: `Reading "${handle.name}"…`,
        filesFound: walkProgress.filesFound,
        bytesFound: walkProgress.bytesFound,
      });
    });
  }, []);

  const mountRepository = useCallback(
    async (handle: PickedDirectoryHandle) => {
      setStatus({ kind: 'mounting' });
      setErrorMessage('');
      setWarnings([]);
      try {
        const { files, unreadablePaths } = await readFolder(handle);
        setProgress({
          label: 'Preparing the git engine…',
          filesFound: files.length,
          bytesFound: 0,
        });
        // The engine module (and with it the git worker client) loads only once a folder is actually mounted.
        engineRef.current ??= (
          createEngine ?? (await import('./gitEngine/gitEngine')).createGitEngine
        )();
        const engine = engineRef.current;
        const info = await engine.open(files, handle.name);
        handleRef.current = handle;
        bridgeRef.current ??= installLocalApiBridge();
        bridgeRef.current.setRepository({
          engine,
          repositoryId: info.repositoryId,
          repoName: info.repoName,
        });
        setWarnings([...walkWarnings(unreadablePaths), ...info.warnings]);
        setStatus({ kind: 'ready' });
      } catch (mountError) {
        setStatus({
          kind: 'failed',
          message: toMessage(mountError, `Failed to open "${handle.name}"`),
        });
      } finally {
        setProgress(null);
      }
    },
    [createEngine, readFolder],
  );

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      let handle: PickedDirectoryHandle | undefined;
      try {
        handle = (await getStandaloneStore().loadRegisteredRepository(folderName))?.handle;
      } catch (loadError) {
        if (!isCancelled) {
          setStatus({
            kind: 'failed',
            message: toMessage(loadError, 'Failed to read the registered repositories'),
          });
        }
        return;
      }
      if (isCancelled) {
        return;
      }
      if (!handle) {
        setStatus({ kind: 'unregistered' });
        return;
      }

      handleRef.current = handle;
      // A bookmarked link reaches a cold browser where the stored handle still needs a gesture.
      if ((await queryReadPermission(handle)) !== 'granted') {
        if (!isCancelled) {
          setStatus({ kind: 'permission-required' });
        }
        return;
      }
      if (!isCancelled) {
        await mountRepository(handle);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [folderName, mountRepository]);

  const grantPermission = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }
    setErrorMessage('');
    try {
      if ((await requestReadPermission(handle)) !== 'granted') {
        setErrorMessage(`Permission to read "${folderName}" was not granted.`);
        return;
      }
    } catch (permissionError) {
      setErrorMessage(toMessage(permissionError, `Failed to read "${folderName}"`));
      return;
    }
    await mountRepository(handle);
  }, [folderName, mountRepository]);

  const refreshRepository = useCallback(async () => {
    const handle = handleRef.current;
    const bridge = bridgeRef.current;
    if (!handle || !bridge) {
      return;
    }
    setErrorMessage('');
    try {
      const { files, unreadablePaths } = await readFolder(handle);
      const mountWarnings = await bridge.refreshRepository(files);
      setWarnings([...walkWarnings(unreadablePaths), ...mountWarnings]);
    } catch (refreshError) {
      setErrorMessage(toMessage(refreshError, 'Failed to refresh the repository'));
    } finally {
      setProgress(null);
    }
  }, [readFolder]);

  const closeWindow = useCallback(() => {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) {
      opener.focus();
      window.close();
      return;
    }
    goToLauncher();
  }, []);

  const banners = (isFloating: boolean) => (
    <>
      <MessageBanner
        tone="error"
        messages={errorMessage ? [errorMessage] : []}
        isFloating={isFloating}
        onDismiss={() => setErrorMessage('')}
      />
      <MessageBanner
        tone="warning"
        messages={warnings}
        isFloating={isFloating}
        onDismiss={() => setWarnings([])}
      />
    </>
  );

  const progressOverlay = progress && (
    <div className="fixed inset-0 z-50 bg-github-bg-primary/70 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 bg-github-bg-secondary border border-github-border rounded-lg px-8 py-6 shadow-lg">
        <RefreshCw size={20} className="text-github-accent animate-spin" />
        <div className="text-sm text-github-text-primary font-medium">{progress.label}</div>
        {progress.filesFound > 0 && (
          <div className="text-xs text-github-text-secondary">
            {progress.bytesFound > 0
              ? `${progress.filesFound.toLocaleString()} files · ${formatBytes(progress.bytesFound)} read`
              : `${progress.filesFound.toLocaleString()} files read`}
          </div>
        )}
      </div>
    </div>
  );

  if (status.kind !== 'ready') {
    return (
      <div className="h-screen bg-github-bg-primary flex items-center justify-center px-4">
        {progressOverlay}
        <div className="flex flex-col items-center gap-4 max-w-lg w-full text-center">
          <h1 className="text-xl text-github-text-primary font-semibold">{folderName}</h1>
          {status.kind === 'unregistered' && (
            <p className="text-sm text-github-text-secondary">
              &ldquo;{folderName}&rdquo; is not a registered repository in this browser. Register
              the folder on the launcher, then open it from there.
            </p>
          )}
          {status.kind === 'permission-required' && (
            <>
              <p className="text-sm text-github-text-secondary">
                DiffOps needs your permission to read &ldquo;{folderName}&rdquo; again.
              </p>
              <button
                type="button"
                onClick={() => void grantPermission()}
                className="px-4 py-2 rounded-md bg-github-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
                data-testid="grant-permission-button"
              >
                Grant folder access
              </button>
            </>
          )}
          {status.kind === 'failed' && (
            <p role="alert" className="text-sm text-github-danger">
              {status.message}
            </p>
          )}
          {banners(false)}
          {status.kind !== 'checking' && status.kind !== 'mounting' && (
            <button
              type="button"
              onClick={goToLauncher}
              className="px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-primary hover:bg-github-bg-tertiary text-sm transition-colors"
            >
              Back to the launcher
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <App routeSelection={routeSelection} onSelectionChange={onSelectionChange} />
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void refreshRepository()}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary text-xs shadow-md transition-colors"
          title="Re-read the repository folder and refetch the diff"
          data-testid="refresh-repo-button"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <button
          type="button"
          onClick={closeWindow}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary text-xs shadow-md transition-colors"
          title="Close this repository window"
          data-testid="close-repo-button"
        >
          <X size={14} />
          Close
        </button>
      </div>
      {banners(true)}
      {progressOverlay}
    </div>
  );
}
