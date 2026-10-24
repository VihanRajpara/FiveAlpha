import { flushSync } from 'react-dom';
import { AUTO, LEGACY, themeById } from '../themes';
import { reducedMotion } from './motion';

/**
 * The active theme: what was chosen, what it resolves to, and the custom accent
 * on top — as a tiny store outside React, so Auto keeps following the device
 * even on screens with no picker mounted, and the picker is just a view of it.
 *
 * The first paint is not done here. index.html's inline script reads the same
 * three keys and sets `data-theme` (and any accent) before the stylesheet is
 * applied, so there is never a frame in the wrong theme. `installTheme` then
 * takes over and reconciles.
 */

/** 'auto', or a theme id from src/themes/index.ts. */
export type ThemePref = string;

export interface ThemeState {
  pref: ThemePref;
  /** The theme actually on screen — Auto resolved against the device. */
  resolved: string;
  /** A custom accent as `#rrggbb`, or null for the theme's own. */
  accent: string | null;
}

// Shared with the inline script in index.html — keep the names in step.
const PREF_KEY = 'nse.theme';
const ACCENT_KEY = 'nse.accent';
const COLOR_KEY = 'nse.theme-color';

const ACCENT_TOKENS = ['--primary', '--primary-hover', '--primary-container', '--on-primary'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode: the choice lasts for the tab
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applied.
  }
}

function readPref(): ThemePref {
  const raw = read(PREF_KEY) ?? 'auto';
  const pref = LEGACY[raw] ?? raw;
  // A theme removed in a later release falls back to Auto rather than to nothing.
  return pref === 'auto' || themeById(pref) ? pref : 'auto';
}

function readAccent(): string | null {
  try {
    const hex = JSON.parse(read(ACCENT_KEY) ?? 'null')?.hex;
    return typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
  } catch {
    return null;
  }
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const resolve = (pref: ThemePref) => (pref === 'auto' ? AUTO[darkQuery.matches ? 'dark' : 'light'] : pref);

let pref = readPref();
let accent = readAccent();
let snapshot: ThemeState = { pref, resolved: resolve(pref), accent };
const listeners = new Set<() => void>();

export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const getSnapshot = () => snapshot;

// ---- colour arithmetic, just enough to fit an accent ----------------------

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

const css = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;

const luminance = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * A theme's own colours, read from the stylesheet rather than duplicated here.
 * The probe carries the theme's `data-theme`, so it sees that block's values
 * and not any accent overrides sitting on <html>.
 */
function themeColours(id: string, tokens: string[]): RGB[] {
  const probe = document.createElement('span');
  probe.setAttribute('data-theme', id);
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
  document.body.appendChild(probe);
  const out = tokens.map((t) => {
    probe.style.color = `var(${t})`;
    const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
    return [r, g, b] as RGB;
  });
  probe.remove();
  return out;
}

/**
 * A custom accent, fitted to a theme.
 *
 * The colour picked is a hue, not a promise: bright cyan is unreadable as text
 * on white, deep navy is unreadable on black. So it is pulled toward the
 * theme's own ink, a step at a time, until it clears 4.5:1 as text on every
 * ground and on its own tinted container — the same bar `check:contrast` holds
 * the built-in themes to. Usually that is zero steps.
 */
export function fitAccent(hex: string, themeId: string): Record<string, string> {
  const [canvas, surface, surface2, ink] = themeColours(themeId, [
    '--canvas',
    '--surface',
    '--surface-2',
    '--on-surface',
  ]);
  const wanted = hexToRgb(hex);
  const tint = (c: RGB) => mix(surface, c, 0.15);
  const reads = (c: RGB) =>
    Math.min(...[canvas, surface, surface2, tint(c)].map((g) => contrast(c, g))) >= 4.5;

  let primary = wanted;
  for (let step = 1; step <= 20 && !reads(primary); step++) primary = mix(wanted, ink, step / 20);

  // Text on an accent fill: whichever of the theme's own ink or ground reads
  // better, and black/white if neither does (one of those always clears 4.5).
  const onPrimary = [canvas, ink, [0, 0, 0] as RGB, [255, 255, 255] as RGB].reduce((best, c) =>
    contrast(c, primary) > contrast(best, primary) ? c : best,
  );

  return {
    '--primary': css(primary),
    // Toward the ink: darker on a light theme, lighter on a dark one — the
    // same direction every built-in theme's hover goes.
    '--primary-hover': css(mix(primary, ink, 0.2)),
    '--primary-container': css(tint(primary)),
    '--on-primary': css(onPrimary),
  };
}

// ---- applying -------------------------------------------------------------

function paint() {
  const root = document.documentElement;
  const id = resolve(pref);
  root.setAttribute('data-theme', id);

  for (const t of ACCENT_TOKENS) root.style.removeProperty(t);
  if (accent) {
    const tokens = fitAccent(accent, id);
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    // The chart repaints on this attribute; it cannot see the inline style.
    root.setAttribute('data-accent', accent);
    // Cached fitted, per theme, so the pre-paint script can apply it without
    // repeating the arithmetic.
    write(ACCENT_KEY, JSON.stringify({ hex: accent, theme: id, tokens }));
  } else {
    root.removeAttribute('data-accent');
    write(ACCENT_KEY, null);
  }

  // The browser chrome follows the page's own ground.
  const [canvas] = themeColours(id, ['--canvas']);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', css(canvas));
  }
  // Auto leaves this to the media-keyed meta tags in index.html.
  write(COLOR_KEY, pref === 'auto' ? null : css(canvas));

  snapshot = { pref, resolved: id, accent };
  // Synchronous, so the picker's own "selected" mark is in the snapshot the
  // view transition takes, rather than snapping a frame after it.
  flushSync(() => listeners.forEach((fn) => fn()));
}

/**
 * Swap the whole page in one composited crossfade (index.css,
 * `[data-vt='theme']`) — a colour change with no layout or movement in it.
 * Instant where view transitions are missing or motion is reduced.
 */
function withCrossfade(update: () => void) {
  const root = document.documentElement;
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  root.dataset.vt = 'theme';
  document.startViewTransition(update).finished.finally(() => delete root.dataset.vt);
}

export function setThemePref(next: ThemePref) {
  if (next === pref) return;
  pref = next;
  write(PREF_KEY, next);
  withCrossfade(paint);
}

/** Null restores the theme's own accent. Applied without a crossfade: the
 *  colour input fires continuously while it is dragged. */
export function setAccent(next: string | null) {
  accent = next?.toLowerCase() ?? null;
  paint();
}

export function installTheme() {
  // Reconcile with what the pre-paint script did — a cached accent fitted to
  // another theme, an id since renamed.
  paint();

  darkQuery.addEventListener('change', () => {
    if (pref === 'auto') withCrossfade(paint);
  });

  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== PREF_KEY && e.key !== ACCENT_KEY) return;
    const nextPref = readPref();
    const nextAccent = readAccent();
    if (nextPref === pref && nextAccent === accent) return;
    pref = nextPref;
    accent = nextAccent;
    paint();
  });
}
