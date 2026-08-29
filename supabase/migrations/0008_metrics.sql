-- Precomputed per-symbol metrics, so RSI and ROCE are columns of the dataset
-- rather than by-products of a screen run.
--
-- Why this table exists at all. Both figures were only ever populated by
-- `useScreen`, and only for the rows a run actually reached:
--
--   · RSI(M)  needs ten years of monthly closes — 20 symbols per Yahoo spark
--             request, so ~260 requests for the 5,229-row universe. Affordable
--             once a night on a server, not on every page load in a browser.
--   · ROCE    is scraped from screener.in one company page at a time, paced
--             1.2s apart because that is what the origin tolerates. The whole
--             universe is ~1h45m of wall clock. It cannot be done client-side
--             at all, which is why the ROCE column was empty for ~95% of rows:
--             only survivors of every technical leg were ever asked.
--
-- Kept apart from `quotes` deliberately, though not because a partial upsert
-- would clobber anything: PostgREST's `merge-duplicates` updates only the
-- columns present in the payload, which is what lets sync-technicals and
-- sync-fundamentals write different columns of the same row on different
-- schedules. (sync-securities already depends on exactly that — it drops
-- `exchanges` and `bse_code` from its payload when BSE is unreachable so the
-- stored values survive.)
--
-- The reason is lifecycle. `quotes` is rewritten wholesale every five minutes
-- during the session; these figures are refreshed nightly and monthly and carry
-- their own staleness stamps, which is what `roce_at` below drives the scrape
-- queue with. Mixing a 5-minute table with a 30-day one means every price
-- refresh writes columns it has nothing to say about.

-- ---------------------------------------------------------------------------
-- Market cap rides along with the price.
--
-- `/v7/finance/quote` returns `marketCap` in the same response as
-- `regularMarketPrice`, so this costs nothing beyond a column: sync-quotes has
-- the number in hand and would otherwise throw it away, leaving the app to
-- re-fetch it through a separate 13-request pass on every screen run.
-- ---------------------------------------------------------------------------
alter table public.quotes
  add column if not exists market_cap_cr numeric;

comment on column public.quotes.market_cap_cr is
  'Market capitalisation in Rs crore, from Yahoo /v7/finance/quote. NULL when the vendor has no figure.';

create table if not exists public.metrics (
  symbol            text primary key references public.securities (symbol) on delete cascade,
  -- Wilder RSI(14) over collapsed monthly closes. Must match src/lib/technicals.ts
  -- exactly, or the column and a screen verdict would disagree on the same row.
  monthly_rsi14     numeric,
  -- Bars behind the RSI, so "no reading" can be told from "short history".
  bars              integer,
  rsi_at            timestamptz,
  -- Latest annual return on capital employed, percent, scraped from screener.in.
  roce_pct          numeric,
  -- The page the figure came from, so a number in the UI stays checkable.
  fundamentals_url  text,
  -- Drives the incremental scrape: sync-fundamentals takes the oldest rows
  -- first, so the universe fills in over a few nights and then self-maintains.
  -- NULL sorts first under `nulls first`, which is what makes never-scraped
  -- symbols the highest priority without a separate queue.
  roce_at           timestamptz
);

-- The scrape's work queue. Partial rather than plain: the interesting question
-- is only ever "which rows are stale or unscraped", never the full ordering.
create index if not exists metrics_roce_at_idx
  on public.metrics (roce_at nulls first);

alter table public.metrics enable row level security;

drop policy if exists "public read metrics" on public.metrics;
create policy "public read metrics" on public.metrics
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Republish the joined view with the new columns.
--
-- DROP first rather than CREATE OR REPLACE: replacing a view can only append
-- columns, never insert one mid-list, and these belong beside the figures they
-- extend. Same dance as 0003 and 0005.
-- ---------------------------------------------------------------------------
drop view if exists public.securities_with_quotes;

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
         q.market_cap_cr,
         m.monthly_rsi14, m.bars, m.roce_pct, m.fundamentals_url,
         q.price_time,
         q.updated_at
  from public.securities s
  left join public.quotes  q using (symbol)
  left join public.metrics m using (symbol);

grant select on public.securities_with_quotes to anon, authenticated;
