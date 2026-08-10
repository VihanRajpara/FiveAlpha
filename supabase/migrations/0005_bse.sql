-- Add BSE listings to the master list.
--
-- `securities` used to be a straight mirror of NSE's EQUITY_L.csv. It now holds
-- one row per *company* across both cash exchanges, merged on ISIN by
-- sync-securities (and by scripts/seed.mjs): ~2,400 NSE rows, of which ~2,300
-- also trade on BSE, plus ~2,800 BSE-only companies. ~5,200 rows in total.
--
-- The primary key does not change. A dual-listed company keeps its NSE symbol,
-- so every existing row and every quotes.symbol foreign key survives untouched —
-- BSE-only companies are purely additive, keyed on their BSE scrip id.
--
-- Run this BEFORE the next `npm run seed:securities`. The seeder refuses to
-- write BSE rows into a database without these columns, because a BSE-only row
-- inserted without `yahoo_ticker` would be priced as though it were an NSE
-- symbol and quietly fill with the wrong company's price (or with nothing).

alter table public.securities
  add column if not exists exchanges    text[],
  add column if not exists yahoo_ticker text,
  add column if not exists bse_code     text;

-- Backfill: everything already in the table came from EQUITY_L.csv, so it is on
-- NSE and prices off `.NS`. Guarded by IS NULL so re-running is a no-op.
update public.securities
   set exchanges    = coalesce(exchanges, array['NSE']),
       yahoo_ticker = coalesce(yahoo_ticker, symbol || '.NS')
 where exchanges is null or yahoo_ticker is null;

-- Only now that every row is populated can these be made mandatory. Both are
-- read on every page load and neither has a sensible null reading: an empty
-- `exchanges` would render a row that claims to trade nowhere, and a null
-- `yahoo_ticker` is a row that cannot be priced at all.
alter table public.securities
  alter column exchanges    set not null,
  alter column exchanges    set default array['NSE'],
  alter column yahoo_ticker set not null;

comment on column public.securities.exchanges is
  'Cash exchanges this company is listed on, NSE first. {NSE}, {BSE} or {NSE,BSE}.';
comment on column public.securities.yahoo_ticker is
  'Exchange-qualified Yahoo ticker for quotes and charts: SYMBOL.NS, else SCRIPID.BO.';
comment on column public.securities.bse_code is
  'BSE numeric scrip code, NULL for companies not listed on BSE.';
comment on column public.securities.series is
  'NSE settlement series (EQ/BE/BZ) when listed on NSE, else the BSE group (A/B/X/T/Z/…).';

-- Supports the "BSE only" cut without scanning the whole table. GIN because
-- the interesting predicate is array containment (`exchanges @> '{BSE}'`).
create index if not exists securities_exchanges_idx
  on public.securities using gin (exchanges);

-- ---------------------------------------------------------------------------
-- Republish the joined view with the new columns.
--
-- DROP first rather than CREATE OR REPLACE: replacing a view can only append
-- columns, never insert one mid-list, and these belong beside the other
-- identity columns rather than after the price. See 0003 for the same dance.
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
         q.price_time,
         q.updated_at
  from public.securities s
  left join public.quotes q using (symbol);

-- Dropping the view dropped its grants with it; PostgREST needs these to expose it.
grant select on public.securities_with_quotes to anon, authenticated;
