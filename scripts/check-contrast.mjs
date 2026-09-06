// Contrast self-check for the palette — `node scripts/check-contrast.mjs`.
//
// The palette is written as `light-dark()` pairs in one `:root` block, which is
// what makes the theme toggle a single property change — and also what makes a
// contrast regression invisible: edit one hex and the *other* theme is the one
// that breaks, in a mode you were not looking at.
//
// Two things this catches that reading the file cannot:
//
//   1. Text measured against the wrong ground. `--on-surface-faint` is the one
//      that has failed before, and it fails on `--surface-2` (chips, the
//      segmented track, the search field) long before it fails on the page
//      background — so every foreground is checked against every surface it can
//      actually land on, not just against the canvas.
//   2. A theme that passes in light and fails in dark. Both are computed.
//
// Ratios are WCAG 2.1 relative luminance. 4.5:1 is the body-text floor; the
// accent and market colours are held to it too, because they are used at 12–13px
// on figures, not as large display type.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css');
const MIN = 4.5;

/** `--tok: light-dark(#aaa, #bbb);` → { light, dark }, hex only. */
function readTokens(css) {
  const out = {};
  const re = /--([\w-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi;
  for (const [, name, light, dark] of css.matchAll(re)) out[name] = { light, dark };
  return out;
}

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => channel(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Which grounds each foreground is actually painted on. Kept explicit rather
// than "every combination": --on-primary sits on --primary and nowhere else,
// and checking it against the canvas would be a failure that means nothing.
const SURFACES = ['canvas', 'surface', 'surface-2'];
const CHECKS = [
  ['on-surface', SURFACES],
  ['on-surface-variant', SURFACES],
  ['on-surface-faint', SURFACES],
  ['primary', SURFACES],
  ['up', SURFACES],
  ['down', SURFACES],
  ['on-primary', ['primary']],
];

const tokens = readTokens(readFileSync(CSS, 'utf8'));
const missing = CHECKS.flatMap(([fg, bgs]) => [fg, ...bgs]).filter((t) => !tokens[t]);
if (missing.length) {
  console.error(`Tokens not found as light-dark() pairs: ${[...new Set(missing)].join(', ')}`);
  console.error('If one was renamed or made theme-independent, update CHECKS here too.');
  process.exit(1);
}

const failures = [];
for (const theme of ['light', 'dark']) {
  console.log(`\n${theme.toUpperCase()}`);
  for (const [fg, bgs] of CHECKS) {
    const cells = bgs.map((bg) => {
      const r = ratio(tokens[fg][theme], tokens[bg][theme]);
      if (r < MIN) failures.push(`${theme}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      return `${bg} ${r.toFixed(2)}${r < MIN ? ' FAIL' : ''}`;
    });
    console.log(`  ${fg.padEnd(20)} ${cells.join('  ·  ')}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} below ${MIN}:1 —`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\nAll pairs clear ${MIN}:1.`);
