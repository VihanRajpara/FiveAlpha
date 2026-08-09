-- Stop storing chart history.
--
-- `candles` was ~250 daily bars per symbol × ~2,400 symbols ≈ 500k rows, and on
-- its own it filled roughly a third of the free tier's 500 MB — for data that is
-- read one symbol at a time, only while a detail drawer is open. The app now
-- fetches those bars live from Yahoo through the /api/yahoo proxy (the Vite dev
-- proxy locally, the Cloudflare Worker in worker/index.ts when deployed), so
-- nothing reads this table any more.
--
-- What stays in Postgres is what benefits from being there: `securities` (one
-- daily NSE CSV, read by every page load) and `quotes` (one row per symbol,
-- overwritten in place) — together a few MB.
--
-- Run this in the SQL Editor AFTER deploying the app build that no longer reads
-- the table. Dropping a table releases its files immediately; unlike DELETE it
-- needs no VACUUM, so Database Size falls within a few minutes.

-- ---------------------------------------------------------------------------
-- 1. Stop the cron first, so nothing recreates rows mid-drop.
--    Guarded: a project that never ran 0002_cron.sql has no `cron` schema, and
--    an unguarded reference to cron.job would abort the whole migration.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'nse-sync-candles';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Drop the table and the rotation cursor that existed only to feed it.
--    Dropping the column takes securities_candles_cursor_idx with it.
-- ---------------------------------------------------------------------------
drop table if exists public.candles;

alter table public.securities
  drop column if exists candles_synced_at;

-- ---------------------------------------------------------------------------
-- 3. Confirm the space came back.
-- ---------------------------------------------------------------------------
--   select relname,
--          pg_size_pretty(pg_total_relation_size(c.oid)) as size
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r'
--    order by pg_total_relation_size(c.oid) desc;
--
-- If Database Size still looks high afterwards, the remainder is usually
-- Supabase's own schemas plus WAL, not your tables.
