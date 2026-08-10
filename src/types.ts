/** A share listed on the NSE cash market, as published in EQUITY_L.csv. */
export interface Security {
  symbol: string;
  name: string;
  /** EQ = rolling settlement, BE = trade-to-trade, BZ = trade-to-trade surveillance. */
  series: string;
  isin: string;
  /** ISO date (yyyy-mm-dd). NSE publishes it as DD-MMM-YYYY. */
  listingDate: string | null;
  faceValue: number | null;
  paidUpValue: number | null;
  marketLot: number | null;
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
 * The two interchangeable backends. `direct` hits NSE/Yahoo through the Vite dev
 * proxy; `supabase` reads rows that the Edge Functions already ingested.
 */
export interface DataSource {
  readonly kind: 'direct' | 'supabase';
  listSecurities(): Promise<Security[]>;
  /** Resolves progressively — `onBatch` fires as each chunk lands. */
  fetchQuotes(symbols: string[], onBatch?: (batch: Quote[]) => void): Promise<Quote[]>;
  fetchCandles(symbol: string, range: ChartRange): Promise<Candle[]>;
}
