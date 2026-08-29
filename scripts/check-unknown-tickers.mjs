// Self-check for the unknown-ticker registry in src/lib/yahooCandles.ts —
// `node scripts/check-unknown-tickers.mjs`. The point of the registry is that a
// symbol Yahoo has denied knowing is never asked about again, so what is
// asserted is the *requests*: a stub fetch records every URL it is handed.
import { build } from 'esbuild';
import assert from 'node:assert/strict';

// The module reads localStorage on first use and registers pagehide handlers if
// a window exists. Neither is present in Node; the store then lives in memory,
// which is exactly the behaviour under test.
const calls = [];
globalThis.localStorage = undefined;
globalThis.fetch = async (url) => {
  calls.push(url);
  if (url.includes('DEAD')) return new Response('', { status: 404 });
  if (url.includes('spark')) {
    // LIVE answers, GHOST is silently dropped — Yahoo's shape for a symbol it
    // does not carry inside a batch it partly recognises.
    return Response.json({ 'LIVE.NS': { timestamp: [1_700_000_000], close: [10] } });
  }
  return Response.json({
    chart: { result: [{ timestamp: [1_700_000_000], indicators: { quote: [{ close: [10] }] } }] },
  });
};

const out = await build({
  entryPoints: ['src/lib/yahooCandles.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { fetchYahooBars, fetchYahooSparkBars, isUnknownTicker } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

// --- a 404 on the chart endpoint is remembered ----------------------------
await assert.rejects(fetchYahooBars('DEAD.NS', '1y', '1d'), /404/);
assert.equal(calls.length, 1, 'the first ask costs a request');
assert.ok(isUnknownTicker('DEAD.NS'), 'a 404 marks the ticker unknown');

await assert.rejects(fetchYahooBars('DEAD.NS', '1y', '1d'), /no symbol/);
assert.equal(calls.length, 1, 'the second ask costs nothing');

// A live ticker is untouched by any of it.
assert.equal((await fetchYahooBars('LIVE.NS', '1y', '1d')).length, 1);
assert.equal(calls.length, 2);
assert.equal(isUnknownTicker('LIVE.NS'), false);

// --- a symbol missing from a spark response is remembered too -------------
calls.length = 0;
const bars = await fetchYahooSparkBars(['LIVE.NS', 'GHOST.NS'], '10y', '1mo');
assert.equal(bars.size, 1, 'only the symbol Yahoo answered for comes back');
assert.ok(isUnknownTicker('GHOST.NS'), 'the dropped symbol is marked unknown');

// The known-dead ones are filtered out of the next batch rather than taking a
// slot in it, and a batch of nothing else never leaves the browser.
await fetchYahooSparkBars(['GHOST.NS', 'DEAD.NS'], '10y', '1mo');
assert.equal(calls.length, 1, 'an all-dead batch costs no request at all');

assert.ok((await fetchYahooSparkBars(['LIVE.NS', 'GHOST.NS'], '10y', '1mo')).has('LIVE.NS'));
assert.equal(calls.length, 2);
assert.ok(!calls[1].includes('GHOST'), 'the dead symbol is not in the query string');

console.log('unknown-ticker registry: ok');
