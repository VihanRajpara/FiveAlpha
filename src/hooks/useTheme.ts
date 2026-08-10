import { useEffect, useState } from 'react';
import { useMediaQuery } from './useMediaQuery';

export type ThemeMode = 'system' | 'light' | 'dark';

/** Shared with the anti-flash script in index.html — keep the two in step. */
const STORAGE_KEY = 'nse.theme';

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // Storage can throw in private mode; falling back to system is harmless.
  }
  return 'system';
}

/**
 * Theme preference, persisted across sessions.
 *
 * The chosen mode is written to `data-theme` on <html>, which flips the root
 * `color-scheme` and so every `light-dark()` token in the stylesheet. Removing
 * the attribute hands control back to the OS setting.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStored);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolved: 'light' | 'dark' = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);

    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Preference just won't survive the session.
    }
  }, [mode]);

  // Keeps the browser/OS chrome (mobile address bar, task switcher) in step
  // with the page rather than with the system setting alone.
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#202124' : '#ffffff');
  }, [resolved]);

  return { mode, setMode, resolved };
}
