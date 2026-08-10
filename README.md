# NSE + BSE Listed Shares

Every company listed on India's two cash exchanges — **~5,200 companies** — in a sortable, searchable table with live prices and history charts.

The two exchange lists are merged on ISIN, so a dual-listed name like RELIANCE is **one row**, not two: 2,410 NSE shares, of which 2,280 also trade on BSE, plus 2,819 companies that are on BSE only.

React + Vite + TypeScript on the front, Supabase (Postgres + Edge Functions + pg_cron) for production data ingestion.

> 📚 **Detailed documentation is in [`docs/`](docs/README.md)** — architecture, every data source, the full boot flow, frontend internals, the Supabase backend, a from-scratch build guide, and the debugging log.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. No API keys, no signup, no Supabase project needed — it works immediately.

## Where the data comes from

Both sources are free and require no authentication or account.

| What | Source | Notes |
|---|---|---|
| NSE listings | `nsearchives.nseindia.com/content/equities/EQUITY_L.csv` | NSE's own daily publication. Symbol, company, series, ISIN, listing date, face value, paid-up value, market lot. |
| BSE listings | `api.bseindia.com/BseIndiaAPI/api/ListofScripData/w` | The feed behind BSE's "List of Securities" page. 5,099 active equity scrips; joined to the NSE list on ISIN. |
| Prices | Yahoo Finance `v8/finance/spark` | Batched, **hard limit of 20 tickers per request**. `SYMBOL.NS` for anything on NSE, `SCRIPID.BO` for BSE-only companies. |
| History | Yahoo Finance `v8/finance/chart` | One request per symbol. Daily bars up to 1Y, weekly for 5Y. |

Where a company trades on both exchanges the NSE book is quoted — it is the more liquid of the two. The detail drawer names the exact ticker each price came from.

Timing depends on where the requests originate:

| Path | First prices on screen | Full market |
|---|---|---|
| Server-side (Node / Edge Function, concurrency 6) | — | **~3.4s** |
| Browser via the Vite dev proxy | **~4s** | **~19s** |

The browser is slower because Chrome allows only 6 concurrent connections per origin, and the dev proxy is a single HTTP/1.1 Node process. It doesn't matter in practice: quotes render progressively as each batch lands, so the table is usable within a few seconds. In Supabase mode the browser makes one query and the batching happens server-side.

Alternatives evaluated and rejected: Yahoo's `v7/finance/quote` batch endpoint now returns 401 without a crumb; Angel One's scrip master timed out. Zerodha Kite's `/instruments` dump and Dhan's scrip master both work without auth and are good fallbacks for the master list, but they mix in ~7,500 bonds, SGBs, ETFs and SME scrips that have to be filtered out, whereas `EQUITY_L.csv` is exactly the listed-equity universe.

Prices are delayed and this is not investment advice.

## Two modes

The app picks its backend at startup based on whether `VITE_SUPABASE_URL` is set.

**Direct mode (default)** — the browser calls NSE and Yahoo through the Vite dev proxy. Zero setup, but it only works under `npm run dev`, because the proxy is a dev-server feature.

**Supabase mode** — the app reads rows that Edge Functions have already ingested on a schedule. This is what a deployed build needs. Set both env vars and it switches over automatically; no code change.

```
src/lib/dataSource.ts     picks the adapter
src/lib/directSource.ts   NSE + Yahoo via the /api proxy
src/lib/supabaseSource.ts reads the securities / quotes tables
src/lib/yahooCandles.ts   chart history — used by BOTH, never stored
```

Both implement the same `DataSource` interface in `src/types.ts`, so the UI is unaware of which is active.

### About the dev proxy

`vite.config.ts` **replaces** the outgoing request headers rather than adding to them. This matters: Vite's `proxy.headers` option only merges, which leaves Chromium's own `referer` / `sec-ch-ua` headers on the request, and NSE's WAF silently blackholes that particular combination — the request hangs until it times out instead of returning an error. Stripping to a known-good header set is what makes it work from a browser.

In a deployed build the dev proxy is gone, so [`worker/index.ts`](worker/index.ts) serves the same `/api/nse/*` and `/api/yahoo/*` paths with the same header rewriting. The frontend calls one URL shape and neither knows nor cares which is answering.

## Why history is not in the database

The detail chart used to read a `candles` table: ~250 daily bars × ~2,400 symbols ≈ **500,000 rows, 164 MB** — a third of Supabase's free 500 MB — kept warm by an Edge Function doing 11,520 upstream requests a day.

What it bought: a table nobody queries in bulk. A chart is opened for one symbol at a time, only while the drawer is open. So the pre-computation was paying storage and request budget every day to serve a handful of rows per session.

Now nothing stores it. Opening a drawer costs one Yahoo request (~300 ms) through the same-origin proxy, cached in the browser for 10 minutes.

| | Before | After |
|---|---|---|
| Database | ~164 MB of candles | 0 |
| Ingest requests/day | ~23,000 | ~11,500 |
| Cron jobs | 3 | 2 |
| Chart open | one PostgREST query | one Yahoo request via `/api/yahoo` |

The list and the prices stay in Postgres, because *those* are read in full by every page load — the opposite access pattern.

To apply it to an existing project, run [`supabase/migrations/0004_drop_candles.sql`](supabase/migrations/0004_drop_candles.sql) in the SQL Editor **after** deploying this build. It unschedules the cron job, drops the table and drops the `candles_synced_at` cursor column. Dropping a table releases its files immediately — no `VACUUM` needed — so Database Size falls within a few minutes.

## Deploy (Cloudflare Workers)

```bash
npm run deploy      # npm run build && wrangler deploy
```

[`wrangler.toml`](wrangler.toml) uploads `./dist` as static assets and `worker/index.ts` as the Worker in front of them:

- `run_worker_first = ["/api/*"]` — without it, `not_found_handling = "single-page-application"` would answer a chart request with `index.html` and every chart would fail on `JSON.parse` of an HTML document.
- Everything else is served straight from the asset store and **never invokes the Worker**, so static traffic doesn't consume the free plan's 100k daily Worker requests. Only `/api/*` does.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are **build**-time values — Vite inlines them into the bundle. Set them as build variables in the Cloudflare dashboard, not as Worker runtime vars.

> Wrangler 4 requires **Node 22+**. This project otherwise runs on Node 18; if `wrangler deploy` refuses to start, that is why. Deploying through the Cloudflare dashboard's Git integration avoids it, since the build image supplies its own Node.

The Worker's `/api` proxy is an allow-list, not an open proxy: only `v8/finance/chart/<ticker>`, `v8/finance/spark`, the NSE archive CSVs and BSE's `ListofScripData/w` are forwarded, GET/HEAD only. Anything else gets a 403 before a request leaves Cloudflare.

## Supabase setup

Two routes. **Route A needs no CLI and no login** — do that first and you have a working database in about five minutes. Route B adds automated refresh on a schedule.

### Route A — SQL Editor + local seeder (no CLI)

**1. Create the tables.** Supabase dashboard → **SQL Editor** → New query. Paste the whole of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and Run. That creates `securities`, `quotes`, their indexes, and read-only RLS policies. Two small tables, a few MB in total — chart history is deliberately not stored (see [Why history is not in the database](#why-history-is-not-in-the-database)).

Then run the later migrations in order, at minimum [`0003_price_time.sql`](supabase/migrations/0003_price_time.sql) and [`0005_bse.sql`](supabase/migrations/0005_bse.sql). **0005 is not optional if you want BSE listings**: it adds `exchanges`, `yahoo_ticker` and `bse_code`, and the seeder refuses to run without them rather than write BSE-only rows that would then be priced as though they were NSE symbols.

**2. Point the app at your project.** Copy `.env.example` to `.env` — one gitignored file holds every credential — and fill in:

```bash
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Both are safe in the browser bundle. New projects issue a publishable key; older ones issue an `anon` JWT — set `VITE_SUPABASE_ANON_KEY` instead and the app reads either.

**3. Give the seeder a secret key.** Add one more line to the same `.env`, deliberately without a `VITE_` prefix — that prefix is what inlines a value into the public bundle:

```bash
SUPABASE_SECRET_KEY=sb_secret_...
```

Dashboard → Project Settings → API keys → **secret** key. It bypasses RLS, which is why it must never reach the browser. A publishable key here is rejected with a clear error rather than failing mysteriously against RLS.

**4. Seed.**

```bash
npm run seed              # securities → quotes
```

or individually:

```bash
npm run seed:securities   # ~5,200 merged rows from NSE + BSE
npm run seed:quotes       # every price
```

`scripts/seed.mjs` does exactly what the Edge Functions do, but from Node — no CORS, no WAF fingerprint problem, no deploy step. Re-run it any time; every write is an idempotent upsert.

**5. Run it.**

```bash
npm run dev
```

The status pill now reads **Supabase** instead of *Direct (dev proxy)*.

### Route B — Edge Functions + cron (automated refresh)

Route A leaves you refreshing by hand. This makes it automatic. Requires the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npx supabase login
npx supabase link --project-ref <your-ref>

# Shared secret so nobody who finds your function URLs can drive traffic on your project
npx supabase secrets set SYNC_SECRET=$(openssl rand -hex 24)

npx supabase functions deploy sync-securities sync-quotes
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions automatically — don't set them.

Then edit [`supabase/migrations/0002_cron.sql`](supabase/migrations/0002_cron.sql), replacing `YOUR-PROJECT-REF` and `YOUR-SYNC-SECRET` at the bottom, and run it in the SQL Editor (or `npx supabase db push`).

Verify a function manually:

```bash
curl -X POST "https://<your-ref>.supabase.co/functions/v1/sync-quotes" \
     -H "x-sync-secret: <your-secret>"
# → {"ok":true,"requested":2397,"priced":2396,"failedBatches":0}
```

### What runs on a schedule

Set up by `0002_cron.sql` via pg_cron + pg_net. Times are UTC; NSE trades 03:45–10:00 UTC (09:15–15:30 IST).

| Job | Cron | Purpose |
|---|---|---|
| `nse-sync-securities` | `0 1 * * *` | Refresh the master list once daily, before the open |
| `nse-sync-quotes` | `*/5 3-10 * * 1-5` | Prices every 5 min through the trading session |

Two jobs, not three: nothing ingests history.

### Security model

- Both tables have RLS enabled with **read-only** policies for `anon`. The browser can never write.
- Writes happen only inside Edge Functions using the service-role key, which never reaches the client.
- Cron config (URL + secret) lives in a `private` schema with all grants revoked, so PostgREST cannot expose it.

## Project layout

```
src/
  App.tsx                    layout, search, exchange/series filters, status bar
  types.ts                   Security / Quote / Candle / DataSource
  hooks/useMarketData.ts     loads the list, then streams quotes in progressively
  components/
    StockTable.tsx           TanStack Table + virtualizer (only ~35 rows in the DOM)
    StockDetail.tsx          drawer: price, chart, range selector, fundamentals
    PriceChart.tsx           hand-rolled SVG area chart with crosshair
  lib/
    csv.ts                   RFC-4180 parser — NSE quotes names containing commas
    listings.ts              NSE + BSE master lists, merged on ISIN
    format.ts                INR formatting, chunk(), mapPool() concurrency limiter
    yahooCandles.ts          chart history via /api/yahoo — fetched, never stored
worker/
  index.ts                   Cloudflare Worker: serves ./dist + proxies /api/*
supabase/
  migrations/0001_init.sql   tables, indexes, RLS policies, joined view
  migrations/0002_cron.sql   pg_cron + pg_net schedules
  migrations/0004_drop_candles.sql  drops the old stored history
  migrations/0005_bse.sql    exchanges / yahoo_ticker / bse_code — required for BSE
  functions/                 sync-securities, sync-quotes
```

## Notes on the implementation

- **Virtualization is not optional.** 2,397 rows × 11 columns is ~26k cells; rendering them all janks badly. Only the visible window is in the DOM.
- **Quotes stream in.** `fetchQuotes` fires its `onBatch` callback *inside* the worker, as each chunk resolves. Firing it after the pool drains instead is an easy mistake and costs a lot — it holds every update back until all 120 requests finish, so the table sits empty for ~45s and then populates in one jump.
- **Concurrency is capped at 6.** Yahoo starts refusing connections above roughly 8 in parallel. `mapPool` in `src/lib/format.ts` enforces the limit.
- **Unpriced symbols sort last.** Accessors return `undefined` rather than `0` so a handful of unpriced scrips don't masquerade as the day's biggest losers.
- **Numeric columns sort descending on first click** (TanStack's default for numbers), so one click on Chg % gives you the day's top gainers.

## Requirements

Node 18+. Built and verified on Node 18.20.3 with Vite 5. `npm install` prints `EBADENGINE` warnings for a couple of `@supabase/supabase-js` sub-dependencies that declare Node 22 — they are harmless here, since that package only ever runs in the browser bundle.
