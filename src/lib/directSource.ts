import type { Candle, DataSource, Quote, Security } from '../types';
import { parseCsvObjects } from './csv';
import { chunk, mapPool, parseNseDate, toNumber } from './format';

/** Yahoo rejects the whole request with a 400 if more than 20 symbols are passed. */
const SPARK_BATCH_SIZE = 20;
const SPARK_CONCURRENCY = 6;

/**
 * 5-minute bars, not daily. A daily bar carries the *session open* as its
 * timestamp (09:15 IST), so at 3pm it would date a five-minute-old price to six
 * hours ago and permanently trip the staleness warning. 5m bars are stamped
 * within five minutes of the actual print. The price itself is identical either
 * way — this only buys timestamp resolution.
 */
const SPARK_INTERVAL = '5m';

const EQUITY_LIST_URL = '/api/nse/content/equities/EQUITY_L.csv';

/** NSE symbols map to Yahoo tickers by suffixing the exchange. */
export function toYahooSymbol(symbol: string): string {
  return `${symbol}.NS`;
}

interface SparkEntry {
  symbol?: string;
  close?: (number | null)[] | null;
  chartPreviousClose?: number | null;
  previousClose?: number | null;
  timestamp?: number[] | null;
}

interface ChartResponse {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
    error?: { description?: string } | null;
  };
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

  async listSecurities(): Promise<Security[]> {
    const res = await fetch(EQUITY_LIST_URL);
    if (!res.ok) {
      throw new Error(`NSE returned ${res.status} for the equity list. Is the dev proxy running?`);
    }

    const rows = parseCsvObjects(await res.text());

    return rows
      .map((row) => ({
        symbol: row['SYMBOL'] ?? '',
        name: row['NAME OF COMPANY'] ?? '',
        series: row['SERIES'] ?? '',
        isin: row['ISIN NUMBER'] ?? '',
        listingDate: parseNseDate(row['DATE OF LISTING'] ?? ''),
        faceValue: toNumber(row['FACE VALUE']),
        paidUpValue: toNumber(row['PAID UP VALUE']),
        marketLot: toNumber(row['MARKET LOT']),
      }))
      .filter((s) => s.symbol !== '');
  },

  async fetchQuotes(symbols, onBatch): Promise<Quote[]> {
    const batches = chunk(symbols, SPARK_BATCH_SIZE);

    const results = await mapPool(batches, SPARK_CONCURRENCY, async (batch) => {
      const query = batch.map(toYahooSymbol).join(',');
      const url = `/api/yahoo/v8/finance/spark?symbols=${encodeURIComponent(query)}&range=1d&interval=${SPARK_INTERVAL}`;

      try {
        const res = await fetch(url);
        if (!res.ok) return [];

        const payload = (await res.json()) as Record<string, SparkEntry | null>;

        // Yahoo keys the response by ticker and silently drops unknown symbols,
        // so map over the request batch rather than over the response.
        const quotes = batch.map((symbol) =>
          buildQuote(symbol, payload[toYahooSymbol(symbol)]),
        );

        // Publish here, inside the worker, so rows and the progress bar fill in
        // as each batch lands. Calling onBatch after `await mapPool` instead
        // would hold every update back until all 120 requests had finished —
        // roughly 45 seconds of an apparently frozen table in the browser.
        if (quotes.length > 0) onBatch?.(quotes);
        return quotes;
      } catch {
        // A failed chunk shouldn't sink the other 119 — those rows just stay blank.
        return [];
      }
    });

    return results.flat();
  },

  async fetchCandles(symbol, range): Promise<Candle[]> {
    // Daily bars stay readable up to a year; beyond that switch to weekly.
    const interval = range === '5y' ? '1wk' : '1d';
    const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(
      toYahooSymbol(symbol),
    )}?range=${range}&interval=${interval}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${symbol}`);

    const payload = (await res.json()) as ChartResponse;
    const result = payload.chart?.result?.[0];
    if (!result?.timestamp) return [];

    const quote = result.indicators?.quote?.[0] ?? {};

    return result.timestamp
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: quote.open?.[i] ?? null,
        high: quote.high?.[i] ?? null,
        low: quote.low?.[i] ?? null,
        close: quote.close?.[i] ?? null,
        volume: quote.volume?.[i] ?? null,
      }))
      .filter((c) => c.close !== null);
  },
};
