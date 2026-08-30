// Which paths under .git the git engine actually reads: libgit2's read-only
// surface (objects, refs, and a handful of root files). Shared by the worker's
// defence-in-depth filter and the repository walker so the two cannot drift.

const MIRRORED_GIT_ROOT_FILES = new Set(['HEAD', 'config', 'index', 'packed-refs', 'shallow']);

/** Whether a path under `.git` (relative to it) is one the engine mirrors. */
export const isMirroredGitPath = (pathUnderGit: string): boolean => {
  const topSegment = pathUnderGit.split('/')[0] ?? '';
  return (
    topSegment === 'objects' || topSegment === 'refs' || MIRRORED_GIT_ROOT_FILES.has(pathUnderGit)
  );
};

/** Directories under `.git` that can contain a mirrored path. */
export const isMirroredGitDirectory = (pathUnderGit: string): boolean => {
  if (pathUnderGit === '') {
    return true;
  }
  const topSegment = pathUnderGit.split('/')[0] ?? '';
  return topSegment === 'objects' || topSegment === 'refs';
};
