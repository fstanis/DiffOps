import { describe, expect, it } from 'bun:test';

import { DEFAULT_DIFF_VIEW_MODE, normalizeDiffViewMode } from './diffMode';

describe('normalizeDiffViewMode', () => {
  it('accepts the primary mode names', () => {
    expect(normalizeDiffViewMode('split')).toBe('split');
    expect(normalizeDiffViewMode('unified')).toBe('unified');
    expect(normalizeDiffViewMode('current')).toBe('current');
  });

  it('maps legacy aliases', () => {
    expect(normalizeDiffViewMode('side-by-side')).toBe('split');
    expect(normalizeDiffViewMode('inline')).toBe('unified');
  });

  it('falls back to the default for unknown values', () => {
    expect(DEFAULT_DIFF_VIEW_MODE).toBe('split');
    expect(normalizeDiffViewMode('bogus')).toBe(DEFAULT_DIFF_VIEW_MODE);
    expect(normalizeDiffViewMode(null)).toBe(DEFAULT_DIFF_VIEW_MODE);
    expect(normalizeDiffViewMode(undefined)).toBe(DEFAULT_DIFF_VIEW_MODE);
  });
});
