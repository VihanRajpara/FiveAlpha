#!/usr/bin/env node
/**
 * Local ingestion for the app — the same work the Edge Functions do, but run
 * from your machine so no `supabase login` / function deploy is needed.
 *
 * Node has no CORS restriction and no WAF-fingerprint problem, so it can call
 * NSE, BSE and Yahoo directly. Writes go through PostgREST with a SECRET key,
 * which bypasses RLS.
 *
 *   node scripts/seed.mjs securities        NSE + BSE, merged     (~5,200 rows)
 *   node scripts/seed.mjs quotes            refresh every price
 *   node scripts/seed.mjs all               securities → quotes
 *
 * `securities` requires supabase/migrations/0005_bse.sql. It refuses to run
 * without it rather than write BSE rows that would then be priced as NSE ones.
 *
 * Chart history is not seeded: it is fetched live from Yahoo when a chart is
 * opened, so nothing stores it. See supabase/migrations/0004_drop_candles.sql.
 *
 * Credentials come from .env (gitignored). The secret key is deliberately not
 * VITE_-prefixed — that prefix would inline it into the public browser bundle:
 *   VITE_SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_SECRET_KEY=sb_secret_...
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveUpstoxToken } from './upstox-token.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
/**
 * NSE Emerge (SME) — a separate CSV of ~565 companies that EQUITY_L.csv does not
 * contain. Underscored column names, a two-digit listing year, no MARKET LOT.
 */
const SME_LIST_URL =
  'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv';
/** BSE's scrip master — the feed behind its own "List of Securities" page. */
const BSE_LIST_URL =
  'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w' +
  '?Group=&Scripcode=&industry=&segment=Equity&status=Active';
/**
 * Batches in flight.
 *
 * The Upstox limit is 50 requests a second and the whole universe is twelve
 * requests, so this stopped being what governs the wall clock — it is here only
 * to keep a full pass off a single serial chain.
 */
const CONCURRENCY = 6;

const NSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  // NSE returns 403 without a Referer that looks like its own site.
  Referer: 'https://www.nseindia.com/',
  Accept: 'text/csv,application/csv,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const BSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/** Minimal .env reader — avoids a dotenv dependency for four lines of parsing. */
function loadEnvFile(name) {
  const path = resolve(ROOT, name);
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile('.env');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(`
Missing credentials. Add these to ${resolve(ROOT, '.env')}:

  VITE_SUPABASE_URL=${SUPABASE_URL || 'https://<your-ref>.supabase.co'}
  SUPABASE_SECRET_KEY=sb_secret_...

Get the secret key from: Supabase dashboard → Project Settings → API keys.
It must be the SECRET key (sb_secret_… or the legacy service_role JWT) — a
publishable key cannot write, because RLS grants anon read-only access.
`);
  process.exit(1);
}

if (/^sb_publishable_|^eyJ.*anon/.test(SECRET_KEY)) {
  console.error('SUPABASE_SECRET_KEY looks like a publishable/anon key. Writes will be rejected by RLS.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded concurrency over a shared cursor — not Promise.all, which would fire all at once. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

async function fetchWithTimeout(url, init = {}, ms = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Upstox market data.
//
// One credential, read from .env: an Analytics Token, read-only and valid for a
// year. This replaced a Yahoo cookie/crumb handshake that was duplicated in
// three places in this repo and 401d without warning, and an NSE bhavcopy
// walk-back that existed only because Yahoo's Emerge prices froze in July 2024.
//
// Measured 2026-08-31 against the live 5,831-row table: 5,680 rows priced in
// 1.0s over 12 requests, including 560 of the 565 Emerge rows the bhavcopy used
// to cover at end-of-day.
// ---------------------------------------------------------------------------

// Resolved from the database at the top of syncQuotes rather than read here:
// the token lives in private.sync_config now, and `seed securities` must not
// pay for a lookup it never uses. See scripts/upstox-token.mjs.
let UPSTOX_TOKEN = '';

/** 500 accepted, 501 answers 400 (UDAPI100042). Measured, not assumed. */
const QUOTE_BATCH_SIZE = 500;

/**
 * `NSE_EQ|INE002A01018` — segment, pipe, ISIN.
 *
 * Verified against the published NSE master: `instrument_key` equals
 * `segment + '|' + isin` for 9,700 of 9,700 rows. Mirrors `toInstrumentKey` in
 * supabase/functions/_shared/upstox.ts, which is what the deployed sync uses.
 */
function toInstrumentKey(isin, exchanges) {
  const trimmed = (isin ?? '').trim();
  if (!isUsableIsin(trimmed)) return null;
  return `${(exchanges ?? []).includes('NSE') ? 'NSE_EQ' : 'BSE_EQ'}|${trimmed}`;
}

/**
 * One batch of at most QUOTE_BATCH_SIZE keys, keyed by instrument key.
 *
 * `/market-quote/quotes` rather than the leaner `/v3/market-quote/ltp` for one
 * field: LTP carries no timestamp, and `quotes.price_time` means "when the
 * vendor says this printed". Stamping `now` on a closed market is exactly the
 * staleness the Emerge work existed to remove.
 */
async function fetchQuoteBatch(keys) {
  const out = new Map();
  if (keys.length === 0) return out;

  const query = encodeURIComponent(keys.join(','));
  const res = await fetchWithTimeout(
    `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${query}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${UPSTOX_TOKEN}` } },
  );
  if (!res.ok) throw new Error(`Upstox quotes returned ${res.status}`);

  const payload = await res.json();

  // Keyed by `SEGMENT:trading_symbol`, not by the key that was asked for, so
  // index on `instrument_token` — the only field that echoes the request.
  for (const entry of Object.values(payload.data ?? {})) {
    const key = entry?.instrument_token;
    if (!key) continue;

    const price = typeof entry.last_price === 'number' ? entry.last_price : null;
    const change = typeof entry.net_change === 'number' ? entry.net_change : null;
    const stamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;

    out.set(key, {
      // A literal 0 is not a price; dormant scrips report one.
      price: price !== null && price > 0 ? price : null,
      previousClose:
        price !== null && change !== null && price - change > 0 ? price - change : null,
      priceTime: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null,
    });
  }

  return out;
}

const restHeaders = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
};

/** PostgREST upsert. `onConflict` must name the conflict target columns. */
/**
 * Columns a project might not have yet, mapped to the migration that adds them.
 * PostgREST answers PGRST204 for an unknown column; rather than fail the whole
 * seed we drop the column, warn once, and retry — so an older database still
 * gets its prices, just without the finer timestamp.
 */
const OPTIONAL_COLUMNS = {
  price_time: '0003_price_time.sql',
};
const warnedColumns = new Set();

/**
 * Columns there is no safe way to continue without. Dropping `yahoo_ticker` or
 * `exchanges` would not degrade the seed, it would corrupt it: every BSE-only
 * row would land looking like an NSE symbol and then be priced as one. So these
 * stop the run with the migration to apply instead.
 */
const REQUIRED_COLUMNS = { exchanges: '0005_bse.sql', yahoo_ticker: '0005_bse.sql', bse_code: '0005_bse.sql' };

async function upsert(table, rows, onConflict) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;

  const send = async (payload) =>
    fetch(url, {
      method: 'POST',
      headers: { ...restHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });

  let res = await send(rows);
  if (res.ok) return;

  const body = (await res.text()).slice(0, 400);

  const required = Object.keys(REQUIRED_COLUMNS).find(
    (col) => body.includes(`'${col}'`) && /PGRST204|schema cache/.test(body),
  );
  if (required) {
    throw new Error(
      `column "${required}" is missing — run supabase/migrations/${REQUIRED_COLUMNS[required]} ` +
        `in the Supabase SQL Editor, then re-run this command.`,
    );
  }

  // "Could not find the 'price_time' column of 'quotes' in the schema cache"
  const missing = Object.keys(OPTIONAL_COLUMNS).find(
    (col) => body.includes(`'${col}'`) && /PGRST204|schema cache/.test(body),
  );

  if (missing) {
    if (!warnedColumns.has(missing)) {
      warnedColumns.add(missing);
      console.warn(
        `\n  ! column "${missing}" missing — run supabase/migrations/${OPTIONAL_COLUMNS[missing]}\n` +
          `    to record true price capture times. Continuing without it.`,
      );
    }
    const stripped = rows.map(({ [missing]: _drop, ...rest }) => rest);
    res = await send(stripped);
    if (res.ok) return;
    throw new Error(`upsert ${table} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  throw new Error(`upsert ${table} → ${res.status}: ${body}`);
}

async function selectAll(table, columns, extra = '') {
  const out = [];
  const PAGE = 1000; // PostgREST caps responses at 1000 rows
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${columns}${extra}`, {
      headers: { ...restHeaders, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`select ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// ---------------------------------------------------------------------------
// parsing (mirrors src/lib/csv.ts and src/lib/format.ts)
// ---------------------------------------------------------------------------

function parseCsvObjects(text) {
  const rows = [];
  let row = [];
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
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

const MONTHS = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };

/** Emerge's SME list uses a two-digit year (`08-Jul-25`); the main board uses four. */
function parseNseDate(value) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month}-${m[1].padStart(2, '0')}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const toNseTicker = (symbol) => `${symbol}.NS`;
/** Yahoo keys BSE listings on the alphabetic scrip id, not the numeric code. */
const toBseTicker = (scripId) => `${scripId}.BO`;

/**
 * BSE ships a couple of placeholder rows whose ISIN is the literal "NA".
 * Joining on that would merge two unrelated companies into one.
 */
const isUsableIsin = (value) => /^[A-Za-z0-9]{12}$/.test(value);

/**
 * Folds BSE's scrip master into the NSE list on ISIN, giving one row per
 * company. Mirrors mergeListings in src/lib/listings.ts and in the Edge
 * Functions' _shared/upstream.ts — all three must agree, since whichever runs
 * decides what the table holds.
 */
function mergeListings(nse, bse, now) {
  const byIsin = new Map();
  for (const s of bse) {
    // First scrip wins; a second line against one ISIN (partly paid, another
    // class of share) adds nothing beyond "this company trades on BSE".
    if (isUsableIsin(s.isin) && !byIsin.has(s.isin)) byIsin.set(s.isin, s);
  }

  const merged = [];
  const matched = new Set();
  const taken = new Set();

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
      // BSE's scrip master publishes none of these three.
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

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** Emerge's header is underscored: `NAME_OF_COMPANY` → `NAME OF COMPANY`. */
const normaliseSmeHeader = (csv) => csv.replace(/^[^\n]*/, (h) => h.replace(/_/g, ' '));

async function fetchNseRows(now) {
  const get = async (url) => {
    const res = await fetchWithTimeout(url, { headers: NSE_HEADERS });
    if (!res.ok) throw new Error(`NSE responded ${res.status} for ${url}`);
    return res.text();
  };
  const [main, sme] = await Promise.all([get(EQUITY_LIST_URL), get(SME_LIST_URL)]);

  return parseNseCsv(main, now).concat(parseNseCsv(normaliseSmeHeader(sme), now));
}

function parseNseCsv(csv, now) {
  return parseCsvObjects(csv)
    .map((r) => ({
      symbol: r['SYMBOL'] ?? '',
      name: r['NAME OF COMPANY'] ?? '',
      series: r['SERIES'] ?? '',
      isin: r['ISIN NUMBER'] ?? '',
      listing_date: parseNseDate(r['DATE OF LISTING'] ?? ''),
      face_value: toNumber(r['FACE VALUE']),
      paid_up_value: toNumber(r['PAID UP VALUE']),
      market_lot: toNumber(r['MARKET LOT']),
      exchanges: ['NSE'],
      yahoo_ticker: toNseTicker(r['SYMBOL'] ?? ''),
      bse_code: null,
      updated_at: now,
    }))
    .filter((r) => r.symbol !== '');
}

async function fetchBseScrips() {
  // ~1.8 MB of JSON, so it gets more headroom than the NSE CSV.
  const res = await fetchWithTimeout(BSE_LIST_URL, { headers: BSE_HEADERS }, 45_000);
  if (!res.ok) throw new Error(`BSE responded ${res.status}`);

  const payload = await res.json();
  if (!Array.isArray(payload)) throw new Error('BSE returned an unexpected payload');

  return payload
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

async function syncSecurities() {
  process.stdout.write('securities: fetching NSE main board + Emerge and the BSE scrip master … ');
  const now = new Date().toISOString();

  // Settled independently: BSE is the flakier upstream, and losing it should
  // cost the BSE-only rows rather than the whole sync.
  const [nseResult, bseResult] = await Promise.allSettled([fetchNseRows(now), fetchBseScrips()]);
  if (nseResult.status === 'rejected') throw nseResult.reason;

  const bseFailed = bseResult.status === 'rejected';
  const scrips = bseFailed ? [] : bseResult.value;
  const rows = mergeListings(nseResult.value, scrips, now);

  console.log(`${rows.length} rows`);
  if (rows.length === 0) throw new Error('NSE returned an empty list');
  if (bseFailed) {
    console.warn(`  ! BSE unavailable (${bseResult.reason.message}) — writing NSE listings only,`);
    console.warn('    and leaving exchanges/bse_code untouched so stored merges survive.');
  }

  // With BSE unreachable the merge sees no scrips, so every row claims {NSE}
  // and a null scrip code. Writing that would demote yesterday's correctly
  // merged dual listings on nothing more than a timeout, so those two columns
  // are dropped and whatever is stored survives. `yahoo_ticker` stays: for an
  // NSE row it is SYMBOL.NS either way, and it is NOT NULL with no default.
  const payload = bseFailed
    ? rows.map(({ exchanges: _e, bse_code: _b, ...rest }) => rest)
    : rows;

  for (const part of chunk(payload, 500)) await upsert('securities', part, 'symbol');

  const onNse = rows.filter((r) => r.exchanges.includes('NSE')).length;
  const onBse = rows.filter((r) => r.exchanges.includes('BSE')).length;
  console.log(
    `securities: upserted ${rows.length} — NSE ${onNse} · BSE ${onBse} · ` +
      `both ${onNse + onBse - rows.length} · BSE only ${rows.length - onNse}`,
  );
  return rows.length;
}

/** The NSE Emerge settlement series. Upstox quotes these like any other. */
const SME_SERIES = new Set(['SM', 'ST', 'SZ']);

async function syncQuotes() {
  UPSTOX_TOKEN = await resolveUpstoxToken();
  if (!UPSTOX_TOKEN) {
    throw new Error(
      'No Upstox token - quotes have no other source.\n' +
        "  Store one: select public.upstox_token_set('<token>');\n" +
        '  Generate one: Upstox -> Apps -> My Apps -> Analytics -> Generate Token.',
    );
  }

  // `*` rather than naming columns: that would 400 outright on a database
  // without migration 0005, and every row on such a database is an NSE listing.
  const securities = await selectAll('securities', '*', '&order=symbol');
  if (securities.length === 0) throw new Error('securities is empty — run `securities` first');

  const targets = securities.map((r) => ({
    symbol: r.symbol,
    key: toInstrumentKey(r.isin, r.exchanges),
    isSme: SME_SERIES.has(r.series),
  }));
  const keyed = targets.filter((t) => t.key !== null);

  const batches = chunk(keyed, QUOTE_BATCH_SIZE);
  console.log(
    `quotes: ${keyed.length} instruments → ${batches.length} batches of ${QUOTE_BATCH_SIZE}` +
      (targets.length - keyed.length > 0 ? ` (${targets.length - keyed.length} have no usable ISIN)` : ''),
  );

  const now = new Date().toISOString();
  let failed = 0;
  let done = 0;

  const results = await mapPool(batches, CONCURRENCY, async (batch) => {
    try {
      const quotes = await fetchQuoteBatch(batch.map((t) => t.key));

      // Walk the *request*, not the response: an instrument Upstox does not
      // carry is simply absent from it. Rows are keyed back to `symbol`, the
      // securities primary key — the instrument key is only the vendor's name
      // for the row.
      return batch
        .map(({ symbol, key }) => {
          const q = quotes.get(key);
          if (!q) return null;
          return {
            symbol,
            price: q.price,
            previous_close: q.previousClose,
            price_time: q.priceTime,
            updated_at: now,
          };
        })
        // A row with neither figure is one nothing is known about. Writing it
        // would overwrite a good older price with a null.
        .filter((r) => r !== null && (r.price !== null || r.previous_close !== null));
    } catch (err) {
      failed++;
      console.warn(`\n  ! quote batch of ${batch.length} failed: ${err.message}`);
      return [];
    } finally {
      done++;
      process.stdout.write(`  …${done}/${batches.length} batches\r`);
    }
  });

  const rows = results.flat();

  // Every batch failing is a broken credential, not a market where nothing
  // traded. Writing that emptiness over a good table would be the worse error.
  if (batches.length > 0 && failed === batches.length) {
    throw new Error('every Upstox batch failed — nothing written. Check UPSTOX_ACCESS_TOKEN.');
  }

  // `market_cap_cr` is absent from every row rather than written as null: it is
  // filled per-ISIN by the sync-fundamentals Edge Function, and a column that
  // appears in no row is never in the SET list, so whatever is stored survives.
  await upsert('quotes', rows, 'symbol');

  const priced = new Set(rows.map((r) => r.symbol));
  const sme = targets.filter((t) => t.isSme);
  console.log(
    `\nquotes: ${rows.length}/${targets.length} priced` +
      `, SME ${sme.filter((t) => priced.has(t.symbol)).length}/${sme.length}` +
      `, ${failed} failed batches`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [task = 'all'] = process.argv.slice(2);
const t0 = Date.now();

try {
  switch (task) {
    case 'securities': await syncSecurities(); break;
    case 'quotes':     await syncQuotes(); break;
    case 'all':
      await syncSecurities();
      await syncQuotes();
      break;
    default:
      console.error(`Unknown task "${task}". Use: securities | quotes | all`);
      process.exit(1);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
}
