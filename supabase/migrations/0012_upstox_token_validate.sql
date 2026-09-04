-- Refuses a value that cannot be an Upstox token.
--
-- Applied to the live project as `20260904100830_upstox_token_validate`. The
-- same guard is inline in 0011, so a database built from scratch gets it there
-- and this file is a no-op replay; it exists so the local migration history
-- matches what the remote actually ran.
--
-- Why it exists at all: `select public.upstox_token_set('<token>')` — the
-- README line pasted verbatim, placeholder and all — stored seven characters
-- cleanly, stamped `upstox_token_at` with a convincing timestamp, and then
-- looked exactly like an expired credential from every angle downstream. Both
-- the sync function and `npm run check:upstox` reported a 401 from Upstox,
-- which is true and useless: the value never had a chance of working, and the
-- one place that could have said so is the write.

create or replace function public.upstox_token_set(t text)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
begin
  -- Every Upstox token is a JWT: three dot-separated segments, hundreds of
  -- characters. Empty is still allowed — that is how a token is deliberately
  -- cleared.
  if coalesce(t, '') <> '' and t !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    raise exception
      'that does not look like an Upstox token (% chars, expected a JWT) - nothing stored',
      length(t);
  end if;

  update private.sync_config
     set upstox_token    = coalesce(t, ''),
         upstox_token_at = case when coalesce(t, '') = '' then null else now() end
   where id;

  if not found then
    raise exception 'private.sync_config is empty - insert your functions_url and sync_secret first';
  end if;
end;
$$;

revoke all on function public.upstox_token_set(text) from public, anon, authenticated;
grant execute on function public.upstox_token_set(text) to service_role;
