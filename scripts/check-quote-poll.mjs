// Self-check for the incremental quote poll — `node scripts/check-quote-poll.mjs`.
//
// The poll reads only the five columns that a price write can change, and the
// merge in useMarketData spreads the result over the quote already on screen.
// That is what keeps a one-minute poll cheap, and it rests on one property that
// is invisible at the call site:
//
//   **A delta quote must not carry the metric keys at all.**
//
// `marketCapCr`, `monthlyRsi14` and `rocePct` are optional on `Quote`. Absent,
// a spread leaves the value that came from the full page load intact. Set to
// `null` — which is what `toQuote` does, and what anyone "tidying up" this code
// would naturally reach for — the spread erases market cap and ROCE from every
// row, once a minute, silently. The screens then fail their fundamental legs on
// the whole universe and the table shows dashes where figures were.
//
// Nothing in the type system prevents that: `marketCapCr?: number | null`
// accepts null happily. So it is asserted here instead.
//
// The function is lifted out of the shipped source rather than copied, on the
// same reasoning as scripts/check-metrics.mjs — a copy would drift.
import { transform } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = 'src/lib/supabaseSource.ts';

const src = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function toDeltaQuote(');
assert.notEqual(start, -1, `toDeltaQuote not found in ${SOURCE} — renamed?`);
const end = src.indexOf('\n}\n', start) + 3;
assert.ok(end > start, 'could not find the end of toDeltaQuote');

const { code } = await transform('export ' + src.slice(start, end), {
  loader: 'ts',
  format: 'esm',
});
const { toDeltaQuote } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);

const row = {
  symbol: 'RELIANCE',
  price: 1500,
  previous_close: 1400,
  price_time: '2026-09-04T10:25:03.272+05:30',
  updated_at: '2026-09-04T10:25:04.000+05:30',
};

// --- the property the whole design rests on --------------------------------

const delta = toDeltaQuote(row);

for (const key of ['marketCapCr', 'monthlyRsi14', 'rocePct', 'fundamentalsUrl']) {
  assert.equal(
    key in delta,
    false,
    `a delta must not carry \`${key}\` — even as null, a spread would erase it`,
  );
}

// The merge exactly as useMarketData performs it.
const held = {
  symbol: 'RELIANCE',
  price: 1400,
  previousClose: 1400,
  change: 0,
  changePercent: 0,
  updatedAt: '2026-09-04T09:20:00.000+05:30',
  marketCapCr: 1_777_024,
  monthlyRsi14: 61.2,
  rocePct: 10.39,
};
const merged = { ...held, ...delta };

assert.equal(merged.marketCapCr, 1_777_024, 'market cap survives a price poll');
assert.equal(merged.monthlyRsi14, 61.2, 'so does RSI');
assert.equal(merged.rocePct, 10.39, 'so does ROCE');
assert.equal(merged.price, 1500, 'and the price is the new one');
assert.equal(merged.updatedAt, row.price_time, 'stamped with the vendor print time');

// --- the price arithmetic --------------------------------------------------

assert.equal(delta.change, 100, 'change is price - previous close');
assert.ok(Math.abs(delta.changePercent - 7.142857) < 1e-6, 'and the percent of it');

// A missing figure is unknown, not zero — the same trap check-metrics guards on
// the ratio parse. A row with no price must not read as "unchanged".
assert.equal(toDeltaQuote({ ...row, price: null }).change, null, 'no price, no change');
assert.equal(
  toDeltaQuote({ ...row, previous_close: null }).change,
  null,
  'no previous close, no change',
);

// Dividing by a zero previous close would be Infinity, which formats as a real
// number on screen and sorts above every genuine mover.
assert.equal(
  toDeltaQuote({ ...row, previous_close: 0 }).changePercent,
  null,
  'a zero previous close yields no percentage, not Infinity',
);

// `price_time` is the vendor's print time and wins; `updated_at` is when the
// row was written and is only the fallback. Stamping a row with the write time
// would claim a stale price printed just now.
assert.equal(
  toDeltaQuote({ ...row, price_time: null }).updatedAt,
  row.updated_at,
  'falls back to the write time only when there is no print time',
);

console.log('check-quote-poll: all assertions passed');
