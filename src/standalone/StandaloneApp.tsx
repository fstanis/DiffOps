import {
  AlertCircle,
  AlertTriangle,
  Download,
  FileText,
  FileUp,
  FolderGit2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import App from './App';
import { Logo } from './components/Logo';

import { readDiffFile } from './diffFile';
import type { GitEngine } from './gitEngine/gitEngine';
import {
  queryReadPermission,
  requestReadPermission,
  walkDirectoryHandle,
  type PickedDirectoryHandle,
} from './gitEngine/walkDirectory';
import { installLocalApiBridge, type LocalApiBridge } from './localApiBridge';
import {
  getStandaloneStore,
  type RecentDiffSummary,
  type StoredLastRepo,
} from './persistence/standaloneStore';

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<PickedDirectoryHandle>;
};

type StandaloneSource =
  | { kind: 'diff'; fileName: string }
  | { kind: 'repo'; repoName: string; repositoryId: string };

interface StandaloneAppProps {
  /** Engine factory override for tests; defaults to the real git worker. */
  createEngine?: () => GitEngine;
}

const formatRelativeTime = (isoTimestamp: string): string => {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const elapsedMs = Date.now() - timestamp;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
};

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;

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

/** Shell around the client App that opens local diff files and git repositories without a server. */
function StandaloneApp({ createEngine }: StandaloneAppProps) {
  const [source, setSource] = useState<StandaloneSource | null>(null);
  const [session, setSession] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [recentDiffs, setRecentDiffs] = useState<RecentDiffSummary[]>([]);
  const [lastRepo, setLastRepo] = useState<StoredLastRepo | null>(null);
  const [busy, setBusy] = useState<{
    label: string;
    filesFound: number;
    bytesFound: number;
  } | null>(null);
  const bridgeRef = useRef<LocalApiBridge | null>(null);
  const engineRef = useRef<GitEngine | null>(null);
  const repoHandleRef = useRef<PickedDirectoryHandle | null>(null);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const isDirectoryPickerSupported =
    typeof window !== 'undefined' && Boolean((window as PickerWindow).showDirectoryPicker);

  const ensureBridge = useCallback((): LocalApiBridge => {
    bridgeRef.current ??= installLocalApiBridge();
    return bridgeRef.current;
  }, []);

  // The engine module (and with it the git worker client) is loaded only when
  // a repository is actually opened — a .diff-only session never pays for it.
  const ensureEngine = useCallback(async (): Promise<GitEngine> => {
    if (!engineRef.current) {
      const create = createEngine ?? (await import('./gitEngine/gitEngine')).createGitEngine;
      engineRef.current = create();
    }
    return engineRef.current;
  }, [createEngine]);

  const loadRecentDiffs = useCallback(async () => {
    try {
      setRecentDiffs(await getStandaloneStore().listRecentDiffs());
    } catch {
      // The recent list is a convenience; storage failures just skip it.
    }
  }, []);

  useEffect(() => {
    void loadRecentDiffs();
    void getStandaloneStore()
      .loadLastRepo()
      .then((entry) => {
        if (entry) {
          setLastRepo(entry);
        }
      })
      .catch(() => {
        // Reopening is a convenience; storage failures just skip it.
      });
  }, [loadRecentDiffs]);

  const openFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) {
        return;
      }

      setErrorMessage('');
      setWarnings([]);
      try {
        const next = await readDiffFile(file);
        ensureBridge().setDiff(next);
        setSource({ kind: 'diff', fileName: next.fileName });
        // Fresh App instance per file so comment/viewed-file bootstrap
        // re-runs against the new repositoryId.
        setSession((prev) => prev + 1);
        try {
          await getStandaloneStore().recordRecentDiff(file.name, next.repositoryId, file.size);
          await loadRecentDiffs();
        } catch {
          // Recording recents is best-effort.
        }
      } catch (openError) {
        setErrorMessage(
          openError instanceof Error ? openError.message : `Failed to open "${file.name}"`,
        );
      }
    },
    [ensureBridge, loadRecentDiffs],
  );

  const openRepository = useCallback(
    async (handle: PickedDirectoryHandle) => {
      setErrorMessage('');
      setWarnings([]);
      setBusy({ label: `Reading "${handle.name}"…`, filesFound: 0, bytesFound: 0 });
      try {
        const { files, unreadablePaths } = await walkDirectoryHandle(handle, (progress) => {
          setBusy({
            label: `Reading "${handle.name}"…`,
            filesFound: progress.filesFound,
            bytesFound: progress.bytesFound,
          });
        });
        setBusy({ label: 'Preparing the git engine…', filesFound: files.length, bytesFound: 0 });
        const engine = await ensureEngine();
        const info = await engine.open(files, handle.name);
        repoHandleRef.current = handle;
        ensureBridge().setRepository({
          engine,
          repositoryId: info.repositoryId,
          repoName: info.repoName,
        });
        setSource({ kind: 'repo', repoName: info.repoName, repositoryId: info.repositoryId });
        setSession((prev) => prev + 1);
        setWarnings([...walkWarnings(unreadablePaths), ...info.warnings]);
        const entry: StoredLastRepo = {
          repoName: info.repoName,
          repositoryId: info.repositoryId,
          openedAt: new Date().toISOString(),
          handle,
        };
        // Recording is best-effort and must not hold the busy overlay: a wedged
        // persistence layer (a blocked IndexedDB upgrade) must not keep the
        // app "preparing" forever.
        void getStandaloneStore()
          .saveLastRepo(entry)
          .then(() => {
            setLastRepo(entry);
          })
          .catch(() => {
            // Recording the last repo is best-effort.
          });
      } catch (openError) {
        setErrorMessage(
          openError instanceof Error ? openError.message : `Failed to open "${handle.name}"`,
        );
      } finally {
        setBusy(null);
      }
    },
    [ensureBridge, ensureEngine],
  );

  const pickRepository = useCallback(async () => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) {
      setErrorMessage('Opening a repository needs a Chromium-based browser.');
      return;
    }
    try {
      const handle = await picker({ mode: 'read' });
      await openRepository(handle);
    } catch (pickerError) {
      if ((pickerError as { name?: string } | null)?.name === 'AbortError') {
        return;
      }
      setErrorMessage(
        pickerError instanceof Error ? pickerError.message : 'Failed to pick a repository folder',
      );
    }
  }, [openRepository]);

  const reopenLastRepo = useCallback(async () => {
    const handle = lastRepo?.handle;
    if (!handle) {
      return;
    }
    try {
      const permission = await queryReadPermission(handle);
      if (permission === 'denied') {
        setErrorMessage(`Permission to read "${handle.name}" was denied. Pick the folder again.`);
        return;
      }
      if (permission === 'prompt') {
        const granted = await requestReadPermission(handle);
        if (granted !== 'granted') {
          setErrorMessage(`Permission to read "${handle.name}" was not granted.`);
          return;
        }
      }
      await openRepository(handle);
    } catch (reopenError) {
      setErrorMessage(
        reopenError instanceof Error ? reopenError.message : `Failed to reopen "${handle.name}"`,
      );
    }
  }, [lastRepo, openRepository]);

  const refreshRepository = useCallback(async () => {
    const handle = repoHandleRef.current;
    if (!handle || source?.kind !== 'repo') {
      return;
    }
    setErrorMessage('');
    setBusy({ label: `Reading "${handle.name}"…`, filesFound: 0, bytesFound: 0 });
    try {
      const { files, unreadablePaths } = await walkDirectoryHandle(handle, (progress) => {
        setBusy({
          label: `Reading "${handle.name}"…`,
          filesFound: progress.filesFound,
          bytesFound: progress.bytesFound,
        });
      });
      const mountWarnings = await ensureBridge().refreshRepository(files);
      setWarnings([...walkWarnings(unreadablePaths), ...mountWarnings]);
    } catch (refreshError) {
      setErrorMessage(
        refreshError instanceof Error ? refreshError.message : 'Failed to refresh the repository',
      );
    } finally {
      setBusy(null);
    }
  }, [ensureBridge, source]);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      void openFile(event.target.files?.[0]);
      // Allow picking the same file again after fixing its content.
      event.target.value = '';
    },
    [openFile],
  );

  const exportComments = useCallback(async () => {
    if (!source) {
      return;
    }
    try {
      const query = ensureBridge().getCommentQuery();
      const response = await fetch(`/api/comments-json?${query}`);
      if (!response.ok) {
        throw new Error('Failed to export comments');
      }
      const payload: unknown = await response.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${source.kind === 'diff' ? source.fileName : source.repoName}.comments.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (exportError) {
      setErrorMessage(
        exportError instanceof Error ? exportError.message : 'Failed to export comments',
      );
    }
  }, [ensureBridge, source]);

  const handleImportChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !source) {
        return;
      }

      setErrorMessage('');
      try {
        const text = await file.text();
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new Error(`"${file.name}" is not valid JSON`);
        }

        const query = ensureBridge().getCommentQuery();
        const response = await fetch(`/api/comment-imports?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error('Import failed — expected a diffops comments JSON file');
        }

        const result = (await response.json()) as { warnings?: string[] };
        // The bridge broadcasts commentsChanged so the viewer refetches;
        // surfaced warnings are informational, not failures.
        if (result.warnings && result.warnings.length > 0) {
          setErrorMessage(result.warnings.join(' '));
        }
      } catch (importError) {
        setErrorMessage(
          importError instanceof Error ? importError.message : 'Failed to import comments',
        );
      }
    },
    [ensureBridge, source],
  );

  const forgetRecentDiff = useCallback(
    (key: string) => {
      void (async () => {
        try {
          await getStandaloneStore().forgetRecentDiff(key);
          await loadRecentDiffs();
        } catch {
          // Best-effort; the list refresh keeps whatever is still stored.
        }
      })();
    },
    [loadRecentDiffs],
  );

  useEffect(() => {
    const hasFilePayload = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
      dragCounterRef.current += 1;
      setIsDragging(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsDragging(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      void openFile(event.dataTransfer?.files?.[0]);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [openFile]);

  const errorBanner = errorMessage ? (
    <div
      role="alert"
      className={
        source
          ? 'fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl flex items-start gap-3 bg-github-bg-secondary border border-github-danger rounded-md px-4 py-3 shadow-lg'
          : 'flex items-start gap-3 bg-github-bg-secondary border border-github-danger rounded-md px-4 py-3 text-left'
      }
    >
      <AlertCircle size={18} className="text-github-danger shrink-0 mt-0.5" />
      <div className="text-sm text-github-text-primary">{errorMessage}</div>
      <button
        type="button"
        onClick={() => setErrorMessage('')}
        className="p-1 text-github-text-secondary hover:text-github-text-primary rounded"
        aria-label="Dismiss error"
      >
        <X size={14} />
      </button>
    </div>
  ) : null;

  const warningBanner =
    warnings.length > 0 ? (
      <div
        role="status"
        data-testid="warning-banner"
        className={
          source
            ? 'fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl flex items-start gap-3 bg-github-bg-secondary border border-github-warning rounded-md px-4 py-3 shadow-lg'
            : 'flex items-start gap-3 bg-github-bg-secondary border border-github-warning rounded-md px-4 py-3 text-left'
        }
      >
        <AlertTriangle size={18} className="text-github-warning shrink-0 mt-0.5" />
        <div className="text-sm text-github-text-primary">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setWarnings([])}
          className="p-1 text-github-text-secondary hover:text-github-text-primary rounded"
          aria-label="Dismiss warning"
        >
          <X size={14} />
        </button>
      </div>
    ) : null;

  const dragOverlay = isDragging ? (
    <div className="fixed inset-0 z-40 bg-github-bg-primary/70 flex items-center justify-center pointer-events-none">
      <div className="border-2 border-dashed border-github-accent rounded-lg px-8 py-6 text-github-text-primary text-sm font-medium">
        Drop the diff file to open it
      </div>
    </div>
  ) : null;

  const busyOverlay = busy ? (
    <div className="fixed inset-0 z-50 bg-github-bg-primary/70 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 bg-github-bg-secondary border border-github-border rounded-lg px-8 py-6 shadow-lg">
        <RefreshCw size={20} className="text-github-accent animate-spin" />
        <div className="text-sm text-github-text-primary font-medium">{busy.label}</div>
        {busy.filesFound > 0 && (
          <div className="text-xs text-github-text-secondary">
            {busy.bytesFound > 0
              ? `${busy.filesFound.toLocaleString()} files · ${formatBytes(busy.bytesFound)} read`
              : `${busy.filesFound.toLocaleString()} files read`}
          </div>
        )}
      </div>
    </div>
  ) : null;

  const reopenButton = lastRepo ? (
    <button
      type="button"
      onClick={() => void reopenLastRepo()}
      className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-primary hover:bg-github-bg-tertiary text-sm transition-colors"
      title={`Reopen ${lastRepo.repoName}`}
      data-testid="reopen-repo-button"
    >
      <FolderGit2 size={15} />
      Reopen {lastRepo.repoName}
    </button>
  ) : null;

  // While a repository is open the same picker flow switches folders, so the
  // button says so; on the landing screen it opens the first one.
  const isRepoOpen = source?.kind === 'repo';
  const openRepositoryButton = (
    <button
      type="button"
      onClick={() => void pickRepository()}
      className="flex items-center gap-2 px-4 py-2 rounded-md border border-github-border bg-github-bg-secondary text-github-text-primary text-sm font-medium hover:bg-github-bg-tertiary transition-colors"
      title={
        isRepoOpen ? 'Open a different repository folder' : 'Open a local git repository folder'
      }
      data-testid="open-repo-button"
    >
      <FolderGit2 size={16} />
      {isRepoOpen ? 'Change repository…' : 'Open repository…'}
    </button>
  );

  if (!source) {
    return (
      <div className="h-screen bg-github-bg-primary flex items-center justify-center px-4">
        {dragOverlay}
        {busyOverlay}
        <div className="flex flex-col items-center gap-6 max-w-lg w-full text-center">
          <Logo style={{ height: '28px', color: 'var(--color-github-text-secondary)' }} />
          <div>
            <h1 className="text-xl text-github-text-primary font-semibold">
              Review a diff — no server needed
            </h1>
            <p className="text-sm text-github-text-secondary mt-1">
              Open a local git repository, or a{' '}
              <code className="bg-github-bg-tertiary px-1.5 py-0.5 rounded">.diff</code>/
              <code className="bg-github-bg-tertiary px-1.5 py-0.5 rounded">.patch</code> file
              produced by <code>git diff</code>, <code>git show</code>, or your review tooling.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".diff,.patch"
              onChange={handleInputChange}
              className="sr-only"
              aria-label="Open diff file"
              data-testid="diff-file-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-github-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <FileUp size={16} />
              Open diff file…
            </button>
            {isDirectoryPickerSupported && openRepositoryButton}
          </div>
          {isDirectoryPickerSupported && reopenButton}
          {!isDirectoryPickerSupported && (
            <p className="text-xs text-github-text-muted">
              Repository mode needs a Chromium-based browser; diff files work everywhere.
            </p>
          )}
          {errorBanner}
          {warningBanner}
          <p className="text-xs text-github-text-muted">
            …or drop a diff file anywhere in this window
          </p>
          {recentDiffs.length > 0 && (
            <div className="w-full text-left" data-testid="recent-diffs">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-github-text-muted mb-2">
                Recent diffs
              </h2>
              <ul
                className="border border-github-border rounded-md divide-y divide-github-border bg-github-bg-secondary max-h-56 overflow-y-auto"
                aria-label="Recently opened diffs"
              >
                {recentDiffs.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <FileText size={14} className="text-github-text-secondary shrink-0" />
                    <span
                      className="text-github-text-primary truncate flex-1"
                      title={entry.fileName}
                    >
                      {entry.fileName}
                    </span>
                    <span className="text-xs text-github-text-muted shrink-0">
                      {formatRelativeTime(entry.openedAt)}
                    </span>
                    <span className="text-xs text-github-text-secondary shrink-0 whitespace-nowrap">
                      {entry.commentCount} {entry.commentCount === 1 ? 'comment' : 'comments'}
                    </span>
                    <button
                      type="button"
                      onClick={() => forgetRecentDiff(entry.key)}
                      className="p-1 text-github-text-muted hover:text-github-text-primary rounded shrink-0"
                      aria-label={`Forget ${entry.fileName}`}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <App key={session} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".diff,.patch"
        onChange={handleInputChange}
        className="sr-only"
        aria-label="Open diff file"
        data-testid="diff-file-input"
      />
      <input
        ref={importInputRef}
        type="file"
        accept="json,application/json"
        onChange={handleImportChange}
        className="sr-only"
        aria-label="Import comments file"
        data-testid="comment-import-input"
      />
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
        {source.kind === 'repo' && (
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
        )}
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary text-xs shadow-md transition-colors"
          title="Import comments from a JSON file"
        >
          <Upload size={14} />
          Import comments
        </button>
        <button
          type="button"
          onClick={() => void exportComments()}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary text-xs shadow-md transition-colors"
          title="Export comments as a JSON file"
        >
          <Download size={14} />
          Export comments
        </button>
        {isDirectoryPickerSupported && openRepositoryButton}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-github-bg-secondary border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary text-xs shadow-md transition-colors"
          title="Open another diff file"
        >
          <FileUp size={14} />
          Open diff
        </button>
      </div>
      {errorBanner}
      {warningBanner}
      {dragOverlay}
      {busyOverlay}
    </div>
  );
}

export default StandaloneApp;
