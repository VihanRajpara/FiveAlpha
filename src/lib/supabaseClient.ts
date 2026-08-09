import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/**
 * Supabase is migrating from the legacy `anon` JWT to publishable keys
 * (`sb_publishable_…`). Both are safe to ship in a browser bundle and both are
 * accepted by PostgREST, so read either — new projects only issue the first.
 *
 * Never put an `sb_secret_…` / service-role key here: anything prefixed with
 * VITE_ is inlined into the public bundle at build time.
 */
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const key = publishableKey || anonKey;

/** Null when the project isn't configured — the app then falls back to the direct source. */
export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

export const isSupabaseConfigured = supabase !== null;
