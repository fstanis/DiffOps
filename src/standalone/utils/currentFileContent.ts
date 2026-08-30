import type { DiffFile } from '../../types/diff';

// Keyed by DiffFile object identity so a re-fetched diff (new file objects) invalidates the cache naturally.
const contentCache = new WeakMap<DiffFile, string[]>();
const pendingFetches = new WeakMap<DiffFile, Promise<string[]>>();

// Whole-file text for arbitrary repository paths (explain probes and re-ask prompts), cached per ref and path.
const blobTextCache = new Map<string, string>();

// An added file's hunks already contain the whole new file, so no blob fetch is needed.
export function linesFromAddedFile(file: DiffFile): string[] {
  const lines: string[] = [];
  for (const chunk of file.chunks) {
    for (const line of chunk.lines) {
      if (line.type === 'add') {
        lines.push(line.content);
      }
    }
  }
  return lines;
}

/** Returns already-fetched lines for a file object, or undefined on a cache miss. */
export function getCachedCurrentFileLines(file: DiffFile): string[] | undefined {
  return contentCache.get(file);
}

async function fetchBlobText(path: string, ref: string): Promise<string> {
  const encodedPath = encodeURIComponent(path);
  const response = await fetch(`/api/blob/${encodedPath}?ref=${encodeURIComponent(ref)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }
  return response.text();
}

// DiffFile-keyed fetching deliberately bypasses the path-keyed cache, since a fresh diff's file objects must be re-read.
async function fetchBlobLines(path: string, ref: string): Promise<string[]> {
  const text = await fetchBlobText(path, ref);
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Fetches a DiffFile's current content once per file object, deduplicating concurrent callers. */
export function fetchCurrentFileLines(file: DiffFile, ref: string): Promise<string[]> {
  const cached = contentCache.get(file);
  if (cached) {
    return Promise.resolve(cached);
  }

  let pending = pendingFetches.get(file);
  if (!pending) {
    pending = fetchBlobLines(file.path, ref).then(
      (lines) => {
        contentCache.set(file, lines);
        return lines;
      },
      (error: unknown) => {
        pendingFetches.delete(file);
        throw error;
      },
    );
    pendingFetches.set(file, pending);
  }
  return pending;
}

/** Fetches one repository path's whole text, cached per ref and path. */
export async function fetchRepositoryFileText(path: string, ref: string): Promise<string> {
  const cacheKey = `${ref}\n${path}`;
  const cached = blobTextCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const text = await fetchBlobText(path, ref);
  blobTextCache.set(cacheKey, text);
  return text;
}
