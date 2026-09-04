// Refreshes public.quotes for every symbol, from Upstox and nothing else.
//
// One source, one request shape, 500 instruments at a time. Measured against
// the live 5,831-row table on 2026-08-31: **5,680 rows priced in 1.0s over 12
// requests**, every one of them carrying the exchange's own print time.
//
// What this replaced, and why none of it is coming back:
//
//   · **Yahoo /v7** priced 5,088 rows behind an undocumented cookie+crumb
//     handshake that 401s without warning, and left ~150 unpriced. It also
//     supplied `market_cap_cr` — that moves to sync-fundamentals, which is
//     already per-ISIN and where a figure that changes with the price but is
//     read as a two-orders-of-magnitude band actually belongs.
//   · **The NSE bhavcopy walk-back** existed solely because Yahoo's Emerge
//     prices froze in July 2024. It downloaded ~390 KB per session and walked
//     back up to twelve days to price 539 of 565 SME rows at an end-of-day
//     close up to four days old. Upstox prices **560 of 565 live**.
//
// Without a token — `private.sync_config.upstox_token`, see migration 0011 —
// this function writes nothing and says so. That is deliberate: a silent
// fallback to a worse source is how a table fills with figures nobody can
// account for.
import {
  adminClient,
  assertAuthorized,
  CORS_HEADERS,
  json,
} from '../_shared/upstream.ts';
import {
  fetchUpstoxQuotes,
  hasUpstox,
  loadUpstoxToken,
  QUOTE_BATCH_SIZE,
  toInstrumentKey,
} from '../_shared/upstox.ts';

/**
 * The NSE Emerge settlement series.
 *
 * Kept only to report on them separately. They are no longer a special case in
 * the pricing itself — Upstox quotes an Emerge instrument through the same
 * endpoint as RELIANCE, which is the entire point of the change.
 */
const SME_SERIES = new Set(['SM', 'ST', 'SZ']);

interface Target {
  symbol: string;
  /** Null where the ISIN is missing or malformed. Those rows cannot be priced. */
  instrumentKey: string | null;
  isSme: boolean;
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

    // The stored token wins over the env var, so rotating it is a statement
    // rather than a redeploy. See migration 0011.
    await loadUpstoxToken(supabase);

    if (!hasUpstox()) {
      return json(
        {
          error: 'no Upstox token is configured',
          hint:
            'Generate an Analytics Token (Upstox -> Apps -> My Apps -> Analytics), then ' +
            "`select public.upstox_token_set('...')`. This function has no second source.",
        },
        503,
      );
    }

    // -----------------------------------------------------------------------
    // The universe.
    //
    // PostgREST caps responses at 1000 rows, so page through it. `*` rather
    // than naming columns: that would 400 outright on a database that has not
    // run migration 0005, and every row on such a database is an NSE listing
    // anyway.
    // -----------------------------------------------------------------------
    const targets: Target[] = [];
    for (let page = 0; ; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('*')
        .order('symbol')
        .range(from, from + 999);
      if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);

      const batch = (data ?? []) as {
        symbol: string;
        series?: string | null;
        isin?: string | null;
        exchanges?: string[] | null;
      }[];

      for (const r of batch) {
        targets.push({
          symbol: r.symbol,
          instrumentKey: toInstrumentKey(r.isin ?? '', r.exchanges ?? null),
          isSme: SME_SERIES.has(r.series ?? ''),
        });
      }
      if (batch.length < 1000) break;
    }

    if (targets.length === 0) {
      return json({ error: 'securities is empty — run sync-securities first' }, 409);
    }

    // -----------------------------------------------------------------------
    // Price everything.
    // -----------------------------------------------------------------------
    const keyed = targets.filter((t) => t.instrumentKey !== null);
    const upstox = await fetchUpstoxQuotes(keyed.map((t) => t.instrumentKey!));

    // A pass where every batch failed is a broken credential or a dead API, not
    // a market where nothing traded. Writing its emptiness over a good table
    // would turn one bad five-minute window into a blank screen.
    if (upstox.requests > 0 && upstox.failedBatches === upstox.requests) {
      return json(
        {
          error: 'every Upstox batch failed — nothing written',
          requests: upstox.requests,
          hint:
            'Most likely an expired or revoked token. Check `upstox_token_at` in ' +
            'private.sync_config, then `select public.upstox_token_set(...)` with a fresh one.',
        },
        502,
      );
    }

    const now = new Date().toISOString();
    const rows: QuoteRow[] = [];

    // Walk the *request*, not the response: an instrument Upstox does not carry
    // is simply absent from the payload, and rows are keyed back to `symbol`,
    // which is what the table joins on — the instrument key is only ever the
    // vendor's name for the row.
    for (const target of keyed) {
      const quote = upstox.quotes.get(target.instrumentKey!);
      if (!quote) continue;
      // A row with neither figure is one nothing traded in and nothing is known
      // about. Writing it would overwrite a good older price with a null.
      if (quote.price === null && quote.previousClose === null) continue;

      rows.push({
        symbol: target.symbol,
        price: quote.price,
        previous_close: quote.previousClose,
        price_time: quote.priceTime,
        updated_at: now,
      });
    }

    // `market_cap_cr` is deliberately absent from every row above rather than
    // written as null. PostgREST builds one statement from the shape of the
    // payload, so a column that appears in no row is never in the SET list and
    // whatever sync-fundamentals last wrote survives this pass untouched.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('quotes')
        .upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert' }, 500);
    }

    const priced = new Set(rows.map((r) => r.symbol));
    const smeTargets = targets.filter((t) => t.isSme);

    return json({
      ok: true,
      requested: targets.length,
      priced: rows.length,
      requests: upstox.requests,
      failedBatches: upstox.failedBatches,
      batchSize: QUOTE_BATCH_SIZE,
      // Rows Upstox has no instrument for, and rows whose ISIN will not form a
      // key. Both are unpriceable rather than unlucky, and both are worth
      // watching: a jump here means the master list and the table have drifted.
      unpriceable: {
        noIsin: targets.length - keyed.length,
        notCarried: keyed.length - rows.length,
      },
      sme: { total: smeTargets.length, priced: smeTargets.filter((t) => priced.has(t.symbol)).length },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
