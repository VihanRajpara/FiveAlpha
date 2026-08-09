#!/usr/bin/env node
/**
 * Local ingestion for the NSE app — the same work the Edge Functions do, but run
 * from your machine so no `supabase login` / function deploy is needed.
 *
 * Node has no CORS restriction and no WAF-fingerprint problem, so it can call
 * NSE and Yahoo directly. Writes go through PostgREST with a SECRET key, which
 * bypasses RLS.
 *
 *   node scripts/seed.mjs securities        mirror EQUITY_L.csv    (~2,400 rows)
 *   node scripts/seed.mjs quotes            refresh every price
 *   node scripts/seed.mjs candles [n]       history for the n stalest symbols
 *   node scripts/seed.mjs all               securities → quotes → candles 200
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
const SPARK_BATCH_SIZE = 20; // Yahoo 400s above this
const CONCURRENCY = 6; // Yahoo refuses connections past ~8

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
const OPTIONAL_COLUMNS = { price_time: '0003_price_time.sql' };
const warnedColumns = new Set();

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

const toYahoo = (symbol) => `${symbol}.NS`;

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

async function syncSecurities() {
  process.stdout.write('securities: fetching EQUITY_L.csv … ');
  // NSE returns 403 without a Referer that looks like its own site.
  const res = await fetchWithTimeout(EQUITY_LIST_URL, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://www.nseindia.com/',
      Accept: 'text/csv,application/csv,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`NSE responded ${res.status}`);

  const now = new Date().toISOString();
  const rows = parseCsvObjects(await res.text())
    .map((r) => ({
      symbol: r['SYMBOL'] ?? '',
      name: r['NAME OF COMPANY'] ?? '',
      series: r['SERIES'] ?? '',
      isin: r['ISIN NUMBER'] ?? '',
      listing_date: parseNseDate(r['DATE OF LISTING'] ?? ''),
      face_value: toNumber(r['FACE VALUE']),
      paid_up_value: toNumber(r['PAID UP VALUE']),
      market_lot: toNumber(r['MARKET LOT']),
      updated_at: now,
    }))
    .filter((r) => r.symbol !== '');

  console.log(`${rows.length} rows`);
  if (rows.length === 0) throw new Error('NSE returned an empty list');

  for (const part of chunk(rows, 500)) await upsert('securities', part, 'symbol');

  const bySeries = rows.reduce((a, r) => ((a[r.series] = (a[r.series] || 0) + 1), a), {});
  console.log(`securities: upserted ${rows.length} —`,
    Object.entries(bySeries).map(([k, v]) => `${k} ${v}`).join(' · '));
  return rows.length;
}

async function syncQuotes() {
  const symbols = (await selectAll('securities', 'symbol', '&order=symbol')).map((r) => r.symbol);
  if (symbols.length === 0) throw new Error('securities is empty — run `securities` first');

  const batches = chunk(symbols, SPARK_BATCH_SIZE);
  console.log(`quotes: ${symbols.length} symbols → ${batches.length} batches (concurrency ${CONCURRENCY})`);

  const now = new Date().toISOString();
  let failed = 0;
  let done = 0;

  const results = await mapPool(batches, CONCURRENCY, async (batch) => {
    const query = batch.map(toYahoo).join(',');
    // interval=5m, not 1d: a daily bar is stamped with the session OPEN (09:15
    // IST), which would date an current price to hours ago. Same price, usable
    // timestamp.
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(query)}&range=1d&interval=5m`;
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': BROWSER_UA } }, 20_000);
      if (!res.ok) { failed++; return []; }
      const payload = await res.json();
      // Yahoo silently drops unknown tickers, so map over the request batch.
      return batch.map((symbol) => {
        const e = payload[toYahoo(symbol)];
        const closeArr = e?.close ?? [];
        const stamps = e?.timestamp ?? [];

        // Walk back to the last bar that actually traded and read the price and
        // its timestamp from the SAME index. Reading the last close but the last
        // timestamp independently would date a stale price to now whenever the
        // final bars are null (thin trading, halts).
        let i = closeArr.length - 1;
        while (i >= 0 && typeof closeArr[i] !== 'number') i--;

        const stamp = i >= 0 && typeof stamps[i] === 'number' ? stamps[i] : null;
        return {
          symbol,
          price: i >= 0 ? closeArr[i] : null,
          previous_close: e?.chartPreviousClose ?? e?.previousClose ?? null,
          price_time: stamp ? new Date(stamp * 1000).toISOString() : null,
          updated_at: now,
        };
      }).filter((r) => r.price !== null || r.previous_close !== null);
    } catch {
      failed++;
      return [];
    } finally {
      done++;
      if (done % 20 === 0) process.stdout.write(`  …${done}/${batches.length} batches\r`);
    }
  });

  const rows = results.flat();
  for (const part of chunk(rows, 500)) await upsert('quotes', part, 'symbol');

  console.log(`quotes: priced ${rows.length}/${symbols.length} (${((rows.length / symbols.length) * 100).toFixed(2)}%), failed batches ${failed}/${batches.length}`);
  return rows.length;
}

async function syncCandles(limit = 200, range = '1y', interval = '1d') {
  // Oldest cursor first, nulls (never synced) ahead of everything.
  const stale = await selectAll(
    'securities',
    'symbol',
    `&order=candles_synced_at.asc.nullsfirst&limit=${limit}`,
  );
  const symbols = stale.slice(0, limit).map((r) => r.symbol);
  if (symbols.length === 0) throw new Error('securities is empty — run `securities` first');

  console.log(`candles: ${symbols.length} stalest symbols, range=${range} interval=${interval}`);

  let failed = 0;
  let done = 0;

  const perSymbol = await mapPool(symbols, CONCURRENCY, async (symbol) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(symbol))}?range=${range}&interval=${interval}`;
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': BROWSER_UA } }, 20_000);
      if (!res.ok) { failed++; return []; }
      const result = (await res.json())?.chart?.result?.[0];
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
    } finally {
      done++;
      if (done % 25 === 0) process.stdout.write(`  …${done}/${symbols.length} symbols\r`);
    }
  });

  const rows = perSymbol.flat();
  for (const part of chunk(rows, 1000)) await upsert('candles', part, 'symbol,bar_date');

  // Advance the cursor for every symbol ATTEMPTED, including failures — otherwise
  // a symbol Yahoo has no data for blocks the rotation forever.
  const stamp = new Date().toISOString();
  for (const part of chunk(symbols, 100)) {
    const list = part.map((s) => `"${s}"`).join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/securities?symbol=in.(${encodeURIComponent(list)})`,
      { method: 'PATCH', headers: { ...restHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ candles_synced_at: stamp }) },
    );
    if (!res.ok) throw new Error(`cursor update → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  console.log(`candles: ${rows.length} bars from ${symbols.length} symbols, ${failed} failed`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [task = 'all', arg] = process.argv.slice(2);
const t0 = Date.now();

try {
  switch (task) {
    case 'securities': await syncSecurities(); break;
    case 'quotes':     await syncQuotes(); break;
    case 'candles':    await syncCandles(Number(arg) || 200); break;
    case 'all':
      await syncSecurities();
      await syncQuotes();
      await syncCandles(Number(arg) || 200);
      break;
    default:
      console.error(`Unknown task "${task}". Use: securities | quotes | candles [n] | all`);
      process.exit(1);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
}
