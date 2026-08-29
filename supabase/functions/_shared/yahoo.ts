// Yahoo access that needs more than a User-Agent, plus the technicals computed
// from it. Split out from upstream.ts, which is the exchange-listings module.

import { BROWSER_UA, fetchWithTimeout } from './upstream.ts';

// ---------------------------------------------------------------------------
// /v7/finance/quote — the batch quote endpoint.
//
// This replaces `spark` as the price source, and it is the single change that
// answers both "the refresh is slow" and "some stocks never show a price":
//
// Both measured over the live 5,229-row universe, 2026-08-29, at four requests
// in flight:
//
//   · **Batch size.** 200 symbols per request against spark's 20 — 27 requests
//     instead of 262, and the whole universe answered in **2.8 seconds**.
//   · **Coverage.** spark is a *chart* endpoint: it answers out of intraday
//     bars, so a thinly traded BSE scrip that printed no 5-minute bar comes back
//     empty. `/v7/finance/quote` carries the last trade regardless. It priced
//     **5,088** of the 5,229 rows against the spark-filled table's 4,721 — 367
//     companies that had no price at all, almost all of them BSE-only.
//   · **Market cap** arrives in the same response, so the screen's separate
//     cap pass costs nothing to keep fed.
//
// The price of all that is a credential: an unauthenticated call answers 401
// Invalid Crumb. The cookie/crumb dance below mirrors worker/yahooQuote.ts,
// which does the same for the browser. It is unofficial, so callers treat a
// failure as "no figures this pass" rather than as a fatal error.
// ---------------------------------------------------------------------------

/** Yahoo accepts more, but URL length is the real constraint past this. */
export const QUOTE_BATCH_SIZE = 200;

interface Credential {
  cookie: string;
  crumb: string;
}

/** Held for the life of the isolate; a crumb outlives one invocation easily. */
let credential: Promise<Credential> | null = null;

function cookiesFrom(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  // Only `name=value` matters to the server that set it; Path/Expires and the
  // rest are instructions to a browser we are not.
  return raw
    .filter(Boolean)
    .map((line) => line.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function acquire(): Promise<Credential> {
  // 404s, and is supposed to: the Set-Cookie header is the point, not the body.
  const seed = await fetchWithTimeout('https://fc.yahoo.com', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  const cookie = cookiesFrom(seed);
  if (!cookie) throw new Error('Yahoo set no cookie');

  const res = await fetchWithTimeout('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain', Cookie: cookie },
  });
  const crumb = (await res.text()).trim();

  // A refused attempt answers with an HTML page rather than a token, which would
  // otherwise be passed along as a crumb and 401 forever.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new Error(`Yahoo returned no crumb (${res.status})`);
  }
  return { cookie, crumb };
}

function credentials(fresh = false): Promise<Credential> {
  if (fresh || !credential) {
    credential = acquire().catch((err) => {
      // Never remember a failure: the next caller should retry rather than
      // inherit a rejected promise for the life of the isolate.
      credential = null;
      throw err;
    });
  }
  return credential;
}

export interface YahooQuote {
  symbol?: string;
  regularMarketPrice?: number | null;
  regularMarketPreviousClose?: number | null;
  /** Epoch seconds of the last trade. */
  regularMarketTime?: number | null;
  marketCap?: number | null;
}

/**
 * One batch of up to `QUOTE_BATCH_SIZE` tickers.
 *
 * Retried once with a fresh credential on 401/403: a crumb does expire, and the
 * alternative is a dead endpoint for the rest of the invocation.
 */
export async function fetchYahooQuoteBatch(tickers: string[]): Promise<YahooQuote[]> {
  if (tickers.length === 0) return [];
  const query = encodeURIComponent(tickers.join(','));

  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await credentials(attempt > 0);
    const res = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${query}` +
        `&crumb=${encodeURIComponent(auth.crumb)}`,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Cookie: auth.cookie } },
    );

    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (!res.ok) throw new Error(`Yahoo quote returned ${res.status}`);

    const payload = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
    return payload.quoteResponse?.result ?? [];
  }

  throw new Error('Yahoo refused the crumb twice');
}

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
