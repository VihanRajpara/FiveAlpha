import { useSyncExternalStore } from 'react';
import { getSnapshot, setAccent, setThemePref, subscribe } from '../lib/theme';

/**
 * The active theme, for components that show or change it. The state itself
 * lives in src/lib/theme.ts, outside React — see there.
 */
export function useTheme() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return { ...state, setPref: setThemePref, setAccent };
}
