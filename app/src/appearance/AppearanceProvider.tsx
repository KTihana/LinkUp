import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { activeTheme, defaults, palette, type AppearancePatch } from './palette';
import { watchThemeClock } from './themeClock';
import { useVault } from '../security/VaultProvider';
const Context = createContext({ preferences: defaults, activeTheme: activeTheme(defaults), colors: palette(defaults), update: async (_patch: AppearancePatch) => {}, storageError: false });
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const vault = useVault();
  const { status, generation, importLegacyAppearance } = vault;
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    let alive = true;
    if (status === 'unlocked') {
      void importLegacyAppearance().then(() => { if (alive) setStorageError(false); }).catch(() => { if (alive) setStorageError(true); });
    }
    return () => { alive = false; };
  }, [status, generation, importLegacyAppearance]);
  const preferences = vault.appearance;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (preferences.theme !== 'Automatic') return;
    return watchThemeClock(setNow, {
      now: () => new Date(),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: timer => { if (timer !== undefined) clearTimeout(timer as ReturnType<typeof setTimeout>); },
      onResume: callback => {
        const listener = AppState.addEventListener('change', state => { if (state === 'active') callback(); });
        return () => listener.remove();
      },
    });
  }, [preferences.theme]);
  const theme = activeTheme(preferences, now);
  const colors = useMemo(() => palette(preferences, theme), [preferences, theme]);
  async function update(patch: AppearancePatch) {
    try { await vault.saveAppearance(patch); setStorageError(false); }
    catch (error) { setStorageError(true); throw error; }
  }
  return <Context.Provider value={{ preferences, activeTheme: theme, colors, update, storageError }}>{children}</Context.Provider>;
}
export function useAppearance() { return useContext(Context); }
