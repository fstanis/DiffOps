import { Home, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiffSelection } from '../types/diff';

import App from './App';
import { MessageBanner } from './components/MessageBanner';
import type { BlockingIndexExtension, FullWalkReason } from './gitEngine/walkRepository';
import type { GitEngine } from './gitEngine/gitEngine';
import {
  queryReadPermission,
  requestReadPermission,
  type PickedDirectoryHandle,
} from './gitEngine/walkDirectory';
import { walkRepositoryHandle } from './gitEngine/walkRepository';
import { watchRepository, type RepositoryWatcher } from './gitEngine/watchRepository';
import {
  readAppearanceSettings,
  subscribeToAppearanceSettings,
} from './hooks/useAppearanceSettings';
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
  /** Tracked-file total; 0 while only `.git` is being read or on a full walk. */
  totalFiles: number;
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

const FULL_WALK_REASONS: Record<Exclude<FullWalkReason, 'none'>, string> = {
  'missing-index': 'has no readable index',
  'unreadable-index': 'has an index that could not be read',
  'unsupported-index-version': 'uses an index format this app cannot parse',
};

const fullWalkWarning = (repoName: string, reason: FullWalkReason): string[] =>
  reason === 'none'
    ? []
    : [
        `"${repoName}" ${FULL_WALK_REASONS[reason]}, so every file in the folder was read instead of just the tracked ones.`,
      ];

const BLOCKING_INDEX_MESSAGES: Record<BlockingIndexExtension, (repoName: string) => string> = {
  link: (repoName) =>
    `"${repoName}" uses git's split index, which this app's engine cannot open. Run \`git update-index --no-split-index\` in the repository and open it again.`,
  sdir: (repoName) =>
    `"${repoName}" uses a sparse index, which this app's engine cannot open. Run \`git sparse-checkout disable\` (or \`git config index.sparse false\`) in the repository and open it again.`,
};

const toMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

// Staged deletions and sparse checkouts are normal git states, so missing
// tracked paths go to the console instead of a review-facing banner.
const reportMissingTrackedPaths = (repoName: string, missingTrackedPaths: string[]): void => {
  if (missingTrackedPaths.length > 0) {
    console.log(
      `[diffops git] ${missingTrackedPaths.length} tracked path(s) missing from "${repoName}":`,
      missingTrackedPaths.slice(0, 20),
    );
  }
};

const goToLauncher = (): void => {
  window.location.hash = LAUNCHER_HASH;
};

const ICON_BUTTON_CLASS =
  'p-2 rounded transition-colors text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary';

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
  const [hasDiskChanges, setHasDiskChanges] = useState(false);
  const [isWatchEnabled, setIsWatchEnabled] = useState(
    () => readAppearanceSettings().watchRepository,
  );
  const bridgeRef = useRef<LocalApiBridge | null>(null);
  const engineRef = useRef<GitEngine | null>(null);
  const handleRef = useRef<PickedDirectoryHandle | null>(null);
  const watcherRef = useRef<RepositoryWatcher | null>(null);

  useEffect(() => {
    document.title = folderName;
  }, [folderName]);

  // The watcher lives in this shell while the settings modal mounts deep
  // inside App, so the flag is seeded from storage and kept live by
  // subscription rather than waiting for a reload.
  useEffect(
    () => subscribeToAppearanceSettings((settings) => setIsWatchEnabled(settings.watchRepository)),
    [],
  );

  const readRepositoryFolder = useCallback(async (handle: PickedDirectoryHandle) => {
    const label = (phase: 'git' | 'worktree'): string =>
      phase === 'git'
        ? `Reading "${handle.name}" history…`
        : `Reading ${handle.name} — tracked files…`;
    setProgress({ label: label('git'), filesFound: 0, bytesFound: 0, totalFiles: 0 });
    return walkRepositoryHandle(handle, {
      onProgress: ({ phase, filesFound, bytesFound, totalFiles }) => {
        setProgress({ label: label(phase), filesFound, bytesFound, totalFiles });
      },
    });
  }, []);

  const mountRepository = useCallback(
    async (handle: PickedDirectoryHandle) => {
      setStatus({ kind: 'mounting' });
      setErrorMessage('');
      setWarnings([]);
      try {
        const walk = await readRepositoryFolder(handle);
        if (walk.blockingIndexExtension) {
          setStatus({
            kind: 'failed',
            message: BLOCKING_INDEX_MESSAGES[walk.blockingIndexExtension](handle.name),
          });
          return;
        }
        reportMissingTrackedPaths(handle.name, walk.missingTrackedPaths);
        setProgress({
          label: 'Preparing the git engine…',
          filesFound: walk.files.length,
          bytesFound: 0,
          totalFiles: 0,
        });
        // The engine module (and with it the git worker client) loads only once a folder is actually mounted.
        engineRef.current ??= (
          createEngine ?? (await import('./gitEngine/gitEngine')).createGitEngine
        )();
        const engine = engineRef.current;
        const info = await engine.open(walk.files, handle.name);
        handleRef.current = handle;
        bridgeRef.current ??= installLocalApiBridge();
        bridgeRef.current.setRepository({
          engine,
          repositoryId: info.repositoryId,
          repoName: info.repoName,
        });
        setWarnings([
          ...walkWarnings(walk.unreadablePaths),
          ...fullWalkWarning(handle.name, walk.fullWalkReason),
          ...info.warnings,
        ]);
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
    [createEngine, readRepositoryFolder],
  );

  // Purely cosmetic signalling: the watcher only lights the Refresh button
  // (never hides it), so an unsupported browser or a dropped observation
  // degrades to exactly today's behaviour.
  useEffect(() => {
    const handle = handleRef.current;
    if (status.kind !== 'ready' || !handle) {
      return;
    }
    if (!isWatchEnabled) {
      watcherRef.current?.disconnect();
      watcherRef.current = null;
      return;
    }
    let isCancelled = false;
    setHasDiskChanges(false);
    void watchRepository(handle, { onChanged: () => setHasDiskChanges(true) }).then((watcher) => {
      if (isCancelled) {
        watcher?.disconnect();
        return;
      }
      watcherRef.current = watcher;
    });
    return () => {
      isCancelled = true;
      watcherRef.current?.disconnect();
      watcherRef.current = null;
    };
  }, [status.kind, isWatchEnabled]);

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
    // Cleared up front so changes landing mid-refresh re-light the button.
    setHasDiskChanges(false);
    try {
      const walk = await readRepositoryFolder(handle);
      if (walk.blockingIndexExtension) {
        setErrorMessage(BLOCKING_INDEX_MESSAGES[walk.blockingIndexExtension](handle.name));
        return;
      }
      reportMissingTrackedPaths(handle.name, walk.missingTrackedPaths);
      const mountWarnings = await bridge.refreshRepository(walk.files);
      setWarnings([
        ...walkWarnings(walk.unreadablePaths),
        ...fullWalkWarning(handle.name, walk.fullWalkReason),
        ...mountWarnings,
      ]);
    } catch (refreshError) {
      setErrorMessage(toMessage(refreshError, 'Failed to refresh the repository'));
    } finally {
      setProgress(null);
    }
  }, [readRepositoryFolder]);

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
            {progress.totalFiles > 0
              ? `${progress.filesFound.toLocaleString()} / ${progress.totalFiles.toLocaleString()} files · ${formatBytes(progress.bytesFound)}`
              : progress.bytesFound > 0
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

  // Icon buttons for the App header: same shape as the file-tree and Settings
  // buttons, so they read as one cluster.
  const headerActions = (
    <>
      <button
        type="button"
        onClick={() => void refreshRepository()}
        className={
          hasDiskChanges
            ? 'p-2 rounded transition-colors bg-github-accent text-white'
            : ICON_BUTTON_CLASS
        }
        title={
          hasDiskChanges
            ? 'The folder changed on disk — re-read it and refetch the diff'
            : 'Re-read the repository folder and refetch the diff'
        }
        aria-label={hasDiskChanges ? 'Refresh · changes on disk' : 'Refresh'}
        data-testid="refresh-repo-button"
      >
        <RefreshCw size={18} />
      </button>
      <button
        type="button"
        onClick={closeWindow}
        className={ICON_BUTTON_CLASS}
        title="Close this repository window"
        aria-label="Close this repository window"
        data-testid="close-repo-button"
      >
        <Home size={18} />
      </button>
    </>
  );

  return (
    <div className="h-screen">
      <App
        routeSelection={routeSelection}
        onSelectionChange={onSelectionChange}
        headerActions={headerActions}
      />
      {banners(true)}
      {progressOverlay}
    </div>
  );
}
