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
