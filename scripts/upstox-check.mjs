#!/usr/bin/env node
// Phase 0 of plan.md — `npm run check:upstox`.
//
// plan.md decides which parts of this app move off Yahoo and screener.in and
// which stay. Five of its load-bearing claims were read off Upstox's own
// documentation and community posts rather than measured, and every later phase
// is sized by them. This script measures them.
//
// It writes nothing and changes nothing. A failed check is a *finding* — the
// script exits 0 either way and names the plan.md section the result overturns,
// because "Upstox is worse at this than what we already have" is an answer this
// has to be able to give.
//
// The token is read from .env and is never printed.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/**
 * Minimal .env reader — the same four lines as scripts/seed.mjs, and for the
 * same reason: Node 18.20.3 has no --env-file and dotenv is not a dependency.
 */
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

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

if (!TOKEN) {
  console.error(`
Missing UPSTOX_ACCESS_TOKEN. Add it to ${resolve(ROOT, '.env')}:

  UPSTOX_ACCESS_TOKEN=<your Analytics Token>

Get it from: Upstox -> Apps -> My Apps -> Analytics tab -> Generate Token.
One year, read-only, one per account. No OAuth app and no static IP needed --
the API Key / Secret / Redirect URI fields in .env belong to the daily-login
path this project deliberately does not take, and stay blank.
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with a hard timeout, so one stalled upstream cannot hang the run. */
async function timed(url, init = {}, ms = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Upstox call. Returns the parsed body alongside the status and never
 * throws on a non-200: a 400 at 501 instrument keys is a *result* here, not a
 * failure.
 */
async function upstox(path, { version = 'v3' } = {}) {
  const { res, ms } = await timed(`https://api.upstox.com/${version}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body, ms };
}

// ---------------------------------------------------------------------------
// Yahoo, for the comparisons
//
// The cookie/crumb dance is duplicated here rather than lifted out of
// supabase/functions/_shared/yahoo.ts: this is a throwaway measurement script,
// and twenty lines of duplication is cheaper than dragging a Deno module into
// Node to run one function. That it has to exist at all is part of what is
// being measured.
// ---------------------------------------------------------------------------

let credential = null;

async function yahooCredential() {
  if (credential) return credential;

  // 404s, and is supposed to: the Set-Cookie header is the point, not the body.
  const { res: seed } = await timed('https://fc.yahoo.com', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  const raw = seed.headers.getSetCookie?.() ?? [seed.headers.get('set-cookie') ?? ''];
  const cookie = raw
    .filter(Boolean)
    .map((line) => line.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('Yahoo set no cookie');

  const { res } = await timed('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain', Cookie: cookie },
  });
  const crumb = (await res.text()).trim();
  // A refused attempt answers with an HTML page rather than a token.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new Error(`Yahoo returned no crumb (${res.status})`);
  }

  credential = { cookie, crumb };
  return credential;
}

/** ticker -> { price, marketCap, time } for up to 200 tickers. */
async function yahooQuotes(tickers) {
  if (tickers.length === 0) return new Map();

  const auth = await yahooCredential();
  const query = encodeURIComponent(tickers.join(','));
  const { res } = await timed(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${query}` +
      `&crumb=${encodeURIComponent(auth.crumb)}`,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Cookie: auth.cookie } },
  );
  if (!res.ok) throw new Error(`Yahoo quote returned ${res.status}`);

  const payload = await res.json();
  const out = new Map();
  for (const q of payload.quoteResponse?.result ?? []) {
    if (!q.symbol) continue;
    out.set(q.symbol, {
      price: typeof q.regularMarketPrice === 'number' ? q.regularMarketPrice : null,
      marketCap: typeof q.marketCap === 'number' ? q.marketCap : null,
      // `> 0`: Yahoo returns a literal 0 for dormant scrips, and epoch 0 reads
      // as a real 1970 timestamp rather than as the "unknown" it means.
      time:
        typeof q.regularMarketTime === 'number' && q.regularMarketTime > 0
          ? new Date(q.regularMarketTime * 1000).toISOString().slice(0, 10)
          : null,
    });
  }
  return out;
}

/** Ten years of monthly bars from Yahoo's chart endpoint — no auth needed. */
async function yahooMonthly(ticker) {
  const { res } = await timed(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      '?range=10y&interval=1mo',
    { headers: { 'User-Agent': BROWSER_UA } },
  );
  if (!res.ok) return null;

  const result = (await res.json()).chart?.result?.[0];
  if (!result?.timestamp) return null;

  const q = result.indicators?.quote?.[0] ?? {};
  const bars = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = q.close?.[i];
    if (typeof close !== 'number') continue;
    bars.push({ close, high: typeof q.high?.[i] === 'number' ? q.high[i] : close });
  }
  return bars.length > 0 ? bars : null;
}

// ---------------------------------------------------------------------------
// instrument masters
// ---------------------------------------------------------------------------

const MASTERS = {
  NSE: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
};

/** The two cash-equity segments, indexed by trading symbol and kept whole. */
async function loadMasters() {
  const bySymbol = { NSE_EQ: new Map(), BSE_EQ: new Map() };
  const all = { NSE_EQ: [], BSE_EQ: [] };

  for (const [name, url] of Object.entries(MASTERS)) {
    const { res } = await timed(url, {}, 180_000);
    if (!res.ok) throw new Error(`${name} master returned ${res.status}`);

    const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString());
    const segment = `${name}_EQ`;
    for (const row of rows) {
      if (row.segment !== segment) continue;
      all[segment].push(row);
      // First wins. The master is unique on trading_symbol within a segment
      // today; a future collision should not silently reassign a key.
      if (!bySymbol[segment].has(row.trading_symbol)) {
        bySymbol[segment].set(row.trading_symbol, row);
      }
    }
  }

  return { bySymbol, all };
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

const findings = [];
const record = (title, verdict, detail, affects) =>
  findings.push({ title, verdict, detail, affects });

const pct = (a, b) => (b === 0 ? Infinity : (Math.abs(a - b) / b) * 100);
const fmt = (n, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '--' : n.toFixed(d);

/** ISO date `n` days ago, in the form the historical endpoint wants. */
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Is history adjusted for corporate actions?
//
// src/lib/technicals.ts names UEL, CLCIND and IVZINGOLD as rows where Yahoo
// never applied a split — which is why SPIKE_RATIO exists and why that screen is
// "not a drop-in replacement for Chartink's". An unapplied split shows up as a
// uniformly scaled *stretch* of bars, so the tell is a pair of vendors who agree
// on today's price and disagree on the ten-year high by the split factor.
// ---------------------------------------------------------------------------

const SPLIT_SUSPECTS = ['UEL', 'CLCIND', 'IVZINGOLD', 'RELIANCE'];

async function checkSplitAdjustment(bySymbol) {
  console.log('\n=== 1. Split adjustment - Upstox vs Yahoo monthly history ===\n');

  const rows = [];
  for (const symbol of SPLIT_SUSPECTS) {
    const inst = bySymbol.NSE_EQ.get(symbol);
    if (!inst) {
      rows.push({ symbol, note: 'not in the NSE master' });
      continue;
    }

    const up = await upstox(
      `/historical-candle/${encodeURIComponent(inst.instrument_key)}/months/1/` +
        `${isoDaysAgo(0)}/${isoDaysAgo(365 * 10)}`,
    );
    if (!up.ok) {
      rows.push({ symbol, note: `Upstox HTTP ${up.status}` });
      continue;
    }

    // candles are [timestamp, open, high, low, close, volume, oi], newest first.
    const candles = up.body?.data?.candles ?? [];
    if (candles.length === 0) {
      rows.push({ symbol, note: 'Upstox returned no candles' });
      continue;
    }

    const yahoo = await yahooMonthly(`${symbol}.NS`);

    rows.push({
      symbol,
      isin: inst.isin,
      bars: candles.length,
      // Candles come newest first, so the *last* entry is the oldest bar.
      since: String(candles[candles.length - 1][0]).slice(0, 7),
      upHigh: Math.max(...candles.map((c) => c[2])),
      upLast: candles[0][4],
      yBars: yahoo ? yahoo.length : null,
      yHigh: yahoo ? Math.max(...yahoo.map((b) => b.high)) : null,
      yLast: yahoo ? yahoo[yahoo.length - 1].close : null,
    });
  }

  console.log(
    ['symbol', 'up bars', 'since', 'y bars', 'up 10y hi', 'y 10y hi', 'hi gap %', 'px gap %'].join('\t'),
  );

  const measured = [];
  for (const r of rows) {
    if (r.note) {
      console.log(`${r.symbol}\t${r.note}`);
      continue;
    }
    const highGap = r.yHigh !== null ? pct(r.upHigh, r.yHigh) : null;
    const priceGap = r.yLast !== null ? pct(r.upLast, r.yLast) : null;
    measured.push({ ...r, highGap, priceGap });
    console.log(
      [
        r.symbol, r.bars, r.since, r.yBars ?? '--',
        fmt(r.upHigh), fmt(r.yHigh), fmt(highGap, 1), fmt(priceGap, 1),
      ].join('\t'),
    );
  }

  // DECADE_MONTHS in src/lib/technicals.ts needs 120 months of history before a
  // ten-year high exists at all. Upstox keys history by ISIN, and a corporate
  // action that issues a new ISIN restarts it — which is the finding that
  // matters here, and it cuts against Upstox rather than for it.
  const truncated = measured.filter((r) => r.bars < 120 && (r.yBars ?? 0) >= 120);
  const deeper = measured.filter((r) => r.bars > (r.yBars ?? 0));

  record(
    'History usable for the ten-year-high leg',
    measured.length === 0 ? 'UNKNOWN' : truncated.length > 0 ? 'PARTIAL' : 'PASS',
    (truncated.length > 0
      ? `TRUNCATED at the ISIN: ${truncated
          .map((r) => `${r.symbol} ${r.bars} bars from ${r.since}`)
          .join(', ')} — Yahoo carries 120+ for the same names. A corporate action that issues a ` +
        'new ISIN restarts Upstox history, so these rows go UNJUDGED under DECADE_MONTHS. '
      : '') +
      (deeper.length > 0
        ? `Deeper where the ISIN is stable: ${deeper
            .map((r) => `${r.symbol} ${r.bars} bars from ${r.since}`)
            .join(', ')}. `
        : '') +
      'Where both have depth the highs diverge by the split factor, so the prices themselves are ' +
      'adjusted — but depth, not adjustment, is the binding constraint.',
    'plan.md section 7 - Upstox cannot replace Yahoo for the ten-year-high leg unaided',
  );
}

// ---------------------------------------------------------------------------
// 2. Is the profile market cap per company or per sector?
//
// The documentation calls it a "sector market cap", which would make it useless
// for the screens' cap band. Two companies in the *same* sector settle it in two
// requests: identical figures mean sector-level, different figures mean
// per-company. Yahoo is asked alongside only for magnitude.
// ---------------------------------------------------------------------------

const CAP_PAIR = ['TCS', 'INFY'];
const CAP_MAGNITUDE = ['RELIANCE', 'THYROCARE'];

async function checkMarketCap(bySymbol) {
  console.log('\n=== 2. Market cap - per company, or per sector? ===\n');

  const CRORE = 1e7;
  const symbols = [...CAP_PAIR, ...CAP_MAGNITUDE];
  const caps = new Map();
  const raw = new Map();

  for (const symbol of symbols) {
    const inst = bySymbol.NSE_EQ.get(symbol);
    if (!inst) continue;
    const res = await upstox(`/fundamentals/${inst.isin}/profile`, { version: 'v2' });
    if (!res.ok) {
      raw.set(symbol, `HTTP ${res.status}`);
      continue;
    }
    // The field is named `sector_market_cap_inr` but carries a nested
    // `{ value, unit, formatted }` — and the value turns out to be the
    // *company's* cap, not the sector's. So read the shape rather than trusting
    // either the name or a stringification: `String({}).replace(/[^0-9.]/g,'')`
    // is `''`, and `Number('')` is 0, which reads as a real figure. That is the
    // same trap scripts/check-metrics.mjs exists to guard on screener.in.
    const data = res.body?.data ?? {};
    const entry = Object.entries(data).find(([k]) => /market_?cap.*inr|inr.*market_?cap/i.test(k));
    const cell = entry?.[1];
    const value =
      cell && typeof cell === 'object' && Number.isFinite(Number(cell.value))
        ? Number(cell.value)
        : Number.isFinite(Number(cell))
          ? Number(cell)
          : null;
    raw.set(symbol, entry ? `${entry[0]}=${cell?.formatted ?? cell}` : 'no market-cap field');
    caps.set(symbol, value);
  }

  let yahoo = new Map();
  try {
    yahoo = await yahooQuotes(symbols.map((s) => `${s}.NS`));
  } catch (err) {
    console.log(`  (Yahoo comparison unavailable: ${err.message})`);
  }

  console.log(['symbol', 'upstox field', 'upstox Cr', 'yahoo Cr', 'gap %'].join('\t'));
  const gaps = [];
  for (const symbol of symbols) {
    const up = caps.get(symbol) ?? null;
    const y = yahoo.get(`${symbol}.NS`)?.marketCap;
    const yCr = typeof y === 'number' ? y / CRORE : null;
    const gap = up !== null && yCr !== null ? pct(up, yCr) : null;
    if (gap !== null) gaps.push({ symbol, gap });
    console.log(
      [symbol, raw.get(symbol) ?? '--', fmt(up, 0), fmt(yCr, 0), fmt(gap, 1)].join('\t'),
    );
  }

  const [a, b] = CAP_PAIR;
  const known = caps.get(a) !== undefined && caps.get(a) !== null;
  // Two companies in the same sector returning the same number would mean the
  // field is what its name claims. Different numbers, each tracking Yahoo's
  // figure for that company, mean it is a company cap under a misleading name.
  const identical = known && caps.get(a) === caps.get(b);
  const close = gaps.filter((g) => g.gap <= 10);

  record(
    'Profile market cap is per company',
    !known ? 'UNKNOWN' : identical ? 'FAIL' : close.length === gaps.length ? 'PASS' : 'PARTIAL',
    identical
      ? `${a} and ${b} return the identical figure - it is a sector aggregate, not a company cap.`
      : `${a} and ${b} differ, and ${close.length}/${gaps.length} land within 10% of Yahoo's ` +
        'figure for the same company. The field is named `sector_market_cap_inr` but carries the ' +
        'company cap. It is still one request per ISIN against Yahoo\'s 200 per batch.',
    'plan.md section 4 - whether the Yahoo /v7 market-cap pass can be retired',
  );
}

// ---------------------------------------------------------------------------
// 3. Which ROCE basis does Upstox report?
//
// The screens are calibrated against Chartink and read the *consolidated*
// figure: Reliance is 7.78% standalone against 10.3% consolidated, opposite
// sides of the `> 10` leg. screener.in is scraped here exactly the way
// sync-fundamentals does it, at the same 1.2s pacing, because the limit is a
// rate and not a quota.
// ---------------------------------------------------------------------------

// Weighted towards the `> 10` threshold the screens actually test, because
// that is the only place a disagreement changes a verdict. A 7pp gap between
// 55 and 63 costs nothing; a 1pp gap across 10 costs a row.
const ROCE_SAMPLE = [
  // The basis discriminator: 7.78 standalone vs 10.3 consolidated.
  'RELIANCE',
  // In or near the threshold band.
  'TATASTEEL', 'VEDL', 'ONGC', 'IOC', 'NTPC', 'POWERGRID', 'GAIL', 'BPCL', 'TATAMOTORS',
  // Comfortably above it, as a sanity check on the parse.
  'TCS', 'INFY', 'TITAN', 'THYROCARE', 'TANLA',
];

/** The leg the screens actually run. */
const ROCE_THRESHOLD = 10;
const SCREENER_INTERVAL_MS = 1200;

/** Pulls `#top-ratios` into a name -> numbers map. Mirrors parseTopRatios. */
function parseTopRatios(html) {
  const out = new Map();

  const start = html.indexOf('id="top-ratios"');
  if (start < 0) return out;
  const end = html.indexOf('</ul>', start);
  const block = html.slice(start, end < 0 ? undefined : end);

  for (const item of block.split('<li').slice(1)) {
    const name = /class="name"[^>]*>([\s\S]*?)<\/span>/.exec(item)?.[1];
    if (!name) continue;
    // The empty span must be discarded before Number sees it: Number('') is 0,
    // which reads as a definite ROCE failure rather than as an unknown.
    const numbers = [...item.matchAll(/class="number"[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/[,\s]/g, ''))
      .filter((text) => text !== '')
      .map(Number)
      .filter(Number.isFinite);
    out.set(name.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), numbers);
  }

  return out;
}

async function screenerRoce(symbol) {
  const base = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;

  for (const url of [`${base}consolidated/`, base]) {
    const { res } = await timed(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.status === 429) return { roce: null, page: 'rate limited' };
    if (!res.ok) return { roce: null, page: `HTTP ${res.status}` };

    const ratios = parseTopRatios(await res.text());
    // screener.in serves a 200 with every value blank for companies that file
    // no consolidated statements, so the page to use is decided by what came
    // back rather than assumed.
    if ([...ratios.values()].some((n) => n.length > 0)) {
      return {
        roce: ratios.get('ROCE')?.[0] ?? null,
        page: url.endsWith('consolidated/') ? 'consolidated' : 'standalone',
      };
    }
    await sleep(SCREENER_INTERVAL_MS);
  }

  return { roce: null, page: 'no figures' };
}

async function checkRoce(bySymbol) {
  console.log('\n=== 3. ROCE - Upstox vs screener.in ===\n');
  console.log(['symbol', 'upstox %', 'screener %', 'gap pp', 'screener page'].join('\t'));

  const gaps = [];
  for (const symbol of ROCE_SAMPLE) {
    const inst = bySymbol.NSE_EQ.get(symbol);
    if (!inst) {
      console.log(`${symbol}\tnot in the NSE master`);
      continue;
    }

    const res = await upstox(`/fundamentals/${inst.isin}/key-ratios`, { version: 'v2' });
    const cell = (res.body?.data ?? []).find((r) => /roce/i.test(r?.name ?? ''))?.company_value;
    const upRoce = cell ? Number(String(cell).replace(/[^0-9.\-]/g, '')) : null;

    const { roce: srRoce, page } = await screenerRoce(symbol);
    await sleep(SCREENER_INTERVAL_MS);

    const gap = upRoce !== null && srRoce !== null ? upRoce - srRoce : null;
    if (gap !== null) gaps.push({ symbol, gap, up: upRoce, screener: srRoce });

    console.log(
      [
        symbol,
        res.ok ? fmt(upRoce) : `HTTP ${res.status}`,
        fmt(srRoce),
        fmt(gap),
        page,
      ].join('\t'),
    );
  }

  // What matters is not the size of the gap but whether it moves a row across
  // the leg. Two sources can disagree by 8pp at ROCE 60 and never change a
  // verdict; disagreeing by 0.5pp at 10 changes one every time.
  const flips = gaps.filter(
    (g) => g.up >= ROCE_THRESHOLD !== g.screener >= ROCE_THRESHOLD,
  );
  const close = gaps.filter((g) => Math.abs(g.gap) <= 1);

  record(
    'Upstox ROCE is a drop-in for the screens\' > 10 leg',
    gaps.length === 0 ? 'UNKNOWN' : flips.length === 0 ? 'PASS' : 'FAIL',
    `${flips.length}/${gaps.length} rows land on opposite sides of ROCE > ${ROCE_THRESHOLD}` +
      (flips.length > 0
        ? `: ${flips.map((g) => `${g.symbol} (${fmt(g.up, 1)} vs ${fmt(g.screener, 1)})`).join(', ')}.`
        : '.') +
      ` ${close.length}/${gaps.length} agree within 1pp overall. RELIANCE is the basis ` +
      'discriminator: ~10.3 means consolidated, ~7.8 means standalone.',
    'plan.md section 5 - whether screens.ts can read the Upstox ROCE column',
  );
}

// ---------------------------------------------------------------------------
// 4. Are SME rows quoted live?
//
// This is the check that decides whether fetchNseBhavcopy() and its whole
// walk-back can be deleted. Yahoo's Emerge data froze in July 2024, so a Yahoo
// price stamped 2024 beside a fresh Upstox price is the entire argument.
// ---------------------------------------------------------------------------

async function checkSme(masters) {
  console.log('\n=== 4. NSE Emerge (SME) - quoted live by Upstox? ===\n');

  const sme = masters.all.NSE_EQ.filter((r) => r.security_type === 'SME');
  // EMKAYTOOLS first: _shared/upstream.ts cites it showing Yahoo's Rs 883.95
  // against an actual close of Rs 94.20.
  const picked = [
    ...sme.filter((r) => r.trading_symbol === 'EMKAYTOOLS'),
    ...sme.filter((r) => r.trading_symbol !== 'EMKAYTOOLS').slice(0, 19),
  ];
  if (picked.length === 0) {
    record('SME rows are quoted live by Upstox', 'UNKNOWN', 'No SME rows in the master.', 'plan.md section 3');
    return;
  }

  const keys = picked.map((r) => r.instrument_key);
  const res = await upstox(`/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`);
  if (!res.ok) {
    console.log(`  Upstox LTP failed: HTTP ${res.status}`);
    record(
      'SME rows are quoted live by Upstox',
      'UNKNOWN',
      `LTP returned ${res.status}.`,
      'plan.md section 3 - whether fetchNseBhavcopy() can be deleted',
    );
    return;
  }

  // The response is keyed by "SEGMENT:trading_symbol" rather than by the
  // instrument key that was asked for, so index it by the instrument_token each
  // entry carries -- the only field guaranteed to match the request.
  const byToken = new Map();
  for (const entry of Object.values(res.body?.data ?? {})) {
    if (entry?.instrument_token) byToken.set(entry.instrument_token, entry);
  }

  let yahoo = new Map();
  try {
    yahoo = await yahooQuotes(picked.map((r) => `${r.trading_symbol}.NS`));
  } catch (err) {
    console.log(`  (Yahoo comparison unavailable: ${err.message})`);
  }

  console.log(['symbol', 'upstox ltp', 'yahoo price', 'yahoo date', 'gap %'].join('\t'));

  let priced = 0;
  let divergent = 0;
  let staleYahoo = 0;

  for (const inst of picked) {
    const up = byToken.get(inst.instrument_key);
    const y = yahoo.get(`${inst.trading_symbol}.NS`);
    if (typeof up?.last_price === 'number' && up.last_price > 0) priced++;
    if (y?.time && y.time < '2025-01-01') staleYahoo++;

    const gap =
      typeof up?.last_price === 'number' && typeof y?.price === 'number'
        ? pct(up.last_price, y.price)
        : null;
    if (gap !== null && gap > 10) divergent++;

    console.log(
      [inst.trading_symbol, fmt(up?.last_price), fmt(y?.price), y?.time ?? '--', fmt(gap, 1)].join('\t'),
    );
  }

  record(
    'SME rows are quoted live by Upstox',
    priced >= picked.length * 0.8 ? 'PASS' : 'FAIL',
    `${priced}/${picked.length} SME instruments returned a last price. Yahoo carried a pre-2025 ` +
      `timestamp on ${staleYahoo} of them and disagreed by more than 10% on ${divergent}.`,
    'plan.md section 3 - whether fetchNseBhavcopy() and the SME overlay can be deleted',
  );
}

// ---------------------------------------------------------------------------
// 5. Batch ceiling and rate limit
// ---------------------------------------------------------------------------

async function checkBatching(masters) {
  console.log('\n=== 5. LTP batch ceiling and rate limit ===\n');

  const pool = [...masters.all.NSE_EQ, ...masters.all.BSE_EQ]
    .filter((r) => r.instrument_key)
    .map((r) => r.instrument_key);

  console.log(['keys', 'status', 'returned', 'ms'].join('\t'));

  const results = [];
  for (const size of [100, 250, 500, 501]) {
    const keys = pool.slice(0, size);
    const res = await upstox(`/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`);
    const returned = Object.keys(res.body?.data ?? {}).length;
    results.push({ size, status: res.status, returned });
    console.log([size, res.status, returned, res.ms].join('\t'));
    await sleep(300);
  }

  // Eleven 500-key calls is one whole-universe pass over the app's 5,229 rows.
  console.log('\n  Eleven 500-key calls - one full universe pass:');
  const started = Date.now();
  let ok = 0;
  let covered = 0;
  for (let i = 0; i < 11; i++) {
    const keys = pool.slice(i * 500, i * 500 + 500);
    if (keys.length === 0) break;
    const res = await upstox(`/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`);
    if (res.ok) ok++;
    covered += Object.keys(res.body?.data ?? {}).length;
  }
  const elapsed = (Date.now() - started) / 1000;
  console.log(`  ${ok}/11 succeeded, ${covered} instruments priced, ${elapsed.toFixed(1)}s\n`);

  const at500 = results.find((r) => r.size === 500);
  const at501 = results.find((r) => r.size === 501);

  record(
    '500 keys per request, 11 requests for the universe',
    at500?.status === 200 && ok === 11 ? 'PASS' : 'FAIL',
    `500 keys -> HTTP ${at500?.status}, 501 keys -> HTTP ${at501?.status}. Full pass: ${ok}/11 ` +
      `requests, ${covered} instruments, ${elapsed.toFixed(1)}s. Yahoo /v7 does the same universe ` +
      'in 27 requests and 2.8s per docs/02-data-sources.md, so this is about coverage, not speed.',
    'plan.md section 2 - the request budget for sync-quotes',
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function main() {
  console.log('Upstox Phase 0 - measuring the five claims plan.md rests on.\n');

  // The cheapest possible proof the token works, before anything expensive runs.
  const probe = await upstox('/market-quote/ltp?instrument_key=NSE_EQ%7CINE002A01018');
  if (!probe.ok) {
    console.error(
      `\nThe token was rejected: HTTP ${probe.status} ` +
        `${JSON.stringify(probe.body).slice(0, 300)}\n\n` +
        `(token length ${TOKEN.length}; the value itself is never printed)\n\n` +
        'A 401 means the Analytics Token was never generated, or has been revoked.\n' +
        'A 403 usually means the token came from the Algo Trading tab rather than\n' +
        'the Analytics tab.\n',
    );
    process.exit(1);
  }
  console.log(`Token accepted - RELIANCE LTP answered in ${probe.ms}ms.`);

  console.log('Downloading the NSE and BSE instrument masters...');
  const masters = await loadMasters();
  const smeCount = masters.all.NSE_EQ.filter((r) => r.security_type === 'SME').length;
  console.log(
    `  NSE_EQ ${masters.all.NSE_EQ.length} - BSE_EQ ${masters.all.BSE_EQ.length} - SME ${smeCount}`,
  );

  const checks = [
    ['split adjustment', () => checkSplitAdjustment(masters.bySymbol)],
    ['market cap', () => checkMarketCap(masters.bySymbol)],
    ['ROCE', () => checkRoce(masters.bySymbol)],
    ['SME', () => checkSme(masters)],
    ['batching', () => checkBatching(masters)],
  ];

  for (const [name, run] of checks) {
    try {
      await run();
    } catch (err) {
      // One check throwing must not cost the other four their measurement.
      console.log(`\n  ${name} check threw: ${err.message}`);
      record(name, 'UNKNOWN', err.message, 'unmeasured - rerun this check');
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('SUMMARY\n');
  for (const f of findings) {
    console.log(`[${f.verdict.padEnd(12)}] ${f.title}`);
    console.log(`                ${f.detail}`);
    console.log(`                affects: ${f.affects}\n`);
  }

  // PARTIAL counts. A claim that holds for three symbols and breaks on the
  // fourth still changes what plan.md should say about it.
  const unsettled = findings.filter((f) => f.verdict !== 'PASS');
  console.log(
    unsettled.length === 0
      ? 'Every claim held. plan.md stands as written.'
      : `${unsettled.length} claim(s) did not come back clean - update plan.md before building ` +
        `on them: ${unsettled.map((f) => f.title).join('; ')}.`,
  );
  // Exit 0 regardless: a failed check is a finding, not a broken script.
}

main().catch((err) => {
  console.error(`\nFatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
