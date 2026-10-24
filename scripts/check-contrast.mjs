// Contrast self-check for every theme — `npm run check:contrast`.
//
// Each theme is one block in src/themes/themes.css. Editing a single value can
// break a pair you were not looking at — usually in a theme you were not
// looking at either — so this measures every text colour against every ground
// it is actually painted on, in every block.
//
// Ratios are WCAG 2.1 relative luminance. 4.5:1 is the body-text floor, and the
// accent and market colours are held to it too: they are used at 12–13px on
// figures, not as large display type. Translucent containers (the dark themes'
// tinted chips) are composited over the surface they sit on before measuring.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'themes', 'themes.css');
const MIN = 4.5;

/** `[data-theme='x'] { --tok: value; … }` → { x: { tok: value } } */
function readThemes(css) {
  const out = {};
  const block = /\[data-theme='([\w-]+)'\]\s*\{([^}]*)\}/g;
  for (const [, id, body] of css.matchAll(block)) {
    out[id] = Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  }
  return out;
}

/** `#rrggbb` or `rgba(r, g, b, a)` → [r, g, b, a] */
function parse(c) {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unparseable colour: ${c}`);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b, a];
}

/** A translucent colour as it actually renders over an opaque one. */
const over = (fg, bg) => {
  const [r, g, b, a] = parse(fg);
  const [R, G, B] = parse(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
};

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) =>
  0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);

function ratio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Which grounds each foreground is actually painted on — explicit rather than
// "every combination": --on-primary sits on --primary and nowhere else.
const GROUNDS = ['canvas', 'surface', 'surface-2'];
const CHECKS = [
  ['on-surface', GROUNDS],
  ['on-surface-variant', GROUNDS],
  ['on-surface-faint', GROUNDS],
  ['primary', [...GROUNDS, 'primary-container']],
  ['up', [...GROUNDS, 'up-container']],
  ['down', [...GROUNDS, 'down-container']],
  ['on-primary', ['primary']],
  ['on-warn', ['warn']],
  // Primary buttons, at rest and hovered; the selected segment of a control.
  ['btn-fg', ['btn-bg', 'btn-hover']],
  ['on-surface', ['raised']],
];

const themes = readThemes(readFileSync(CSS, 'utf8'));
const failures = [];

for (const [id, t] of Object.entries(themes)) {
  console.log(`\n${id.toUpperCase()}`);
  for (const [fg, grounds] of CHECKS) {
    const cells = grounds.map((g) => {
      if (!t[fg] || !t[g]) {
        failures.push(`${id}: --${!t[fg] ? fg : g} is missing`);
        return `${g} MISSING`;
      }
      // Grounds can be translucent (containers); composite them over the surface.
      const ground = over(t[g], t.surface);
      const r = ratio(over(t[fg], t.surface), ground);
      if (r < MIN) failures.push(`${id}: --${fg} on --${g} is ${r.toFixed(2)}:1`);
      return `${g} ${r.toFixed(2)}${r < MIN ? ' FAIL' : ''}`;
    });
    console.log(`  ${fg.padEnd(20)} ${cells.join('  ·  ')}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} below ${MIN}:1 —`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\n${Object.keys(themes).length} themes · all pairs clear ${MIN}:1.`);
