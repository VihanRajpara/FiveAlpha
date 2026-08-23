import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * `import.meta.env` is Vite's, and this module is also pulled into the Node
 * self-check bundle (scripts/check-signals.mjs) where it does not exist —
 * reading a property off it there is a TypeError at import time, i.e. before
 * any test runs. Defaulting to an empty bag leaves `supabase` null, which is
 * exactly the "not configured" path everything already handles.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

const url = env.VITE_SUPABASE_URL;

/**
 * Supabase is migrating from the legacy `anon` JWT to publishable keys
 * (`sb_publishable_…`). Both are safe to ship in a browser bundle and both are
 * accepted by PostgREST, so read either — new projects only issue the first.
 *
 * Never put an `sb_secret_…` / service-role key here: anything prefixed with
 * VITE_ is inlined into the public bundle at build time.
 */
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const anonKey = env.VITE_SUPABASE_ANON_KEY;
const key = publishableKey || anonKey;

/**
 * Who this browser is, for the one table it writes to.
 *
 * There is no sign-in, so a random id generated once and kept in localStorage
 * is the whole of the identity — see supabase/migrations/0006_watchlists.sql,
 * which explains what that does and does not protect. Sent as a header on every
 * request because RLS reads it there: a policy can compare a row's `owner` to
 * `request.headers ->> 'x-owner'`, and without it anon could select the table.
 */
const OWNER_KEY = 'fivealpha:owner';

export function ownerId(): string {
  try {
    const existing = localStorage.getItem(OWNER_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(OWNER_KEY, fresh);
    return fresh;
  } catch {
    // Private mode or no storage: a per-session id still works for this tab,
    // it just will not be the same one tomorrow.
    return crypto.randomUUID();
  }
}

/** Null when the project isn't configured — the app then falls back to the direct source. */
export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: { persistSession: false },
        global: { headers: { 'x-owner': typeof localStorage === 'undefined' ? '' : ownerId() } },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
