[← Frontend internals](04-frontend.md) · [Docs index](README.md) · Next: [Build from scratch →](06-build-from-scratch.md)

# 5. Supabase backend

> **Status:** the schema and Edge Functions here are written and typechecked. The **client** side is verified against a live project (`fivepercent`, ap-northeast-1): supabase-js authenticates with a publishable key and issues correctly paginated PostgREST queries. The **migrations and functions themselves have not been executed** — that needs dashboard/CLI access. Treat those command sequences as tested-by-inspection.

## 5.0 Two ways to get data in

| | Route A — local seeder | Route B — Edge Functions |
|---|---|---|
| Needs Supabase CLI / login | no | yes |
| Needs functions deployed | no | yes |
| Where the fetching runs | your machine (`scripts/seed.mjs`) | Supabase edge runtime |
| Refresh | manual (`npm run seed`) | automatic (pg_cron) |
| Good for | getting working today, local dev | production |

Both write the same rows through the same schema, so you can start with A and add B later without changing anything.

### Route A — `scripts/seed.mjs`

Node has no CORS restriction and does not trip NSE's header fingerprinting, so it can call NSE and Yahoo directly — the same work the Edge Functions do, minus the deploy step.

```bash
npm run seed              # securities → quotes
npm run seed:securities
npm run seed:quotes
```

There is no candles task. Chart history is never stored — see [5.2](#52-schema).

Credentials come from `.env`, the single gitignored file holding every credential in the project. The secret key is deliberately **not** `VITE_`-prefixed — anything with that prefix is inlined into the public browser bundle:

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

The script refuses to run if handed a publishable or anon key:

```
SUPABASE_SECRET_KEY looks like a publishable/anon key. Writes will be rejected by RLS.
```

That guard exists because the failure it prevents is confusing — RLS grants `anon` read-only access, so writes fail with a permissions error that reads like a schema problem.

It writes via PostgREST with `Prefer: resolution=merge-duplicates` rather than supabase-js. Two reasons: every write is an idempotent upsert on the primary key, and `@supabase/supabase-js` ≥2.112 requires native `WebSocket`, which Node 18 lacks (added in Node 22). Plain `fetch` sidesteps that entirely.

## 5.1 Why a backend exists at all

Direct mode works only under `npm run dev`, because the Vite proxy is a dev-server feature. A deployed build has no proxy, and the browser cannot call NSE or Yahoo directly (no CORS). Something server-side must do it.

Supabase supplies all three needed pieces in one project:

| Need | Supabase piece |
|---|---|
| Server-side fetching with forged headers | Edge Functions (Deno) |
| Somewhere to keep the 2,397-row master list and its prices | Postgres |
| Something to run it on a schedule | pg_cron + pg_net |

It also inverts the request economics: the browser goes from **121 requests** to **2**.

## 5.2 Schema

```mermaid
erDiagram
    securities ||--o| quotes  : "1:1"

    securities {
        text        symbol PK
        text        name
        text        series
        text        isin
        date        listing_date
        numeric     face_value
        numeric     paid_up_value
        integer     market_lot
        timestamptz updated_at
    }
    quotes {
        text        symbol PK_FK
        numeric     price
        numeric     previous_close
        numeric     day_high
        numeric     day_low
        bigint      volume
        timestamptz price_time
        timestamptz updated_at
    }
```

### Design decisions

**`quotes` is one row per symbol, overwritten in place.** Not an append-only tick log. The UI only ever needs the current price. Appending every 5 minutes would add ~180k rows/day for data nobody reads.

**Chart history is not stored at all.** There *was* a `candles` table — ~250 daily bars × ~2,400 symbols ≈ 500k rows, about 164 MB, a third of the free tier's 500 MB budget. What it bought was a table read one symbol at a time, only while a detail drawer is open, i.e. a handful of rows per user session. The trade is inverted compared to `quotes`, which every page load reads in full. So the drawer now fetches its bars live from Yahoo through the `/api/yahoo` proxy, and [`0004_drop_candles.sql`](../supabase/migrations/0004_drop_candles.sql) removes the table. Cost: one upstream request when a drawer opens (~300 ms), against a permanent third of the database.

**Money is `numeric`, never `float`.** Binary floating point cannot represent `0.05` exactly; accumulated error in financial data is unacceptable.

### Indexes

| Index | Serves |
|---|---|
| `securities_series_idx` on `(series)` | series filter |
| `securities_name_idx` GIN on `to_tsvector('simple', name)` | full-text company search |

## 5.3 Security model

Three layers, each assuming the others might fail.

### Row Level Security

```sql
alter table public.securities enable row level security;
create policy "public read securities" on public.securities
  for select to anon, authenticated using (true);
```

`select` only — no insert, update or delete policy exists for `anon`. A leaked anon key permits reading public market data and nothing else. **RLS enabled with no policy denies everything**, so a forgotten policy fails closed.

Writes go through Edge Functions using the **service role key**, which bypasses RLS and is only ever present in the function environment. It never reaches the browser.

### Function authorization

Every function requires a shared secret:

```ts
export function assertAuthorized(req: Request): Response | null {
  const expected = Deno.env.get('SYNC_SECRET');
  if (!expected) return json({ error: 'SYNC_SECRET is not configured on this function' }, 500);
  if (req.headers.get('x-sync-secret') !== expected) return json({ error: 'unauthorized' }, 401);
  return null;
}
```

Without this, anyone who discovered the URL could invoke `sync-quotes` repeatedly and drive unlimited outbound traffic on your project — a billing attack more than a data one. Note it fails **closed**: a missing `SYNC_SECRET` returns 500, it does not skip the check.

### Cron config isolation

The cron job needs the URL and secret, and they must not be reachable through the API:

```sql
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.sync_config (
  id            boolean primary key default true check (id),
  functions_url text not null,
  sync_secret   text not null
);
revoke all on private.sync_config from anon, authenticated;
```

PostgREST only exposes the `public` schema, so `private.sync_config` is unreachable over HTTP regardless of RLS. The `id boolean primary key default true check (id)` idiom is a **single-row constraint** — the only permissible key is `true`, so the table cannot hold a second config row.

## 5.4 The two Edge Functions

Both are Deno, both share [_shared/upstream.ts](../supabase/functions/_shared/upstream.ts), and both follow the same skeleton: handle `OPTIONS`, check the secret, do work, return JSON.

### `sync-securities`

Mirrors `EQUITY_L.csv` into `securities`. Fetches with the NSE header set, parses with the same RFC-4180 reader as the frontend, upserts in **chunks of 500** so no single statement exceeds the request body limit.

```
POST /functions/v1/sync-securities
→ { "ok": true, "securities": 2397 }
```

Cheap and slow-moving — the list only changes on listings and delistings, so once daily is plenty.

### `sync-quotes`

Refreshes every price. Reads all symbols (paginating past PostgREST's 1,000-row cap), chunks by 20, pools at concurrency 8, upserts in chunks of 500.

```
POST /functions/v1/sync-quotes
→ { "ok": true, "requested": 2397, "priced": 2396, "failedBatches": 0 }
```

120 upstream requests at concurrency 8 fits comfortably in one invocation — measured at 3.4s server-side with concurrency 6.

Rows where both `price` and `previous_close` are null are dropped rather than written as an all-null row.

### There is no `sync-candles`

There used to be, and it was the most intricate function in the project: Yahoo's chart endpoint is **one request per symbol**, so 2,397 symbols could not be done in a single invocation. It worked around that with a rotation cursor (`securities.candles_synced_at`, `NULLS FIRST`), 120 symbols every 15 minutes, ~5 hours for a full pass — 11,520 upstream requests a day to keep half a million rows warm.

All of that machinery existed to pre-compute an answer nobody was asking for in bulk. A chart is opened for one symbol at a time; fetching that one symbol on demand costs a single request and no storage. The function, its cron job, the cursor column and its index are all gone.

### Shared helpers

| Helper | Purpose |
|---|---|
| `adminClient()` | service-role client; throws if env vars are missing |
| `assertAuthorized(req)` | the secret check |
| `fetchWithTimeout(url, init, ms)` | `AbortController` + 15s default — one stalled upstream cannot eat the whole invocation budget |
| `mapPool`, `chunk` | same concurrency primitives as the frontend |
| `parseCsvObjects`, `parseNseDate`, `toNumber` | duplicated from `src/lib` — Deno and Vite cannot share a module graph here, so this is intentional duplication |

## 5.5 Scheduling

pg_cron fires, pg_net makes the HTTP call. `invoke_sync` is `security definer` so it can read `private.sync_config`, and is revoked from `anon`/`authenticated`.

```sql
select net.http_post(
  url     := cfg.functions_url || '/' || fn || query,
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-secret', cfg.sync_secret),
  body    := '{}'::jsonb,
  timeout_milliseconds := 120000
) into request_id;
```

`pg_net` is **asynchronous** — it queues the request and returns an id immediately. The cron job does not block waiting for the function, and a slow sync cannot hold a database connection open.

### Schedules

**pg_cron runs in UTC. NSE trades 09:15–15:30 IST = 03:45–10:00 UTC.** Getting this wrong is the classic way to schedule a market job that never fires during market hours.

| Job | Cron (UTC) | Meaning |
|---|---|---|
| `nse-sync-securities` | `0 1 * * *` | 01:00 UTC = 06:30 IST — daily, well before the open |
| `nse-sync-quotes` | `*/5 3-10 * * 1-5` | every 5 min, 03:00–10:59 UTC, Mon–Fri — the session plus padding for pre-open and the closing print |

Two jobs, not three. Chart history has no schedule because nothing ingests it.

The migration unschedules by name before scheduling, so re-running it is idempotent:

```sql
select cron.unschedule(jobname) from cron.job
 where jobname in ('nse-sync-securities', 'nse-sync-quotes', 'nse-sync-candles');
--                                                     ^ still listed so re-running
--                                                       0002 removes the old job
```

### Cost

| Job | Runs/day | Upstream requests/day |
|---|---|---|
| securities | 1 | 1 |
| quotes | ~96 (weekdays) | ~11,520 |

~11.5k outbound requests/day, spread out, from one IP — half what it was before the candles job was removed. Well within Supabase's free tier for invocations; the constraint you would hit first is Yahoo's tolerance, and no throttling was observed at these rates. Chart requests now come from the Cloudflare Worker instead, one per drawer opened.

To reduce it: widen the quotes interval to 15 minutes, and narrow the hours to `4-10` once you have confirmed your instance's clock.

## 5.6 The convenience view

```sql
create or replace view public.securities_with_quotes as
  select s.symbol, s.name, s.series, s.isin, s.listing_date, …,
         q.price, q.previous_close,
         q.price - q.previous_close as change,
         case when q.previous_close is null or q.previous_close = 0 then null
              else (q.price - q.previous_close) / q.previous_close * 100
         end as change_percent,
         q.updated_at
  from public.securities s
  left join public.quotes q using (symbol);
```

`LEFT JOIN` so a share with no quote yet still appears. The `change_percent` case guards division by zero — the same guard as `buildQuote()` on the client.

The app does not currently use this view (it reads the two tables and joins in JS, which keeps the two adapters symmetrical). It exists for ad-hoc SQL and as the natural single-query optimisation if you want it.

## 5.7 Deploying

Full command sequence in the [README](../README.md#supabase-setup). Summary:

```bash
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set SYNC_SECRET=$(openssl rand -hex 24)
# edit supabase/migrations/0002_cron.sql — replace both placeholders
supabase db push
supabase functions deploy sync-securities sync-quotes

BASE=https://YOUR-PROJECT-REF.supabase.co/functions/v1
curl -X POST "$BASE/sync-securities" -H "x-sync-secret: $SECRET"
curl -X POST "$BASE/sync-quotes"     -H "x-sync-secret: $SECRET"
```

**Do not set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`** — Supabase injects both into every function automatically, and setting them manually is how people accidentally commit a service role key.

### Order matters

`sync-quotes` reads from `securities`. Running it first returns:

```json
{ "error": "securities is empty — run sync-securities first" }
```

409, deliberately — a clear message beats an empty table.

---

Next: [Build from scratch →](06-build-from-scratch.md)
