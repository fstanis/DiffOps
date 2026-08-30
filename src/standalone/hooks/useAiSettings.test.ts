import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'bun:test';

import { resetClientSettingsForTests } from '../services/userSettings';

import { DEFAULT_AI_SETTINGS, useAiSettings } from './useAiSettings';

const AI_STORAGE_KEY = 'diffops-ai-settings';

const readPersistedSettings = () => JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? 'null');

/** Programs the client-settings endpoint the hook hydrates from. */
const mockClientSettings = (client: Record<string, unknown> | null) => {
  vi.mocked(global.fetch).mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/user-settings' && init?.method !== 'PUT') {
      return Promise.resolve({
        ok: client !== null,
        json: () => Promise.resolve({ version: 1, client }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  }) as unknown as typeof fetch);
};

const putBodies = () =>
  vi
    .mocked(global.fetch)
    .mock.calls.filter(
      ([url, init]) => String(url) === '/api/user-settings' && init?.method === 'PUT',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as { client: Record<string, unknown> });

describe('useAiSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    resetClientSettingsForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('starts with no key and the default models', () => {
    mockClientSettings({});

    const { result } = renderHook(() => useAiSettings());

    expect(result.current.settings).toEqual(DEFAULT_AI_SETTINGS);
    expect(DEFAULT_AI_SETTINGS.apiKey).toBe('');
  });

  it('reads the persisted settings synchronously on the first render', () => {
    localStorage.setItem(
      AI_STORAGE_KEY,
      JSON.stringify({ apiKey: 'local-key', explainModel: 'openai/gpt-5.6-sol' }),
    );
    mockClientSettings({});

    const { result } = renderHook(() => useAiSettings());

    expect(result.current.settings).toEqual({
      apiKey: 'local-key',
      explainModel: 'openai/gpt-5.6-sol',
      narrateModel: DEFAULT_AI_SETTINGS.narrateModel,
    });
  });

  it('hydrates from the persisted client settings and caches them locally', async () => {
    mockClientSettings({
      ai: { apiKey: 'remote-key', explainModel: 'a/b', narrateModel: 'c/d' },
    });

    const { result } = renderHook(() => useAiSettings());

    await waitFor(() => {
      expect(result.current.settings.apiKey).toBe('remote-key');
    });
    expect(result.current.settings).toEqual({
      apiKey: 'remote-key',
      explainModel: 'a/b',
      narrateModel: 'c/d',
    });
    expect(readPersistedSettings()).toEqual(result.current.settings);
  });

  it('falls back to the defaults for a blank stored model id', async () => {
    mockClientSettings({ ai: { apiKey: 'k', explainModel: '   ', narrateModel: 'c/d' } });

    const { result } = renderHook(() => useAiSettings());

    await waitFor(() => {
      expect(result.current.settings.apiKey).toBe('k');
    });
    expect(result.current.settings.explainModel).toBe(DEFAULT_AI_SETTINGS.explainModel);
  });

  it('persists an update to both localStorage and the settings endpoint', async () => {
    mockClientSettings({});
    const { result } = renderHook(() => useAiSettings());

    const next = { ...DEFAULT_AI_SETTINGS, apiKey: 'typed-key' };
    act(() => {
      result.current.updateSettings(next);
    });

    expect(result.current.settings).toEqual(next);
    expect(readPersistedSettings()).toEqual(next);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(putBodies()).toEqual([{ client: { ai: next } }]);
  });
});
