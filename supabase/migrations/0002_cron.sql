-- Scheduled ingestion. pg_cron fires, pg_net makes the HTTP call to the Edge Function.
--
-- Before running this migration, set the two values in the `private.sync_config`
-- insert at the bottom (project ref + the SYNC_SECRET you gave the functions).

-- Enable these from Dashboard → Database → Extensions (search "pg_cron", "pg_net")
-- if the statements below fail. Both are non-relocatable: they insist on creating
-- their own `cron` and `net` schemas, so naming a target schema here errors with
--   "extension \"pg_cron\" must be installed in schema \"cron\""
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Config lives in a private schema with no grants, so PostgREST can never expose
-- the secret and anon/authenticated cannot read it.
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.sync_config (
  id           boolean primary key default true check (id),
  functions_url text not null,
  sync_secret   text not null
);

-- Added after the fact; keeps this migration re-runnable on an existing table.
alter table private.sync_config
  add column if not exists anon_key text not null default '';

revoke all on private.sync_config from anon, authenticated;

-- Belt and braces on a table PostgREST cannot reach anyway. Does not affect the
-- cron: invoke_sync is `security definer` and owners are exempt from RLS unless
-- the table is FORCE ROW LEVEL SECURITY.
alter table private.sync_config enable row level security;

-- Fires one Edge Function. pg_net is async: it queues the request and returns an id.
create or replace function private.invoke_sync(fn text, query text default '')
returns bigint
language plpgsql
security definer
set search_path = private, extensions, public
as $$
declare
  cfg private.sync_config;
  request_id bigint;
begin
  select * into cfg from private.sync_config where id;
  if not found then
    raise exception 'private.sync_config is empty — insert your functions_url and sync_secret';
  end if;

  -- The Authorization header is NOT optional. Supabase's function gateway
  -- verifies a JWT before your code is ever reached; without it every call dies
  -- at the edge with {"code":"UNAUTHORIZED_NO_AUTH_HEADER"} and, because pg_net
  -- is fire-and-forget, the cron job still reports success. Silent 401s every
  -- five minutes is exactly the failure you don't notice.
  --
  -- The publishable/anon key is safe to store here: it is already public in the
  -- browser bundle, and `x-sync-secret` is what actually authorises the sync.
  select net.http_post(
    url     := cfg.functions_url || '/' || fn || query,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || cfg.anon_key,
                 'x-sync-secret', cfg.sync_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function private.invoke_sync(text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules. pg_cron runs in UTC; NSE trades 09:15–15:30 IST = 03:45–10:00 UTC.
-- ---------------------------------------------------------------------------

select cron.unschedule(jobname) from cron.job
 where jobname in ('nse-sync-securities', 'nse-sync-quotes', 'nse-sync-candles');

-- Master list: once a day, well before the open.
select cron.schedule(
  'nse-sync-securities', '0 1 * * *',
  $$ select private.invoke_sync('sync-securities'); $$
);

-- Prices: every 5 minutes on weekdays across the trading session (plus a little
-- padding either side to catch the pre-open and the closing print).
select cron.schedule(
  'nse-sync-quotes', '*/5 3-10 * * 1-5',
  $$ select private.invoke_sync('sync-quotes'); $$
);

-- There is deliberately no candles job. History is fetched live from Yahoo when
-- a chart is opened (see 0004_drop_candles.sql); the unschedule above removes
-- 'nse-sync-candles' if this migration is re-run on a database that had it.

-- ---------------------------------------------------------------------------
-- Fill these in, then run the migration.
--   functions_url : https://<your-project-ref>.supabase.co/functions/v1
--   sync_secret   : must match the SYNC_SECRET set via `supabase secrets set`
--   anon_key      : the publishable / anon key (also in .env) — required, see
--                   the Authorization note in invoke_sync above
--
-- ⚠ Leave the placeholders in this file. It is tracked by git, and a real
--   sync_secret committed to a repo is a leaked credential. Run this migration
--   as written, then set the live values with a separate UPDATE that never
--   touches disk:
--
--     update private.sync_config
--        set functions_url = 'https://<ref>.supabase.co/functions/v1',
--            sync_secret   = '<your-secret>',
--            anon_key      = '<your-publishable-key>'
--      where id;
-- ---------------------------------------------------------------------------
insert into private.sync_config (id, functions_url, sync_secret, anon_key)
values (true, 'https://YOUR-PROJECT-REF.supabase.co/functions/v1', 'YOUR-SYNC-SECRET', 'YOUR-ANON-KEY')
-- Placeholders must never overwrite live values on a re-run — that would break a
-- working cron the next time anyone applies migrations.
on conflict (id) do nothing;
