import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_DIFF_VIEW_MODE,
  DEFAULT_FILE_VIEW_MODE,
  normalizeDiffViewMode,
  normalizeFileViewMode,
  parseFileViewMode,
} from './diffMode';

describe('normalizeDiffViewMode', () => {
  it('accepts the primary mode names', () => {
    expect(normalizeDiffViewMode('split')).toBe('split');
    expect(normalizeDiffViewMode('unified')).toBe('unified');
    expect(normalizeDiffViewMode('full')).toBe('full');
  });

  it('maps legacy names and aliases', () => {
    expect(normalizeDiffViewMode('current')).toBe('full');
    expect(normalizeDiffViewMode('side-by-side')).toBe('split');
    expect(normalizeDiffViewMode('inline')).toBe('unified');
  });

  it('falls back to the unified default for unknown values', () => {
    expect(DEFAULT_DIFF_VIEW_MODE).toBe('unified');
    expect(DEFAULT_FILE_VIEW_MODE).toBe('unified');
    expect(normalizeDiffViewMode('bogus')).toBe(DEFAULT_DIFF_VIEW_MODE);
    expect(normalizeDiffViewMode(null)).toBe(DEFAULT_DIFF_VIEW_MODE);
    expect(normalizeDiffViewMode(undefined)).toBe(DEFAULT_DIFF_VIEW_MODE);
  });
});

describe('parseFileViewMode', () => {
  it('accepts every per-file mode', () => {
    expect(parseFileViewMode('split')).toBe('split');
    expect(parseFileViewMode('unified')).toBe('unified');
    expect(parseFileViewMode('full')).toBe('full');
    expect(parseFileViewMode('diff-preview')).toBe('diff-preview');
    expect(parseFileViewMode('full-preview')).toBe('full-preview');
  });

  it('migrates legacy persisted values', () => {
    expect(parseFileViewMode('current')).toBe('full');
    expect(parseFileViewMode('diff')).toBe('unified');
    expect(parseFileViewMode('side-by-side')).toBe('split');
    expect(parseFileViewMode('inline')).toBe('unified');
  });

  it('returns null for unknown values', () => {
    expect(parseFileViewMode('bogus')).toBeNull();
    expect(parseFileViewMode(null)).toBeNull();
    expect(parseFileViewMode(undefined)).toBeNull();
  });

  it('normalizes unknown values to the unified default', () => {
    expect(normalizeFileViewMode('bogus')).toBe('unified');
    expect(normalizeFileViewMode(null)).toBe('unified');
  });
});
