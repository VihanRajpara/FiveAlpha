-- Prune what nothing writes, and move market cap to the table whose cadence it
-- actually follows.
--
-- Measured against the live database on 2026-09-02 (5,836 securities / 5,829
-- quotes) before writing any of this:
--
--   quotes.day_high        0 / 5,829 populated
--   quotes.day_low         0 / 5,829
--   quotes.volume          0 / 5,829
--   metrics.fundamentals_url  0 rows
--   securities_name_idx    0 index scans, 840 kB
--
-- All five are leftovers of sources this repo no longer uses: the Yahoo /v7
-- quote (which carried the OHLCV block) and the screener.in scrape (which
-- carried the page URL). The Upstox LTP feed that replaced them returns price,
-- previous close and a print time, and nothing else — see sync-quotes/index.ts.
--
-- Re-runnable: every statement is guarded.

-- ---------------------------------------------------------------------------
-- 1. The view depends on quotes.market_cap_cr, so it goes first and is rebuilt
--    at the bottom. Same DROP-then-CREATE dance as 0003, 0005 and 0008.
-- ---------------------------------------------------------------------------
drop view if exists public.securities_with_quotes;

-- ---------------------------------------------------------------------------
-- 2. quotes: the price row, and only the price row.
-- ---------------------------------------------------------------------------
alter table public.quotes
  drop column if exists day_high,
  drop column if exists day_low,
  drop column if exists volume;

-- ---------------------------------------------------------------------------
-- 3. Market cap moves to `metrics`.
--
-- It lived on `quotes` because Yahoo's /v7 returned it in the same response as
-- the price, so it genuinely rode along for free. It no longer does: since the
-- Upstox switch it is fetched per ISIN by sync-fundamentals, on the hourly
-- rotating pass, alongside ROCE — which is exactly the lifecycle 0008 split
-- `metrics` off `quotes` to keep apart. Leaving it here meant an hourly job
-- upserting into the five-minute table and relying on PostgREST's partial-column
-- semantics not to clobber a price; worse, a cap arriving for a symbol with no
-- quote row yet would INSERT a priceless quote.
--
-- `market_cap_at` is its own stamp for the same reason `roce_at` is: the two
-- figures come from different endpoints and either can be missing.
-- ---------------------------------------------------------------------------
alter table public.metrics
  add column if not exists market_cap_cr numeric,
  add column if not exists market_cap_at timestamptz;

-- Carry what is stored before the source column is dropped. `market_cap_at`
-- stays null deliberately: these figures came from Yahoo before 2026-08-31 and
-- their vintage is not knowable from `quotes.updated_at`, which records the last
-- *price* write. Null reads as "never fetched by the current source", which is
-- true, and puts them at the front of the refresh queue.
insert into public.metrics (symbol, market_cap_cr)
select symbol, market_cap_cr
  from public.quotes
 where market_cap_cr is not null and market_cap_cr > 0
on conflict (symbol) do update set market_cap_cr = excluded.market_cap_cr;

alter table public.quotes   drop column if exists market_cap_cr;

-- Nothing has written this since the screener.in scrape was deleted from
-- sync-fundamentals; the live client scrape still supplies the drawer's link
-- from its own response (src/lib/fundamentals.ts), which is where it belongs.
alter table public.metrics  drop column if exists fundamentals_url;

-- ---------------------------------------------------------------------------
-- 4. Constraints, because the app already learned these the hard way.
--
-- `market_cap_cr > 0` is the database-level version of the bug recorded in
-- plan.md: Upstox answers `market_cap = 0` for every BSE debt scrip, and a zero
-- stored as a cap passes a `>= 0` band and sorts to the top of a smallest-first
-- list — ~150 companies filed as worth nothing. toMarketCapCr() guards it in
-- code; this guards it for every writer, including a hand-run SQL fix.
--
-- Verified against live data before adding: 0 violating rows on all four.
-- ---------------------------------------------------------------------------
alter table public.quotes
  drop constraint if exists quotes_price_nonneg,
  add  constraint quotes_price_nonneg
       check (price is null or price >= 0),
  drop constraint if exists quotes_previous_close_nonneg,
  add  constraint quotes_previous_close_nonneg
       check (previous_close is null or previous_close >= 0);

alter table public.metrics
  drop constraint if exists metrics_market_cap_positive,
  add  constraint metrics_market_cap_positive
       check (market_cap_cr is null or market_cap_cr > 0),
  -- Wilder RSI is bounded by construction; anything outside it is a computation
  -- that went wrong, not a stock that moved a lot.
  drop constraint if exists metrics_rsi_range,
  add  constraint metrics_rsi_range
       check (monthly_rsi14 is null or monthly_rsi14 between 0 and 100),
  drop constraint if exists metrics_bars_nonneg,
  add  constraint metrics_bars_nonneg
       check (bars is null or bars >= 0);

alter table public.securities
  -- '' is the documented "no ISIN" value (3 rows today, all BSE debt scrips);
  -- anything else must be a real 12-character ISIN, because it is the key every
  -- Upstox call is built from — toInstrumentKey() silently returns null on a
  -- malformed one and the row goes unpriced with no explanation.
  drop constraint if exists securities_isin_format,
  add  constraint securities_isin_format
       check (isin = '' or isin ~ '^[A-Za-z0-9]{12}$'),
  -- A row that claims to trade nowhere, or on an exchange this app has no
  -- ticker rule for, cannot be priced or charted.
  drop constraint if exists securities_exchanges_valid,
  add  constraint securities_exchanges_valid
       check (cardinality(exchanges) between 1 and 2
              and exchanges <@ array['NSE', 'BSE']);

-- ---------------------------------------------------------------------------
-- 5. Indexes.
--
-- securities_name_idx was a GIN index over to_tsvector(name) for a full-text
-- search that was never built: the client loads the whole table once and filters
-- in memory (src/lib/filters.ts). 0 scans since it was created, 840 kB, and it
-- is re-tokenised for all 5,836 rows on every daily sync-securities upsert.
--
-- securities_series_idx and securities_exchanges_idx are kept — small, and they
-- do get scanned.
-- ---------------------------------------------------------------------------
drop index if exists public.securities_name_idx;

-- ---------------------------------------------------------------------------
-- 6. Republish the view.
--
-- market_cap_cr keeps its name and position, now sourced from `metrics`, so
-- nothing downstream changes. `bars` is dropped: sync-technicals writes it as a
-- diagnostic ("no reading" vs "short history") and the table keeps it, but no
-- client reads it off the view and it is 5,836 unread integers on every load.
-- ---------------------------------------------------------------------------
create view public.securities_with_quotes
-- security_invoker so the view evaluates RLS as the caller rather than as its
-- owner; the default would silently bypass the table policies.
with (security_invoker = true) as
  select s.symbol, s.name, s.series, s.isin, s.exchanges, s.yahoo_ticker, s.bse_code,
         s.listing_date, s.face_value, s.paid_up_value, s.market_lot,
         q.price, q.previous_close,
         q.price - q.previous_close                                    as change,
         case when q.previous_close is null or q.previous_close = 0 then null
              else (q.price - q.previous_close) / q.previous_close * 100
         end                                                           as change_percent,
         m.market_cap_cr,
         m.monthly_rsi14, m.roce_pct,
         q.price_time,
         q.updated_at
  from public.securities s
  left join public.quotes  q using (symbol)
  left join public.metrics m using (symbol);

grant select on public.securities_with_quotes to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Comments, which had gone stale against the source they name.
-- ---------------------------------------------------------------------------
comment on table public.securities is
  'One row per company across NSE and BSE, merged on ISIN by sync-securities. Daily.';
comment on table public.quotes is
  'Current price per symbol, overwritten wholesale by sync-quotes every 5 minutes during the session. Source: Upstox /v3/market-quote/ltp.';
comment on table public.metrics is
  'Slow-moving per-symbol figures, each with its own staleness stamp. RSI nightly (Yahoo spark), ROCE and market cap hourly per ISIN (Upstox fundamentals).';

comment on column public.quotes.price_time is
  'Exchange/vendor timestamp of the price itself. NULL when the feed did not supply one.';
comment on column public.metrics.market_cap_cr is
  'Market capitalisation in Rs crore, from Upstox /v2/fundamentals/:isin/profile. Constrained > 0: the vendor answers 0 for debt scrips and a stored zero is worse than a null.';
comment on column public.metrics.market_cap_at is
  'When market_cap_cr was last fetched. NULL means never, under the current source.';
comment on column public.metrics.bars is
  'Monthly closes behind monthly_rsi14, so "no reading" can be told from "short history". Diagnostic only — not exposed on securities_with_quotes.';
