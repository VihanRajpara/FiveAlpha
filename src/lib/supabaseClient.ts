import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { currentUser } from './session';

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
 * Who this browser is, for the one table it writes to: the signed-in username.
 *
 * It was a random UUID minted once per browser, which meant lists followed the
 * device rather than the person — sign in on a laptop and a phone and you had
 * two unrelated sets. Now it is the account, so they are one.
 *
 * Sent as a header on every request because RLS reads it there: the policies in
 * supabase/migrations/0006_watchlists.sql compare a row's `owner` to
 * `request.headers ->> 'x-owner'`, and without it anon could select the whole
 * table. Empty when nobody is signed in, which matches no rows at all.
 */
export const owner = (): string => currentUser()?.username ?? '';

/** Null when the project isn't configured — the app then falls back to the direct source. */
export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: { persistSession: false },
        global: {
          // Wrapped rather than a fixed `headers` entry: this module is
          // evaluated before the sign-in form has even rendered, so a header
          // read once here would carry an empty owner for the whole session.
          // Read per request, it is always whoever is signed in now.
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('x-owner', owner());
            return fetch(input, { ...init, headers });
          },
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
