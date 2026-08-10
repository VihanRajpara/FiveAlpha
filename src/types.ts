export type Exchange = 'NSE' | 'BSE';

/**
 * One *company*, not one listing.
 *
 * NSE's EQUITY_L.csv and BSE's scrip master are merged on ISIN, so a dual-listed
 * name like RELIANCE is a single row carrying `exchanges: ['NSE', 'BSE']` rather
 * than two near-identical rows quoting the same company within a rupee of each
 * other. About 2,300 of BSE's 5,100 active scrips merge away this way; the
 * remaining ~2,800 are genuinely BSE-only and appear as their own rows.
 */
export interface Security {
  /**
   * Identity and display key: the NSE symbol when the company is listed there,
   * otherwise the BSE scrip id. Unique across the merged list — see
   * `mergeListings`, which breaks the handful of BSE-vs-NSE ticker collisions.
   */
  symbol: string;
  name: string;
  /**
   * NSE settlement series (EQ = rolling, BE = trade-to-trade, BZ = surveillance)
   * for anything listed on NSE, and the BSE group (A, B, X, T, Z, …) for
   * BSE-only rows. Both describe how the share settles, so they share a column.
   */
  series: string;
  isin: string;
  /** ISO date (yyyy-mm-dd). NSE publishes it as DD-MMM-YYYY; BSE doesn't publish it. */
  listingDate: string | null;
  faceValue: number | null;
  paidUpValue: number | null;
  marketLot: number | null;
  /** Where the company is listed. Never empty; ordered NSE first. */
  exchanges: Exchange[];
  /**
   * The Yahoo ticker prices and charts are read from — `SYMBOL.NS` whenever the
   * company is on NSE, else `SCRIPID.BO`. Resolved once at merge time rather
   * than derived from `symbol` at each call site, because the two differ for
   * every BSE-only row.
   */
  ticker: string;
  /** BSE scrip code (e.g. `500325`), when the company is listed on BSE. */
  bseCode: string | null;
}

/** The minimum a data source needs to price a row. */
export interface QuoteTarget {
  symbol: string;
  ticker: string;
}

/** Latest traded price for a symbol. */
export interface Quote {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  updatedAt: string | null;
}

/** One historical bar. Yahoo's chart endpoint can return nulls inside the arrays. */
export interface Candle {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export type ChartRange = '1mo' | '6mo' | '1y' | '5y';

/**
 * Market-cap band, derived from NSE index membership rather than from a
 * computed market cap — NSE rebalances these lists semi-annually against its
 * own free-float methodology, which is the classification the market actually
 * refers to. The three named bands partition the Nifty 500 exactly
 * (50 + 50 + 150 + 250); everything outside it is `micro`.
 *
 * The indices are NSE's, so every BSE-only company lands in `micro` — which is
 * what the definition says, since a share NSE does not list cannot be in an NSE
 * index. It is a statement about index membership, not about the company's size.
 */
export type CapBand = 'large' | 'mid' | 'small' | 'micro';

/** What kind of instrument a symbol is, beyond its settlement series. */
export interface Classification {
  /** Derivatives available on this underlying (NSE F&O market-lots file). */
  fno: boolean;
  capBand: CapBand;
}

export type SecurityWithQuote = Security & { quote?: Quote; cls?: Classification };

/**
 * The two interchangeable backends. `direct` hits NSE/BSE/Yahoo through the Vite
 * dev proxy; `supabase` reads rows that the Edge Functions already ingested.
 */
export interface DataSource {
  readonly kind: 'direct' | 'supabase';
  listSecurities(): Promise<Security[]>;
  /** Resolves progressively — `onBatch` fires as each chunk lands. */
  fetchQuotes(targets: QuoteTarget[], onBatch?: (batch: Quote[]) => void): Promise<Quote[]>;
  /** Takes the Yahoo ticker (`Security.ticker`), not the display symbol. */
  fetchCandles(ticker: string, range: ChartRange): Promise<Candle[]>;
}
