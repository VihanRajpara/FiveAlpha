# NSE Listed Shares

Every share listed on India's National Stock Exchange — **2,397 securities** (EQ 2,075 · BE 294 · BZ 28) — in a sortable, searchable table with live prices and history charts.

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
| The list of listed shares | `nsearchives.nseindia.com/content/equities/EQUITY_L.csv` | NSE's own daily publication. Symbol, company, series, ISIN, listing date, face value, paid-up value, market lot. |
| Prices | Yahoo Finance `v8/finance/spark` | Batched, **hard limit of 20 tickers per request**. NSE symbols map to Yahoo by suffixing `.NS`. |
| History | Yahoo Finance `v8/finance/chart` | One request per symbol. Daily bars up to 1Y, weekly for 5Y. |

Measured coverage: **2,396 of 2,397 symbols priced** (99.96%), zero failed batches across 120 requests.

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
src/lib/directSource.ts   NSE + Yahoo via the dev proxy
src/lib/supabaseSource.ts reads securities / quotes / candles tables
```

Both implement the same `DataSource` interface in `src/types.ts`, so the UI is unaware of which is active.

### About the dev proxy

`vite.config.ts` **replaces** the outgoing request headers rather than adding to them. This matters: Vite's `proxy.headers` option only merges, which leaves Chromium's own `referer` / `sec-ch-ua` headers on the request, and NSE's WAF silently blackholes that particular combination — the request hangs until it times out instead of returning an error. Stripping to a known-good header set is what makes it work from a browser.

## Supabase setup

Two routes. **Route A needs no CLI and no login** — do that first and you have a working database in about five minutes. Route B adds automated refresh on a schedule.

### Route A — SQL Editor + local seeder (no CLI)

**1. Create the tables.** Supabase dashboard → **SQL Editor** → New query. Paste the whole of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and Run. That creates `securities`, `quotes`, `candles`, their indexes, and read-only RLS policies.

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
npm run seed              # securities → quotes → candles (200 symbols)
```

or individually:

```bash
npm run seed:securities   # ~2,400 rows from NSE
npm run seed:quotes       # every price, ~3.4s
npm run seed:candles      # history for the 200 stalest symbols
node scripts/seed.mjs candles 400   # bigger slice
```

`scripts/seed.mjs` does exactly what the Edge Functions do, but from Node — no CORS, no WAF fingerprint problem, no deploy step. Re-run it any time; every write is an idempotent upsert.

**5. Run it.**

```bash
npm run dev
```

The status pill now reads **Supabase** instead of *Direct (dev proxy)*.

> **Candles rotate.** Each `seed:candles` run takes the 200 least-recently-synced symbols and advances a cursor, so repeated runs work through the whole market. Roughly 12 runs at 200 covers all 2,397. Stocks without candles yet still show prices — the chart just says no history available.

### Route B — Edge Functions + cron (automated refresh)

Route A leaves you refreshing by hand. This makes it automatic. Requires the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npx supabase login
npx supabase link --project-ref <your-ref>

# Shared secret so nobody who finds your function URLs can drive traffic on your project
npx supabase secrets set SYNC_SECRET=$(openssl rand -hex 24)

npx supabase functions deploy sync-securities sync-quotes sync-candles
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
| `nse-sync-candles` | `*/15 * * * *` | 120 stalest symbols per run — full universe rotates every ~5h |

`sync-candles` can't do 2,400 symbols in one invocation (Yahoo's chart endpoint is one request per symbol), so it works through them using `securities.candles_synced_at` as a cursor, oldest first.

### Security model

- The three tables have RLS enabled with **read-only** policies for `anon`. The browser can never write.
- Writes happen only inside Edge Functions using the service-role key, which never reaches the client.
- Cron config (URL + secret) lives in a `private` schema with all grants revoked, so PostgREST cannot expose it.

## Project layout

```
src/
  App.tsx                    layout, search, series filter, status bar
  types.ts                   Security / Quote / Candle / DataSource
  hooks/useMarketData.ts     loads the list, then streams quotes in progressively
  components/
    StockTable.tsx           TanStack Table + virtualizer (only ~35 rows in the DOM)
    StockDetail.tsx          drawer: price, chart, range selector, fundamentals
    PriceChart.tsx           hand-rolled SVG area chart with crosshair
  lib/
    csv.ts                   RFC-4180 parser — NSE quotes names containing commas
    format.ts                INR formatting, chunk(), mapPool() concurrency limiter
supabase/
  migrations/0001_init.sql   tables, indexes, RLS policies, joined view
  migrations/0002_cron.sql   pg_cron + pg_net schedules
  functions/                 sync-securities, sync-quotes, sync-candles
```

## Notes on the implementation

- **Virtualization is not optional.** 2,397 rows × 11 columns is ~26k cells; rendering them all janks badly. Only the visible window is in the DOM.
- **Quotes stream in.** `fetchQuotes` fires its `onBatch` callback *inside* the worker, as each chunk resolves. Firing it after the pool drains instead is an easy mistake and costs a lot — it holds every update back until all 120 requests finish, so the table sits empty for ~45s and then populates in one jump.
- **Concurrency is capped at 6.** Yahoo starts refusing connections above roughly 8 in parallel. `mapPool` in `src/lib/format.ts` enforces the limit.
- **Unpriced symbols sort last.** Accessors return `undefined` rather than `0` so a handful of unpriced scrips don't masquerade as the day's biggest losers.
- **Numeric columns sort descending on first click** (TanStack's default for numbers), so one click on Chg % gives you the day's top gainers.

## Requirements

Node 18+. Built and verified on Node 18.20.3 with Vite 5. `npm install` prints `EBADENGINE` warnings for a couple of `@supabase/supabase-js` sub-dependencies that declare Node 22 — they are harmless here, since that package only ever runs in the browser bundle.
