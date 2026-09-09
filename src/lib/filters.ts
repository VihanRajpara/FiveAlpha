import type { SecurityWithQuote } from '../types';

/**
 * Numeric range filters, as data rather than as code.
 *
 * Every one of these is "is this number inside this range", and writing seven
 * bespoke predicates for seven of them is how a filter bar turns into a file
 * nobody wants to add to. A band is a `[min, max)` pair with a label; the whole
 * matcher is `inBand`.
 */
export interface Band {
  value: string;
  label: string;
  hint: string;
  /** Inclusive. */
  min?: number;
  /** Exclusive, so adjacent bands cannot both claim a value. */
  max?: number;
}

/** The "no filter" selection, shared by every group. */
export const ANY = 'ANY';

const any = (hint: string): Band => ({ value: ANY, label: 'Any', hint });

export function inBand(value: number | null | undefined, band: Band): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  if (band.min !== undefined && value < band.min) return false;
  if (band.max !== undefined && value >= band.max) return false;
  return true;
}

export interface NumericFilter {
  key: string;
  label: string;
  get: (row: SecurityWithQuote) => number | null | undefined;
  bands: Band[];
  /**
   * True when the bands are cumulative thresholds ("15%+", "20%+") rather than
   * a partition of the axis, so they deliberately contain one another. Only the
   * self-check reads it: partitioned sets are asserted not to overlap, and this
   * is what says "not that kind".
   */
  nested?: boolean;
}

/**
 * The filters worth having, in the order they are offered.
 *
 * Every one of them now reads the quote. RSI, ROCE and market cap used to be
 * produced by a screen run and were dead controls until someone clicked Run;
 * they are precomputed for the whole universe (migration 0008) and arrive with
 * the price, so there is no longer such a thing as a row the numbers are
 * missing from because nobody asked.
 */
export const NUMERIC_FILTERS: NumericFilter[] = [
  {
    key: 'price',
    label: 'Price',
    get: (row) => row.quote?.price,
    bands: [
      any('Any share price'),
      { value: 'u100', label: '< ₹100', hint: 'Under ₹100', max: 100 },
      { value: '100_500', label: '₹100–500', hint: '₹100 to ₹500', min: 100, max: 500 },
      { value: '500_2k', label: '₹500–2k', hint: '₹500 to ₹2,000', min: 500, max: 2000 },
      { value: 'o2k', label: '> ₹2k', hint: 'Over ₹2,000', min: 2000 },
    ],
  },
  {
    key: 'dayMove',
    nested: true,
    label: 'Day move',
    get: (row) => row.quote?.changePercent,
    bands: [
      any("Any of today's move"),
      { value: 'up2', label: '▲ 2%+', hint: 'Up more than 2% today', min: 2 },
      { value: 'up5', label: '▲ 5%+', hint: 'Up more than 5% today', min: 5 },
      { value: 'dn2', label: '▼ 2%+', hint: 'Down more than 2% today', max: -2 },
      { value: 'dn5', label: '▼ 5%+', hint: 'Down more than 5% today', max: -5 },
    ],
  },
  {
    key: 'rsi',
    label: 'RSI(M)',
    get: (row) => row.quote?.monthlyRsi14,
    bands: [
      any('Any monthly RSI'),
      { value: 'u40', label: '< 40', hint: 'Monthly RSI under 40 — weak', max: 40 },
      { value: '40_60', label: '40–60', hint: 'Monthly RSI 40 to 60 — neutral', min: 40, max: 60 },
      { value: '60_70', label: '60–70', hint: 'Monthly RSI 60 to 70 — strong', min: 60, max: 70 },
      { value: 'o70', label: '> 70', hint: 'Monthly RSI over 70 — overbought', min: 70 },
    ],
  },
  {
    key: 'roce',
    nested: true,
    label: 'ROCE',
    get: (row) => row.quote?.rocePct,
    bands: [
      any('Any return on capital employed'),
      { value: 'o10', label: '10%+', hint: 'ROCE above 10%', min: 10 },
      { value: 'o15', label: '15%+', hint: 'ROCE above 15%', min: 15 },
      { value: 'o20', label: '20%+', hint: 'ROCE above 20%', min: 20 },
      { value: 'o25', label: '25%+', hint: 'ROCE above 25%', min: 25 },
    ],
  },
  {
    key: 'mcap',
    label: 'M.Cap',
    get: (row) => row.quote?.marketCapCr,
    bands: [
      any('Any market capitalisation'),
      { value: 'o50k', label: '> 50k Cr', hint: 'Above ₹50,000 crore', min: 50000 },
      { value: '10k_50k', label: '10–50k Cr', hint: '₹10,000 to ₹50,000 crore', min: 10000, max: 50000 },
      { value: '1k_10k', label: '1–10k Cr', hint: '₹1,000 to ₹10,000 crore', min: 1000, max: 10000 },
      { value: 'u1k', label: '< 1k Cr', hint: 'Below ₹1,000 crore', max: 1000 },
    ],
  },
];

/**
 * Does a row pass every active band filter?
 *
 * A row with no figure for an active filter is rejected rather than admitted:
 * the same rule the signal filters use, and for the same reason — an unmeasured
 * row is not a match.
 */
export function matchesBands(
  row: SecurityWithQuote,
  selected: Record<string, string>,
): boolean {
  for (const filter of NUMERIC_FILTERS) {
    const chosen = selected[filter.key];
    if (!chosen || chosen === ANY) continue;
    const band = filter.bands.find((b) => b.value === chosen);
    if (!band) continue;
    if (!inBand(filter.get(row), band)) return false;
  }
  return true;
}
