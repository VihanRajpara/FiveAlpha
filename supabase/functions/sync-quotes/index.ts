// Refreshes public.quotes for every symbol via Yahoo's spark endpoint.
// ~2,400 symbols / 20 per request = ~120 upstream calls, which fits comfortably
// inside one invocation at concurrency 8.
import {
  adminClient,
  assertAuthorized,
  BROWSER_UA,
  chunk,
  CORS_HEADERS,
  fetchWithTimeout,
  json,
  mapPool,
  SPARK_BATCH_SIZE,
  toYahooSymbol,
} from '../_shared/upstream.ts';

const CONCURRENCY = 8;

interface SparkEntry {
  close?: (number | null)[] | null;
  chartPreviousClose?: number | null;
  previousClose?: number | null;
  /** Epoch seconds, index-aligned with `close`. */
  timestamp?: number[] | null;
}

interface QuoteRow {
  symbol: string;
  price: number | null;
  previous_close: number | null;
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
    const symbols: string[] = [];
    for (let page = 0; ; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('symbol')
        .order('symbol')
        .range(from, from + 999);
      if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);
      const batch = (data ?? []) as { symbol: string }[];
      symbols.push(...batch.map((r) => r.symbol));
      if (batch.length < 1000) break;
    }

    if (symbols.length === 0) {
      return json({ error: 'securities is empty — run sync-securities first' }, 409);
    }

    const now = new Date().toISOString();
    let failedBatches = 0;

    const batches = await mapPool(
      chunk(symbols, SPARK_BATCH_SIZE),
      CONCURRENCY,
      async (batch): Promise<QuoteRow[]> => {
        const query = batch.map(toYahooSymbol).join(',');
        // interval=5m, not 1d: a daily bar carries the session OPEN as its
        // timestamp (09:15 IST), so a current price would be dated hours ago.
        const url =
          `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(query)}` +
          `&range=1d&interval=5m`;
        try {
          const res = await fetchWithTimeout(url, { headers: { 'User-Agent': BROWSER_UA } });
          if (!res.ok) { failedBatches++; return []; }

          const payload = await res.json() as Record<string, SparkEntry | null>;

          // Yahoo drops unknown tickers from the response, so iterate the request.
          return batch.map((symbol) => {
            const entry = payload[toYahooSymbol(symbol)];
            const closeArr = entry?.close ?? [];
            const stamps = entry?.timestamp ?? [];

            // Last bar that actually traded — price and timestamp from the same
            // index, so null trailing bars can't make a stale price look fresh.
            let i = closeArr.length - 1;
            while (i >= 0 && typeof closeArr[i] !== 'number') i--;

            const stamp = i >= 0 && typeof stamps[i] === 'number' ? stamps[i] : null;
            return {
              symbol,
              price: i >= 0 ? (closeArr[i] as number) : null,
              previous_close: entry?.chartPreviousClose ?? entry?.previousClose ?? null,
              price_time: stamp !== null ? new Date(stamp * 1000).toISOString() : null,
              updated_at: now,
            };
          }).filter((r) => r.price !== null || r.previous_close !== null);
        } catch {
          failedBatches++;
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
      requested: symbols.length,
      priced: rows.length,
      failedBatches,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
