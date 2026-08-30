import { describe, expect, it, vi } from 'bun:test';

import {
  registerChunkRowVirtualizer,
  scrollChunkOriginalIndexIntoRange,
} from './diffRowVirtualizerRegistry';

describe('diffRowVirtualizerRegistry', () => {
  it('returns false when no virtualizer is registered for the chunk', () => {
    expect(scrollChunkOriginalIndexIntoRange(99, 99, 0)).toBe(false);
  });

  it('forwards the original line index to the registered chunk and reports success', () => {
    const scrollToOriginalIndex = vi.fn().mockReturnValue(true);
    registerChunkRowVirtualizer(1, 2, scrollToOriginalIndex);

    expect(scrollChunkOriginalIndexIntoRange(1, 2, 7)).toBe(true);
    expect(scrollToOriginalIndex).toHaveBeenCalledWith(7);

    registerChunkRowVirtualizer(1, 2, null);
  });

  it('does not confuse chunks that share a fileIndex or chunkIndex', () => {
    const scrollA = vi.fn().mockReturnValue(true);
    const scrollB = vi.fn().mockReturnValue(true);
    registerChunkRowVirtualizer(3, 0, scrollA);
    registerChunkRowVirtualizer(3, 1, scrollB);

    scrollChunkOriginalIndexIntoRange(3, 1, 5);

    expect(scrollA).not.toHaveBeenCalled();
    expect(scrollB).toHaveBeenCalledWith(5);

    registerChunkRowVirtualizer(3, 0, null);
    registerChunkRowVirtualizer(3, 1, null);
  });

  it('unregisters when passed null, so later lookups report failure again', () => {
    const scrollToOriginalIndex = vi.fn().mockReturnValue(true);
    registerChunkRowVirtualizer(5, 0, scrollToOriginalIndex);
    registerChunkRowVirtualizer(5, 0, null);

    expect(scrollChunkOriginalIndexIntoRange(5, 0, 0)).toBe(false);
    expect(scrollToOriginalIndex).not.toHaveBeenCalled();
  });
});
