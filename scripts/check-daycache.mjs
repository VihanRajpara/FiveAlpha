// Self-check for src/lib/dayCache.ts — `node scripts/check-daycache.mjs`.
//
// One question: does an entry expire in a tab that is already open? The store
// is read by a screen people leave running for days, and IST midnight is the
// one moment its answers are guaranteed to be wrong. Expiry used to be applied
// only when the store was first loaded, so that tab served yesterday's signals
// until someone reloaded it.
//
// Bundled through esbuild (already a vite dependency) because Node 18 cannot
// import TypeScript — same device as scripts/check-signals.mjs.
import { build } from 'esbuild';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// A browser, roughly.
// ---------------------------------------------------------------------------

// Must be installed before the module is imported: dayCache builds its
// Intl.DateTimeFormat at module scope.
let NOW = Date.parse('2026-09-03T10:00:00+05:30');

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    // `new Date()` follows the fake clock; every other form is left alone, or
    // the ISO parsing inside dayCache would break.
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return NOW;
  }
};
globalThis.Date.parse = RealDate.parse;
globalThis.Date.UTC = RealDate.UTC;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// `window`/`document` stay undefined — dayCache guards on them, and that guard
// is what keeps this file from needing a DOM.

const out = await build({
  entryPoints: ['src/lib/dayCache.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { dayCache } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

const identity = { encode: (v) => v, decode: (r) => r };

// ---------------------------------------------------------------------------
// The point of the file.
// ---------------------------------------------------------------------------

const cache = dayCache('selftest', identity, 1);
cache.set('RELIANCE', 1234);

assert.equal(cache.get('RELIANCE'), 1234, 'a value written today reads back');
assert.equal(cache.has('RELIANCE'), true, 'and `has` agrees with `get`');

// Same tab, same Map, no reload — only the clock moves, and only by 20 minutes.
NOW = Date.parse('2026-09-04T00:20:00+05:30');

assert.equal(cache.get('RELIANCE'), undefined, 'IST midnight expires it without a reload');
assert.equal(cache.has('RELIANCE'), false, '`has` must not disagree with `get`');

// A shorter hop that does not cross the boundary must NOT expire anything —
// otherwise "expires daily" quietly becomes "expires after some hours".
const evening = dayCache('selftest-evening', identity, 1);
NOW = Date.parse('2026-09-04T09:00:00+05:30');
evening.set('TCS', 7);
NOW = Date.parse('2026-09-04T23:59:00+05:30');
assert.equal(evening.get('TCS'), 7, '14 hours later, same IST day: still live');

// maxAgeDays is honoured, not hardcoded to one. Fundamentals keep 30 days and
// unknown-tickers 7; collapsing those to a day would re-scrape the universe
// every morning.
const week = dayCache('selftest-week', identity, 7);
NOW = Date.parse('2026-09-04T10:00:00+05:30');
week.set('INFY', 'x');
NOW = Date.parse('2026-09-09T10:00:00+05:30');
assert.equal(week.get('INFY'), 'x', 'five days into a seven-day window: still live');
NOW = Date.parse('2026-09-11T10:00:00+05:30');
assert.equal(week.get('INFY'), undefined, 'seven days out: expired');

// An expired entry is dropped, not merely hidden — a tab open for a week must
// not flush a store full of dead weight into a 5 MB quota.
week.flush();
const written = JSON.parse(store.get('fivealpha:selftest-week:v4') ?? '{"entries":{}}');
assert.equal(
  Object.keys(written.entries).length,
  0,
  'the flushed store must not still contain the expired entry',
);

console.log('check-daycache: all assertions passed');
