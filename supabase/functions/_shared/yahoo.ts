// Yahoo's spark endpoint and the monthly RSI computed from it.
//
// This is all that remains of the Yahoo integration. Prices, market cap and
// ROCE now come from Upstox; what keeps this file alive is one thing Upstox
// cannot do: **there is no batch endpoint for historical candles.** Ten years
// of monthly closes for the whole universe is 20 tickers a request here against
// one instrument a request there — 292 calls versus 5,831 — so sync-technicals
// stays on spark. See plan.md section 6.

import { BROWSER_UA, fetchWithTimeout } from './upstream.ts';

// ---------------------------------------------------------------------------
// Monthly closes and Wilder RSI.
//
// Deliberately a transcription of `rsi` and `collapseMonths` in
// src/lib/technicals.ts rather than an independent implementation: the stored
// column and a live screen verdict are meant to be the same number, and two
// versions of Wilder smoothing drifting apart would put a row above the
// screen's threshold in one place and below it in the other.
// ---------------------------------------------------------------------------

export const RSI_PERIOD = 14;
/** Wilder needs one bar to seed the first delta plus `period` deltas. */
export const MIN_RSI_BARS = RSI_PERIOD + 2;

/** Yahoo answers 400 above this many tickers on a spark request. */
export const SPARK_BATCH_SIZE = 20;

/** NSE and BSE are both IST and India has no daylight saving, so this is exact. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const sessionMonth = (ts: number): string =>
  new Date(ts * 1000 + IST_OFFSET_MS).toISOString().slice(0, 7);

/**
 * Wilder's RSI over a close series, latest value.
 *
 * Wilder smoothing, not a simple mean of gains and losses: the two diverge by
 * several points at period 14, and Chartink's `rsi( 14 )` — which the screens
 * are written against — is Wilder's.
 */
export function rsi(closes: number[], period = RSI_PERIOD): number | null {
  if (closes.length < period + 2) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  // No down-closes at all: RS is infinite and RSI saturates. Returning 100
  // rather than dividing by zero matters — that is exactly the shape of a share
  // pinned at a new high, which is the population the screens hunt.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Monthly closes for a batch of tickers, from one spark request.
 *
 * Yahoo reports the current month *twice* — a monthly bar whose close is a day
 * or two stale, then a bar dated today carrying the live price. Left alone that
 * pair is an extra delta Wilder RSI cannot tell from a real month's move, and it
 * was the single largest source of disagreement with Chartink. Keeping the last
 * close seen per calendar month collapses it, which is what `collapseMonths`
 * does on the client.
 */
export async function fetchMonthlyCloses(tickers: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (tickers.length === 0) return out;

  const symbols = encodeURIComponent(tickers.join(','));
  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=10y&interval=1mo`,
    { headers: { 'User-Agent': BROWSER_UA } },
  );
  // A batch Yahoo recognises nothing in is a 404 for the whole request. That is
  // an empty answer, not a failure.
  if (res.status === 404) return out;
  if (!res.ok) throw new Error(`Yahoo spark returned ${res.status}`);

  const payload = (await res.json()) as Record<
    string,
    { timestamp?: number[] | null; close?: (number | null)[] | null } | null
  >;

  // Iterate the request, not the response: Yahoo silently drops tickers it does
  // not carry rather than returning them as null.
  for (const ticker of tickers) {
    const series = payload[ticker];
    const stamps = series?.timestamp;
    const closes = series?.close;
    if (!stamps || !closes) continue;

    const months: string[] = [];
    const values: number[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const close = closes[i];
      if (typeof close !== 'number') continue;
      const month = sessionMonth(stamps[i]);
      if (months.length > 0 && months[months.length - 1] === month) {
        values[values.length - 1] = close;
      } else {
        months.push(month);
        values.push(close);
      }
    }

    if (values.length > 0) out.set(ticker, values);
  }

  return out;
}
