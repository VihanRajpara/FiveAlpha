// Shared helpers for the three sync functions. Deno runtime (Supabase Edge Functions).
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Yahoo answers 400 if a spark request carries more than 20 tickers. */
export const SPARK_BATCH_SIZE = 20;

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/** Service-role client — bypasses RLS, so it must never be exposed to the browser. */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Rejects unless the caller presents SYNC_SECRET. Without this anyone who knows
 * the function URL could drive unlimited outbound requests on your project.
 */
export function assertAuthorized(req: Request): Response | null {
  const expected = Deno.env.get('SYNC_SECRET');
  if (!expected) {
    return json({ error: 'SYNC_SECRET is not configured on this function' }, 500);
  }
  const provided = req.headers.get('x-sync-secret');
  if (provided !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function toNseTicker(symbol: string): string {
  return `${symbol}.NS`;
}

/**
 * Yahoo keys BSE listings on the alphabetic scrip id (`TANFACIND.BO`), not the
 * numeric scrip code — recent listings are unreachable by code.
 */
export function toBseTicker(scripId: string): string {
  return `${scripId}.BO`;
}

// ---------------------------------------------------------------------------
// NSE + BSE master lists
//
// Mirrors src/lib/listings.ts. The browser reaches these through a proxy and
// Deno reaches them directly, so the fetch differs, but the merge must not —
// the whole point is that Supabase stores the same rows direct mode computes.
// ---------------------------------------------------------------------------

export const EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

export const BSE_LIST_URL =
  'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w' +
  '?Group=&Scripcode=&industry=&segment=Equity&status=Active';

export const NSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  // NSE only serves the archives to requests that look like they came from its site.
  Referer: 'https://www.nseindia.com/',
  Accept: 'text/csv,application/csv,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const BSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** A row of public.securities, as written by the syncs. */
export interface SecurityRow {
  symbol: string;
  name: string;
  series: string;
  isin: string;
  listing_date: string | null;
  face_value: number | null;
  paid_up_value: number | null;
  market_lot: number | null;
  exchanges: string[];
  yahoo_ticker: string;
  bse_code: string | null;
  updated_at: string;
}

export interface BseScrip {
  code: string;
  id: string;
  name: string;
  isin: string;
  group: string;
  faceValue: number | null;
}

/**
 * BSE ships a couple of placeholder rows whose ISIN is the literal "NA". Joining
 * on that would merge two unrelated companies, so only a well-formed 12-character
 * identifier counts.
 */
function isUsableIsin(value: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(value);
}

export function parseNseSecurities(csv: string, now: string): SecurityRow[] {
  return parseCsvObjects(csv)
    .map((row) => {
      const symbol = row['SYMBOL'] ?? '';
      return {
        symbol,
        name: row['NAME OF COMPANY'] ?? '',
        series: row['SERIES'] ?? '',
        isin: row['ISIN NUMBER'] ?? '',
        listing_date: parseNseDate(row['DATE OF LISTING'] ?? ''),
        face_value: toNumber(row['FACE VALUE']),
        paid_up_value: toNumber(row['PAID UP VALUE']),
        market_lot: toNumber(row['MARKET LOT']),
        exchanges: ['NSE'],
        yahoo_ticker: toNseTicker(symbol),
        bse_code: null,
        updated_at: now,
      };
    })
    .filter((r) => r.symbol !== '');
}

export function parseBseScrips(payload: unknown): BseScrip[] {
  if (!Array.isArray(payload)) throw new Error('BSE returned an unexpected payload');

  return (payload as Record<string, string | null>[])
    .filter((r) => (r.Segment ?? '').trim() === 'Equity' && (r.Status ?? '').trim() === 'Active')
    .map((r) => ({
      code: (r.SCRIP_CD ?? '').trim(),
      id: (r.scrip_id ?? '').trim(),
      name: (r.Scrip_Name ?? '').trim(),
      isin: (r.ISIN_NUMBER ?? '').trim(),
      group: (r.GROUP ?? '').trim(),
      faceValue: toNumber(r.FACE_VALUE ?? ''),
    }))
    .filter((s) => s.code !== '' && s.id !== '');
}

/**
 * Folds BSE into NSE on ISIN, producing one row per company.
 *
 * Dual-listed names keep their NSE symbol, series and `.NS` ticker and simply
 * gain `BSE` in `exchanges` — the NSE book is the more liquid one, so its last
 * trade is the better price to carry. BSE-only names become new rows.
 */
export function mergeListings(nse: SecurityRow[], bse: BseScrip[], now: string): SecurityRow[] {
  const byIsin = new Map<string, BseScrip>();
  for (const scrip of bse) {
    // First scrip wins; a second line against one ISIN (partly paid, another
    // class of share) adds nothing beyond "this company trades on BSE".
    if (isUsableIsin(scrip.isin) && !byIsin.has(scrip.isin)) byIsin.set(scrip.isin, scrip);
  }

  const merged: SecurityRow[] = [];
  const matched = new Set<string>();
  const taken = new Set<string>();

  for (const row of nse) {
    const scrip = isUsableIsin(row.isin) ? byIsin.get(row.isin) : undefined;
    taken.add(row.symbol);
    if (scrip) matched.add(scrip.code);
    merged.push(scrip ? { ...row, exchanges: ['NSE', 'BSE'], bse_code: scrip.code } : row);
  }

  for (const scrip of bse) {
    if (matched.has(scrip.code)) continue;

    // A BSE ticker can collide with an unrelated NSE one (BSE's FOCUS is Focus
    // Business Solution; NSE's is Focus Lighting and Fixtures). `symbol` is the
    // primary key, so the loser falls back to its numeric scrip code, which can
    // never collide with an NSE symbol. Yahoo is still queried by scrip id.
    const symbol = taken.has(scrip.id) ? scrip.code : scrip.id;
    taken.add(symbol);

    merged.push({
      symbol,
      name: scrip.name,
      series: scrip.group,
      isin: isUsableIsin(scrip.isin) ? scrip.isin : '',
      // BSE's scrip master publishes none of these.
      listing_date: null,
      face_value: scrip.faceValue,
      paid_up_value: null,
      market_lot: null,
      exchanges: ['BSE'],
      yahoo_ticker: toBseTicker(scrip.id),
      bse_code: scrip.code,
      updated_at: now,
    });
  }

  return merged;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded-concurrency map; Yahoo starts refusing connections past ~8 in parallel. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

/** Minimal RFC-4180 parser — NSE quotes company names that contain commas. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (clean.length === 0) return [];

  const headers = clean[0].map((h) => h.trim());
  return clean.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** `06-OCT-2008` → `2008-10-06`. */
export function parseNseDate(value: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** fetch with a hard timeout, so one stalled upstream can't eat the whole budget. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
