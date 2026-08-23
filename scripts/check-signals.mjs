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
const { hma, atr, latestSignal, signalGapPct, matchesSignalFilter, cleanBars, stopDistancePct, runUtBot } =
  await import(
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


// --- bad ticks -------------------------------------------------------------
// A high three times the bar's own body is a Yahoo tick, not a range. Clamped
// to the body, so the ATR it feeds does not widen the trailing stop for the
// rest of the smoothing window.
const ticked = cleanBars([
  { date: '2026-01-01', open: 100, high: 105, low: 95, close: 102, volume: 1 },
  { date: '2026-01-02', open: 100, high: 400, low: 95, close: 101, volume: 1 },
  { date: '2026-01-03', open: 100, high: 105, low: 10, close: 101, volume: 1 },
  { date: '2026-01-04', open: 100, high: 99, low: 101, close: 103, volume: 1 },
  { date: '2026-01-05', open: null, high: null, low: null, close: 100, volume: 1 },
  { date: '2026-01-06', open: 100, high: 105, low: 95, close: null, volume: 1 },
]);
assert.equal(ticked.length, 4, 'bars with no usable high/low/close are dropped');
assert.equal(ticked[0].high, 105, 'an honest bar is left alone');
assert.equal(ticked[1].high, 101, 'a 4x high is clamped to the body');
assert.equal(ticked[2].low, 100, 'and a low a tenth of it, likewise');
assert.equal(ticked[3].high, 103, 'a high under the body is raised to it');
assert.equal(ticked[3].low, 100, 'and a low above the body lowered');

// The tick must not move the verdict: same series, one poisoned high.
const poisoned = v.map((b, i) => (i === 200 ? { ...b, high: b.close * 4 } : b));
assert.equal(latestSignal(poisoned).date, signal.date, 'a bad tick must not move the flip');

// --- the trailing stop -----------------------------------------------------
assert.ok(signal.stop > 0, 'a signal carries the level it flips back at');
assert.ok(signal.stop < v.at(-1).close, 'a long stop sits below the price');
assert.ok(stopDistancePct(signal, 1000) > 0, 'room above the stop is positive on a BUY');
assert.ok(stopDistancePct(signal, signal.stop * 0.9) < 0, 'and negative once price is through it');
// Signed by side, not by direction: a SELL is safe while price is *below*.
const sell = { ...signal, side: 'SELL', stop: 100 };
assert.ok(stopDistancePct(sell, 90) > 0, 'a SELL has room while price is under its stop');
assert.ok(stopDistancePct(sell, 110) < 0);
assert.equal(stopDistancePct(signal, null), null, 'an unpriced row has no distance');

// --- context ---------------------------------------------------------------
// The V recovers above its own 200-day average, so the BUY fires with the trend.
assert.equal(signal.trend, 1, 'a BUY in an uptrend agrees with it');
assert.equal(latestSignal(peak).trend, 1, 'as does a SELL in a downtrend');
assert.ok(signal.score >= 0 && signal.score <= 100, 'the score is a percentage');
assert.equal(typeof signal.provisional, 'boolean');
// Every bar has volume 1, so the flip bar traded exactly its own average.
assert.ok(Math.abs(signal.volumeRatio - 1) < 1e-9);
// Turnover is close x volume, medianed: 1 share a day is not tradeable, and
// the score has to say so.
assert.ok(signal.turnover < 2_500_000);
assert.ok(signal.score < 60, `an untradeable name cannot score well: ${signal.score}`);

// A saw-tooth flips repeatedly, which is the only way a hit rate exists at all.
const saw = Array.from({ length: 420 }, (_, i) =>
  bar(i, 500 + 120 * Math.sin((i / 35) * Math.PI)),
);
const sawSignal = latestSignal(saw);
assert.ok(sawSignal.history, 'repeated flips give the rule a track record here');
assert.ok(sawSignal.history.trades >= 3, 'under three round trips it stays null');
assert.ok(
  sawSignal.history.wins >= 0 && sawSignal.history.wins <= sawSignal.history.trades,
  'wins cannot exceed trades',
);
// Round trips are flip-to-flip, and the open one is not counted.
assert.equal(sawSignal.history.trades, runUtBot(saw).flips.length - 1);

// --- the score filter ------------------------------------------------------
const strong = { ...buy, score: 80 };
const weak = { ...buy, score: 30 };
assert.ok(matchesSignalFilter(strong, 110, { side: 'ALL', age: 'ALL', gap: 'ALL', score: '75' }));
assert.ok(!matchesSignalFilter(weak, 110, { side: 'ALL', age: 'ALL', gap: 'ALL', score: '60' }));
assert.ok(matchesSignalFilter(weak, 110, { side: 'ALL', age: 'ALL', gap: 'ALL', score: 'ALL' }));
// An omitted score slot is 'ALL' — older callers must keep working.
assert.ok(matchesSignalFilter(weak, 110, { side: 'ALL', age: 'ALL', gap: 'ALL' }));
assert.ok(!matchesSignalFilter(null, 110, { side: 'ALL', age: 'ALL', gap: 'ALL', score: '60' }));


// --- technicals: the ten-year window --------------------------------------
const bundle = async (entry) =>
  import(
    'data:text/javascript;base64,' +
      Buffer.from(
        (
          await build({
            entryPoints: [entry],
            bundle: true,
            format: 'esm',
            platform: 'node',
            write: false,
          })
        ).outputFiles[0].text,
      ).toString('base64')
  );

const { computeTechnicals, computeCoarseTechnicals, collapseMonths, rsi } =
  await bundle('src/lib/technicals.ts');

/** Monthly bars from `yyyy-mm` for `count` months, closing at `close`. */
const months = (from, count, close = 100) =>
  Array.from({ length: count }, (_, i) => {
    const [y, m] = from.split('-').map(Number);
    const month = m - 1 + i;
    const date = `${y + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-01`;
    return { date, open: close, high: close * 1.1, low: close * 0.9, close, volume: 1 };
  });

// Yahoo returns the same window for every long-listed symbol: 2016-09 to
// 2026-08, 120 months. That is a complete decade and carries a ten-year high.
const full = months('2016-09', 120);
assert.ok(computeTechnicals(full).high10y > 0, '120 months of history has a ten-year high');
assert.equal(computeCoarseTechnicals(full).decade, true);

// One month short of the window is a listing inside it, and has none.
assert.equal(computeTechnicals(months('2016-10', 119)).high10y, null, '119 months does not');
assert.equal(computeCoarseTechnicals(months('2016-10', 119)).decade, false);

// The edge the year-count proxy got wrong: first traded October 2016, so it
// touches eleven distinct calendar years while being under ten years old.
const octoberIpo = months('2016-10', 119);
assert.equal(new Set(octoberIpo.map((b) => b.date.slice(0, 4))).size, 11, 'eleven calendar years');
assert.equal(computeCoarseTechnicals(octoberIpo).decade, false, 'and still not a decade');

// A recent listing is nowhere near, and is unjudged rather than measured
// against its own short history.
assert.equal(computeTechnicals(months('2023-03', 43)).high10y, null);
assert.equal(computeCoarseTechnicals(months('2023-03', 43)).decade, false);

// Yahoo reports the current month twice; the pair is one month, not two.
const dupe = [...months('2016-09', 120), { ...months('2026-08', 1)[0], date: '2026-08-21' }];
assert.equal(collapseMonths(dupe).length, 120, 'the trailing live bar folds into its month');
assert.equal(computeCoarseTechnicals(dupe).density, 1, 'and does not inflate the density');
assert.ok(Math.abs(rsi(new Array(40).fill(0).map((_, i) => 100 + i)) - 100) < 1e-9);

// --- screener.in: consolidated, or standalone when it is a rendered blank ---
const { fetchScreenerPage, screenerPaths, parseTopRatios } = await bundle('src/lib/fundamentals.ts');

const page = (ratios) =>
  `<ul id="top-ratios">${Object.entries(ratios)
    .map(
      ([name, value]) =>
        // A blank is an *empty* number span, which is what screener.in
        // actually serves — not a missing one.
        `<li><span class="name">${name}</span><span class="value">` +
        `<span class="number">${value ?? ''}</span></span></li>`,
    )
    .join('')}</ul>`;

// Exactly the shape screener.in serves for a company with no consolidated
// statements: 200, the strip rendered, every value empty.
const BLANK = page({ 'Market Cap': null, ROCE: null });
const REAL = page({ 'Market Cap': '6,134', ROCE: '27.2' });

assert.equal(parseTopRatios(BLANK).get('ROCE').length, 0, 'a blank strip parses to no numbers');
assert.deepEqual(parseTopRatios(REAL).get('Market Cap'), [6134], 'and commas do not split a figure');

const company = (symbol, exchanges = ['NSE'], bseCode = null) => ({ symbol, bseCode, exchanges });

assert.deepEqual(screenerPaths(company('ANYCO')), [
  '/api/screener/company/ANYCO/consolidated/',
  '/api/screener/company/ANYCO/',
]);
assert.ok(
  screenerPaths(company('X', ['BSE'], '500325'))[0].includes('/500325/'),
  'BSE-only rows are keyed by scrip code',
);
assert.deepEqual(screenerPaths(company('X', ['BSE'])), [], 'and are unaskable without one');
assert.ok(
  screenerPaths(company('ARE&M'))[0].includes('ARE%26M'),
  'an ampersand in a symbol survives the query',
);

/** Serves canned HTML per path and records what was asked for. */
function stubFetch(bodies) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    const body = bodies[url];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return asked;
}

/**
 * Which page answers is a property of the *response*, never of the company.
 *
 * So the four cases are replayed for unrelated symbols — an NSE ticker, one
 * with an ampersand in it, a BSE-only scrip code — and the paths come out of
 * `screenerPaths` rather than being written down. Nothing in here can quietly
 * become true of one ticker only, which is the whole point: the blank
 * consolidated page is what every company with no subsidiaries is served, and
 * there are hundreds of them.
 */
for (const target of [company('ANYCO'), company('ARE&M'), company('X', ['BSE'], '500325')]) {
  const [consolidated, standalone] = screenerPaths(target);
  const where = target.symbol;

  // Blank consolidated → ask again, and answer from the standalone page.
  let asked = stubFetch({ [consolidated]: BLANK, [standalone]: REAL });
  let got = await fetchScreenerPage(target);
  assert.equal(asked.length, 2, `${where}: a blank consolidated page is not the answer`);
  assert.equal(got.path, standalone, `${where}: the standalone page is`);
  assert.deepEqual(got.ratios.get('ROCE'), [27.2], `${where}: with its figures`);

  // The common case still costs one request — consolidated is the better page
  // wherever it has figures, and is not second-guessed.
  asked = stubFetch({ [consolidated]: REAL, [standalone]: BLANK });
  got = await fetchScreenerPage(target);
  assert.equal(asked.length, 1, `${where}: a consolidated page with figures ends it`);
  assert.equal(got.path, consolidated);

  // A company screener.in does not carry 404s both ways: one request, no page.
  asked = stubFetch({});
  assert.equal(await fetchScreenerPage(target), null, `${where}: a 404 is a real answer`);
  assert.equal(asked.length, 1, `${where}: and is not asked twice`);

  // Blank both ways is still returned — a missing ratio reads as unknown, and
  // the drawer has a page to show and link to.
  asked = stubFetch({ [consolidated]: BLANK, [standalone]: BLANK });
  got = await fetchScreenerPage(target);
  assert.equal(asked.length, 2, `${where}: both variants tried`);
  assert.equal(got.ratios.get('ROCE').length, 0, `${where}: with nothing on it`);
}


// --- the watchlists --------------------------------------------------------
// It is the one thing here the user typed in, so the store is checked against a
// real storage implementation rather than a mock of one.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// A data-URL module is cached by its own text, so a second `bundle` of the same
// file is the *same* module instance — no use for checking that the lists are
// read back on a fresh load. A nonce makes each one a genuinely new page.
let nonce = 0;
const reload = async () => {
  const out = await build({
    entryPoints: ['src/lib/watchlist.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    // The database mirror stays out of this. Left external, its dynamic import
    // cannot resolve from a data: URL and rejects — which is the same path a
    // browser takes when Supabase is unconfigured or offline, so the store is
    // checked in exactly the state it has to survive.
    external: ['./watchlistSync'],
  });
  const text = `${out.outputFiles[0].text}\n//${nonce++}`;
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
};

const wl = await reload();

// One list to begin with, and the star writes to it.
assert.equal(wl.watchlistSnapshot().lists.length, 1, 'there is always a list to star into');
assert.equal(wl.isWatched('TCS'), false);
assert.equal(wl.toggleWatch('TCS'), true, 'starring returns the new state');
assert.equal(wl.isWatched('TCS'), true);
assert.equal(wl.toggleWatch('TCS'), false, 'and unstarring returns it too');

// Newest first — the row you just starred is the one you were looking at.
wl.toggleWatch('INFY');
wl.toggleWatch('WIPRO');
assert.deepEqual(wl.activeList().symbols, ['WIPRO', 'INFY']);

// The snapshot must be referentially stable between changes, or
// `useSyncExternalStore` re-renders forever.
const before = wl.watchlistSnapshot();
assert.equal(wl.watchlistSnapshot(), before, 'an unchanged store is the same object');
wl.toggleWatch('LT');
assert.notEqual(wl.watchlistSnapshot(), before, 'a changed one is not');

// A second list is separate, active, and empty — you make one in order to fill
// it, so creating it selects it.
const second = wl.createList('Momentum');
assert.equal(wl.watchlistSnapshot().activeId, second, 'a new list is the active one');
assert.deepEqual(wl.activeList().symbols, [], 'and starts empty');
assert.equal(wl.isWatched('INFY'), false, 'a symbol in another list is not starred here');

wl.toggleWatch('SUZLON');
assert.deepEqual(wl.activeList().symbols, ['SUZLON']);
const [first] = wl.watchlistSnapshot().lists;
assert.deepEqual(first.symbols, ['LT', 'WIPRO', 'INFY'], 'and the other list is untouched');

// The same symbol can sit in two lists; they are independent.
wl.toggleWatch('INFY');
assert.equal(wl.isWatched('INFY'), true);
wl.setActiveList(first.id);
assert.equal(wl.isWatched('INFY'), true, 'still in the first list too');
wl.toggleWatch('INFY');
assert.equal(wl.isWatched('INFY'), false);
wl.setActiveList(second);
assert.equal(wl.isWatched('INFY'), true, 'removing it from one leaves the other alone');

// --- membership: a symbol lives in as many lists as you tick ---------------
// What the star's fill means, and what the picker ticks.
assert.equal(wl.isWatchedAnywhere('INFY'), true, 'in one list is starred');
assert.deepEqual(wl.listsWith('INFY'), [second], 'and the picker knows which');

wl.toggleInList(first.id, 'INFY');
assert.deepEqual(
  wl.listsWith('INFY').sort(),
  [first.id, second].sort(),
  'the same symbol can sit in two lists at once',
);
assert.equal(wl.isWatchedAnywhere('INFY'), true);

// Unticking one leaves the other — the whole point of asking which list.
wl.toggleInList(first.id, 'INFY');
assert.deepEqual(wl.listsWith('INFY'), [second]);
assert.equal(wl.isWatchedAnywhere('INFY'), true, 'still saved somewhere');

// Unticking the last one empties the star.
wl.toggleInList(second, 'INFY');
assert.deepEqual(wl.listsWith('INFY'), []);
assert.equal(wl.isWatchedAnywhere('INFY'), false);

// A list that no longer exists is not a crash, and not a silent write either.
assert.equal(wl.toggleInList('gone', 'INFY'), false);
assert.equal(wl.isWatchedAnywhere('INFY'), false);

// The `w` shortcut still writes to the list the section is showing.
wl.toggleInList(second, 'INFY');
assert.equal(wl.watchlistSnapshot().activeId, second);
assert.equal(wl.toggleWatch('ONGC'), true, 'toggleWatch targets the active list');
assert.deepEqual(wl.listsWith('ONGC'), [second]);

// Names are trimmed, capped and never blank — a nameless tab cannot be clicked.
wl.renameList(second, '   ');
assert.equal(wl.watchlistSnapshot().lists.find((l) => l.id === second).name, 'Momentum');
wl.renameList(second, '  Breakouts  ');
assert.equal(wl.watchlistSnapshot().lists.find((l) => l.id === second).name, 'Breakouts');
const longId = wl.createList('x'.repeat(80));
assert.equal(
  wl.watchlistSnapshot().lists.find((l) => l.id === longId).name.length,
  40,
  'a pasted essay is cut to a tab-sized name',
);

// Deleting the active list must leave *some* list active, or every star after
// it writes into nothing.
const doomed = wl.watchlistSnapshot().activeId;
wl.deleteList(doomed);
assert.ok(
  wl.watchlistSnapshot().lists.some((l) => l.id === wl.watchlistSnapshot().activeId),
  'the active id always names a list that exists',
);
assert.ok(!wl.watchlistSnapshot().lists.some((l) => l.id === doomed));

// Emptying keeps the list; deleting the last one empties it rather than
// leaving a state with no way out.
wl.setActiveList(first.id);
assert.ok(wl.activeList().symbols.length > 0);
wl.clearList(first.id);
assert.deepEqual(wl.activeList().symbols, [], 'emptied');
assert.ok(wl.watchlistSnapshot().lists.some((l) => l.id === first.id), 'but still there');

while (wl.watchlistSnapshot().lists.length > 1) {
  wl.deleteList(wl.watchlistSnapshot().lists.at(-1).id);
}
wl.toggleWatch('ONGC');
wl.deleteList(wl.watchlistSnapshot().activeId);
assert.equal(wl.watchlistSnapshot().lists.length, 1, 'the last list survives being deleted');
assert.deepEqual(wl.activeList().symbols, [], 'emptied instead');

// Every change must reach every subscriber — the row, the drawer, the tabs.
let calls = 0;
const stop = wl.subscribeWatchlist(() => calls++);
wl.toggleWatch('LT');
assert.equal(calls, 1, 'subscribers hear about a change');
stop();
wl.toggleWatch('LT');
assert.equal(calls, 1, 'and stop hearing once they unsubscribe');

// --- what is in storage, and what comes back out ---------------------------
// The single unnamed array the first version wrote must become a named list,
// not a fresh start: losing someone's stars to a refactor is not a migration.
store.set('fivealpha:watchlist', JSON.stringify(['TCS', 'INFY', 7, null, '']));
let migrated = await reload();
assert.deepEqual(migrated.activeList().symbols, ['TCS', 'INFY'], 'the old list is carried over');
assert.equal(migrated.watchlistSnapshot().lists.length, 1);
assert.equal(migrated.isWatched('TCS'), true);

// A real save round-trips.
migrated.createList('Long term');
migrated.toggleWatch('HDFCBANK');
const reopened = await reload();
assert.equal(reopened.watchlistSnapshot().lists.length, 2, 'both lists come back');
assert.equal(reopened.activeList().name, 'Long term', 'and the same one is active');
assert.equal(reopened.isWatched('HDFCBANK'), true);

// Junk starts empty rather than throwing the table down with it.
for (const junk of ['{not json', '{"lists":"nope"}', '{}', 'null', '[]']) {
  store.set('fivealpha:watchlist', junk);
  const recovered = await reload();
  assert.equal(recovered.watchlistSnapshot().lists.length, 1, `one list from ${junk}`);
  assert.deepEqual(recovered.activeList().symbols, [], `and no symbols from ${junk}`);
}

// An active id naming a list that is gone would leave every star writing into
// nothing, so it falls back to the first list rather than being trusted.
store.set(
  'fivealpha:watchlist',
  JSON.stringify({ activeId: 'vanished', lists: [{ id: 'a', name: 'A', symbols: ['TCS'] }] }),
);
const repaired = await reload();
assert.equal(repaired.watchlistSnapshot().activeId, 'a');
assert.equal(repaired.isWatched('TCS'), true);

// --- CSV out ---------------------------------------------------------------
const { toCsv, parseCsv } = await bundle('src/lib/csv.ts');

// The three characters that need quoting are exactly the ones the reader in the
// same file cares about, so a round trip is the test.
const headers = ['Symbol', 'Company', 'LTP'];
const body = [
  ['TCS', 'Tata Consultancy', 3200.5],
  ['X', 'Comma, Inc', null],
  ['Y', 'A "quoted" name', undefined],
  ['Z', 'Two\nlines', 0],
];
const csv = toCsv(headers, body);
assert.deepEqual(parseCsv(csv), [
  headers,
  ['TCS', 'Tata Consultancy', '3200.5'],
  ['X', 'Comma, Inc', ''],
  ['Y', 'A "quoted" name', ''],
  ['Z', 'Two\nlines', '0'],
], 'what is written parses back to what went in');

// Quoting only where it is needed — an export of 2,400 rows should not double
// in size for nothing.
assert.ok(csv.startsWith('Symbol,Company,LTP\r\n'), 'plain fields stay bare');
assert.ok(csv.includes('"Comma, Inc"'), 'and only the ones that must are quoted');
assert.equal(toCsv(['a'], [[null]]), 'a\r\n', 'an empty value is an empty field, not "null"');


// --- where the star's menu opens -------------------------------------------
// The bug this exists to catch was invisible in a build and obvious on a phone:
// a menu that opened three hundred pixels above the star that summoned it.
const { placeMenu, menuHeight } = await bundle('src/components/PopMenu.tsx');

/** What the star's picker asks for: one row per list, plus its own chrome. */
const picker = (lists) => menuHeight(lists, 92);
const W = 268;

/** A star of the size the table renders, at a given point. */
const starAt = (left, top) => ({ left, top, right: left + 24, bottom: top + 24 });
const phone = { width: 420, height: 700 };

// The reported case: one list, a row two thirds down a phone screen. 138px of
// menu against 186px of room below it — it opens *downwards*, under the star.
const low = placeMenu(starAt(28, 490), phone, picker(1), W);
assert.ok(low.top > 490, `must open below the star, opened at ${low.top}`);
assert.ok(low.top - 514 < 12, 'and right under it, not floating');

// Same star, twenty lists: now it genuinely does not fit below, so it flips —
// and its bottom edge still sits just above the star rather than anywhere else.
const many = placeMenu(starAt(28, 490), phone, picker(20), W);
assert.ok(many.top < 490, 'a menu too tall for the space below opens upward');
assert.equal(many.top + many.maxHeight + 6, 490, 'with its foot at the star');

// A star near the top has no room above, so a tall menu goes below and scrolls.
const top = placeMenu(starAt(28, 40), phone, picker(20), W);
assert.ok(top.top > 40, 'nothing opens off the top of the screen');
assert.ok(top.top + top.maxHeight <= phone.height, 'nor off the bottom');

// Height follows content, never the cap: two lists is not a 340px menu.
const two = placeMenu(starAt(28, 100), phone, picker(2), W);
assert.ok(two.maxHeight < 200, `two lists should not reserve ${two.maxHeight}px`);
assert.ok(placeMenu(starAt(28, 100), phone, picker(20), W).maxHeight > two.maxHeight, 'more lists, more menu');

// Whichever side wins, it stays on screen — checked over every position a star
// can occupy, at both extremes of list count.
for (let y = 0; y <= phone.height - 24; y += 10) {
  for (const n of [0, 1, 3, 20]) {
    const at = placeMenu(starAt(28, y), phone, picker(n), W);
    assert.ok(at.top >= 8, `y=${y} n=${n}: opened above the viewport (${at.top})`);
    assert.ok(
      at.top + at.maxHeight <= phone.height,
      `y=${y} n=${n}: ran off the bottom (${at.top + at.maxHeight})`,
    );
  }
}

// The bar's own actions menu shares this placement, and it is the one that made
// the case for sharing it: hand-positioned `right: 0`, it opened off the *left*
// edge of a phone. Anchored to a trigger at the right of a narrow bar, it now
// stays on screen.
const dots = placeMenu(starAt(390, 40), phone, menuHeight(3, 48), 236);
assert.ok(dots.left >= 8, `opened off the left edge at ${dots.left}`);
assert.ok(dots.left + 236 <= phone.width, 'and not off the right');
assert.ok(dots.top > 64, 'below its trigger, which has the room');

// Horizontally the same: a star in the last column must not open off the edge.
assert.equal(placeMenu(starAt(410, 100), phone, picker(3), W).left, phone.width - W - 8);
assert.equal(placeMenu(starAt(2, 100), phone, picker(3), W).left, 8, 'nor off the left');
assert.equal(placeMenu(starAt(200, 100), { width: 1600, height: 900 }, picker(3), W).left, 192, 'aligned to the star when there is room');

console.log('signals · filters · technicals · fundamentals · watchlist · csv · picker ok');
