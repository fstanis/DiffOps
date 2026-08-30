import { beforeEach, describe, expect, it } from 'bun:test';

import { loadFileViewModes, saveFileViewModes } from './fileViewModes';

const REPOSITORY_ID = 'repo-abc123';
const STORAGE_KEY = `diffops.fileViewModes:${REPOSITORY_ID}`;

describe('fileViewModes storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty map when nothing is stored', () => {
    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({});
  });

  it('round-trips per-file selections', () => {
    saveFileViewModes(REPOSITORY_ID, { 'src/app.ts': 'split', 'README.md': 'full-preview' });

    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({
      'src/app.ts': 'split',
      'README.md': 'full-preview',
    });
  });

  it('keeps each repository’s selections for the same path apart', () => {
    saveFileViewModes(REPOSITORY_ID, { 'src/app.ts': 'split' });
    saveFileViewModes('repo-other', { 'src/app.ts': 'full' });

    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({ 'src/app.ts': 'split' });
    expect(loadFileViewModes('repo-other')).toEqual({ 'src/app.ts': 'full' });
  });

  it('drops entries with unrecognized values', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'keep.ts': 'full', 'drop.ts': 'bogus', 'drop2.ts': 42 }),
    );

    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({ 'keep.ts': 'full' });
  });

  it('returns an empty map for malformed JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');

    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({});
  });

  it('returns an empty map for non-object payloads', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['split']));

    expect(loadFileViewModes(REPOSITORY_ID)).toEqual({});
  });
});
