// Self-check for the precomputed-metrics path — `node scripts/check-metrics.mjs`.
//
// Three things here can be wrong without anything failing loudly, which is why
// they are the ones checked:
//
//   1. The Edge Function's Wilder RSI must agree with the browser's. They are
//      two transcriptions of the same formula in two runtimes, and a drift
//      between them puts a row above a screen's threshold in the stored column
//      and below it in the live verdict — a disagreement on the same screen.
//   2. The month collapse. Yahoo reports the current month twice, and failing
//      to fold the pair is an extra delta the RSI cannot tell from a real
//      month's move. It was worth several points on real symbols.
//   3. The screener.in ratio parse must read an empty `<span class="number">`
//      as *unknown*, never as zero — `Number('')` is 0, and that reads as a
//      definite ROCE failure rather than a missing figure.
//
// Bundled through esbuild (already a vite dependency) because Node 18 cannot
// import TypeScript.
import { build, transform } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (code) =>
  import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const bundle = async (entry) => {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  return load(out.outputFiles[0].text);
};

/**
 * One top-level `function name(` … `\n}` block, lifted out of a Deno module and
 * stripped of its types.
 *
 * The Edge Functions cannot be bundled here: they import `https://esm.sh/...`
 * URLs that Node will not resolve. Extracting the one function under test keeps
 * the check honest — it runs the *shipped* source rather than a copy of it that
 * could drift — without dragging the Deno runtime in behind it.
 */
async function liftFunction(path, signature, name, prelude = '') {
  // Normalised first: this repo is mixed CRLF/LF, and matching the closing
  // brace on a bare `\n}` silently finds nothing in a CRLF file — which shows
  // up as a baffling "unexpected end of file" from the transform rather than as
  // a missing function.
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in ${path} — has it been renamed?`);
  const end = src.indexOf('\n}\n', start) + 3;
  assert.ok(end > start, `could not find the end of ${signature} in ${path}`);
  // `prelude` supplies the module-level constants the lifted body closes over.
  // A default parameter referring to one would otherwise throw on the first
  // call, and silently only for the callers that omit that argument.
  const ts = prelude + '\nexport ' + src.slice(start, end).replace(/^export /, '');
  const { code } = await transform(ts, { loader: 'ts', format: 'esm' });
  return (await load(code))[name];
}

const { rsi: clientRsi, collapseMonths } = await bundle('src/lib/technicals.ts');

const serverRsi = await liftFunction(
  'supabase/functions/_shared/yahoo.ts',
  'export function rsi(',
  'rsi',
  'const RSI_PERIOD = 14;',
);

// ---------------------------------------------------------------------------
// 1. The two implementations are the same function.
// ---------------------------------------------------------------------------

// A deterministic but not monotonic series — a ramp would hide any smoothing
// difference, because Wilder and a simple mean agree when nothing ever falls.
const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 12 + i * 0.4);

const mine = clientRsi(closes);
const theirs = serverRsi(closes);
assert.ok(mine !== null, 'client RSI should have a reading on 80 bars');
assert.ok(
  Math.abs(mine - theirs) < 1e-9,
  `server and client RSI must agree: ${theirs} vs ${mine}`,
);

// Wilder, not a simple average. A simple mean of gains/losses over the same
// series lands several points away, so this fails loudly if either side is
// swapped for the naive version.
assert.ok(mine > 0 && mine < 100, `RSI is a percentage: ${mine}`);

// Too short to seed: period + 2 bars is the documented floor.
assert.equal(clientRsi(closes.slice(0, 15)), null, 'RSI needs 16 bars');
assert.equal(serverRsi(closes.slice(0, 15)), null, 'and the server agrees');

// No down-closes at all saturates rather than dividing by zero — the exact
// shape of a share pinned at a new high, which is what the screens hunt.
const up = Array.from({ length: 30 }, (_, i) => 100 + i);
assert.equal(clientRsi(up), 100, 'a series that only rises reads 100');
assert.equal(serverRsi(up), 100, 'and the server agrees');

// ---------------------------------------------------------------------------
// 2. The current month, reported twice, is one bar.
// ---------------------------------------------------------------------------

// The server collapses inline in `fetchMonthlyCloses`; this is the same rule,
// stated the way that function applies it — last close seen per calendar month.
function collapseServerStyle(bars) {
  const months = [];
  const values = [];
  for (const { date, close } of bars) {
    const month = date.slice(0, 7);
    if (months.length > 0 && months[months.length - 1] === month) {
      values[values.length - 1] = close;
    } else {
      months.push(month);
      values.push(close);
    }
  }
  return values;
}

const raw = [
  { date: '2026-06-01', open: 1, high: 12, low: 9, close: 10, volume: 100 },
  { date: '2026-07-01', open: 1, high: 22, low: 9, close: 20, volume: 100 },
  // The duplicated current month: a stale monthly bar, then today's live price.
  { date: '2026-08-01', open: 1, high: 32, low: 9, close: 30, volume: 100 },
  { date: '2026-08-29', open: 1, high: 36, low: 9, close: 35, volume: 200 },
];

const collapsed = collapseMonths(raw);
assert.equal(collapsed.length, 3, 'the duplicated month collapses to one bar');
assert.equal(collapsed[2].close, 35, 'and keeps the later close');
assert.equal(collapsed[2].high, 36, 'and the higher high');

assert.deepEqual(
  collapseServerStyle(raw),
  collapsed.map((b) => b.close),
  'server and client must collapse to the same close series',
);

// ---------------------------------------------------------------------------
// 3. An empty ratio is unknown, not zero.
// ---------------------------------------------------------------------------

// Lifted from the Deno function for the same reason as the RSI above.
const parseTopRatios = await liftFunction(
  'supabase/functions/sync-fundamentals/index.ts',
  'function parseTopRatios(',
  'parseTopRatios',
);

const withFigures = `
  <ul id="top-ratios">
    <li><span class="name">Market Cap</span><span class="value">₹ <span class="number">1,800,557</span> Cr.</span></li>
    <li><span class="name">ROCE</span><span class="value"><span class="number">10.3</span> %</span></li>
  </ul>`;

const ratios = parseTopRatios(withFigures);
assert.equal(ratios.get('ROCE')[0], 10.3, 'ROCE parses');
assert.equal(ratios.get('Market Cap')[0], 1800557, 'and the comma-grouped market cap');

// The shape screener.in serves for a company with no consolidated statements:
// a 200, the strip fully rendered, every value empty. Read as zero this is a
// definite ROCE *fail*; read as absent it is correctly unknown.
const blank = `
  <ul id="top-ratios">
    <li><span class="name">Market Cap</span><span class="value">₹ <span class="number"></span> Cr.</span></li>
    <li><span class="name">ROCE</span><span class="value"><span class="number"></span> %</span></li>
  </ul>`;

const empty = parseTopRatios(blank);
assert.deepEqual(empty.get('ROCE'), [], 'an empty ratio yields no number at all');
assert.notEqual(empty.get('ROCE')?.[0], 0, 'and must never read as zero');

// ---------------------------------------------------------------------------
// 4. A dropped connection is retried; an answer and an abort are not.
//
// The retry in `fetchYahoo` has three branches and only one of them may fire.
// Retrying a 404 would double the cost of every dead ticker (the BSE list has
// hundreds), and retrying an abort would keep a request alive after the screen
// run that owns it was cancelled.
// ---------------------------------------------------------------------------

const { fetchYahooBars } = await bundle('src/lib/yahooCandles.ts');

const realFetch = globalThis.fetch;
const chart = (closes) =>
  new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            timestamp: closes.map((_, i) => 1_700_000_000 + i * 86_400),
            indicators: { quote: [{ close: closes, open: [], high: [], low: [], volume: [] }] },
          },
        ],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

// A socket hang up on the first attempt, an answer on the second.
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) throw new TypeError('fetch failed'); // what a hang up looks like
  return chart([101, 102, 103]);
};
const recovered = await fetchYahooBars('TCS.NS', '1y', '1d');
assert.equal(calls, 2, 'a dropped connection is retried exactly once');
assert.equal(recovered.length, 3, 'and the retry’s bars are returned');

// Two failures in a row give up rather than looping.
calls = 0;
globalThis.fetch = async () => {
  calls++;
  throw new TypeError('fetch failed');
};
await assert.rejects(() => fetchYahooBars('TCS.NS', '1y', '1d'), 'a second failure propagates');
assert.equal(calls, 2, 'and it is not retried more than once');

// A 404 is an answer about the symbol, not a failure to reach Yahoo.
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response('not found', { status: 404 });
};
await assert.rejects(() => fetchYahooBars('NOSUCH.BO', '1y', '1d'), 'a 404 still throws');
assert.equal(calls, 1, 'but is never retried — that would double every dead ticker');

// An abort must propagate untouched.
calls = 0;
const controller = new AbortController();
globalThis.fetch = async () => {
  calls++;
  controller.abort();
  throw new DOMException('Aborted', 'AbortError');
};
await assert.rejects(
  () => fetchYahooBars('TCS.NS', '1y', '1d', controller.signal),
  (err) => err.name === 'AbortError',
  'an abort propagates as an abort',
);
assert.equal(calls, 1, 'and a cancelled request is never retried');

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// 5. Delistings are removed; a truncated upstream is not mistaken for one.
//
// The only code in this project that deletes rows. The failure it guards
// against is silent — both exchanges answering 200 with a short body — so the
// guard is worth more than the feature.
// ---------------------------------------------------------------------------

const planDelistings = await liftFunction(
  'supabase/functions/sync-securities/index.ts',
  'export function planDelistings(',
  'planDelistings',
);

const universe = Array.from({ length: 5229 }, (_, i) => `SYM${i}`);

// The ordinary case: a handful of companies left the exchanges.
const afterDelisting = new Set(universe.slice(0, universe.length - 12));
const ordinary = planDelistings(universe, afterDelisting);
assert.equal(ordinary.skipped, null, 'a dozen delistings is a normal day');
assert.equal(ordinary.gone.length, 12, 'and all twelve are removed');

// Nothing changed — the overwhelmingly common case.
const quiet = planDelistings(universe, new Set(universe));
assert.deepEqual(quiet.gone, [], 'an unchanged list deletes nothing');
assert.equal(quiet.skipped, null);

// A truncated upstream: the exchanges "returned" only the first 2,000 symbols.
// Deleting on this would destroy 3,229 live companies and their quotes and
// metrics with them, silently, on a response that looked like a success.
const truncated = planDelistings(universe, new Set(universe.slice(0, 2000)));
assert.deepEqual(truncated.gone, [], 'a truncated list must delete NOTHING');
assert.match(truncated.skipped, /ceiling/, 'and must say why it refused');

// Right at the boundary: 5% of 5,229 is 261, so 261 deletes and 262 refuses.
assert.equal(
  planDelistings(universe, new Set(universe.slice(0, universe.length - 261))).gone.length,
  261,
  '261 is at the ceiling and still deletes',
);
assert.deepEqual(
  planDelistings(universe, new Set(universe.slice(0, universe.length - 262))).gone,
  [],
  'one over the ceiling refuses',
);

// The floor keeps a small table workable: 5% of 100 rows is 5, which would
// refuse an ordinary handful of delistings on a freshly seeded database.
const small = Array.from({ length: 100 }, (_, i) => `S${i}`);
assert.equal(
  planDelistings(small, new Set(small.slice(0, 70))).gone.length,
  30,
  'the floor of 50 keeps small tables from tripping the ceiling',
);

console.log('check-metrics: all assertions passed');
