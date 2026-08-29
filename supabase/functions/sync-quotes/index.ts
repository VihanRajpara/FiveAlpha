// Refreshes public.quotes for every symbol via Yahoo's batch quote endpoint.
//
// Was 262 spark requests at 20 tickers each; is now 27 at 200. See the header of
// _shared/yahoo.ts for why the endpoint changed — the short version is that
// spark answers out of intraday *chart bars*, so every thinly traded scrip that
// did not print a 5-minute bar came back with no price at all. 508 of the 5,229
// rows in the table were unpriced for that reason on 2026-08-29; /v7 priced
// 5,088 of them in 2.8 seconds, leaving 141.
//
// Market cap now rides along, because /v7 returns it in the same response.
import {
  adminClient,
  assertAuthorized,
  chunk,
  CORS_HEADERS,
  json,
  mapPool,
  toNseTicker,
} from '../_shared/upstream.ts';
import { fetchYahooQuoteBatch, QUOTE_BATCH_SIZE } from '../_shared/yahoo.ts';

/**
 * Fewer in flight than the old spark pass used, and deliberately: each request
 * now carries ten times the payload, so eight of these is 1,600 symbols being
 * priced at once. The whole universe is 27 requests — concurrency stopped being
 * what governs the wall clock.
 */
const CONCURRENCY = 4;

/** Yahoo answers in rupees; the app is written in Rs crore throughout. */
const CRORE = 1e7;

interface QuoteRow {
  symbol: string;
  price: number | null;
  previous_close: number | null;
  market_cap_cr: number | null;
  /** Vendor timestamp of the price itself — requires migration 0003. */
  price_time: string | null;
  updated_at: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const supabase = adminClient();

    // PostgREST caps responses at 1000 rows, so page through the symbol list.
    // `*` rather than naming yahoo_ticker: that would 400 outright on a database
    // that hasn't run migration 0005, where falling back to `SYMBOL.NS` is
    // exactly right because every row there is an NSE listing.
    const targets: { symbol: string; ticker: string }[] = [];
    for (let page = 0; ; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('*')
        .order('symbol')
        .range(from, from + 999);
      if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);
      const batch = (data ?? []) as { symbol: string; yahoo_ticker?: string | null }[];
      targets.push(
        ...batch.map((r) => ({ symbol: r.symbol, ticker: r.yahoo_ticker || toNseTicker(r.symbol) })),
      );
      if (batch.length < 1000) break;
    }

    if (targets.length === 0) {
      return json({ error: 'securities is empty — run sync-securities first' }, 409);
    }

    const now = new Date().toISOString();
    let failedBatches = 0;

    const batches = await mapPool(
      chunk(targets, QUOTE_BATCH_SIZE),
      CONCURRENCY,
      async (batch): Promise<QuoteRow[]> => {
        try {
          const quotes = await fetchYahooQuoteBatch(batch.map((t) => t.ticker));

          // Yahoo keys its answer by ticker and drops what it does not carry, so
          // index it and then walk the *request*. Rows are keyed back to
          // `symbol`, which is the securities primary key and what the table
          // joins on — the ticker is only ever the vendor's name for the row.
          const byTicker = new Map<string, typeof quotes[number]>();
          for (const q of quotes) if (q.symbol) byTicker.set(q.symbol, q);

          return batch
            .map(({ symbol, ticker }) => {
              const q = byTicker.get(ticker);
              const price = typeof q?.regularMarketPrice === 'number' ? q.regularMarketPrice : null;
              const prev =
                typeof q?.regularMarketPreviousClose === 'number'
                  ? q.regularMarketPreviousClose
                  : null;
              const cap = typeof q?.marketCap === 'number' ? q.marketCap / CRORE : null;
              // `> 0`, not just "is a number": Yahoo returns a literal 0 for a
              // handful of dormant scrips, and epoch 0 stores as 1970-01-01 —
              // which reads as a real timestamp everywhere downstream rather
              // than as the "unknown" it actually means.
              const stamp =
                typeof q?.regularMarketTime === 'number' && q.regularMarketTime > 0
                  ? q.regularMarketTime
                  : null;

              return {
                symbol,
                price,
                previous_close: prev,
                market_cap_cr: cap,
                price_time: stamp !== null ? new Date(stamp * 1000).toISOString() : null,
                updated_at: now,
              };
            })
            // A row with neither figure is one Yahoo has nothing for. Writing it
            // would only overwrite a good older price with a null.
            .filter((r) => r.price !== null || r.previous_close !== null);
        } catch (err) {
          failedBatches++;
          console.warn(`Quote batch of ${batch.length} failed`, err);
          return [];
        }
      },
    );

    const rows = batches.flat();

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('quotes')
        .upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert' }, 500);
    }

    return json({
      ok: true,
      requested: targets.length,
      priced: rows.length,
      requests: Math.ceil(targets.length / QUOTE_BATCH_SIZE),
      failedBatches,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
