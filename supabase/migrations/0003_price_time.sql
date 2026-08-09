-- Separate "when the price was captured" from "when we wrote the row".
--
-- `updated_at` records the sync — useful for checking cron is alive, useless as
-- a freshness signal. Yahoo returns its own print timestamp for every bar, and
-- without somewhere to keep it the UI ends up reporting a Friday closing price
-- as "just now" because that is when the seeder happened to run.

alter table public.quotes
  add column if not exists price_time timestamptz;

comment on column public.quotes.price_time is
  'Exchange/vendor timestamp of the price itself (Yahoo last print). NULL when the feed did not supply one.';
comment on column public.quotes.updated_at is
  'When this row was last written by a sync. Not a freshness signal for the price — use price_time.';

-- ---------------------------------------------------------------------------
-- Surface it through the joined view as well.
--
-- DROP first, rather than CREATE OR REPLACE: replacing a view can only *append*
-- columns, never insert one mid-list. Adding price_time before updated_at makes
-- Postgres see column 12 renaming itself and it refuses with
--   42P16: cannot change name of view column "updated_at" to "price_time"
-- Dropping sidesteps the ordering constraint entirely.
-- ---------------------------------------------------------------------------

drop view if exists public.securities_with_quotes;

create view public.securities_with_quotes
-- security_invoker makes the view evaluate RLS as the *caller*. Without it a
-- view runs with its owner's rights and quietly bypasses the table policies —
-- harmless for public market data, but it trips Supabase's security linter and
-- is the wrong default to leave lying around.
with (security_invoker = true) as
  select s.symbol, s.name, s.series, s.isin, s.listing_date, s.face_value,
         s.paid_up_value, s.market_lot,
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
