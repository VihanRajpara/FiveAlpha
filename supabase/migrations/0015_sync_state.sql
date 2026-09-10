-- "The prices just changed" as one row, so the browser can be told rather than
-- having to ask.
--
-- The screen list is pushed straight from its own table (migration 0014) — 76
-- rows, replaced whole, ~150 events a run, which Realtime carries happily. The
-- same trick does not scale to `quotes`: that is ~5,200 rows rewritten every
-- five minutes, so publishing it would send every connected browser ~5,200
-- messages a run — around 400,000 a day each — to convey one fact it already
-- knows how to act on ("read the delta").
--
-- So the *notification* is separated from the *data*. This table holds one row
-- per writer and nothing else. Browsers subscribe to it and, when it changes,
-- do the incremental read they were already doing on a timer — the same single
-- PostgREST request asking only for rows newer than the last one they saw. One
-- realtime message per statement instead of one per row, and the price payload
-- never travels over the websocket at all.
create table if not exists public.sync_state (
  -- Which writer: 'quotes' today. Not an enum — a new sync should be able to
  -- stamp itself without a migration.
  fn      text primary key,
  ran_at  timestamptz not null default now()
);

comment on table public.sync_state is
  'One row per writer, stamped when it commits. A change here is the signal for browsers to re-read that data; it carries no data itself.';

alter table public.sync_state enable row level security;

drop policy if exists "public read sync_state" on public.sync_state;
create policy "public read sync_state" on public.sync_state
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Stamped by a trigger on `quotes`, not by sync-quotes itself.
--
-- Deliberate: the fact worth broadcasting is "this table changed", which is a
-- property of the table and not of whichever client wrote it. A trigger covers
-- sync-quotes, `npm run seed quotes`, a hand-run backfill and anything added
-- later, and none of them has to remember to stamp. It also means this whole
-- feature needed no Edge Function redeploy.
--
-- FOR EACH STATEMENT, emphatically not FOR EACH ROW: sync-quotes upserts in
-- batches of 500, so this fires ~11 times a run instead of ~5,200. Those eleven
-- are spread across the run as the batches land, which is a feature — the
-- browser reads each batch's delta as it appears rather than waiting for the
-- last one.
-- ---------------------------------------------------------------------------
create or replace function public.mark_synced()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.sync_state (fn, ran_at) values (tg_argv[0], now())
  on conflict (fn) do update set ran_at = now();
  -- AFTER ... FOR EACH STATEMENT ignores the return value.
  return null;
end;
$fn$;

drop trigger if exists quotes_synced on public.quotes;
create trigger quotes_synced
  after insert or update on public.quotes
  for each statement
  execute function public.mark_synced('quotes');

-- Guarded like 0014: `add table` errors if it is already published, which would
-- abort a re-run of this migration.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'sync_state'
  ) then
    alter publication supabase_realtime add table public.sync_state;
  end if;
end
$$;
