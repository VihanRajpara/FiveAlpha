// Backfills daily bars into public.candles.
//
// Yahoo's chart endpoint is one request per symbol, so all ~2,400 symbols cannot
// be done in a single invocation. Instead each run takes the N symbols whose
// candles are stalest (candles_synced_at nulls first) and advances the cursor.
// Run it on a short cron and the whole universe rotates through automatically.
import {
  adminClient,
  assertAuthorized,
  BROWSER_UA,
  CORS_HEADERS,
  fetchWithTimeout,
  json,
  mapPool,
  toYahooSymbol,
} from '../_shared/upstream.ts';

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 400;
const CONCURRENCY = 6;

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
  };
}

interface CandleRow {
  symbol: string;
  bar_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const url = new URL(req.url);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT),
    );
    // `range=1y` on the daily interval is the sweet spot: enough history for the
    // 1M/6M/1Y charts without pulling megabytes per symbol. Pass range=5y&interval=1wk
    // once for the initial deep backfill.
    const range = url.searchParams.get('range') ?? '1y';
    const interval = url.searchParams.get('interval') ?? '1d';

    const supabase = adminClient();

    const { data, error } = await supabase
      .from('securities')
      .select('symbol')
      .order('candles_synced_at', { ascending: true, nullsFirst: true })
      .limit(limit);

    if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);

    const symbols = ((data ?? []) as { symbol: string }[]).map((r) => r.symbol);
    if (symbols.length === 0) {
      return json({ error: 'securities is empty — run sync-securities first' }, 409);
    }

    let failed = 0;

    const perSymbol = await mapPool(symbols, CONCURRENCY, async (symbol): Promise<CandleRow[]> => {
      const endpoint =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}` +
        `?range=${range}&interval=${interval}`;
      try {
        const res = await fetchWithTimeout(endpoint, { headers: { 'User-Agent': BROWSER_UA } });
        if (!res.ok) { failed++; return []; }

        const payload = await res.json() as ChartResponse;
        const result = payload.chart?.result?.[0];
        if (!result?.timestamp) return [];

        const q = result.indicators?.quote?.[0] ?? {};
        return result.timestamp
          .map((ts, i) => ({
            symbol,
            bar_date: new Date(ts * 1000).toISOString().slice(0, 10),
            open: q.open?.[i] ?? null,
            high: q.high?.[i] ?? null,
            low: q.low?.[i] ?? null,
            close: q.close?.[i] ?? null,
            volume: q.volume?.[i] ?? null,
          }))
          .filter((c) => c.close !== null);
      } catch {
        failed++;
        return [];
      }
    });

    const rows = perSymbol.flat();

    for (let i = 0; i < rows.length; i += 1000) {
      const { error: upsertError } = await supabase
        .from('candles')
        .upsert(rows.slice(i, i + 1000), { onConflict: 'symbol,bar_date' });
      if (upsertError) return json({ error: upsertError.message, stage: 'upsert' }, 500);
    }

    // Advance the cursor for every symbol attempted, including the ones Yahoo
    // has no data for — otherwise they'd be retried forever and block the rotation.
    const { error: cursorError } = await supabase
      .from('securities')
      .update({ candles_synced_at: new Date().toISOString() })
      .in('symbol', symbols);
    if (cursorError) return json({ error: cursorError.message, stage: 'cursor' }, 500);

    return json({ ok: true, symbols: symbols.length, candles: rows.length, failed });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
