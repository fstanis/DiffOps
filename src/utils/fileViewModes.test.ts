import { beforeEach, describe, expect, it } from 'bun:test';

import { loadFileViewModes, saveFileViewModes } from './fileViewModes';

describe('fileViewModes storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty map when nothing is stored', () => {
    expect(loadFileViewModes()).toEqual({});
  });

  it('round-trips per-file selections', () => {
    saveFileViewModes({ 'src/app.ts': 'split', 'README.md': 'full-preview' });

    expect(loadFileViewModes()).toEqual({ 'src/app.ts': 'split', 'README.md': 'full-preview' });
  });

  it('drops entries with unrecognized values', () => {
    window.localStorage.setItem(
      'diffops.fileViewModes',
      JSON.stringify({ 'keep.ts': 'full', 'drop.ts': 'bogus', 'drop2.ts': 42 }),
    );

    expect(loadFileViewModes()).toEqual({ 'keep.ts': 'full' });
  });

  it('returns an empty map for malformed JSON', () => {
    window.localStorage.setItem('diffops.fileViewModes', '{not json');

    expect(loadFileViewModes()).toEqual({});
  });

  it('returns an empty map for non-object payloads', () => {
    window.localStorage.setItem('diffops.fileViewModes', JSON.stringify(['split']));

    expect(loadFileViewModes()).toEqual({});
  });
});
