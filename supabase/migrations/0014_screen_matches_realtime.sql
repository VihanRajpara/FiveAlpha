-- Push the screen list to open browsers instead of making them ask.
--
-- The table is rewritten by a five-minute cron and was read by a five-minute
-- poll, and the two are not in step: a browser that loaded at :02 asks again at
-- :07, two minutes after the list it is showing was replaced. Worst case the
-- page shows a list ten minutes old, and there is no amount of polling that
-- fixes that without asking far more often than the data changes.
--
-- Realtime inverts it: Postgres tells the browser the moment the replace
-- commits. Adding the table to the publication is the whole server side of it —
-- Realtime evaluates the same RLS policy the REST read does, so the anon read
-- policy on this table is what authorises the subscription, and nothing new is
-- exposed.
--
-- The client still keeps its poll as a fallback (see useScreenMatches): a
-- websocket can drop, and a dropped one must not mean a page that quietly stops
-- updating for the rest of the session.
--
-- `add table` errors if the table is already published, which would abort a
-- re-run of this migration, so it is guarded.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'screen_matches'
  ) then
    alter publication supabase_realtime add table public.screen_matches;
  end if;
end
$$;
