import type { DataSource, Quote, Security } from '../types';
import { chunk, mapPool } from './format';
import { fetchBseScrips, fetchNseSecurities, mergeListings } from './listings';
import { fetchYahooCandles } from './yahooCandles';

/**
 * Symbols per request, and how many requests at once.
 *
 * This used to be Yahoo's `spark` endpoint at 20 tickers a request — 262 calls
 * to price the 5,229-row universe. `/v7/finance/quote` takes 200 at a time, so
 * the same pass is 27 calls, and four in flight is already 800 symbols being
 * priced at once. See worker/yahooQuote.ts for the credential this costs.
 *
 * The batch size is Yahoo's practical ceiling — the URL is what runs out first —
 * and `QUOTE_BATCH_SIZE` in worker/yahooQuote.ts rejects anything above it, so
 * the two drifting apart is a 400 rather than a silent truncation.
 */
const QUOTE_BATCH_SIZE = 200;
const QUOTE_CONCURRENCY = 4;

/** Yahoo answers in rupees; the app is written in Rs crore throughout. */
const CRORE = 1e7;

interface QuoteEntry {
  symbol?: string;
  regularMarketPrice?: number | null;
  regularMarketPreviousClose?: number | null;
  /** Epoch seconds of the last trade — the vendor's own print time. */
  regularMarketTime?: number | null;
  marketCap?: number | null;
}

interface QuoteResponse {
  quoteResponse?: { result?: QuoteEntry[] };
}

function buildQuote(symbol: string, entry: QuoteEntry | undefined): Quote {
  const price = typeof entry?.regularMarketPrice === 'number' ? entry.regularMarketPrice : null;
  const previousClose =
    typeof entry?.regularMarketPreviousClose === 'number'
      ? entry.regularMarketPreviousClose
      : null;

  const change = price !== null && previousClose !== null ? price - previousClose : null;
  const changePercent =
    change !== null && previousClose !== null && previousClose !== 0
      ? (change / previousClose) * 100
      : null;

  // `> 0`, not just "is a number": Yahoo returns a literal 0 for a handful of
  // dormant scrips, and epoch 0 renders as 1 January 1970 — a real-looking
  // timestamp standing in for "the vendor doesn't know".
  const stamp =
    typeof entry?.regularMarketTime === 'number' && entry.regularMarketTime > 0
      ? entry.regularMarketTime
      : null;

  return {
    symbol,
    price,
    previousClose,
    change,
    changePercent,
    updatedAt: stamp !== null ? new Date(stamp * 1000).toISOString() : null,
    marketCapCr: typeof entry?.marketCap === 'number' ? entry.marketCap / CRORE : null,
    // Direct mode has no database behind it, so these stay unknown until a
    // screen run computes them. Supabase mode reads them precomputed.
    monthlyRsi14: null,
    rocePct: null,
    fundamentalsUrl: null,
  };
}

export const directSource: DataSource = {
  kind: 'direct',

  /**
   * Both exchange lists, merged on ISIN into one row per company.
   *
   * Settled independently: BSE's API is the flakier of the two, and losing it
   * should cost the ~2,800 BSE-only rows, not the whole table. NSE failing is
   * still fatal, because without it there is no list at all.
   */
  async listSecurities(): Promise<Security[]> {
    const [nseResult, bseResult] = await Promise.allSettled([
      fetchNseSecurities(),
      fetchBseScrips(),
    ]);

    if (nseResult.status === 'rejected') throw nseResult.reason;

    if (bseResult.status === 'rejected') {
      console.warn('BSE scrip list unavailable — showing NSE listings only.', bseResult.reason);
      return nseResult.value;
    }

    return mergeListings(nseResult.value, bseResult.value);
  },

  /**
   * Prices for the whole universe through the batch quote proxy.
   *
   * Moved off `spark` for two reasons, and the second is the one that shows in
   * the table. spark is a *chart* endpoint: it answers out of intraday bars, so
   * a thinly traded scrip that printed no 5-minute bar came back with no price
   * at all — 508 of 5,229 rows on 2026-08-29, mostly BSE-only. `/v7` carries the
   * last trade whether or not a bar exists: measured over the whole universe the
   * same day it priced 5,088 rows, recovering 367 of those 508. The other reason
   * is simply that it takes ten times as many tickers per request — 27 of them
   * cover the market, in 2.8 seconds.
   */
  async fetchQuotes(targets, onBatch): Promise<Quote[]> {
    const batches = chunk(targets, QUOTE_BATCH_SIZE);

    const results = await mapPool(batches, QUOTE_CONCURRENCY, async (batch) => {
      const query = batch.map((t) => t.ticker).join(',');

      try {
        const res = await fetch(`/api/yquote?symbols=${encodeURIComponent(query)}`);
        if (!res.ok) return [];

        const payload = (await res.json()) as QuoteResponse;

        // Yahoo keys its answer by ticker and drops what it does not carry, so
        // index the response and walk the *request*. Quotes are keyed back to
        // `symbol`, which is what the table joins on — the ticker is only ever
        // the vendor's name for the row.
        const byTicker = new Map<string, QuoteEntry>();
        for (const entry of payload.quoteResponse?.result ?? []) {
          if (entry.symbol) byTicker.set(entry.symbol, entry);
        }

        const quotes = batch.map((t) => buildQuote(t.symbol, byTicker.get(t.ticker)));

        // Published here, inside the worker, so rows and the progress bar fill
        // in as each batch lands rather than all at once at the end.
        if (quotes.length > 0) onBatch?.(quotes);
        return quotes;
      } catch {
        // A failed chunk shouldn't sink the others — those rows stay blank.
        return [];
      }
    });

    return results.flat();
  },

  fetchCandles: fetchYahooCandles,
};
