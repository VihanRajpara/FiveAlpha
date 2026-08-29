import type { Candle, ChartRange } from '../types';
import { dayCache } from './dayCache';

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
 * Tickers Yahoo has already answered "I don't carry that" for.
 *
 * NSE Emerge (series SM/ST/SZ) is on the master list and largely absent from
 * Yahoo, so every pass that touches the whole universe — the screen's scan, the
 * market-cap batch, the signal column on any row scrolled into view — was
 * re-discovering the same few hundred dead tickers, one 404 at a time, on every
 * run and every reload. The answer is stable and free to remember, so it is
 * remembered here and every Yahoo fetcher checks it first.
 *
 * Kept a week rather than the usual day: a symbol Yahoo does not carry does not
 * start being carried overnight, and the expiry is what bounds the cost of
 * being wrong — a ticker wrongly marked is asked again within the week rather
 * than never.
 */
const unknownStore = dayCache<1>(
  'unknown-tickers',
  { encode: () => 1, decode: (raw) => (raw === 1 ? 1 : undefined) },
  7,
);

/** Has Yahoo already said it has no such symbol? */
export const isUnknownTicker = (ticker: string): boolean => unknownStore.has(ticker);

/** Record a "no such symbol" — a 404, or an absence from a batch response. */
export const markUnknownTicker = (ticker: string): void => unknownStore.set(ticker, 1);

/**
 * One GET, retried once if the connection itself fails.
 *
 * Both bar fetchers below go through this, and so therefore does everything
 * that reads bars — the chart drawer, `useSignal`, and the screen's scan and
 * confirm passes. It is the one place all of them meet, which is why the retry
 * lives here rather than in any of them.
 *
 * What it is for: a transient `socket hang up` from the dev proxy. Yahoo itself
 * is not the problem — measured 2026-08-29, 562 requests through the Vite proxy
 * at the app's own concurrency came back with no connection failures at all,
 * and 24-way direct requests likewise. These arrive in ones and twos, minutes
 * apart, which is the signature of a dropped connection rather than of load.
 * Left alone each one costs real data: a failed scan batch falls back to twenty
 * individual requests, and a failed signal leaves that row blank until it is
 * scrolled out of view and back.
 *
 * **Only a thrown fetch is retried**, which is the narrow case where a retry is
 * both safe and useful:
 *   · An HTTP status is an *answer*. A 404 means Yahoo does not carry the
 *     symbol — asking twice gets the same 404 and doubles the cost of every
 *     dead ticker, of which the BSE list has hundreds.
 *   · An abort must propagate untouched. Retrying one would keep a request
 *     alive after the run that owns it has been cancelled.
 */
async function fetchYahoo(url: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    // One short pause, then one more try. A longer backoff would be worse than
    // useless here: the screen's stages are already racing each other, and a
    // stalled row holds a slot in the pool that a fresh one could use.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return await fetch(url, { signal });
  }
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
  // Asked and answered — throw the same error the request would have, for free.
  if (isUnknownTicker(ticker)) throw new Error(`Yahoo has no symbol ${ticker}`);

  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=${range}&interval=${interval}`;

  const res = await fetchYahoo(url, signal);
  if (!res.ok) {
    // 404 is Yahoo's "no such symbol", and the only status worth remembering:
    // a 429 or a 5xx is about this request, not about the ticker.
    if (res.status === 404) markUnknownTicker(ticker);
    throw new Error(`Yahoo returned ${res.status} for ${ticker}`);
  }

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

/** Yahoo rejects the whole request with a 400 above this many symbols. */
export const SPARK_BATCH_SIZE = 20;

interface SparkSeries {
  timestamp?: number[] | null;
  close?: (number | null)[] | null;
}

/**
 * Closes for up to `SPARK_BATCH_SIZE` tickers in **one** request.
 *
 * The screens used to be priced one `chart` call per symbol on the stated
 * grounds that "there is no batch endpoint for a decade of bars". That was
 * wrong, and expensively so: `spark` takes the same `range`/`interval` pair as
 * `chart` and answers twenty symbols at a time. Measured 2026-08-12 against 600
 * NSE symbols through the dev proxy at the same concurrency, this is **19×**
 * the throughput of the per-symbol call — the difference between twelve minutes
 * and forty seconds on the whole market.
 *
 * What it gives up is the OHLC: `spark` carries `close` and nothing else, so a
 * ten-year *high* cannot be read off it — only bounded from below. See
 * `computeCoarseTechnicals` in src/lib/technicals.ts, which is the only caller
 * and is careful about exactly that. The closes themselves are the same numbers
 * `chart` returns, verified bar for bar over the same window (spark rounds to
 * one decimal, which moves an RSI by ~1e-6).
 *
 * Two response quirks, both load-bearing:
 *   · Symbols Yahoo does not know are **silently dropped** from the object
 *     rather than returned as null. Every one sampled also 404s on `chart`, so a
 *     missing key means "no history anywhere", not "ask again differently".
 *   · A batch in which it recognises *nothing* is a 404 for the whole request.
 *     That is an empty answer, not a failure — throwing would sink the batch.
 */
export async function fetchYahooSparkBars(
  tickers: string[],
  range: string,
  interval: string,
  signal?: AbortSignal,
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  // Dead tickers do not just cost their own slot: a batch of nothing but known
  // dead ones is a whole request spent to be told 404.
  const live = tickers.filter((t) => !isUnknownTicker(t));
  if (live.length === 0) return out;

  // The whole joined string is encoded, commas included — Yahoo decodes them
  // back, and it is the only way `ARE&M.NS` survives the query string.
  const symbols = encodeURIComponent(live.join(','));
  const url = `/api/yahoo/v8/finance/spark?symbols=${symbols}&range=${range}&interval=${interval}`;

  const res = await fetchYahoo(url, signal);
  // Yahoo 404s the whole request only when it recognises nothing in it, so this
  // is an answer about every symbol asked for rather than a failure.
  if (res.status === 404) {
    for (const ticker of live) markUnknownTicker(ticker);
    return out;
  }
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for a batch of ${tickers.length}`);

  const payload = (await res.json()) as Record<string, SparkSeries | null>;

  // Iterate the request, not the response: the response is keyed by ticker and
  // is missing an entry for anything Yahoo doesn't carry.
  for (const ticker of live) {
    const series = payload[ticker];
    const timestamps = series?.timestamp;
    const closes = series?.close;
    if (!timestamps || !closes) {
      markUnknownTicker(ticker);
      continue;
    }

    const bars: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (typeof close !== 'number') continue;
      bars.push({
        date: sessionDate(timestamps[i]),
        open: null,
        high: null,
        low: null,
        close,
        volume: null,
      });
    }

    if (bars.length > 0) out.set(ticker, bars);
  }

  return out;
}
