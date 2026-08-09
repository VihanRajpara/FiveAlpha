// Mirrors NSE's EQUITY_L.csv into public.securities. Cheap and slow-moving —
// once a day is plenty, since the list only changes on listings/delistings.
import {
  adminClient,
  assertAuthorized,
  BROWSER_UA,
  CORS_HEADERS,
  fetchWithTimeout,
  json,
  parseCsvObjects,
  parseNseDate,
  toNumber,
} from '../_shared/upstream.ts';

const EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    // NSE 403s anything that doesn't look like its own site calling.
    const res = await fetchWithTimeout(EQUITY_LIST_URL, {
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: 'https://www.nseindia.com/',
        Accept: 'text/csv,application/csv,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, 30_000);

    if (!res.ok) return json({ error: `NSE responded ${res.status}` }, 502);

    const rows = parseCsvObjects(await res.text())
      .map((row) => ({
        symbol: row['SYMBOL'] ?? '',
        name: row['NAME OF COMPANY'] ?? '',
        series: row['SERIES'] ?? '',
        isin: row['ISIN NUMBER'] ?? '',
        listing_date: parseNseDate(row['DATE OF LISTING'] ?? ''),
        face_value: toNumber(row['FACE VALUE']),
        paid_up_value: toNumber(row['PAID UP VALUE']),
        market_lot: toNumber(row['MARKET LOT']),
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.symbol !== '');

    if (rows.length === 0) return json({ error: 'NSE returned an empty list' }, 502);

    const supabase = adminClient();

    // Chunked so a single statement never exceeds the request body limit.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('securities')
        .upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) return json({ error: error.message, stage: 'upsert' }, 500);
    }

    return json({ ok: true, securities: rows.length });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
