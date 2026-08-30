import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import type { AppearanceSettings } from '../components/SettingsModal';
import { fetchClientSettings, saveClientSettings } from '../services/userSettings';
import { normalizeAutoViewedPatterns } from '../utils/autoViewedPatterns';
import {
  APPEARANCE_STORAGE_KEY,
  applyResolvedTheme,
  resolveThemePreference,
  type ColorVisionMode,
  type ResolvedTheme,
} from '../utils/appearanceTheme';
import { getFallbackSyntaxTheme, isSyntaxThemeForResolvedTheme } from '../utils/themeLoader';

const DEFAULT_SETTINGS: AppearanceSettings = {
  fontSize: 14,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
  theme: 'dark',
  syntaxTheme: 'vsDark',
  colorVision: 'normal',
  autoViewedPatterns: [],
  watchRepository: true,
};

const APPEARANCE_SETTINGS_KEY = 'appearance';

const normalizeStoredSettings = (raw: unknown): AppearanceSettings | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const parsed = raw as Partial<AppearanceSettings> & {
    autoViewedPatterns?: unknown;
  };

  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    autoViewedPatterns: normalizeAutoViewedPatterns(parsed.autoViewedPatterns),
    watchRepository: parsed.watchRepository !== false,
  };
};

type AppearanceSettingsListener = (settings: AppearanceSettings) => void;

const listeners = new Set<AppearanceSettingsListener>();

/** The returned function unsubscribes. */
export const subscribeToAppearanceSettings = (
  listener: AppearanceSettingsListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Notifies subscribers of a settings change; the hook's update path publishes here. */
export const broadcastAppearanceSettings = (settings: AppearanceSettings): void => {
  for (const listener of listeners) {
    listener(settings);
  }
};

/** Reads the persisted appearance settings, falling back to the defaults. */
export const readAppearanceSettings = (): AppearanceSettings => {
  try {
    const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (stored) {
      return normalizeStoredSettings(JSON.parse(stored)) ?? DEFAULT_SETTINGS;
    }
  } catch {
    // Unreadable stored settings are not worth a warning on every reader.
  }
  return DEFAULT_SETTINGS;
};

interface UseAppearanceSettingsReturn {
  settings: AppearanceSettings;
  updateSettings: (newSettings: AppearanceSettings) => void;
}

export function useAppearanceSettings(): UseAppearanceSettingsReturn {
  const [settings, setSettings] = useState<AppearanceSettings>(readAppearanceSettings);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Hydrate from the server-persisted settings (shared across ports); seed the server from localStorage if it has none yet.
  useEffect(() => {
    let cancelled = false;

    void fetchClientSettings().then((client) => {
      if (cancelled || !client) {
        return;
      }

      const remote = normalizeStoredSettings(client[APPEARANCE_SETTINGS_KEY]);
      if (remote) {
        setSettings(remote);
        broadcastAppearanceSettings(remote);
        try {
          localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(remote));
        } catch {
          // localStorage is only a cache here; ignore write failures.
        }
        return;
      }

      let hasLocalSettings = false;
      try {
        hasLocalSettings = localStorage.getItem(APPEARANCE_STORAGE_KEY) !== null;
      } catch {
        // Treat unreadable localStorage as empty.
      }
      if (hasLocalSettings) {
        saveClientSettings({ [APPEARANCE_SETTINGS_KEY]: settingsRef.current });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const applyTheme = useCallback(
    (theme: 'light' | 'dark', colorVision: ColorVisionMode = 'normal') => {
      applyResolvedTheme(theme, colorVision);
    },
    [],
  );

  const saveSettings = useCallback((newSettings: AppearanceSettings) => {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(newSettings));
    } catch (error) {
      console.warn('Failed to save appearance settings to localStorage:', error);
    }
    saveClientSettings({ [APPEARANCE_SETTINGS_KEY]: newSettings });
  }, []);

  const getSettingsForResolvedTheme = useCallback(
    (currentSettings: AppearanceSettings, resolvedTheme: ResolvedTheme) => {
      if (isSyntaxThemeForResolvedTheme(currentSettings.syntaxTheme, resolvedTheme)) {
        return currentSettings;
      }

      const fallbackSyntaxTheme = getFallbackSyntaxTheme(resolvedTheme);
      if (!fallbackSyntaxTheme) {
        return currentSettings;
      }

      return {
        ...currentSettings,
        syntaxTheme: fallbackSyntaxTheme.id,
      };
    },
    [],
  );

  useEffect(() => {
    const root = document.documentElement;

    root.style.setProperty('--app-font-size', `${settings.fontSize}px`);

    root.style.setProperty('--app-font-family', settings.fontFamily);

    const colorVision = settings.colorVision ?? 'normal';
    const applyResolvedAppearance = (resolvedTheme: ResolvedTheme) => {
      applyTheme(resolvedTheme, colorVision);

      const nextSettings = getSettingsForResolvedTheme(settings, resolvedTheme);
      if (nextSettings !== settings) {
        setSettings(nextSettings);
        saveSettings(nextSettings);
      }
    };

    if (settings.theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyResolvedAppearance(
        resolveThemePreference('auto', mediaQuery.matches ? 'dark' : 'light'),
      );

      const handleChange = (e: MediaQueryListEvent) => {
        applyResolvedAppearance(resolveThemePreference('auto', e.matches ? 'dark' : 'light'));
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else {
      applyResolvedAppearance(settings.theme);
      return undefined;
    }
  }, [settings, applyTheme, getSettingsForResolvedTheme, saveSettings]);

  const updateSettings = useCallback(
    (newSettings: AppearanceSettings) => {
      setSettings(newSettings);
      saveSettings(newSettings);
      broadcastAppearanceSettings(newSettings);
    },
    [saveSettings],
  );

  return useMemo(() => ({ settings, updateSettings }), [settings, updateSettings]);
}
