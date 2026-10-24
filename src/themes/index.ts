/**
 * The theme catalogue.
 *
 * A theme is two things: its colours, as one block in `./themes.css`, and its
 * entry here — what the picker calls it and which half of Auto it could stand
 * in for. Nothing else in the app names a theme; components only ever read the
 * role tokens (--canvas, --on-surface, --primary…), so a new block plus a new
 * entry is the whole job. `npm run check:contrast` then measures it.
 *
 * Keep the ids in step with index.html's pre-paint script only where it names
 * them: the Auto pair and the legacy mapping.
 */

export type Scheme = 'light' | 'dark';

export interface Theme {
  /** The `data-theme` value, and the block's selector in themes.css. */
  id: string;
  name: string;
  scheme: Scheme;
  /** One line under the name in the picker. */
  note: string;
}

export const THEMES: readonly Theme[] = [
  { id: 'porcelain', name: 'Porcelain', scheme: 'light', note: 'Cool white, cobalt' },
  { id: 'newsprint', name: 'Newsprint', scheme: 'light', note: 'Warm paper, amber' },
  { id: 'sandstone', name: 'Sandstone', scheme: 'light', note: 'Earthy sand, petrol' },
  { id: 'monochrome', name: 'Monochrome', scheme: 'light', note: 'Grayscale, ink accent' },
  { id: 'contrast', name: 'Contrast', scheme: 'light', note: 'Black on white, AAA' },
  { id: 'graphite', name: 'Graphite', scheme: 'dark', note: 'Neutral dark, cobalt' },
  { id: 'ink', name: 'Ink', scheme: 'dark', note: 'Warm black, amber' },
  { id: 'midnight', name: 'Midnight', scheme: 'dark', note: 'Deep navy, cyan' },
  { id: 'fjord', name: 'Fjord', scheme: 'dark', note: 'Cool slate, frost' },
  { id: 'forest', name: 'Forest', scheme: 'dark', note: 'Green-black, brass' },
  { id: 'dusk', name: 'Dusk', scheme: 'dark', note: 'Aubergine, lavender' },
  { id: 'terminal', name: 'Terminal', scheme: 'dark', note: 'True black, phosphor' },
];

/** What Auto resolves to for each device setting. */
export const AUTO = { light: 'porcelain', dark: 'graphite' } as const;

/** Accent presets offered on top of any theme. Each is a *hue*: the exact
 *  shade is fitted to the theme by `fitAccent` so it always reads as text. */
export const ACCENTS: readonly { id: string; name: string; hex: string }[] = [
  { id: 'cobalt', name: 'Cobalt', hex: '#3b6cf6' },
  { id: 'teal', name: 'Teal', hex: '#0fa3a3' },
  { id: 'amber', name: 'Amber', hex: '#f0a020' },
  { id: 'violet', name: 'Violet', hex: '#8b5cf6' },
  { id: 'slate', name: 'Slate', hex: '#64748b' },
];

export const themeById = (id: string): Theme | undefined => THEMES.find((t) => t.id === id);
