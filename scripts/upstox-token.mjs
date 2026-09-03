// Where the local scripts get their Upstox token.
//
// The database is the source of truth (migration 0011), the same row the Edge
// Functions read. `.env` is only the fallback, so a token rotated once — by
// `select public.upstox_token_set(...)` or by the nightly refresh workflow —
// is picked up by `npm run seed:quotes` and `npm run check:upstox` without
// anyone editing a file.
//
// Callers must have loaded .env already; this only reads process.env.

/**
 * The stored token, or '' if there is none to be had.
 *
 * Every failure path falls through to the env var rather than throwing: an
 * unconfigured Supabase, a database without migration 0011, a network fault.
 * These are hand-run scripts, and refusing to price anything because the
 * *lookup* failed would be worse than using the token sitting in .env.
 */
export async function resolveUpstoxToken() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fallback = (process.env.UPSTOX_ACCESS_TOKEN || '').trim();

  if (!url || !key) return fallback;

  try {
    // upstox_token_get is `security definer` over private.sync_config, which
    // PostgREST cannot reach directly. The secret key is required: the function
    // is granted to service_role only.
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/upstox_token_get`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback;

    const stored = (await res.json() ?? '').trim();
    return stored || fallback;
  } catch {
    return fallback;
  }
}
