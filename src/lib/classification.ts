import type { CapBand, Classification } from '../types';
import { parseCsvObjects } from './csv';

/**
 * Stock classification, joined client-side from NSE's published lists.
 *
 * EQUITY_L.csv carries no segment information — its SERIES column only ever
 * holds EQ, BE or BZ, which is settlement type, not instrument type. Derivatives
 * eligibility and cap band each live in their own archive file, so they are
 * fetched separately and joined by symbol.
 *
 * All of these are small, slow-moving files (a few hundred KB in total, changed
 * on index rebalance) and both proxies put a long cache TTL in front of them.
 */

/** Underlyings with listed futures & options. Also lists index underlyings. */
const FO_URL = '/api/nse/content/fo/fo_mktlots.csv';

const INDEX_URL = (file: string) => `/api/nse/content/indices/${file}.csv`;

/**
 * Cap band by index membership, narrowest first. NIFTY 100 (= 50 + Next 50) is
 * large cap; the midcap and smallcap lists complete the Nifty 500.
 */
const CAP_LISTS: { band: Exclude<CapBand, 'micro'>; files: string[] }[] = [
  { band: 'large', files: ['ind_nifty50list', 'ind_niftynext50list'] },
  { band: 'mid', files: ['ind_niftymidcap150list'] },
  { band: 'small', files: ['ind_niftysmallcap250list'] },
];

async function fetchCsv(url: string): Promise<Record<string, string>[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return parseCsvObjects(await res.text());
}

/**
 * Symbols in the F&O market-lots file.
 *
 * Two quirks in that file:
 *
 *  - Every column is space-padded to a fixed width, headers included.
 *    `parseCsvObjects` trims both, so `SYMBOL` resolves cleanly.
 *  - It is *sectioned*. Index derivatives come first, then a second header row
 *    ("Derivatives on Individual Securities, Symbol, …") introduces the stock
 *    underlyings. That repeated header parses as a data row carrying the
 *    literal symbol "Symbol", so it is dropped by name.
 *
 * Index underlyings (NIFTY, BANKNIFTY, …) are kept and simply never match a
 * security — they fall out of the join on their own.
 */
async function fetchFnoSymbols(): Promise<Set<string>> {
  const rows = await fetchCsv(FO_URL);
  const out = new Set<string>();
  for (const row of rows) {
    const symbol = (row['SYMBOL'] ?? '').trim();
    if (symbol && symbol.toUpperCase() !== 'SYMBOL') out.add(symbol);
  }
  return out;
}

async function fetchCapBands(): Promise<Map<string, CapBand>> {
  const bands = new Map<string, CapBand>();

  await Promise.all(
    CAP_LISTS.flatMap(({ band, files }) =>
      files.map(async (file) => {
        const rows = await fetchCsv(INDEX_URL(file));
        for (const row of rows) {
          const symbol = (row['Symbol'] ?? '').trim();
          // First list to claim a symbol wins. The lists are disjoint today, so
          // this only matters if NSE ever publishes an overlap mid-rebalance.
          if (symbol && !bands.has(symbol)) bands.set(symbol, band);
        }
      }),
    ),
  );

  return bands;
}

/**
 * Builds the symbol → classification map.
 *
 * Each source is settled independently: a failure to reach the F&O file should
 * not also cost the cap bands. Classification is enrichment, so the caller gets
 * whatever resolved and the UI degrades to "unclassified" for the rest.
 */
export async function fetchClassification(): Promise<{
  map: Map<string, Classification>;
  failed: string[];
}> {
  const [fnoResult, capResult] = await Promise.allSettled([fetchFnoSymbols(), fetchCapBands()]);

  const failed: string[] = [];
  const fno = fnoResult.status === 'fulfilled' ? fnoResult.value : new Set<string>();
  const caps = capResult.status === 'fulfilled' ? capResult.value : new Map<string, CapBand>();

  if (fnoResult.status === 'rejected') failed.push('F&O list');
  if (capResult.status === 'rejected') failed.push('index constituents');

  const map = new Map<string, Classification>();
  for (const symbol of fno) map.set(symbol, { fno: true, capBand: caps.get(symbol) ?? 'micro' });
  for (const [symbol, capBand] of caps) {
    if (!map.has(symbol)) map.set(symbol, { fno: false, capBand });
  }

  return { map, failed };
}

/**
 * The default for any symbol absent from both files: cash-only, and outside the
 * Nifty 500. That is a genuine classification, not a gap — roughly 1,900 of the
 * 2,400 listed shares sit here.
 */
export const UNCLASSIFIED: Classification = { fno: false, capBand: 'micro' };

export const CAP_LABEL: Record<CapBand, string> = {
  large: 'Large cap',
  mid: 'Mid cap',
  small: 'Small cap',
  micro: 'Micro cap',
};

export const CAP_SHORT: Record<CapBand, string> = {
  large: 'Large',
  mid: 'Mid',
  small: 'Small',
  micro: 'Micro',
};

/** Sort rank: F&O before cash, then descending by size. */
export const CAP_RANK: Record<CapBand, number> = { large: 0, mid: 1, small: 2, micro: 3 };

export function classRank(cls: Classification | undefined): number {
  const c = cls ?? UNCLASSIFIED;
  return (c.fno ? 0 : 10) + CAP_RANK[c.capBand];
}
