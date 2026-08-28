-- Watchlists: the first thing in this database the *user* writes.
--
-- UPDATE, after 0007_users.sql: `owner` now holds the signed-in **username**,
-- not the random per-browser UUID this file was written around. The policies
-- below are unchanged and did not need to be — they compare `owner` against the
-- `x-owner` header whatever that header contains, and the client now puts the
-- username in it (see `owner` in src/lib/supabaseClient.ts). So lists follow the
-- person rather than the device, and the paragraphs below about "ownership
-- without accounts" describe how this started, not how it works now. What is
-- still true: the header is self-asserted, so this is separation, not security.
--
-- Everything else here is public market data ingested by an Edge Function with
-- the service-role key, and anon is read-only on all of it (see 0001_init.sql).
-- A watchlist is the opposite: it is private, it is small, and it is written
-- from the browser with the publishable key.
--
-- ---------------------------------------------------------------------------
-- Ownership without accounts
-- ---------------------------------------------------------------------------
-- This app has no sign-in. So there is no `auth.uid()` to key rows on, and the
-- owner is a random UUID the browser generates once and keeps in localStorage.
--
-- **That id is a bearer credential.** Anyone who has it can read and write that
-- owner's lists, and that is the whole of the protection. It is a v4 UUID, so
-- guessing one is not a practical attack, and the policies below at least stop
-- the table being *enumerated*: a request only sees rows whose owner it already
-- names, in an `x-owner` header PostgREST exposes to RLS. Without that clause
-- anon could simply select the whole table.
--
-- What this is not is user isolation. If this app ever grows a login, the fix
-- is one migration and a few lines of client: turn on Supabase anonymous
-- sign-ins (or any real provider), add `user_id uuid references auth.users`,
-- and rewrite the four policies as `auth.uid() = user_id`. The client already
-- treats the remote copy as best-effort, so nothing downstream changes.
--
-- The other consequence worth stating plainly: an owner id lives in one
-- browser's localStorage, so lists follow the browser, not the person. Clearing
-- site data on a device orphans that device's rows rather than deleting them.

create table if not exists public.watchlists (
  id         uuid        primary key,
  owner      text        not null,
  name       text        not null,
  -- The whole list in one column. A join table would be the normal shape and is
  -- the wrong one here: a watchlist is read and written whole, never queried
  -- across, and never larger than a few hundred symbols.
  symbols    text[]      not null default '{}',
  -- Tab order, so the section renders them the way they were arranged.
  position   integer     not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists watchlists_owner_idx on public.watchlists (owner, position);

alter table public.watchlists enable row level security;

-- The owner named in the request header, or null when none was sent. `true` as
-- the second argument makes the setting missing rather than an error.
create or replace function public.request_owner() returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-owner', '')
$$;

drop policy if exists "owner reads own watchlists" on public.watchlists;
create policy "owner reads own watchlists" on public.watchlists
  for select to anon, authenticated
  using (owner = public.request_owner());

drop policy if exists "owner inserts own watchlists" on public.watchlists;
create policy "owner inserts own watchlists" on public.watchlists
  for insert to anon, authenticated
  with check (owner = public.request_owner());

drop policy if exists "owner updates own watchlists" on public.watchlists;
create policy "owner updates own watchlists" on public.watchlists
  for update to anon, authenticated
  using (owner = public.request_owner())
  with check (owner = public.request_owner());

drop policy if exists "owner deletes own watchlists" on public.watchlists;
create policy "owner deletes own watchlists" on public.watchlists
  for delete to anon, authenticated
  using (owner = public.request_owner());
