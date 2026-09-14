-- Push notifications: which devices to reach, and what they have already been told.
--
-- Two alerts, one job (supabase/functions/notify-signals):
--
--   · a UT Bot **BUY** on a symbol in `public.screen_matches` → every device
--   · a UT Bot **SELL** on a symbol in somebody's `public.watchlists` → that
--     person's devices only
--
-- Both are computed from the same `latestSignal` the browser draws in the
-- Signal column, extracted to supabase/functions/_shared/utbot.ts so the two
-- cannot drift apart. The job runs every five minutes through the session, on
-- the same beat as the quotes.

-- ---------------------------------------------------------------------------
-- One row per DEVICE, not per account.
--
-- An account is a person and a person has a phone and a laptop, so `username`
-- is deliberately not unique here — it is the fan-out key. The FCM registration
-- token is the identity of a browser profile on a device, so it is the primary
-- key: the same device re-registering lands on the same row rather than growing
-- a second one, which is what makes the write on every sign-in an upsert and
-- not a leak.
--
-- Written at **sign-in**, not from a settings toggle: the account is the thing
-- that has devices, so the moment it is known is the moment to record the one
-- in front of you. Sign-out deletes the row, which is also the only "off"
-- switch this feature has and the only one it needs.
-- ---------------------------------------------------------------------------
create table if not exists public.fcm_tokens (
  fcm_token  text primary key,
  -- A real foreign key rather than the loose `owner text` that public.watchlists
  -- carries, because this table is written from a path that has *just* proved
  -- the username against app_users. Deleting an account therefore takes its
  -- devices with it instead of leaving rows that would be pushed to forever.
  --
  -- ⚠ This makes 0007_users.sql no longer re-runnable as written: its
  --   `drop table if exists public.app_users` now has a dependent table and
  --   needs `cascade` — which would take these rows with it. That is the right
  --   outcome (tokens for accounts that no longer exist are garbage), but it is
  --   a footgun worth knowing about before pasting 0007 in again.
  username   text not null
    references public.app_users (username) on update cascade on delete cascade,
  -- Refreshed on every sign-in. Two jobs: it is the liveness stamp the stale
  -- sweep below reads, and it is how a device that keeps being used stays warm
  -- rather than looking abandoned.
  updated_at timestamptz not null default now()
);

create index if not exists fcm_tokens_username_idx on public.fcm_tokens (username);

comment on table public.fcm_tokens is
  'FCM registration tokens, one row per device. Upserted on sign-in, deleted on sign-out, on an UNREGISTERED send, or by the stale sweep in notify-signals.';

alter table public.fcm_tokens enable row level security;

-- The same four policies as 0006_watchlists.sql, keyed on the same helper, and
-- carrying the same caveat in the same words: **the header is self-asserted**,
-- so this is separation, not security. Someone editing localStorage can
-- register a token under another username and receive that person's watchlist
-- alerts. That is this app's existing threat model rather than a regression
-- here, and the fix — real auth and `auth.uid()` — is the one 0006 spells out.
--
-- What the policies do buy is that the table cannot be *enumerated*: without
-- the username clause the publishable key in the bundle would select every
-- token in it.
drop policy if exists "owner reads own fcm tokens" on public.fcm_tokens;
create policy "owner reads own fcm tokens" on public.fcm_tokens
  for select to anon, authenticated
  using (username = public.request_owner());

drop policy if exists "owner inserts own fcm tokens" on public.fcm_tokens;
create policy "owner inserts own fcm tokens" on public.fcm_tokens
  for insert to anon, authenticated
  with check (username = public.request_owner());

drop policy if exists "owner updates own fcm tokens" on public.fcm_tokens;
create policy "owner updates own fcm tokens" on public.fcm_tokens
  for update to anon, authenticated
  using (username = public.request_owner())
  with check (username = public.request_owner());

drop policy if exists "owner deletes own fcm tokens" on public.fcm_tokens;
create policy "owner deletes own fcm tokens" on public.fcm_tokens
  for delete to anon, authenticated
  using (username = public.request_owner());

-- ---------------------------------------------------------------------------
-- Dead tokens, swept on a stamp.
--
-- The reliable signal is the send itself: FCM answers UNREGISTERED or 404 for a
-- token whose site data was cleared or whose app was uninstalled, and
-- notify-signals deletes that row on the spot. That covers everything the
-- server can observe.
--
-- What it does not cover is a device that simply never comes back — nothing is
-- ever sent to it that fails, because it only enters a recipient list when one
-- of its owner's symbols flips. So a second rule, on the stamp above: a row
-- nobody has signed in on for 90 days is not a device any more. FCM itself
-- treats a token as stale after ~270 days of inactivity, so this is the
-- conservative end of the same judgement.
--
-- Note for anyone widening the predicate: this project runs with pg_safeupdate
-- on, so an unrestricted delete is rejected outright. The date clause here is
-- what says this one is deliberate.
-- ---------------------------------------------------------------------------
create or replace function public.fcm_tokens_sweep(max_age interval default interval '90 days')
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
begin
  delete from public.fcm_tokens where updated_at < now() - max_age;
  get diagnostics removed = row_count;
  return removed;
end;
$fn$;

-- Only notify-signals calls this, with the service-role key. Left reachable by
-- PostgREST and it would be a public "forget everyone's devices" button.
revoke all on function public.fcm_tokens_sweep(interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What has already been sent. This table is the entire idempotency story.
--
-- The job runs every five minutes and a flip stays "today's flip" for the rest
-- of the day, so without a ledger a single BUY would be pushed ~78 times. The
-- primary key is what stops that: the insert is an upsert with duplicates
-- ignored, and **the rows that come back are exactly the ones nobody has been
-- told about yet**. Re-running the cron, or hitting the function by hand,
-- notifies no one twice. Nothing has to remember to set a flag.
--
-- `owner = '*'` is the screen broadcast — recorded once for everybody rather
-- than once per person, so a device registering later does not resurrect an
-- alert that was already announced. A sentinel rather than a nullable column
-- because a null cannot sit in a primary key, and no foreign key for the same
-- reason: '*' is not an account.
--
-- `side` is in the key: a symbol can sit on the screen and on a watchlist at
-- once, and a BUY to everybody and a SELL to its owner are different facts.
--
-- Intraday has a cost this table bounds rather than removes: the last daily bar
-- is still trading, so a flip dated today can un-flip before the close
-- (`provisional` in latestSignal). One push per symbol per side per day is the
-- most that can be wrong, and nothing retracts it.
-- ---------------------------------------------------------------------------
create table if not exists public.signal_alerts (
  owner       text not null,
  symbol      text not null,
  side        text not null check (side in ('BUY', 'SELL')),
  -- The flip's own session date in IST, not when this row was written. Dating
  -- an Indian bar in UTC puts it a day early.
  signal_date date not null,
  sent_at     timestamptz not null default now(),
  primary key (owner, symbol, side, signal_date)
);

comment on table public.signal_alerts is
  'Send-once ledger for notify-signals. owner = ''*'' is the screen-wide BUY broadcast; anything else is a watchlist owner''s SELL. Also the alert history, if one is ever wanted.';

-- RLS on with **no policies**, like public.app_users in 0007_users.sql: only
-- the service role touches this. The browser has no reason to read it, and a
-- readable record of who was told what is not worth publishing.
alter table public.signal_alerts enable row level security;
revoke all on public.signal_alerts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule. pg_cron runs in UTC; NSE trades 09:15–15:30 IST = 03:45–10:00 UTC.
--
-- The same window and beat as `nse-sync-quotes` (0002_cron.sql), deliberately:
-- the signal is recomputed from a bar whose last price moves exactly as often
-- as that job writes it, so asking more often would only cost Yahoo requests.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobname) from cron.job where jobname = 'nse-notify-signals';

select cron.schedule(
  'nse-notify-signals', '*/5 3-10 * * 1-5',
  $$ select private.invoke_sync('notify-signals'); $$
);
