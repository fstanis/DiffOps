import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_EXPLAIN_MODEL } from '../../utils/explainPrompt';
import { DEFAULT_NARRATE_MODEL } from '../../utils/narratePrompt';
import { fetchClientSettings, saveClientSettings } from '../services/userSettings';

/** Everything the AI features need; an empty key means AI is off. */
export interface AiSettings {
  apiKey: string;
  explainModel: string;
  narrateModel: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  apiKey: '',
  explainModel: DEFAULT_EXPLAIN_MODEL,
  narrateModel: DEFAULT_NARRATE_MODEL,
};

const AI_STORAGE_KEY = 'diffops-ai-settings';

// Key for AI settings inside the persisted client settings object.
const AI_SETTINGS_KEY = 'ai';

const asNonEmptyString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;

const normalizeStoredSettings = (raw: unknown): AiSettings | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const parsed = raw as Partial<AiSettings>;
  return {
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
    explainModel: asNonEmptyString(parsed.explainModel, DEFAULT_EXPLAIN_MODEL),
    narrateModel: asNonEmptyString(parsed.narrateModel, DEFAULT_NARRATE_MODEL),
  };
};

const readLocalSettings = (): AiSettings | null => {
  try {
    const stored = localStorage.getItem(AI_STORAGE_KEY);
    return stored ? normalizeStoredSettings(JSON.parse(stored)) : null;
  } catch (error) {
    console.warn('Failed to load AI settings from localStorage:', error);
    return null;
  }
};

const writeLocalSettings = (settings: AiSettings): void => {
  try {
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('Failed to save AI settings to localStorage:', error);
  }
};

interface UseAiSettingsReturn {
  settings: AiSettings;
  updateSettings: (newSettings: AiSettings) => void;
}

/**
 * The API key and model ids, cached synchronously in localStorage and
 * persisted through the same client-settings endpoint appearance uses.
 */
export function useAiSettings(): UseAiSettingsReturn {
  const [settings, setSettings] = useState<AiSettings>(
    () => readLocalSettings() ?? DEFAULT_AI_SETTINGS,
  );

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Hydrate from the persisted settings; seed them from localStorage when the
  // stored object has no AI section yet.
  useEffect(() => {
    let cancelled = false;

    void fetchClientSettings().then((client) => {
      if (cancelled || !client) {
        return;
      }

      const remote = normalizeStoredSettings(client[AI_SETTINGS_KEY]);
      if (remote) {
        setSettings(remote);
        writeLocalSettings(remote);
        return;
      }
      if (readLocalSettings() !== null) {
        saveClientSettings({ [AI_SETTINGS_KEY]: settingsRef.current });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((newSettings: AiSettings) => {
    setSettings(newSettings);
    writeLocalSettings(newSettings);
    saveClientSettings({ [AI_SETTINGS_KEY]: newSettings });
  }, []);

  return useMemo(() => ({ settings, updateSettings }), [settings, updateSettings]);
}
