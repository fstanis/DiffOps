import type { DiffSelection } from '../types/diff';
import { createDiffSelection } from '../utils/diffSelection';

/**
 * A repository window's address: which registered folder it mounts and, when
 * the URL carries one, which diff it shows. Hash routing keeps the app free of
 * server rewrite rules and service-worker navigation handling.
 */
export interface RepositoryRoute {
  folderName: string;
  selection: DiffSelection | null;
}

const REPOSITORY_PATH_PATTERN = /^\/r\/(.+)$/;

/** Returns null for the launcher route and for anything unrecognised. */
export const parseRepositoryRoute = (hash: string): RepositoryRoute | null => {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const separatorIndex = fragment.indexOf('?');
  const path = separatorIndex < 0 ? fragment : fragment.slice(0, separatorIndex);
  const query = separatorIndex < 0 ? '' : fragment.slice(separatorIndex + 1);

  const match = REPOSITORY_PATH_PATTERN.exec(path);
  if (!match?.[1]) {
    return null;
  }

  const folderName = decodeURIComponent(match[1]);
  const params = new URLSearchParams(query);
  const base = params.get('base') ?? '';
  const target = params.get('target') ?? '';
  const baseMode = params.get('baseMode') === 'merge-base' ? 'merge-base' : undefined;

  return {
    folderName,
    selection: base && target ? createDiffSelection(base, target, baseMode) : null,
  };
};

export const buildRepositoryHash = (
  folderName: string,
  selection: DiffSelection | null,
): string => {
  const path = `#/r/${encodeURIComponent(folderName)}`;
  if (!selection) {
    return path;
  }

  const params = new URLSearchParams({
    base: selection.baseCommitish,
    target: selection.targetCommitish,
  });
  if (selection.baseMode === 'merge-base') {
    params.set('baseMode', 'merge-base');
  }
  return `${path}?${params.toString()}`;
};

export const LAUNCHER_HASH = '#/';
