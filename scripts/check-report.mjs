// Self-check for the watchlist report — `node scripts/check-report.mjs`.
//
// The report is one pass that produces fifteen numbers, and every one of them
// is stated as a fact at the top of a section people act on. Three ways it can
// be wrong and look right:
//
//   1. Averages over the wrong denominator. `avgChangePct` is the mean over
//      *priced* rows, not over the list — a watchlist with one unpriced name
//      would otherwise report a day move dragged toward zero by a row that has
//      no price at all.
//   2. Signal figures counting rows nobody has read. A reading arrives per
//      symbol over several seconds, so "4 buy / 1 sell" has to mean four of the
//      seven read, not four of the nine in the list.
//   3. The attention list listing a row twice, or under the wrong reason. A
//      crossed stop outranks a fresh flip outranks a screen match, a row that
//      qualifies several ways appears once under the worst of them, and the cap
//      keeps the *most* urgent rather than the first six seen.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript — same as scripts/check-chart.mjs.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMP = 'scripts/.check-report.bundle.mjs';
await build({
  entryPoints: ['src/lib/watchlistReport.ts'],
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
const { buildReport, groupLists, ATTENTION_MAX } = mod;

/** A row as the table holds one — only the fields the report reads. */
const row = (symbol, chg, price, capBand, fno = false) => ({
  symbol,
  ticker: `${symbol}.NS`,
  name: symbol,
  quote: chg === null ? undefined : { price, changePercent: chg },
  cls: { capBand, fno },
});

/** A UT Bot reading. `stop` is what decides "below stop", `age` what decides "fresh". */
const sig = (side, age, stop, score) => ({
  side,
  price: 100,
  date: '2026-09-01',
  age,
  stop,
  trend: 1,
  volumeRatio: null,
  turnover: null,
  history: null,
  provisional: false,
  score,
});

const rows = [
  row('A', 5, 100, 'large', true), //  fresh BUY, stop 5% below
  row('B', -4, 100, 'mid'), //         old BUY, price has crossed its stop
  row('C', 2, 50, 'small'), //         fresh SELL
  row('D', 1, 10, 'micro'), //         no flip in the window, stretched
  row('E', -1, 20, 'micro'), //        old BUY, washed out
  row('F', 0, 30, 'large', true), //   old BUY, and on the screen
  row('G', null, null, 'small'), //    no price, no reading
  row('H', 9, 200, 'mid'), //          priced, chart not read yet
  row('I', -0.5, 40, 'micro'), //      no flip, washed out
];

const readings = {
  'A.NS': { signal: sig('BUY', 1, 95, 80), mapo: { above: 50, proximity: 50 } },
  'B.NS': { signal: sig('BUY', 30, 105, 40), mapo: { above: 50, proximity: 50 } },
  'C.NS': { signal: sig('SELL', 2, 60, 70), mapo: { above: 50, proximity: 50 } },
  'D.NS': { signal: null, mapo: { above: 90, proximity: 50 } },
  'E.NS': { signal: sig('BUY', 40, 15, 60), mapo: { above: 10, proximity: 50 } },
  'F.NS': { signal: sig('BUY', 10, 28, 50), mapo: { above: 50, proximity: 50 } },
  'I.NS': { signal: null, mapo: { above: 5, proximity: 50 } },
};

const r = buildReport(rows, (ticker) => readings[ticker], new Set(['F']));

// --- 1. the day, over priced rows only --------------------------------------
assert.equal(r.count, 9);
assert.equal(r.priced, 8, 'G carries no quote and must not be counted as priced');
assert.deepEqual([r.up, r.down, r.flat], [4, 3, 1]);
// (5 − 4 + 2 + 1 − 1 + 0 + 9 − 0.5) / 8. Over 9 it would read 1.28.
assert.ok(
  Math.abs(r.avgChangePct - 1.4375) < 1e-9,
  `equal-weight mean over priced rows, got ${r.avgChangePct}`,
);

// --- 2. signal figures cover what has been read, not the list ----------------
assert.equal(r.read, 7, 'G and H have no reading yet');
assert.deepEqual([r.buy, r.sell, r.quiet], [4, 1, 2]);
assert.equal(r.fresh, 2, 'A and C flipped within five sessions');
assert.equal(r.belowStop, 1, 'only B has price through its stop');
assert.equal(r.avgScore, 60, 'mean over the five rows that have a signal');
assert.deepEqual([r.overbought, r.oversold], [1, 2]);
assert.equal(r.matches, 1);

// --- 3. movers, best first on both sides -------------------------------------
assert.deepEqual(
  r.gainers.map((x) => x.symbol),
  ['H', 'A', 'C'],
);
assert.deepEqual(
  r.losers.map((x) => x.symbol),
  ['B', 'E', 'I'],
  'losers lead with the worst, not with the nearest to zero',
);

// --- 4. attention: one row once, worst reason first, capped ------------------
assert.equal(r.attention.length, ATTENTION_MAX);
assert.deepEqual(
  r.attention.map((a) => [a.row.symbol, a.kind]),
  [
    ['B', 'stop'], //   money at risk now
    ['A', 'fresh'], //  two fresh flips, bigger mover first
    ['C', 'fresh'],
    ['F', 'screen'],
    ['D', 'hot'],
    ['E', 'cold'], //   I is also cold but moved less, so the cap drops it
  ],
);
assert.equal(
  new Set(r.attention.map((a) => a.row.symbol)).size,
  r.attention.length,
  'a row that qualifies several ways is listed once',
);
assert.equal(r.attention[1].side, 'BUY');
assert.equal(r.attention[2].side, 'SELL');

// --- 5. composition counts every row, read or not ----------------------------
assert.deepEqual(r.cap, { large: 2, mid: 2, small: 2, micro: 3 });
assert.equal(r.fno, 2);

// --- 6. an empty list is a report of nothing, not a crash --------------------
const empty = buildReport([], () => undefined, new Set());
assert.equal(empty.count, 0);
assert.equal(empty.avgChangePct, null);
assert.equal(empty.avgScore, null);
assert.deepEqual(empty.attention, []);

// --- 7. flattening every list: once for the roll-up, per list for the cards --
// The two halves of the page disagree on purpose, and both come from here.
const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
const g = groupLists(
  [
    { name: 'Core', symbols: ['A', 'B', 'C'] },
    { name: 'Swing', symbols: ['B', 'C', 'Z'] }, //   B and C filed twice, Z has no row
    { name: 'Empty', symbols: [] },
  ],
  bySymbol,
);
assert.equal(g.filed, 6, 'filings count a symbol once per list it is in');
assert.equal(g.held, 4, 'held counts A, B, C and Z once each');
assert.deepEqual(
  g.union.map((r) => r.symbol),
  ['A', 'B', 'C'],
  'the roll-up reads each symbol once, and cannot read one with no row',
);
assert.deepEqual(g.memberOf.get('B'), ['Core', 'Swing'], 'in list order');
assert.deepEqual(
  g.memberOf.get('Z'),
  ['Swing'],
  'a symbol the market has not loaded is still filed, and must not vanish',
);
assert.deepEqual(
  g.rowsOf.map((rs) => rs.map((r) => r.symbol)),
  [['A', 'B', 'C'], ['B', 'C'], []],
  'per-list rows keep the duplicates the roll-up drops',
);

const none = groupLists([], new Map());
assert.deepEqual([none.held, none.filed, none.union.length], [0, 0, 0]);

console.log('watchlist report ok');
