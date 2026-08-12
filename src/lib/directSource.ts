import type { DataSource, Quote, Security } from '../types';
import { chunk, mapPool } from './format';
import { fetchBseScrips, fetchNseSecurities, mergeListings } from './listings';
import { SPARK_BATCH_SIZE, fetchYahooCandles } from './yahooCandles';

const SPARK_CONCURRENCY = 6;

/**
 * 5-minute bars, not daily. A daily bar carries the *session open* as its
 * timestamp (09:15 IST), so at 3pm it would date a five-minute-old price to six
 * hours ago and permanently trip the staleness warning. 5m bars are stamped
 * within five minutes of the actual print. The price itself is identical either
 * way — this only buys timestamp resolution.
 */
const SPARK_INTERVAL = '5m';

interface SparkEntry {
  symbol?: string;
  close?: (number | null)[] | null;
  chartPreviousClose?: number | null;
  previousClose?: number | null;
  timestamp?: number[] | null;
}

function buildQuote(symbol: string, entry: SparkEntry | null | undefined): Quote {
  const closeArr = entry?.close ?? [];
  const stamps = entry?.timestamp ?? [];

  // Walk back to the last bar that actually traded, and take BOTH the price and
  // its timestamp from that same index. Taking the last close but the last
  // timestamp independently would report a stale price as fresh whenever the
  // final bars are null (thin trading, halts).
  let i = closeArr.length - 1;
  while (i >= 0 && typeof closeArr[i] !== 'number') i--;

  const price = i >= 0 ? (closeArr[i] as number) : null;
  const stamp = i >= 0 && typeof stamps[i] === 'number' ? stamps[i] : null;

  const previousClose = entry?.chartPreviousClose ?? entry?.previousClose ?? null;

  const change = price !== null && previousClose !== null ? price - previousClose : null;
  const changePercent =
    change !== null && previousClose !== null && previousClose !== 0
      ? (change / previousClose) * 100
      : null;

  return {
    symbol,
    price,
    previousClose,
    change,
    changePercent,
    updatedAt: stamp !== null ? new Date(stamp * 1000).toISOString() : null,
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

  async fetchQuotes(targets, onBatch): Promise<Quote[]> {
    const batches = chunk(targets, SPARK_BATCH_SIZE);

    const results = await mapPool(batches, SPARK_CONCURRENCY, async (batch) => {
      const query = batch.map((t) => t.ticker).join(',');
      const url = `/api/yahoo/v8/finance/spark?symbols=${encodeURIComponent(query)}&range=1d&interval=${SPARK_INTERVAL}`;

      try {
        const res = await fetch(url);
        if (!res.ok) return [];

        const payload = (await res.json()) as Record<string, SparkEntry | null>;

        // Yahoo keys the response by ticker and silently drops unknown symbols,
        // so map over the request batch rather than over the response. Quotes
        // are keyed back to `symbol`, which is what the table joins on.
        const quotes = batch.map((t) => buildQuote(t.symbol, payload[t.ticker]));

        // Publish here, inside the worker, so rows and the progress bar fill in
        // as each batch lands. Calling onBatch after `await mapPool` instead
        // would hold every update back until all ~260 requests had finished —
        // a minute or more of an apparently frozen table in the browser.
        if (quotes.length > 0) onBatch?.(quotes);
        return quotes;
      } catch {
        // A failed chunk shouldn't sink the other ~259 — those rows stay blank.
        return [];
      }
    });

    return results.flat();
  },

  fetchCandles: fetchYahooCandles,
};
