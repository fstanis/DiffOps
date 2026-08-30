import { beforeEach, describe, expect, it } from 'bun:test';

import {
  loadStandaloneClientSettings,
  resetStandaloneSettingsForTests,
  saveStandaloneClientSettings,
} from './settingsStore';

describe('standalone settings store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStandaloneSettingsForTests();
  });

  it('returns an empty client object when nothing is stored', () => {
    expect(loadStandaloneClientSettings()).toEqual({});
  });

  it('shallow-merges patches and round-trips through localStorage', () => {
    saveStandaloneClientSettings({ appearance: { theme: 'dark' } });
    saveStandaloneClientSettings({ lastSnapshot: 'abc' });

    expect(loadStandaloneClientSettings()).toEqual({
      appearance: { theme: 'dark' },
      lastSnapshot: 'abc',
    });
  });

  it('replaces a key wholesale on overwrite', () => {
    saveStandaloneClientSettings({ appearance: { theme: 'dark', fontSize: 14 } });
    saveStandaloneClientSettings({ appearance: { theme: 'light' } });

    expect(loadStandaloneClientSettings()).toEqual({ appearance: { theme: 'light' } });
  });

  it('treats corrupt storage as empty instead of throwing', () => {
    window.localStorage.setItem('diffops-standalone:user-settings', '{not json');

    expect(loadStandaloneClientSettings()).toEqual({});
  });
});
