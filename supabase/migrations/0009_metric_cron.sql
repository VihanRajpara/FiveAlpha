-- Schedules for the two functions that populate public.metrics.
--
-- Both reuse private.invoke_sync from 0002_cron.sql, so there is nothing new to
-- configure: the same functions_url / sync_secret / anon_key row drives them.

select cron.unschedule(jobname) from cron.job
 where jobname in ('nse-sync-technicals', 'nse-sync-fundamentals');

-- RSI(M): once a night, after the securities list refreshes at 01:00 UTC.
-- Monthly closes move once a month, so nightly is already generous; it is
-- nightly rather than weekly only so a newly listed symbol picks up a reading
-- within a day of appearing in the master list.
select cron.schedule(
  'nse-sync-technicals', '30 1 * * *',
  $$ select private.invoke_sync('sync-technicals'); $$
);

-- ROCE: hourly, ~90 companies a run.
--
-- Paced at 1.2s a page because that is what screener.in tolerates, so a run is
-- under two minutes of wall clock. Hourly gives a first full pass over the
-- ~5,200-row universe in about two and a half days, and a re-read of every row
-- roughly every 60 hours thereafter. That is far more often than an annual
-- figure changes — the schedule is set by how much scraping is polite per hour,
-- not by how fast the data moves.
select cron.schedule(
  'nse-sync-fundamentals', '7 * * * *',
  $$ select private.invoke_sync('sync-fundamentals'); $$
);
