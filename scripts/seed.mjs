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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
/** BSE's scrip master — the feed behind its own "List of Securities" page. */
const BSE_LIST_URL =
  'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w' +
  '?Group=&Scripcode=&industry=&segment=Equity&status=Active';
/**
 * Symbols per quote request, and how many at once.
 *
 * This used to be Yahoo's `spark` endpoint at 20 a request. spark is a *chart*
 * endpoint: it answers out of intraday bars, which has two consequences that
 * both showed up in the seeded table.
 *
 *   · A scrip that printed no 5-minute bar gets **no price at all** — 508 of
 *     5,229 rows.
 *   · A scrip whose last bar traded at 14:55 gets *that* bar, so the stored
 *     price is a mid-session quote rather than the session's official close,
 *     and `price_time` reads 14:55 on a day that closed at 15:30.
 *
 * `/v7/finance/quote` carries `regularMarketPrice`, `regularMarketPreviousClose`
 * and `regularMarketTime` — the official figures, not the last bar that
 * happened to trade — plus `marketCap`, and takes 200 symbols a request. The
 * whole universe is 27 requests and about three seconds.
 *
 * Kept in step with supabase/functions/_shared/yahoo.ts, which does the same
 * thing for the scheduled sync. The two must not drift: whichever ran last is
 * what the table holds.
 */
const QUOTE_BATCH_SIZE = 200;
const CONCURRENCY = 6; // Yahoo refuses connections past ~8

/** Yahoo answers in rupees; the app is written in Rs crore throughout. */
const CRORE = 1e7;

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
// Yahoo's batch quote credential.
//
// `/v8/finance/spark` and `/v8/finance/chart` are open — a User-Agent is enough.
// `/v7/finance/quote` is not: unauthenticated it answers **401 Invalid Crumb**.
// The cookie/crumb pair is obtained the way Yahoo's own site does, and is the
// price of the endpoint that carries official closes and market cap.
//
// Mirrors worker/yahooQuote.ts and supabase/functions/_shared/yahoo.ts.
// ---------------------------------------------------------------------------

let credential = null;

async function acquireCredential() {
  // 404s, and is supposed to: the Set-Cookie header is the point, not the body.
  const seed = await fetchWithTimeout('https://fc.yahoo.com', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'follow',
  });

  const raw = seed.headers.getSetCookie?.() ?? [seed.headers.get('set-cookie') ?? ''];
  // Only `name=value` matters to the server that set it; Path/Expires are
  // instructions to a browser we are not.
  const cookie = raw
    .filter(Boolean)
    .map((line) => line.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('Yahoo set no cookie');

  const res = await fetchWithTimeout('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain', Cookie: cookie },
  });
  const crumb = (await res.text()).trim();

  // A refused attempt answers with an HTML page rather than a token, which would
  // otherwise be sent along as a crumb and 401 forever.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new Error(`Yahoo returned no crumb (${res.status})`);
  }
  return { cookie, crumb };
}

async function credentials(fresh = false) {
  if (fresh || !credential) {
    // Never remember a failure: the next caller should retry rather than
    // inherit a rejected promise for the rest of the run.
    credential = acquireCredential().catch((err) => {
      credential = null;
      throw err;
    });
  }
  return credential;
}

/** One batch of up to QUOTE_BATCH_SIZE tickers, retried once on a stale crumb. */
async function fetchQuoteBatch(tickers) {
  const query = encodeURIComponent(tickers.join(','));

  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await credentials(attempt > 0);
    const res = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${query}` +
        `&crumb=${encodeURIComponent(auth.crumb)}`,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Cookie: auth.cookie } },
      20_000,
    );

    // The two ways a stale pair shows up. A crumb does expire, and the
    // alternative is a dead endpoint for the rest of the run.
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (!res.ok) throw new Error(`Yahoo quote returned ${res.status}`);

    const payload = await res.json();
    return payload.quoteResponse?.result ?? [];
  }

  throw new Error('Yahoo refused the crumb twice');
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
  market_cap_cr: '0008_metrics.sql',
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

function parseNseDate(value) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
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

async function fetchNseRows(now) {
  const res = await fetchWithTimeout(EQUITY_LIST_URL, { headers: NSE_HEADERS });
  if (!res.ok) throw new Error(`NSE responded ${res.status}`);

  return parseCsvObjects(await res.text())
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
  process.stdout.write('securities: fetching NSE EQUITY_L.csv and BSE scrip master … ');
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

async function syncQuotes() {
  // `*` rather than naming yahoo_ticker: that would 400 outright on a database
  // without migration 0005, where falling back to SYMBOL.NS is exactly right
  // because every row there is an NSE listing.
  const targets = (await selectAll('securities', '*', '&order=symbol')).map((r) => ({
    symbol: r.symbol,
    ticker: r.yahoo_ticker || toNseTicker(r.symbol),
  }));
  if (targets.length === 0) throw new Error('securities is empty — run `securities` first');

  const batches = chunk(targets, QUOTE_BATCH_SIZE);
  console.log(`quotes: ${targets.length} symbols → ${batches.length} batches (concurrency ${CONCURRENCY})`);

  const now = new Date().toISOString();
  let failed = 0;
  let done = 0;

  const results = await mapPool(batches, CONCURRENCY, async (batch) => {
    try {
      const quotes = await fetchQuoteBatch(batch.map((t) => t.ticker));

      // Yahoo keys its answer by ticker and drops what it does not carry, so
      // index the response and walk the *request*. Rows are keyed back to
      // `symbol`, the securities primary key — the ticker is only ever the
      // vendor's name for the row.
      const byTicker = new Map();
      for (const q of quotes) if (q.symbol) byTicker.set(q.symbol, q);

      return batch.map(({ symbol, ticker }) => {
        const q = byTicker.get(ticker);
        const num = (v) => (typeof v === 'number' ? v : null);
        // `regularMarketTime` is the vendor's stamp on the price itself. Unlike
        // the old spark path this is the *official* last trade, so a session
        // that closed at 15:30 reads 15:30 rather than whichever 5-minute bar
        // happened to be the last one with a trade in it.
        //
        // `> 0` rather than a null check: Yahoo returns a literal **0** for a
        // handful of dormant scrips, and epoch 0 is a valid number — it stored
        // as `1970-01-01`, which reads as a real timestamp everywhere
        // downstream rather than as the "unknown" it actually means.
        const stamp = num(q?.regularMarketTime);
        const cap = num(q?.marketCap);

        return {
          symbol,
          price: num(q?.regularMarketPrice),
          previous_close: num(q?.regularMarketPreviousClose),
          market_cap_cr: cap === null ? null : cap / CRORE,
          price_time: stamp !== null && stamp > 0 ? new Date(stamp * 1000).toISOString() : null,
          updated_at: now,
        };
      }).filter((r) => r.price !== null || r.previous_close !== null);
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
  for (const part of chunk(rows, 500)) await upsert('quotes', part, 'symbol');

  // Two different numbers, and only the second is what the table shows as LTP.
  // A row is kept when it has a price *or* a previous close, so "rows written"
  // overstates coverage: a scrip that did not trade today still yields a
  // previous close. That is the whole reason the UI has to distinguish "no
  // price yet" from "no price" — several hundred rows land in the latter.
  const withPrice = rows.filter((r) => r.price !== null).length;
  const pct = (n) => `${((n / targets.length) * 100).toFixed(2)}%`;
  console.log(
    `quotes: wrote ${rows.length}/${targets.length} (${pct(rows.length)}) — ` +
      `with a last traded price ${withPrice} (${pct(withPrice)}), ` +
      `previous close only ${rows.length - withPrice}; ` +
      `failed batches ${failed}/${batches.length}`,
  );
  return rows.length;
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
