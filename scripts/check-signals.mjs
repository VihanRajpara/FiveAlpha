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
assert.ok(matchesSignalFilter(null, 110, 'ALL', 'ALL'));
// Any filter rejects a row with nothing to say.
assert.ok(!matchesSignalFilter(null, 110, '5', 'ALL'));
assert.ok(!matchesSignalFilter(undefined, 110, 'ALL', '0_5'));

// Age is a ceiling in bars.
assert.ok(matchesSignalFilter(buy, 110, '10', 'ALL'), '7 bars is within 10');
assert.ok(!matchesSignalFilter(buy, 110, '5', 'ALL'), '7 bars is not within 5');
assert.ok(matchesSignalFilter({ ...buy, age: 5 }, 110, '5', 'ALL'), 'the bound is inclusive');

// Gap bands are [min, max) — no row may fall in two, and none between them.
assert.ok(matchesSignalFilter(buy, 103, 'ALL', '0_5'));
assert.ok(!matchesSignalFilter(buy, 105, 'ALL', '0_5'), '5% belongs to the band above');
assert.ok(matchesSignalFilter(buy, 105, 'ALL', '5_15'));
assert.ok(matchesSignalFilter(buy, 100, 'ALL', '0_5'), 'exactly at the signal is 0%');
assert.ok(matchesSignalFilter(buy, 99, 'ALL', 'BELOW'));
assert.ok(!matchesSignalFilter(buy, 100, 'ALL', 'BELOW'), 'BELOW is strictly under');
assert.ok(matchesSignalFilter(buy, 200, 'ALL', '15'));

// Both at once is an AND.
assert.ok(matchesSignalFilter(buy, 103, '10', '0_5'));
assert.ok(!matchesSignalFilter(buy, 103, '5', '0_5'), 'passing the gap does not excuse the age');

console.log('signals.ts ok —', JSON.stringify(signal));
