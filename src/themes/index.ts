/**
 * The theme catalogue.
 *
 * A theme is two things: its tokens, as one block in `./themes.css`, and its
 * entry here — what the picker calls it and where it comes from. Nothing else
 * in the app names a theme; components only ever read role tokens (--canvas,
 * --on-surface, --primary…), so a new block plus a new entry is the whole job.
 * `npm run check:contrast` then measures it.
 *
 * Keep the ids in step with index.html's pre-paint script where it names
 * them: the Auto pair and the legacy mapping.
 */

export type Scheme = 'light' | 'dark';

export interface Theme {
  /** The `data-theme` value, and the block's selector in themes.css. */
  id: string;
  name: string;
  scheme: Scheme;
  /** One line under the name in the picker: the source, then the character. */
  note: string;
}

export const THEMES: readonly Theme[] = [
  { id: 'geist-light', name: 'Geist Light', scheme: 'light', note: 'Vercel · monochrome' },
  { id: 'primer-light', name: 'Primer Light', scheme: 'light', note: 'GitHub · cool neutral' },
  { id: 'chart-light', name: 'Charting Light', scheme: 'light', note: 'TradingView-style' },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', scheme: 'light', note: 'Warm parchment · iris' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', scheme: 'light', note: 'Soft pastel · mauve' },
  { id: 'geist-dark', name: 'Geist Dark', scheme: 'dark', note: 'Vercel · pure black' },
  { id: 'indigo', name: 'Indigo', scheme: 'dark', note: 'Linear-style' },
  { id: 'chart-dark', name: 'Charting Dark', scheme: 'dark', note: 'TradingView-style' },
  { id: 'primer-dimmed', name: 'Primer Dimmed', scheme: 'dark', note: 'GitHub · low glare' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', scheme: 'dark', note: 'Pastels on charcoal' },
  { id: 'tokyo-night', name: 'Tokyo Night', scheme: 'dark', note: 'Deep indigo · neon' },
  { id: 'nord', name: 'Nord', scheme: 'dark', note: 'Arctic slate · frost' },
  { id: 'terminal-amber', name: 'Terminal Amber', scheme: 'dark', note: 'Bloomberg-style' },
];

/** What Auto resolves to for each device setting. */
export const AUTO = { light: 'geist-light', dark: 'geist-dark' } as const;

/**
 * Ids that no longer exist, mapped to their nearest successor so a saved choice
 * survives a catalogue change: the first toggle's light/dark/system, and the
 * previous set of themes.
 */
export const LEGACY: Readonly<Record<string, string>> = {
  system: 'auto',
  light: 'geist-light',
  dark: 'geist-dark',
  porcelain: 'geist-light',
  monochrome: 'geist-light',
  contrast: 'primer-light',
  newsprint: 'rose-pine-dawn',
  sandstone: 'rose-pine-dawn',
  graphite: 'geist-dark',
  ink: 'terminal-amber',
  terminal: 'terminal-amber',
  midnight: 'tokyo-night',
  fjord: 'nord',
  forest: 'catppuccin-mocha',
  dusk: 'catppuccin-mocha',
};

/** Accent presets offered on top of any theme. Each is a *hue*: the exact
 *  shade is fitted to the theme by `fitAccent` so it always reads as text. */
export const ACCENTS: readonly { id: string; name: string; hex: string }[] = [
  { id: 'blue', name: 'Blue', hex: '#2962ff' },
  { id: 'indigo', name: 'Indigo', hex: '#5e6ad2' },
  { id: 'teal', name: 'Teal', hex: '#0fa3a3' },
  { id: 'amber', name: 'Amber', hex: '#f0a020' },
  { id: 'violet', name: 'Violet', hex: '#8b5cf6' },
];

export const themeById = (id: string): Theme | undefined => THEMES.find((t) => t.id === id);
