// Self-check for the master-list ingestion — `node scripts/check-listings.mjs`.
//
// The failure this guards against is the one that shipped: an entire NSE board
// silently missing. EQUITY_L.csv is the *main* board only, so every Emerge (SME)
// company — Emkay Tools, Emkay Taps and Cutting Tools, ~565 others — was absent
// from the app with nothing failing, because the fetch that omitted them
// succeeded.
//
// Two things have to hold for the Emerge list to survive the shared parser:
//
//   1. Its header is underscored (`NAME_OF_COMPANY`) where the main board's is
//      spaced, and it has no MARKET LOT column. If the rewrite regresses, every
//      SME row parses to an empty name and a null ISIN rather than throwing.
//   2. Its listing dates carry a two-digit year (`08-Jul-25`). The old
//      four-digit-only regex returned null for all of them, which reads in the
//      UI as "listing date unknown" rather than as a parse failure.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript.
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const out = await build({
  entryPoints: ['src/lib/listings.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { normaliseSmeHeader, parseNseCsv, describeSeries, compareSeries } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

// Two real rows, copied verbatim from the Emerge CSV.
const SME_CSV = [
  'SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,',
  'ETL,Emkay Tools Limited,SM,08-Jul-25,1,INE0PXC01024,1,',
  'EMKAYTOOLS,Emkay Taps and Cutting Tools Limited,SM,13-Aug-15,10,INE332S01011,10,',
].join('\n');

const rows = parseNseCsv(normaliseSmeHeader(SME_CSV));
assert.equal(rows.length, 2, 'both Emerge rows must survive the parse');

assert.deepEqual(rows[0], {
  symbol: 'ETL',
  name: 'Emkay Tools Limited',
  series: 'SM',
  isin: 'INE0PXC01024',
  // The bug: a four-digit-only year regex made this null.
  listingDate: '2025-07-08',
  faceValue: 1,
  paidUpValue: 1,
  // Emerge publishes no MARKET LOT column at all — null, not 0.
  marketLot: null,
  exchanges: ['NSE'],
  ticker: 'ETL.NS',
  bseCode: null,
});

assert.equal(rows[1].name, 'Emkay Taps and Cutting Tools Limited');
assert.equal(rows[1].listingDate, '2015-08-13', 'a 2015 listing, not 2025');

// The rewrite must touch the header line only: an underscore inside a company
// name is data, and turning it into a space would silently rename the company.
const withUnderscoreInBody = normaliseSmeHeader('A_B,C_D\nX_Y,Z');
assert.equal(withUnderscoreInBody, 'A B,C D\nX_Y,Z', 'only the header is rewritten');

// The main board must still parse exactly as before — same function, four-digit
// year, MARKET LOT present.
const MAIN_CSV = [
  'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE',
  'EMKAY,Emkay Global Financial Services Limited,EQ,28-APR-2006,10,1,INE296H01011,10',
].join('\n');

const [main] = parseNseCsv(MAIN_CSV);
assert.equal(main.listingDate, '2006-04-28');
assert.equal(main.marketLot, 1);

// Emerge's series codes must be named, not fall through to the BSE wording —
// "BSE settlement group SM" on an NSE row reads as authoritative and is wrong.
for (const code of ['SM', 'ST', 'SZ']) {
  assert.match(describeSeries(code), /Emerge/, `${code} must be described as NSE Emerge`);
}
assert.ok(compareSeries('EQ', 'SM') < 0, 'the main board sorts ahead of Emerge');
assert.ok(compareSeries('SM', 'A') < 0, 'NSE series sort ahead of BSE groups');

console.log('check-listings: all assertions passed');

// ---------------------------------------------------------------------------
// The Emerge price source.
//
// Yahoo's SME series froze on 2024-07-24 but kept answering, so the failure was
// invisible: a stale price renders identically to a live one. These assertions
// pin the two things that make the bhavcopy overlay correct — that it parses
// NSE's spacing, and that a zero close is refused rather than stored as a
// price, which is the one value that would read as real everywhere downstream.
// ---------------------------------------------------------------------------
const { parseCsvObjects } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      (
        await build({
          entryPoints: ['src/lib/csv.ts'],
          bundle: true,
          format: 'esm',
          platform: 'node',
          write: false,
        })
      ).outputFiles[0].text,
    ).toString('base64')
);

// Verbatim from sec_bhavdata_full: NSE pads every header and every value with a
// leading space, and a naive split leaves " SM" — which matches no series.
const BHAV = [
  'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER',
  'ETL, SM, 28-Aug-2026, 1063.80, 1060.00, 1120.00, 1012.10, 1120.00, 1104.00, 1078.31, 2700, 29.11, 15, 1950, 72.22',
  'EMKAYTOOLS, SM, 28-Aug-2026, 96.80, 95.75, 99.00, 94.20, 94.20, 94.20, 97.16, 1500, 1.46, 6, 1500, 100.00',
  'DORMANT, SM, 28-Aug-2026, 10.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0, 0.00, 0, 0, 0.00',
  'EMKAY, EQ, 28-Aug-2026, 239.73, 239.00, 259.90, 239.00, 251.00, 251.59, 251.08, 77078, 193.53, 2777, 39867, 51.72',
].join('\n');

const bhav = parseCsvObjects(BHAV);
assert.equal(bhav[0]['SERIES'], 'SM', 'headers and values must both be trimmed');
assert.equal(bhav[0]['CLOSE_PRICE'], '1104.00');

// The overlay's own filter, applied to the parsed rows.
const SME = new Set(['SM', 'ST', 'SZ']);
const priced = bhav.filter((r) => SME.has(r['SERIES']) && Number(r['CLOSE_PRICE']) > 0);

assert.deepEqual(
  priced.map((r) => r['SYMBOL']),
  ['ETL', 'EMKAYTOOLS'],
  'only Emerge rows with a real close survive — EQ is Yahoo\'s job, and a 0.00 close is not a price',
);

// The number that made the bug visible: Yahoo said 883.95, the exchange says 94.20.
assert.equal(Number(priced[1]['CLOSE_PRICE']), 94.2);
assert.equal(Number(priced[1]['PREV_CLOSE']), 96.8);

console.log('check-listings: bhavcopy assertions passed');
