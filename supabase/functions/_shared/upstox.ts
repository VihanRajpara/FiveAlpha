// Upstox market data. Deno runtime (Supabase Edge Functions).
//
// One credential, in one of two shapes. An **Analytics Token** is read-only and
// valid for a year, and is what this is written for. The **OAuth token** the API
// more commonly issues expires at 3:30 AM IST daily and has no refresh — see
// plan.md, "The one thing that decides everything".
//
// The env var is only the fallback. The live value is `private.sync_config.
// upstox_token`, loaded per invocation by each caller and pushed in here with
// `setUpstoxToken` (migration 0011). That indirection exists for exactly one
// reason: a module-level `const Deno.env.get(...)` makes rotating the credential
// a `secrets set` plus a redeploy, which is a build every morning on the daily
// token. From the database it is one statement and the next invocation has it.
//
// **Everything here treats an absent or refused token as "no figures this
// pass", never as an error.** The Yahoo path this sits in front of still works,
// and a project that cannot run without a broker credential would have lost the
// zero-setup mode the app is built around. Callers check `hasUpstox()` and fall
// back; nothing below throws on a bad credential.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { chunk, fetchWithTimeout, mapPool } from './upstream.ts';

let TOKEN = (Deno.env.get('UPSTOX_ACCESS_TOKEN') ?? '').trim();

/**
 * Reads the stored token and makes it the one this invocation uses.
 *
 * Failure of any kind — the RPC missing on a database that has not run 0011, an
 * empty column, a permission error — leaves the env-var value in place rather
 * than clearing it. An existing `supabase secrets set` deployment keeps working
 * unchanged, which is what makes this migration safe to apply before the
 * database has a token in it.
 */
export async function loadUpstoxToken(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.rpc('upstox_token_get');
  const stored = typeof data === 'string' ? data.trim() : '';
  if (stored) TOKEN = stored;
}

/** Whether a token is configured at all. Not whether it still works. */
export const hasUpstox = (): boolean => TOKEN.length > 0;

/**
 * Instrument keys per request.
 *
 * Measured 2026-08-31 against the live API: 500 keys answer 200, **501 answers
 * 400** (`UDAPI100042`). Eleven of these cover the app's 5,229-row universe.
 */
export const QUOTE_BATCH_SIZE = 500;

/**
 * Four at a time. The documented limit is 50/sec and eleven requests is the
 * whole market, so concurrency stopped being what governs the wall clock — this
 * is only here to keep a full pass off a single serial chain.
 */
const CONCURRENCY = 4;

/**
 * `NSE_EQ|INE002A01018` — the segment, a pipe, and the ISIN.
 *
 * Not a guess. Measured over the published NSE master: `instrument_key` equals
 * `segment + '|' + isin` for **9,700 of 9,700** rows, and no ISIN appears twice
 * within a segment. That is what makes this derivable from a column
 * `securities` already stores, instead of needing a 35 MB instrument dump in
 * every invocation or a new column to hold it.
 *
 * NSE wins for a dual-listed company, matching `mergeListings()`, which keeps
 * everything NSE for those rows because it is the more liquid book.
 *
 * Null where the ISIN is missing — `securities.isin` defaults to `''` — or
 * malformed. Those rows simply go on to be priced the old way.
 */
export function toInstrumentKey(isin: string, exchanges: string[] | null): string | null {
  const trimmed = (isin ?? '').trim();
  // Same 12-character test `mergeListings` joins on: BSE ships placeholder rows
  // whose ISIN is the literal "NA".
  if (!/^[A-Za-z0-9]{12}$/.test(trimmed)) return null;
  const segment = (exchanges ?? []).includes('NSE') ? 'NSE_EQ' : 'BSE_EQ';
  return `${segment}|${trimmed}`;
}

export interface UpstoxQuote {
  price: number | null;
  previousClose: number | null;
  /** The exchange's own print time, as an ISO instant. */
  priceTime: string | null;
}

interface QuoteEntry {
  instrument_token?: string;
  last_price?: number | null;
  net_change?: number | null;
  /** ISO 8601 with an IST offset, e.g. `2026-08-31T22:04:47.266+05:30`. */
  timestamp?: string | null;
}

/**
 * One batch of at most `QUOTE_BATCH_SIZE` keys, or null if the call failed.
 *
 * `/market-quote/quotes` rather than the leaner `/v3/market-quote/ltp`, and the
 * reason is one field: **LTP carries no timestamp.** `quotes.price_time` means
 * "when the vendor says this price printed", and stamping `now` on a market
 * that closed hours ago is precisely the staleness the Emerge work existed to
 * get rid of. The full quote is ~440 KB per 500 keys against LTP's ~63 KB,
 * which is a trade worth making once every five minutes.
 *
 * Previous close comes from `last_price - net_change`; the `ohlc` block in this
 * response is the *current* session's, so its `close` is today's last trade
 * rather than yesterday's.
 */
async function fetchBatch(keys: string[]): Promise<Map<string, UpstoxQuote> | null> {
  const out = new Map<string, UpstoxQuote>();
  if (keys.length === 0) return out;

  const query = encodeURIComponent(keys.join(','));
  const res = await fetchWithTimeout(
    `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${query}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` } },
    30_000,
  );

  if (!res.ok) {
    // A refused credential is reported once per batch and swallowed. The caller
    // reads null as "ask Yahoo instead", which is the whole contract here.
    console.warn(`Upstox quotes returned ${res.status} for ${keys.length} keys`);
    return null;
  }

  const payload = (await res.json()) as { data?: Record<string, QuoteEntry> };

  // The response is keyed by `SEGMENT:trading_symbol` — *not* by the
  // instrument key that was asked for — so index on `instrument_token`, which
  // is the only field that echoes the request.
  for (const entry of Object.values(payload.data ?? {})) {
    const key = entry?.instrument_token;
    if (!key) continue;

    const price = typeof entry.last_price === 'number' ? entry.last_price : null;
    const change = typeof entry.net_change === 'number' ? entry.net_change : null;

    out.set(key, {
      // A literal 0 is not a price. Dormant scrips report one, and it would
      // read downstream as a real quote rather than as "nothing traded".
      price: price !== null && price > 0 ? price : null,
      previousClose: price !== null && change !== null && price - change > 0 ? price - change : null,
      priceTime: parseStamp(entry.timestamp),
    });
  }

  return out;
}

/** The vendor's IST-offset timestamp, or null if it is absent or unparseable. */
function parseStamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Quotes for as many keys as asked for, keyed by instrument key.
 *
 * A key that is absent from the result is one Upstox did not answer for — a
 * dead instrument, or a failed batch. The caller cannot tell the two apart and
 * should not try: both mean "no Upstox figure for this row", and both are
 * handled by falling through to what priced it before.
 */
export async function fetchUpstoxQuotes(keys: string[]): Promise<{
  quotes: Map<string, UpstoxQuote>;
  requests: number;
  failedBatches: number;
}> {
  const quotes = new Map<string, UpstoxQuote>();
  if (!hasUpstox() || keys.length === 0) {
    return { quotes, requests: 0, failedBatches: 0 };
  }

  const batches = chunk(keys, QUOTE_BATCH_SIZE);
  let failedBatches = 0;

  const results = await mapPool(batches, CONCURRENCY, async (batch) => {
    try {
      return await fetchBatch(batch);
    } catch (err) {
      console.warn(`Upstox batch of ${batch.length} threw`, err);
      return null;
    }
  });

  for (const result of results) {
    if (result === null) {
      failedBatches++;
      continue;
    }
    for (const [key, quote] of result) quotes.set(key, quote);
  }

  return { quotes, requests: batches.length, failedBatches };
}

// ---------------------------------------------------------------------------
// Fundamentals — one ISIN per request.
//
// This is the half that cannot be batched, and it is why the figures it
// supplies live on a rotating incremental schedule rather than on the
// five-minute quote pass. Both endpoints are keyed by ISIN, which `securities`
// already stores as its merge key, so no lookup is needed to call them.
// ---------------------------------------------------------------------------

/**
 * Return on capital employed, as a percentage.
 *
 * Measured against screener.in over 14 companies weighted towards the `> 10`
 * threshold the screens actually test: **0 of 14 landed on opposite sides of
 * it**, and RELIANCE reads 10.39 against screener.in's consolidated 10.3 —
 * confirming Upstox reports the consolidated basis, which is the one the
 * screens are calibrated against.
 *
 * Absolute values still drift where the leg does not bind (VEDL 25.21 against
 * 16.10), so this is a faithful input to a threshold test rather than a figure
 * to display beside someone else's.
 */
export async function fetchUpstoxRoce(isin: string): Promise<number | null> {
  const body = await getJson<{ data?: { name?: string; company_value?: string }[] }>(
    `/v2/fundamentals/${encodeURIComponent(isin)}/key-ratios`,
  );
  if (!body) return null;

  const cell = (body.data ?? []).find((row) => /roce/i.test(row?.name ?? ''))?.company_value;
  return parsePercent(cell);
}

/**
 * Market cap in Rs crore, and the sector label that comes with it.
 *
 * The field is named `sector_market_cap_inr` and the documentation calls it a
 * sector figure. It is not: measured 2026-08-31, TCS returns 848,080 Cr and
 * INFY 464,100 Cr — different companies in the same sector, each within 0.6–3.2%
 * of Yahoo's figure for that company. The name is simply wrong.
 *
 * It already arrives in crore, which is the unit the whole app is written in,
 * so unlike Yahoo's rupees there is nothing to divide.
 */
export async function fetchUpstoxProfile(
  isin: string,
): Promise<{ marketCapCr: number | null; sector: string | null } | null> {
  const body = await getJson<{
    data?: {
      sector?: string | null;
      sector_market_cap_inr?: { value?: number; unit?: string } | null;
    };
  }>(`/v2/fundamentals/${encodeURIComponent(isin)}/profile`);
  if (!body) return null;

  return {
    marketCapCr: toMarketCapCr(body.data?.sector_market_cap_inr),
    sector: body.data?.sector ?? null,
  };
}

/**
 * The profile's market-cap cell -> Rs crore, or null where there is no figure.
 *
 * Two guards, both earned:
 *
 *   · **`> 0`, not merely "is a number".** Measured 2026-08-31: every BSE debt
 *     scrip — `08ABB`, `08ADD` and the ~150 others that are not really
 *     equities — answers with a market cap of **0**. Stored, that is a company
 *     worth nothing: it passes a `>= 0` band and sorts to the top of a
 *     smallest-first list. Null is the truth, and it is the same shape of
 *     mistake as `Number('')` returning 0, in a different costume.
 *   · **The unit is checked, not assumed.** The payload states its own, and a
 *     silent switch to rupees would put every figure out by 1e7 — two whole
 *     bands on a screen that filters by size.
 */
function toMarketCapCr(cell: { value?: number; unit?: string } | null | undefined): number | null {
  const value = cell?.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return (cell?.unit ?? 'crore') === 'crore' ? value : null;
}

/**
 * `"10.39%"` -> `10.39`.
 *
 * Explicitly null for an empty or absent string rather than letting `Number('')`
 * answer **0** — a definite failure on a `> 10` leg, where the truth is that
 * nothing is known. The same trap scripts/check-metrics.mjs guards on
 * screener.in's empty ratio spans.
 */
function parsePercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One GET, returning null on any refusal rather than throwing. */
async function getJson<T>(path: string): Promise<T | null> {
  if (!hasUpstox()) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.upstox.com${path}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` } },
      20_000,
    );
    // A 404 is an answer about this company — Upstox carries no fundamentals for
    // a great many small scrips — and is recorded as "no figure" by the caller
    // rather than retried.
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
