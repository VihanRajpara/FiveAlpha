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

/**
 * Yahoo's bar timestamps are the *start* of the period in exchange-local time,
 * so an NSE bar opening 1 September lands on epoch `2016-08-31T18:30:00Z`.
 * Slicing that in UTC dates every Indian bar a day early and, at monthly
 * resolution, files it under the wrong month entirely — which is not cosmetic
 * once anything groups bars by month, as `src/lib/technicals.ts` now does.
 *
 * NSE and BSE are both IST and India has no daylight saving, so a fixed +5:30
 * is exact rather than an approximation.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const sessionDate = (ts: number) =>
  new Date(ts * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Bars at an arbitrary range/interval.
 *
 * Exported because the chart is no longer the only caller: `src/lib/technicals.ts`
 * asks for ten years of *monthly* bars, which is not one of the ranges the
 * drawer offers. Keeping one fetch/parse here means the screens and the chart
 * cannot disagree about what Yahoo returned.
 *
 * `ticker` is the exchange-qualified Yahoo symbol — `TCS.NS` or `TANFACIND.BO`.
 */
export async function fetchYahooBars(
  ticker: string,
  range: string,
  interval: string,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=${range}&interval=${interval}`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${ticker}`);

  const payload = (await res.json()) as ChartResponse;
  const result = payload.chart?.result?.[0];
  if (!result?.timestamp) return [];

  const quote = result.indicators?.quote?.[0] ?? {};

  return result.timestamp
    .map((ts, i) => ({
      date: sessionDate(ts),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close: quote.close?.[i] ?? null,
      volume: quote.volume?.[i] ?? null,
    }))
    .filter((c) => c.close !== null);
}

/** The drawer's chart: daily bars up to a year, weekly beyond it. */
export function fetchYahooCandles(ticker: string, range: ChartRange): Promise<Candle[]> {
  return fetchYahooBars(ticker, range, range === '5y' ? '1wk' : '1d');
}
