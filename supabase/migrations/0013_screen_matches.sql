-- The screen's answer, taken from Chartink instead of recomputed here.
--
-- The app used to run the screen itself: ten years of monthly bars per symbol
-- from Yahoo, RSI in the browser, then a paced screener.in scrape for ROCE over
-- whatever survived — thousands of requests and a minute of wall clock for a
-- verdict that Chartink already publishes, against its own data, for free.
-- Worse, it was a *translation*: `yearly max( 10 , yearly high )` reimplemented
-- from Yahoo bars will disagree with the original at the margin, and the margin
-- is the whole population this screen exists to find.
--
-- So the list is now scraped whole (supabase/functions/sync-screen) and this
-- table is what the browser reads. One request per page load instead of ~2,600.
create table if not exists public.screen_matches (
  -- Chartink's `nsecode`, which is the NSE ticker and therefore already the
  -- key `public.securities` uses for anything listed there. No foreign key:
  -- a symbol Chartink returns and this database has never heard of is a fact
  -- worth keeping (and counting), not a row to reject.
  symbol     text primary key,
  name       text,
  -- Chartink's own ordering, so the list can be shown as it was published.
  rank       integer,
  close      numeric,
  chg_pct    numeric,
  volume     bigint,
  fetched_at timestamptz not null default now()
);

comment on table public.screen_matches is
  'Latest result set of the Chartink screen in src/lib/screens.ts. Replaced whole every 5 minutes by sync-screen; never appended to.';

alter table public.screen_matches enable row level security;

drop policy if exists "public read screen_matches" on public.screen_matches;
create policy "public read screen_matches" on public.screen_matches
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Replace the list, atomically.
--
-- The requirement is "truncate, then insert", and the reason it is one function
-- rather than two statements from the Edge Function is the gap between them:
-- the browser polls this table on the same five-minute beat that writes it, so
-- a separate DELETE and INSERT would sooner or later serve somebody an empty
-- screen. Inside one function both happen in one transaction and no reader ever
-- sees the intermediate state.
--
-- DELETE rather than TRUNCATE: truncate takes an ACCESS EXCLUSIVE lock that
-- blocks concurrent readers, and on a 100-row table it buys nothing.
--
-- `where true` is not decoration. This project runs with pg_safeupdate on, so a
-- bare `delete from` is rejected outright — "DELETE requires a WHERE clause" —
-- and the whole replace fails. The predicate is what says the unrestricted
-- delete is deliberate.
--
-- An empty payload is refused. Chartink answering with no rows is nearly always
-- a scrape that broke — a moved CSRF field, a changed endpoint — and blanking a
-- working list on that is worse than serving one five minutes stale.
-- ---------------------------------------------------------------------------
create or replace function public.screen_matches_replace(rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  if jsonb_typeof(rows) is distinct from 'array' then
    raise exception 'screen_matches_replace: expected a json array, got %', jsonb_typeof(rows);
  end if;
  if jsonb_array_length(rows) = 0 then
    raise exception 'screen_matches_replace: refusing to replace the list with nothing';
  end if;

  delete from public.screen_matches where true;

  insert into public.screen_matches (symbol, name, rank, close, chg_pct, volume)
  select r.symbol, r.name, r.rank, r.close, r.chg_pct, r.volume
    from jsonb_to_recordset(rows)
      as r(symbol text, name text, rank integer, close numeric, chg_pct numeric, volume bigint)
   where coalesce(r.symbol, '') <> ''
  -- Chartink has been seen to return a symbol twice across segments; the
  -- primary key would abort the whole replace over a duplicate that carries no
  -- new information.
  on conflict (symbol) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Only the service role calls this. Left reachable by PostgREST for anon and it
-- would be a public "wipe the screen" button.
revoke all on function public.screen_matches_replace(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Every five minutes through the session, on the same schedule as the quotes —
-- the screen reads a daily close and an intraday price, so it moves exactly as
-- often as the prices under it do.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobname) from cron.job where jobname = 'nse-sync-screen';

select cron.schedule(
  'nse-sync-screen', '*/5 3-10 * * 1-5',
  $$ select private.invoke_sync('sync-screen'); $$
);
