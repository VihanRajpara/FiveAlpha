-- Moves the Upstox credential out of the function environment and into the
-- database.
--
-- It was `Deno.env.get('UPSTOX_ACCESS_TOKEN')` read into a module-level const,
-- which made rotating it a deploy: `supabase secrets set` plus a redeploy to get
-- a cold start. Harmless once a year for an Analytics Token; unworkable for the
-- OAuth token, which dies at 3:30 AM IST daily and would drag a build behind it
-- every morning.
--
-- Stored here, rotation is one statement and takes effect on the next cron tick:
--
--   select public.upstox_token_set('<token>');

-- Same row that already holds sync_secret: private schema, no grants, RLS on,
-- unreachable from PostgREST. `if not exists` keeps this re-runnable.
alter table private.sync_config
  add column if not exists upstox_token    text not null default '',
  add column if not exists upstox_token_at timestamptz;

comment on column private.sync_config.upstox_token is
  'Upstox access token. Overrides the UPSTOX_ACCESS_TOKEN env var when non-empty.';
comment on column private.sync_config.upstox_token_at is
  'When upstox_token was last written — how you tell a stale token from a broken one.';

-- ---------------------------------------------------------------------------
-- Accessors.
--
-- PostgREST cannot see the `private` schema at all, service role included, so
-- the Edge Functions reach the column through `security definer` functions in
-- `public` — the same device private.invoke_sync uses to read sync_secret.
-- ---------------------------------------------------------------------------

create or replace function public.upstox_token_get()
returns text
language sql
security definer
set search_path = private, public
as $$
  select coalesce(upstox_token, '') from private.sync_config where id;
$$;

create or replace function public.upstox_token_set(t text)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
begin
  update private.sync_config
     set upstox_token    = coalesce(t, ''),
         -- Null for a cleared token, so `upstox_token_at` never claims a write
         -- that left nothing behind.
         upstox_token_at = case when coalesce(t, '') = '' then null else now() end
   where id;

  -- Loud, because the alternative is a refresher that reports success every
  -- morning while writing to nothing. sync_config is seeded by 0002.
  if not found then
    raise exception 'private.sync_config is empty - insert your functions_url and sync_secret first';
  end if;
end;
$$;

-- The whole point of the private schema. Only the service role (and the owner)
-- may touch these; the browser's anon key gets a permission error.
revoke all on function public.upstox_token_get() from public, anon, authenticated;
revoke all on function public.upstox_token_set(text) from public, anon, authenticated;
grant execute on function public.upstox_token_get() to service_role;
grant execute on function public.upstox_token_set(text) to service_role;
