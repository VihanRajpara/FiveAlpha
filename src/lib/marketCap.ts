import { chunk, mapPool } from './format';
import { isUnknownTicker, markUnknownTicker } from './yahooCandles';

/**
 * Market cap for a whole universe, two hundred symbols per request.
 *
 * The screens in src/lib/screens.ts have a market-cap band, and until now the
 * only source for it was a screener.in company page — one request per row,
 * paced 1.2s apart, which made that single leg the length of a screen run. It
 * is also the *cheapest* leg to answer in bulk: Yahoo's `/v7/finance/quote`
 * carries `marketCap` for hundreds of symbols at once, and its figures agree
 * with screener.in's (TCS ₹842,580 Cr, Thyrocare ₹9,768 Cr on the day this was
 * written).
 *
 * So the leg moves to the front of the run: ten requests answer it for all
 * 2,410 NSE rows, and everything the band excludes is rejected before a single
 * bar of price history — or a single screener.in page — is paid for.
 *
 * What the endpoint costs is a credential; see worker/yahooQuote.ts, where the
 * cookie/crumb dance lives. Everything here treats an unanswered symbol as
 * **unknown**, never as a failure: a missing market cap leaves the leg
 * unjudged, the row carries on through the run, and the screener.in scrape
 * supplies the figure the way it always did. That is what makes this an
 * optimisation rather than a dependency.
 */

/** Yahoo answers in rupees; every screen is written in ₹ crore. */
const CRORE = 1e7;

/**
 * Symbols per request. Kept here rather than imported from the proxy module so
 * that server-only code stays out of the browser bundle; `QUOTE_BATCH_SIZE` in
 * worker/yahooQuote.ts is the same number and rejects anything above it, so the
 * two drifting apart is a 400 rather than a silent truncation.
 */
const BATCH_SIZE = 200;

interface QuoteResponse {
  quoteResponse?: {
    result?: { symbol?: string; marketCap?: number | null }[];
  };
}

/**
 * Enough to cover a whole-market run's worth of batches without holding the
 * browser's connections open against the price work that follows.
 */
const CONCURRENCY = 4;

/**
 * Answers for the life of the tab. Not a `dayCache`: this is a live figure that
 * moves with the price, it costs ten requests to rebuild, and the band it feeds
 * is two orders of magnitude wide — remembering it across a reload would trade
 * accuracy for nothing worth having.
 */
const cache = new Map<string, number | null>();

/**
 * `ticker` → market cap in ₹ crore, or null where Yahoo has none.
 *
 * Never throws: a refused credential, a blocked endpoint or a dead ticker all
 * come back as an absent entry, and the caller reads that as "not known here".
 */
export async function fetchMarketCaps(
  tickers: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  const wanted: string[] = [];
  for (const ticker of tickers) {
    if (cache.has(ticker)) {
      const hit = cache.get(ticker);
      if (typeof hit === 'number') out.set(ticker, hit);
    } else if (!isUnknownTicker(ticker) && !wanted.includes(ticker)) {
      // A symbol Yahoo has already denied knowing has no market cap either, and
      // unlike `cache` that answer survives a reload — which is the difference
      // between paying for the ~565 SME rows once and paying every session.
      wanted.push(ticker);
    }
  }
  if (wanted.length === 0) return out;

  await mapPool(chunk(wanted, BATCH_SIZE), CONCURRENCY, async (batch) => {
    if (signal?.aborted) return;

    try {
      const url = `/api/yquote?symbols=${encodeURIComponent(batch.join(','))}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Quote batch returned ${res.status}`);

      const payload = (await res.json()) as QuoteResponse;
      for (const quote of payload.quoteResponse?.result ?? []) {
        if (!quote.symbol) continue;
        const cap = typeof quote.marketCap === 'number' ? quote.marketCap / CRORE : null;
        // Cached either way: a symbol Yahoo does not carry is an answer, and
        // re-asking for it on the next run costs a slot in a batch.
        cache.set(quote.symbol, cap);
        if (cap !== null) out.set(quote.symbol, cap);
      }

      // Symbols Yahoo silently dropped — the same behaviour `spark` has, and
      // the same meaning: no such symbol, so tell everything else that asks.
      for (const ticker of batch) {
        if (cache.has(ticker)) continue;
        cache.set(ticker, null);
        markUnknownTicker(ticker);
      }
    } catch (err) {
      if (signal?.aborted) return;
      // Deliberately swallowed. Nothing is cached, so a later run retries, and
      // every row in this batch simply goes on to be judged the old way.
      console.warn(`Market cap batch failed (${batch.length} symbols)`, err);
    }
  });

  return out;
}
