import type { Candle, ChartRange } from '../types';

/**
 * Chart history, fetched on demand rather than stored.
 *
 * Candles used to live in a Supabase table refreshed by a cron: ~250 bars ×
 * ~2,400 symbols is half a million rows, which alone filled a third of the free
 * tier's 500 MB — for data the UI only ever reads one symbol at a time, and only
 * when a drawer is open. Now nothing is stored: the browser asks Yahoo through a
 * same-origin proxy each time a chart is opened.
 *
 * `/api/yahoo/*` is served by two different things depending on where the app is
 * running, which is why this module is backend-agnostic and both data sources
 * share it:
 *   · `npm run dev`  → the Vite proxy in vite.config.ts
 *   · deployed       → the Cloudflare Worker in worker/index.ts
 * Both add the browser User-Agent Yahoo expects and both are same-origin, so
 * there is no CORS to negotiate.
 */

/** NSE symbols map to Yahoo tickers by suffixing the exchange. */
export function toYahooSymbol(symbol: string): string {
  return `${symbol}.NS`;
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

export async function fetchYahooCandles(symbol: string, range: ChartRange): Promise<Candle[]> {
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
}
