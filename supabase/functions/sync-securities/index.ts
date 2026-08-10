// Mirrors the NSE and BSE master lists into public.securities, merged on ISIN
// into one row per company. Cheap and slow-moving — once a day is plenty, since
// the lists only change on listings, delistings and group reclassifications.
//
// Requires migration 0005_bse.sql. Without the `exchanges` / `yahoo_ticker`
// columns the upsert is rejected rather than silently writing BSE-only rows that
// would then be priced as if they were NSE symbols.
import {
  adminClient,
  assertAuthorized,
  BSE_HEADERS,
  BSE_LIST_URL,
  CORS_HEADERS,
  EQUITY_LIST_URL,
  fetchWithTimeout,
  json,
  mergeListings,
  NSE_HEADERS,
  parseBseScrips,
  parseNseSecurities,
  type BseScrip,
} from '../_shared/upstream.ts';

/** BSE's scrip master is ~1.8 MB, so it needs more headroom than the NSE CSV. */
const BSE_TIMEOUT_MS = 45_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const now = new Date().toISOString();

    // Fetched together and settled independently: BSE is the flakier upstream,
    // and losing it should cost the BSE-only rows, not the whole sync.
    const [nseResult, bseResult] = await Promise.allSettled([
      (async () => {
        const res = await fetchWithTimeout(EQUITY_LIST_URL, { headers: NSE_HEADERS }, 30_000);
        if (!res.ok) throw new Error(`NSE responded ${res.status}`);
        return parseNseSecurities(await res.text(), now);
      })(),
      (async (): Promise<BseScrip[]> => {
        const res = await fetchWithTimeout(BSE_LIST_URL, { headers: BSE_HEADERS }, BSE_TIMEOUT_MS);
        if (!res.ok) throw new Error(`BSE responded ${res.status}`);
        return parseBseScrips(await res.json());
      })(),
    ]);

    if (nseResult.status === 'rejected') {
      return json({ error: String(nseResult.reason), stage: 'fetch-nse' }, 502);
    }

    const bseError = bseResult.status === 'rejected' ? String(bseResult.reason) : null;
    const scrips = bseResult.status === 'fulfilled' ? bseResult.value : [];

    const rows = mergeListings(nseResult.value, scrips, now);
    if (rows.length === 0) return json({ error: 'NSE returned an empty list' }, 502);

    // With BSE unreachable the merge sees no scrips, so every row it produces
    // claims `{NSE}` and a null scrip code. Writing that would demote yesterday's
    // correctly-merged dual listings on nothing more than a timeout — so those
    // two columns are dropped from the payload and whatever is already stored
    // survives. `yahoo_ticker` stays: for an NSE row it is `SYMBOL.NS` either
    // way, and it is NOT NULL with no default, so a newly listed symbol still
    // needs one to insert at all.
    const payload = bseError
      ? rows.map(({ exchanges: _e, bse_code: _b, ...rest }) => rest)
      : rows;

    const supabase = adminClient();

    // Chunked so a single statement never exceeds the request body limit.
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await supabase
        .from('securities')
        .upsert(payload.slice(i, i + 500), { onConflict: 'symbol' });

      if (error) {
        // PGRST204 on one of the 0005 columns means the migration hasn't run.
        const missingColumn = /exchanges|yahoo_ticker|bse_code/.test(error.message) &&
          /PGRST204|schema cache|column/i.test(error.message);
        return json({
          error: error.message,
          stage: 'upsert',
          hint: missingColumn
            ? 'Run supabase/migrations/0005_bse.sql — this function will not write BSE rows without it.'
            : undefined,
        }, 500);
      }
    }

    const onBse = rows.filter((r) => r.exchanges.includes('BSE')).length;

    return json({
      ok: true,
      securities: rows.length,
      nse: rows.filter((r) => r.exchanges.includes('NSE')).length,
      bse: onBse,
      bseOnly: rows.filter((r) => !r.exchanges.includes('NSE')).length,
      // Surfaced rather than thrown: the sync still updated every NSE row.
      bseError,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
