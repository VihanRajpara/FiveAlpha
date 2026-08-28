-- Sign-in: one table of usernames and four-digit PINs.
--
-- Re-runnable: it drops and recreates, so pasting it again resets the table.
--
-- The PIN is stored as typed, not hashed — a deliberate choice for a personal
-- screener with a handful of accounts. What that costs: anyone who can read
-- this table (the SQL Editor, the secret key, a database dump) can read every
-- PIN, and there is no lockout, so the only thing standing between a script and
-- 10,000 guesses is that nobody has pointed one at it.
--
-- What it does not cost is the browser: RLS is on with **no policies**, so
-- PostgREST cannot see this table at all. Without that, the publishable key
-- that ships inside the bundle would let anyone on the internet select the PINs
-- straight out of it. `login` below is `security definer` — the only door.

drop function if exists public.create_user(text, text);
drop function if exists public.login(text, text);
drop table if exists public.app_users;

create table public.app_users (
  username text primary key,
  pin      text not null
);

alter table public.app_users enable row level security;
revoke all on public.app_users from anon, authenticated;

-- Add people from the SQL Editor, which runs as `postgres` and is not subject
-- to any of the above:
--
--   insert into public.app_users (username, pin) values ('someone', '1234');
--
-- Changing a PIN is the same door:
--
--   update public.app_users set pin = '4321' where username = 'someone';

-- The username on a match, null on anything else — a wrong username and a wrong
-- PIN are the same answer, because a form that says "no such user" is a form
-- that confirms the ones that do exist.
--
-- `lower()` on both sides so "Vihan" and "vihan" are the same account however
-- the row happened to be inserted.
create or replace function public.login(p_username text, p_pin text)
returns text
language sql
security definer
set search_path = public
as $$
  select username
    from public.app_users
   where lower(username) = lower(btrim(p_username))
     and pin = p_pin
$$;

revoke all on function public.login(text, text) from public;
grant execute on function public.login(text, text) to anon, authenticated;
