-- Schema for the NSE listed-shares app.
--
--   securities  the master list, mirrored from NSE's EQUITY_L.csv (~2,400 rows)
--   quotes      one current price row per symbol, overwritten on each refresh
--   candles     daily/weekly bars for the detail chart

create table if not exists public.securities (
  symbol            text primary key,
  name              text        not null,
  series            text        not null,
  isin              text        not null default '',
  listing_date      date,
  face_value        numeric,
  paid_up_value     numeric,
  market_lot        integer,
  -- Cursor for sync-candles: it always works on the least recently synced symbols.
  candles_synced_at timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists securities_series_idx on public.securities (series);
create index if not exists securities_name_idx   on public.securities using gin (to_tsvector('simple', name));
create index if not exists securities_candles_cursor_idx
  on public.securities (candles_synced_at nulls first);

create table if not exists public.quotes (
  symbol         text primary key references public.securities (symbol) on delete cascade,
  price          numeric,
  previous_close numeric,
  day_high       numeric,
  day_low        numeric,
  volume         bigint,
  updated_at     timestamptz not null default now()
);

create table if not exists public.candles (
  symbol   text  not null references public.securities (symbol) on delete cascade,
  bar_date date  not null,
  open     numeric,
  high     numeric,
  low      numeric,
  close    numeric,
  volume   bigint,
  primary key (symbol, bar_date)
);

-- The detail chart always filters by symbol and a date window.
create index if not exists candles_symbol_date_idx on public.candles (symbol, bar_date desc);

-- ---------------------------------------------------------------------------
-- Row level security: this is public market data, so anon gets read-only access.
-- Writes happen exclusively through the Edge Functions, which use the service
-- role key and therefore bypass RLS.
-- ---------------------------------------------------------------------------

alter table public.securities enable row level security;
alter table public.quotes     enable row level security;
alter table public.candles    enable row level security;

drop policy if exists "public read securities" on public.securities;
create policy "public read securities" on public.securities for select to anon, authenticated using (true);

drop policy if exists "public read quotes" on public.quotes;
create policy "public read quotes" on public.quotes for select to anon, authenticated using (true);

drop policy if exists "public read candles" on public.candles;
create policy "public read candles" on public.candles for select to anon, authenticated using (true);

-- Convenience view joining the list to its latest price.
-- security_invoker so the view evaluates RLS as the caller rather than as its
-- owner; the default would silently bypass the table policies.
create or replace view public.securities_with_quotes
with (security_invoker = true) as
  select s.symbol, s.name, s.series, s.isin, s.listing_date, s.face_value,
         s.paid_up_value, s.market_lot,
         q.price, q.previous_close,
         q.price - q.previous_close                                    as change,
         case when q.previous_close is null or q.previous_close = 0 then null
              else (q.price - q.previous_close) / q.previous_close * 100
         end                                                           as change_percent,
         q.updated_at
  from public.securities s
  left join public.quotes q using (symbol);
