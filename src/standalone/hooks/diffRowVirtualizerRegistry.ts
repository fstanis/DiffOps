type ScrollToOriginalIndex = (originalLineIndex: number) => boolean;

const registry = new Map<string, ScrollToOriginalIndex>();

function registryKey(fileIndex: number, chunkIndex: number): string {
  return `${fileIndex}:${chunkIndex}`;
}

/** Lets a chunk's row virtualizer be reached by keyboard navigation once mounted; pass null to unregister. */
export function registerChunkRowVirtualizer(
  fileIndex: number,
  chunkIndex: number,
  scrollToOriginalIndex: ScrollToOriginalIndex | null,
): void {
  const key = registryKey(fileIndex, chunkIndex);
  if (scrollToOriginalIndex) {
    registry.set(key, scrollToOriginalIndex);
  } else {
    registry.delete(key);
  }
}

/** Returns true if a virtualizer for this chunk exists and scrolled the target line into its rendered range. */
export function scrollChunkOriginalIndexIntoRange(
  fileIndex: number,
  chunkIndex: number,
  originalLineIndex: number,
): boolean {
  const scrollToOriginalIndex = registry.get(registryKey(fileIndex, chunkIndex));
  return scrollToOriginalIndex ? scrollToOriginalIndex(originalLineIndex) : false;
}
