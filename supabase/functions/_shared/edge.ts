// The plumbing every sync function needs: a service-role client, the shared
// secret check, a JSON response, and a fetch that cannot hang forever.
//
// Split out of upstream.ts, which had grown into two unrelated halves — this
// one, and NSE/BSE master-list parsing. sync-screen needs the plumbing and none
// of the listings, and a function should not carry 250 lines of CSV merging
// into its bundle to reach `json()`. upstream.ts re-exports everything here, so
// the functions that predate the split import from either and see the same
// definitions.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/** Service-role client — bypasses RLS, so it must never be exposed to the browser. */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Rejects unless the caller presents SYNC_SECRET. Without this anyone who knows
 * the function URL could drive unlimited outbound requests on your project.
 */
export function assertAuthorized(req: Request): Response | null {
  const expected = Deno.env.get('SYNC_SECRET');
  if (!expected) {
    return json({ error: 'SYNC_SECRET is not configured on this function' }, 500);
  }
  const provided = req.headers.get('x-sync-secret');
  if (provided !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** fetch with a hard timeout, so one stalled upstream can't eat the whole budget. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
