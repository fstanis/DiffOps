import { describe, expect, it } from 'bun:test';

import type { CursorPosition } from '../../hooks/keyboardNavigation/types';

import { getElementId, parseElementId } from './domHelpers';

describe('getElementId / parseElementId', () => {
  it('round-trips a unified position', () => {
    const position: CursorPosition = { fileIndex: 2, chunkIndex: 1, lineIndex: 5, side: 'right' };
    const id = getElementId(position, 'unified');

    expect(id).toBe('file-2-chunk-1-line-5');
    expect(parseElementId(id)).toEqual({ fileIndex: 2, chunkIndex: 1, lineIndex: 5 });
  });

  it('round-trips a split position, ignoring the side suffix', () => {
    const position: CursorPosition = { fileIndex: 0, chunkIndex: 3, lineIndex: 12, side: 'left' };
    const id = getElementId(position, 'split');

    expect(id).toBe('file-0-chunk-3-line-12-left');
    expect(parseElementId(id)).toEqual({ fileIndex: 0, chunkIndex: 3, lineIndex: 12 });
  });

  it('returns null for ids that do not match the expected format', () => {
    expect(parseElementId('not-a-line-id')).toBeNull();
    expect(parseElementId('file-1-chunk-2-line-')).toBeNull();
    expect(parseElementId('')).toBeNull();
  });
});
