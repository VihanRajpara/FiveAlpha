// Self-check for src/lib/signals.ts — `node scripts/check-signals.mjs`.
// Bundled through esbuild (already a vite dependency) because Node 18 cannot
// import TypeScript.
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const out = await build({
  entryPoints: ['src/lib/signals.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { hma, atr, latestSignal, signalGapPct, matchesSignalFilter } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

// HMA barely lags a straight line — a plain WMA(9) would sit 2.67 below it.
const ramp = Array.from({ length: 60 }, (_, i) => i + 1);
const h = hma(ramp, 9);
assert.equal(h[7], null, 'HMA is null until it has enough bars');
assert.ok(Math.abs(h[59] - 60) <= 1, `HMA should track a ramp: ${h[59]}`);
assert.equal(h[59], h[58] + 1, 'and advance one for one with it');

// Every bar ranges 10 and closes mid-range, so both TR and ATR are 10.
const flat = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  open: 100, high: 105, low: 95, close: 100, volume: 1,
}));
assert.ok(Math.abs(atr(flat, 6).at(-1) - 10) < 1e-9, 'ATR of a constant range is that range');

// A V: 120 bars down to a trough, then 120 back up. The last flip must be a BUY
// somewhere on the way up, priced at that bar's close.
const bar = (i, close) => ({
  date: new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10),
  open: close, high: close * 1.01, low: close * 0.99, close, volume: 1,
});
const v = [
  ...Array.from({ length: 120 }, (_, i) => bar(i, 1000 - i * 4)),
  ...Array.from({ length: 120 }, (_, i) => bar(120 + i, 520 + i * 4)),
];
const signal = latestSignal(v);
assert.ok(signal, 'a V-shape should produce a signal');
assert.equal(signal.side, 'BUY', `expected BUY on the recovery, got ${signal.side}`);
assert.ok(signal.date > v[120].date, 'the flip should land after the trough');
assert.equal(signal.price, v.find((b) => b.date === signal.date).close);
assert.equal(signal.age, v.length - 1 - v.findIndex((b) => b.date === signal.date));

// The inverted V — up then down — must flip the other way.
const peak = [
  ...Array.from({ length: 120 }, (_, i) => bar(i, 520 + i * 4)),
  ...Array.from({ length: 120 }, (_, i) => bar(120 + i, 1000 - i * 4)),
];
assert.equal(latestSignal(peak).side, 'SELL');

// --- the signal filters ---------------------------------------------------
const buy = { side: 'BUY', price: 100, date: '2026-08-01', age: 7 };

assert.equal(signalGapPct(buy, 110), 10, 'price above the signal is a positive gap');
assert.equal(signalGapPct(buy, 90), -10, 'and below it a negative one');
assert.equal(signalGapPct(buy, null), null, 'an unpriced row has no gap');
// Both sides are signed the same way: a SELL that kept running is still positive.
assert.equal(signalGapPct({ ...buy, side: 'SELL' }, 110), 10);

// No filter admits everything, including rows with no signal at all.
assert.ok(matchesSignalFilter(null, 110, { side: 'ALL', age: 'ALL', gap: 'ALL' }));
// Any filter rejects a row with nothing to say.
assert.ok(!matchesSignalFilter(null, 110, { side: 'ALL', age: '5', gap: 'ALL' }));
assert.ok(!matchesSignalFilter(undefined, 110, { side: 'ALL', age: 'ALL', gap: '0_5' }));

// Age is a ceiling in bars.
assert.ok(matchesSignalFilter(buy, 110, { side: 'ALL', age: '10', gap: 'ALL' }), '7 bars is within 10');
assert.ok(!matchesSignalFilter(buy, 110, { side: 'ALL', age: '5', gap: 'ALL' }), '7 bars is not within 5');
assert.ok(matchesSignalFilter({ ...buy, age: 5 }, 110, { side: 'ALL', age: '5', gap: 'ALL' }), 'the bound is inclusive');

// Gap bands are [min, max) — no row may fall in two, and none between them.
assert.ok(matchesSignalFilter(buy, 103, { side: 'ALL', age: 'ALL', gap: '0_5' }));
assert.ok(!matchesSignalFilter(buy, 105, { side: 'ALL', age: 'ALL', gap: '0_5' }), '5% belongs to the band above');
assert.ok(matchesSignalFilter(buy, 105, { side: 'ALL', age: 'ALL', gap: '5_15' }));
assert.ok(matchesSignalFilter(buy, 100, { side: 'ALL', age: 'ALL', gap: '0_5' }), 'exactly at the signal is 0%');
assert.ok(matchesSignalFilter(buy, 99, { side: 'ALL', age: 'ALL', gap: 'BELOW' }));
assert.ok(!matchesSignalFilter(buy, 100, { side: 'ALL', age: 'ALL', gap: 'BELOW' }), 'BELOW is strictly under');
assert.ok(matchesSignalFilter(buy, 200, { side: 'ALL', age: 'ALL', gap: '15' }));

// Both at once is an AND.
assert.ok(matchesSignalFilter(buy, 103, { side: 'ALL', age: '10', gap: '0_5' }));
assert.ok(!matchesSignalFilter(buy, 103, { side: 'ALL', age: '5', gap: '0_5' }), 'passing the gap does not excuse the age');

// Side is an AND with the rest, and 'ALL' on every slot admits everything.
assert.ok(matchesSignalFilter(buy, 110, { side: 'BUY', age: '10', gap: 'ALL' }));
assert.ok(!matchesSignalFilter(buy, 110, { side: 'SELL', age: 'ALL', gap: 'ALL' }));
assert.ok(matchesSignalFilter(null, 110, { side: 'ALL', age: 'ALL', gap: 'ALL' }));
assert.ok(!matchesSignalFilter(null, 110, { side: 'BUY', age: 'ALL', gap: 'ALL' }));

// --- the numeric band filters ---------------------------------------------
const { inBand, NUMERIC_FILTERS, matchesBands, ANY } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      (
        await build({
          entryPoints: ['src/lib/filters.ts'],
          bundle: true,
          format: 'esm',
          platform: 'node',
          write: false,
        })
      ).outputFiles[0].text,
    ).toString('base64')
);

// [min, max): the upper edge belongs to the next band up, and no value can
// fall into two adjacent bands or between them.
assert.ok(inBand(100, { min: 100, max: 500 }), 'the lower bound is inclusive');
assert.ok(!inBand(500, { min: 100, max: 500 }), 'the upper bound is not');
assert.ok(inBand(500, { min: 500, max: 2000 }), 'it belongs to the band above');
assert.ok(inBand(50, { max: 100 }), 'an open lower end');
assert.ok(inBand(5000, { min: 2000 }), 'an open upper end');
// A number that was never measured is not a match, at any bound.
for (const v of [null, undefined, NaN]) {
  assert.ok(!inBand(v, { min: 0 }), `${v} must not match`);
}

// Every band set partitions its axis: walking the edges must hit exactly one
// band per value, and every set must start with the shared "Any" option.
for (const f of NUMERIC_FILTERS) {
  assert.equal(f.bands[0].value, ANY, `${f.key} must open with Any`);
  // Threshold sets ("15%+", "20%+") contain one another on purpose.
  if (f.nested) continue;
  const real = f.bands.slice(1);
  const edges = real.flatMap((b) => [b.min, b.max].filter((n) => n !== undefined));
  for (const edge of edges) {
    const hits = real.filter((b) => inBand(edge, b)).length;
    assert.ok(hits <= 1, `${f.key}: ${edge} falls in ${hits} bands at once`);
  }
}

// matchesBands ANDs across filters and ignores unset ones.
const row = { quote: { price: 250, changePercent: 6 } };
assert.ok(matchesBands(row, undefined, {}), 'no selection admits everything');
assert.ok(matchesBands(row, undefined, { price: '100_500' }));
assert.ok(!matchesBands(row, undefined, { price: 'u100' }));
assert.ok(matchesBands(row, undefined, { price: '100_500', dayMove: 'up5' }));
assert.ok(!matchesBands(row, undefined, { price: 'u100', dayMove: 'up5' }), 'one failure is enough');
// A screen-derived filter rejects a row the screen never reached.
assert.ok(!matchesBands(row, undefined, { roce: 'o20' }));
assert.ok(matchesBands(row, { metrics: { rocePct: 22 } }, { roce: 'o20' }));

console.log('signals.ts + filters.ts ok —', JSON.stringify(signal));
