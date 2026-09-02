// Fills public.metrics.roce_pct and public.metrics.market_cap_cr from Upstox.
//
// **What this replaced.** ROCE used to be scraped off screener.in one company
// page at a time, paced 1.2s apart because that is the rate the site tolerates —
// 90 rows an invocation, a first full pass in about two and a half days, and an
// HTML ratio strip with no contract behind it. Market cap came from Yahoo's /v7
// quote, which arrived free with the price but behind a cookie+crumb handshake.
//
// Both are now JSON endpoints keyed by ISIN, which `securities` already stores
// as its merge key. Neither can be batched — one request per company each — so
// this stays a rotating incremental pass, but the pacing is now set by a
// published rate limit (50/sec, 500/min) rather than by how much scraping a
// third party will put up with. That is the difference between ~90 rows an hour
// and the whole universe in an afternoon.
//
// Two figures per company, deliberately in one function: they come from the
// same ISIN, on the same cadence, and splitting them would double the
// bookkeeping to save nothing.
import {
  adminClient,
  assertAuthorized,
  CORS_HEADERS,
  json,
  mapPool,
} from '../_shared/upstream.ts';
import { fetchUpstoxProfile, fetchUpstoxRoce, hasUpstox } from '../_shared/upstox.ts';

/**
 * Rows per invocation.
 *
 * Two requests per row, so 400 rows is 800 requests — inside the documented
 * 2000-per-30-minutes ceiling with room to spare, and comfortably inside an
 * Edge Function's wall clock at this concurrency. Hourly, that is ~9,600 rows a
 * day against a 5,831-row universe: a full pass every fifteen hours or so,
 * which is far more often than an annual figure moves. Override with `?limit=`
 * for a manual backfill.
 */
const DEFAULT_SLICE = 400;

/**
 * Eight in flight. The limit is 50/sec and these are small JSON responses; this
 * is set well under it because nothing here is racing a user, and a rate limit
 * tripped on a background job costs the whole slice.
 */
const CONCURRENCY = 8;

interface Target {
  symbol: string;
  isin: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  if (!hasUpstox()) {
    return json(
      {
        error: 'UPSTOX_ACCESS_TOKEN is not set on this function',
        hint:
          'Generate an Analytics Token (Upstox -> Apps -> My Apps -> Analytics), then ' +
          '`supabase secrets set UPSTOX_ACCESS_TOKEN=...`.',
      },
      503,
    );
  }

  try {
    const supabase = adminClient();
    const slice = Number(new URL(req.url).searchParams.get('limit')) || DEFAULT_SLICE;

    // -----------------------------------------------------------------------
    // Least recently read first.
    //
    // `metrics` may have no row for a symbol yet, so the queue is built from
    // `securities` left-joined to it — a symbol with no metrics row has never
    // been read and must outrank every stale one.
    //
    // Paged rather than given a large `limit`: PostgREST caps a response at
    // 1000 rows whatever the limit says, so a single call would quietly
    // consider only the alphabetical first thousand symbols and never reach
    // anything after ~BAJAJ. The whole list has to be in hand before it can be
    // sorted by staleness, because the sort key lives in the embedded resource.
    // -----------------------------------------------------------------------
    const rows: {
      symbol: string;
      isin: string | null;
      metrics: { roce_at: string | null }[] | null;
    }[] = [];

    for (let page = 0; ; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('symbol, isin, metrics(roce_at)')
        .order('symbol')
        .range(from, from + 999);
      if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < 1000) break;
    }

    const queue: Target[] = rows
      // No ISIN, no request to make: both endpoints are keyed by it.
      .filter((r) => /^[A-Za-z0-9]{12}$/.test((r.isin ?? '').trim()))
      .map((r) => ({
        target: { symbol: r.symbol, isin: (r.isin ?? '').trim() },
        // Nulls sort first: never-read beats stale, always.
        at: r.metrics?.[0]?.roce_at ?? '',
      }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, slice)
      .map((r) => r.target);

    const now = new Date().toISOString();
    const metricRows: { symbol: string; roce_pct: number | null; roce_at: string }[] = [];
    const capRows: { symbol: string; market_cap_cr: number; market_cap_at: string }[] = [];

    await mapPool(queue, CONCURRENCY, async (target) => {
      // Settled independently: a company with no key-ratios entry may still
      // have a profile, and losing one figure should not cost the other.
      const [roce, profile] = await Promise.all([
        fetchUpstoxRoce(target.isin),
        fetchUpstoxProfile(target.isin),
      ]);

      // Stamped even when the figure is null: "asked, nothing there" is an
      // answer, and without the stamp the row would be retried every run and
      // starve every symbol behind it in the queue.
      metricRows.push({ symbol: target.symbol, roce_pct: roce, roce_at: now });

      // Market cap is only written when there is one. A null here would blank a
      // good figure on a company Upstox happens to carry no profile for, and
      // the screens read a missing cap as "cannot judge" rather than as zero.
      if (profile?.marketCapCr !== null && profile?.marketCapCr !== undefined) {
        capRows.push({
          symbol: target.symbol,
          market_cap_cr: profile.marketCapCr,
          market_cap_at: now,
        });
      }
    });

    for (let i = 0; i < metricRows.length; i += 500) {
      const { error } = await supabase
        .from('metrics')
        .upsert(metricRows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert-metrics' }, 500);
    }

    // A second pass over the same table rather than one merged payload:
    // PostgREST requires every row of an upsert to carry the same keys, and a
    // company with no profile must be *absent* from this payload rather than
    // present with a null — a null would be in the SET list and would blank a
    // good figure. `roce_pct` is absent here for the same reason, so the pass
    // above survives untouched. Requires migration 0010, which moved the column
    // off `quotes` and onto the table whose cadence it follows.
    for (let i = 0; i < capRows.length; i += 500) {
      const { error } = await supabase
        .from('metrics')
        .upsert(capRows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert-market-cap' }, 500);
    }

    return json({
      ok: true,
      queued: queue.length,
      withRoce: metricRows.filter((r) => r.roce_pct !== null).length,
      withMarketCap: capRows.length,
      requests: queue.length * 2,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
