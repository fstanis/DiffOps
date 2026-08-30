// User settings for the standalone app live in localStorage, exposed through
// the same { version, client } shape as the server's ~/.diffops/config.json.
// The two worlds are intentionally separate (see docs/plans/pwa-port.md).

const STORAGE_KEY = 'diffops-standalone:user-settings';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Loads the standalone app's client settings, returning an empty object when none persist. */
export const loadStandaloneClientSettings = (): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && isPlainObject(parsed.client)) {
      return parsed.client;
    }
  } catch (error) {
    console.warn('diffops: ignoring unreadable standalone settings:', error);
  }
  return {};
};

/**
 * Shallow-merges the patch into the persisted client settings (the client
 * always sends whole values per top-level key, e.g. the complete `appearance`
 * object).
 */
export const saveStandaloneClientSettings = (
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const client = { ...loadStandaloneClientSettings(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, client }));
  } catch (error) {
    console.warn('diffops: failed to persist standalone settings:', error);
  }
  return client;
};

/** Clears the persisted standalone settings. */
export const resetStandaloneSettingsForTests = (): void => {
  localStorage.removeItem(STORAGE_KEY);
};
