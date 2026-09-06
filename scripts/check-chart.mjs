// Self-check for the chart's study series — `node scripts/check-chart.mjs`.
//
// Drawing the studies meant computing them for every bar, and the two things
// that made that possible are both quiet failure modes:
//
//   1. `mapo` (one reading, thousands of tickers, three bars) and `mapoSeries`
//      (every bar, one ticker) now share a per-bar core. If they ever diverge,
//      the pane draws a line that disagrees with the number in the column next
//      to it — and nothing throws. So the series' last value is asserted equal
//      to the single reading, on the same closes.
//   2. `runUtBot` grew a `stops` array beside the `stop` it already returned.
//      The final element must be that same stop, and the leading nulls must line
//      up with the ATR's warm-up — a stop drawn one bar early is a rule that
//      never existed.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript. The bundle goes to a real file rather than a data: URL so
// bare specifiers in the output still resolve.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMP = 'scripts/.check-chart.bundle.mjs';
await build({
  entryPoints: ['src/lib/signals.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: TMP,
});

let mod;
try {
  mod = await import(pathToFileURL(TMP).href);
} finally {
  await rm(TMP, { force: true });
}
const { mapo, mapoSeries, runUtBot, atr, windowChart, MAPO, UT_BOT, CHART_WINDOW } = mod;

// A deterministic walk — no RNG, so a failure is reproducible from this file
// alone. Enough bars to clear MAPO's 100-period fan several times over.
const N = 400;
const closes = [];
let px = 500;
for (let i = 0; i < N; i++) {
  px += Math.sin(i / 7) * 4 + Math.cos(i / 23) * 9 + (i % 11 === 0 ? -6 : 1.2);
  closes.push(Math.max(20, px));
}
const bars = closes.map((c, i) => ({
  date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
  open: c * 0.995,
  high: c * 1.012,
  low: c * 0.988,
  close: c,
  volume: 1000 + i,
}));

// --- 1. the two MAPO paths must agree ---------------------------------------
const series = mapoSeries(closes);
const single = mapo(closes);

assert.ok(single, 'the fixture must be long enough for a reading');
assert.equal(series.length, closes.length, 'series is aligned to closes by index');
assert.ok(
  Math.abs(series.at(-1) - single.above) < 1e-9,
  `mapoSeries tail ${series.at(-1)} must equal mapo().above ${single.above} — ` +
    'the pane and the column would disagree',
);

// Warm-up: nothing before the fan plus its smoothing can exist, and the first
// real value must land exactly on that bar, not near it.
const firstAt = series.findIndex((v) => v !== null);
assert.equal(
  firstAt,
  MAPO.maxLength + MAPO.smooth - 2,
  'the oscillator starts on the first bar it can, and not one earlier',
);
assert.ok(
  series.slice(0, firstAt).every((v) => v === null),
  'no reading is invented before the fan has its history',
);
assert.ok(
  series.slice(firstAt).every((v) => v !== null && v >= 0 && v <= 100),
  'every drawn value is a real percentage',
);

// Truncating the input must not shift earlier values: the series is causal, so
// bar n cannot depend on bars after it.
const shorter = mapoSeries(closes.slice(0, N - 30));
for (let i = 0; i < N - 30; i++) {
  const a = series[i];
  const b = shorter[i];
  assert.ok(
    a === b || (a !== null && b !== null && Math.abs(a - b) < 1e-9),
    `bar ${i} changed when later bars were removed — the series is not causal`,
  );
}

// Too little history is null throughout, never a partial answer.
assert.ok(mapoSeries(closes.slice(0, 40)).every((v) => v === null));

// --- 2. the trailing-stop series --------------------------------------------
const { stop, stops, flips } = runUtBot(bars);
assert.equal(stops.length, bars.length, 'stops are aligned to bars by index');
assert.equal(stops.at(-1), stop, 'the last drawn stop is the stop the table reads');

const ranges = atr(bars, UT_BOT.atrPeriod);
for (let i = 0; i < bars.length; i++) {
  assert.equal(
    stops[i] === null,
    ranges[i] === null,
    `bar ${i}: the stop exists exactly where the ATR does`,
  );
}
assert.ok(flips.length > 0, 'the fixture must actually cross the stop');
for (const f of flips) {
  assert.ok(stops[f.index] !== null, `flip at ${f.index} sits on a bar with a stop`);
}

// --- 3. windowing keeps the three arrays in step ----------------------------
const data = { bars, stop: stops, above: series };
for (const [range, take] of Object.entries(CHART_WINDOW)) {
  const w = windowChart(data, range);
  const want = take === null ? bars.length : Math.min(take, bars.length);
  assert.equal(w.bars.length, want, `${range}: window length`);
  assert.equal(w.stop.length, want, `${range}: stop stayed aligned`);
  assert.equal(w.above.length, want, `${range}: above stayed aligned`);
  // The tail is what a window keeps, and the arrays must be the *same* tail.
  assert.equal(w.bars.at(-1).date, bars.at(-1).date, `${range}: window ends at the last bar`);
  assert.equal(w.stop.at(-1), stops.at(-1), `${range}: stop tail matches`);
  assert.equal(w.above.at(-1), series.at(-1), `${range}: above tail matches`);
}

// An unknown range must not silently return an empty chart.
assert.equal(windowChart(data, 'nonsense').bars.length, bars.length);

console.log(
  `chart series OK — mapoSeries agrees with mapo to 1e-9 over ${N} bars, ` +
    `stops align with the ATR, ${flips.length} flips land on real bars, windows stay in step`,
);
