-- Let the app show what it sent.
--
-- `signal_alerts` was written as a send-once ledger and nothing more: RLS on
-- with no policies, service role only (migration 0016). A push notification is
-- a thing that appears once and is gone — swiped away, missed while the phone
-- was face down, cleared by the OS — so the app needs somewhere to look it up
-- afterwards, and the ledger already holds every one of them.
--
-- One change: let the person an alert was sent to read their own rows.
--
-- Deliberately **no `body` column.** An earlier draft of this migration stored
-- the notification's sentence so the panel could show it verbatim. It is not
-- worth a column: the row already carries side, symbol and date, which is the
-- notification's title and the whole of what identifies it, and the price and
-- score behind it are one tap away in the detail drawer — live, rather than as
-- a frozen copy that has to be kept in step with how the drawer phrases things.

-- ---------------------------------------------------------------------------
-- Read access, and only read.
--
-- The same shape as the watchlist policies (0006) with one addition: `'*'` is
-- the screen-wide broadcast, which by definition every account is a recipient
-- of, so it is readable by all of them.
--
-- `request_owner() is not null` is the part that is easy to leave out and
-- shouldn't be. Without it, `owner = request_owner()` is simply null for a
-- caller that sent no header — which is false, harmless — but `or owner = '*'`
-- still matches, so a signed-out visitor with the publishable key could read
-- the broadcast feed. Requiring an owner first makes the feed an account thing.
--
-- No insert, update or delete policy: the browser has no business writing here,
-- and notify-signals uses the service role, which bypasses all of this.
-- ---------------------------------------------------------------------------
-- The GRANT, which is not the same thing as the policy and is easy to forget.
--
-- 0016 created this table with `revoke all ... from anon, authenticated`, copied
-- from `app_users` where nothing but the service role should ever touch it. A
-- policy does not undo that: a grant decides whether the role may run the
-- statement, a policy decides which rows it then sees. With the policy and no
-- grant, PostgREST answers **"permission denied for table signal_alerts"** —
-- which is what the app's alerts panel showed, and which looks nothing like an
-- RLS refusal (that returns an empty list, not an error).
--
-- SELECT only. Nothing in the browser writes here.
grant select on public.signal_alerts to anon, authenticated;

drop policy if exists "owner reads own alerts" on public.signal_alerts;
create policy "owner reads own alerts" on public.signal_alerts
  for select to anon, authenticated
  using (
    public.request_owner() is not null
    and (owner = public.request_owner() or owner = '*')
  );

-- The panel reads the newest first and stops; without this that is a sort of
-- the whole table on every open.
create index if not exists signal_alerts_sent_idx on public.signal_alerts (sent_at desc);
