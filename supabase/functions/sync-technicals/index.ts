// Fills public.metrics.monthly_rsi14 for the whole universe.
//
// The RSI(M) column used to be a by-product of a screen run: `useScreen` fetched
// monthly bars for the rows a run reached, and every other row rendered an em
// dash forever. The figure is not expensive, it is just too slow to do in a
// browser on every page load — 5,229 symbols at 20 per spark request is ~260
// requests. Once a night on a server it is a rounding error, and the column is
// then populated for every row before anyone clicks anything.
//
// Monthly closes change meaningfully once a month, so a nightly pass is already
// far more often than the data moves.
import {
  adminClient,
  assertAuthorized,
  chunk,
  CORS_HEADERS,
  json,
  mapPool,
  toNseTicker,
} from '../_shared/upstream.ts';
import { fetchMonthlyCloses, MIN_RSI_BARS, rsi, SPARK_BATCH_SIZE } from '../_shared/yahoo.ts';

/**
 * Spark tolerates this comfortably — measured at 24 in flight from a browser in
 * src/hooks/useScreen.ts with no non-200s. Eight here because an Edge Function
 * has a wall-clock budget and no user watching a progress bar: finishing inside
 * the invocation matters more than finishing fast.
 */
const CONCURRENCY = 8;

/**
 * Symbols per invocation, oldest reading first.
 *
 * The whole universe fits in one pass today (~260 requests at 20 symbols), but
 * the cap is here so the function has a bounded cost as the list grows and so a
 * partial run still makes progress rather than timing out having written
 * nothing. `rsi_at nulls first` means a never-computed symbol always outranks a
 * stale one.
 */
const BATCH_LIMIT = 6000;

interface MetricRow {
  symbol: string;
  monthly_rsi14: number | null;
  bars: number;
  rsi_at: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const supabase = adminClient();

    const targets: { symbol: string; ticker: string }[] = [];
    for (let page = 0; targets.length < BATCH_LIMIT; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('symbol, yahoo_ticker')
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
    let unreachable = 0;

    const batches = await mapPool(
      chunk(targets, SPARK_BATCH_SIZE),
      CONCURRENCY,
      async (batch): Promise<MetricRow[]> => {
        try {
          const closes = await fetchMonthlyCloses(batch.map((t) => t.ticker));

          const rows: MetricRow[] = [];
          for (const { symbol, ticker } of batch) {
            const series = closes.get(ticker);
            // Yahoo carries no history at all for a lot of thin BSE scrips.
            // Writing a null RSI for them would be honest but pointless — the
            // row already renders an em dash without one, and skipping keeps the
            // table to symbols something is actually known about.
            if (!series || series.length === 0) {
              unreachable++;
              continue;
            }
            rows.push({
              symbol,
              // Short histories get a null rather than a reading computed over
              // too few bars: an RSI off six months of data is a number, not an
              // answer, and the screens read null as "cannot judge".
              monthly_rsi14: series.length >= MIN_RSI_BARS ? rsi(series) : null,
              bars: series.length,
              rsi_at: now,
            });
          }
          return rows;
        } catch (err) {
          failedBatches++;
          console.warn(`Monthly batch of ${batch.length} failed`, err);
          return [];
        }
      },
    );

    const rows = batches.flat();

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('metrics')
        .upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert' }, 500);
    }

    return json({
      ok: true,
      requested: targets.length,
      computed: rows.length,
      withReading: rows.filter((r) => r.monthly_rsi14 !== null).length,
      unreachable,
      failedBatches,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
