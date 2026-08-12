/**
 * Cloudflare Worker: static site + upstream proxy.
 *
 * The site itself is still just ./dist served from the edge — but the deployed
 * build now fetches chart history live instead of reading it from a Supabase
 * table, and none of Yahoo, NSE or BSE sends CORS headers, so the browser cannot
 * call them itself. This Worker is the production counterpart of the Vite dev
 * proxy in vite.config.ts: same `/api/yahoo/*`, `/api/nse/*`, `/api/bse/*` and
 * `/api/screener/*` paths, same header rewriting, so `src/lib/yahooCandles.ts`,
 * `src/lib/listings.ts` and `src/lib/fundamentals.ts` work unchanged in both.
 *
 * Anything that is not an /api/ path falls through to the static assets.
 */

export interface Env {
  /** Binding to ./dist, declared in wrangler.toml. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface Upstream {
  origin: string;
  /**
   * Allow-list of upstream paths. Without it this is an open proxy: anyone could
   * point it at any URL on that origin and burn the account's request quota.
   */
  allow: RegExp;
  headers: Record<string, string>;
  /** Seconds. Chart bars move during the session; the equity list is daily. */
  ttl: number;
}

const UPSTREAMS: Record<string, Upstream> = {
  '/api/yahoo': {
    origin: 'https://query1.finance.yahoo.com',
    // `%` is in the class because the ticker reaches us percent-encoded:
    // `encodeURIComponent('ARE&M.NS')` is `ARE%26M.NS`, and `URL.pathname` keeps
    // the escape rather than decoding it. Without `%` every ampersand ticker —
    // ARE&M on NSE, J&KBANK, a slew of BSE scrip ids — 403s here while working
    // fine against the Vite dev proxy.
    allow: /^\/v8\/finance\/(chart\/[A-Za-z0-9.\-&%]+|spark)$/,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    ttl: 600,
  },
  '/api/nse': {
    origin: 'https://nsearchives.nseindia.com',
    // The equity master list, the F&O market-lots file (derivatives
    // eligibility), and the index constituent lists (cap bands). Still an
    // explicit allowlist — this must not become an open proxy to NSE.
    allow: /^\/content\/(equities\/EQUITY_L|fo\/fo_mktlots|indices\/ind_[a-z0-9]+list)\.csv$/,
    headers: {
      'User-Agent': BROWSER_UA,
      // NSE only serves the archives to requests that look like they came from its site.
      Referer: 'https://www.nseindia.com/',
      Accept: 'text/csv,application/csv,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    ttl: 21_600,
  },
  '/api/bse': {
    origin: 'https://api.bseindia.com',
    // Exactly one endpoint: the scrip master behind BSE's "List of Securities"
    // page. The query string carries the filters and is not matched here, so the
    // allowlist deliberately pins the path alone.
    allow: /^\/BseIndiaAPI\/api\/ListofScripData\/w$/,
    headers: {
      'User-Agent': BROWSER_UA,
      // Same story as NSE: served only to requests that look like BSE's own site.
      Referer: 'https://www.bseindia.com/',
      Origin: 'https://www.bseindia.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // The scrip master changes on listings and group reclassifications, i.e.
    // daily at most — and the response is ~1.8 MB, so caching it matters more
    // here than anywhere else in this file.
    ttl: 21_600,
  },
  '/api/screener': {
    origin: 'https://www.screener.in',
    // Company pages only, and only the two shapes src/lib/fundamentals.ts asks
    // for: `/company/TCS/consolidated/` for anything on NSE and
    // `/company/500325/` (BSE scrip code) for the BSE-only rows. The charset
    // matches the Yahoo entry's, and for the same reason — `M&M` reaches us as
    // `M%26M`.
    allow: /^\/company\/[A-Za-z0-9.\-&%]+\/(consolidated\/)?$/,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // A screen run asks for hundreds of these pages and the user will re-run it;
    // meanwhile the numbers behind them are a daily market cap over quarterly
    // financials. Six hours of cache costs accuracy nothing and is the
    // difference between one polite pass over screener.in and several.
    ttl: 21_600,
  },
};

function match(pathname: string): { prefix: string; upstream: Upstream } | null {
  for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return { prefix, upstream };
  }
  return null;
}

/**
 * The edge cache is a no-op on a *.workers.dev subdomain — it only engages on a
 * custom domain — so the `Cache-Control` header below is what actually saves
 * requests today: it lets the browser reuse a chart the user reopens. Both are
 * cheap to keep, and moving to a custom domain then turns the edge cache on with
 * no code change.
 */
function edgeCache(): Cache | null {
  try {
    return (caches as unknown as { default?: Cache }).default ?? null;
  } catch {
    return null;
  }
}

async function proxy(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const hit = match(url.pathname);
  if (!hit) return new Response('Not found', { status: 404 });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const upstreamPath = url.pathname.slice(hit.prefix.length) || '/';
  if (!hit.upstream.allow.test(upstreamPath)) {
    return new Response('Upstream path not allowed', { status: 403 });
  }

  // Key on our own URL, not the upstream one: the Cache API only accepts keys on
  // the Worker's own origin.
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = edgeCache();

  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) return cached;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${hit.upstream.origin}${upstreamPath}${url.search}`, {
      // Only the headers listed above go out. Forwarding the browser's own
      // sec-ch-ua / referer is what makes NSE's WAF blackhole the request.
      headers: hit.upstream.headers,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err instanceof Error ? err.message : err}`, {
      status: 502,
    });
  }

  const response = new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: {
      'Content-Type': upstreamResponse.headers.get('Content-Type') ?? 'application/octet-stream',
      // Yahoo answers `no-store`; that decision is about Yahoo's own edge, not
      // about a chart the same user may reopen twice in a minute.
      'Cache-Control': upstreamResponse.ok
        ? `public, max-age=${hit.upstream.ttl}`
        : 'no-store',
    },
  });

  // Never cache an error: a single upstream 429 would otherwise stick around for
  // the full TTL and break every chart.
  if (upstreamResponse.ok && cache) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  }

  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Everything under /api/ is the proxy's, including paths it doesn't know —
    // those get a 404. Falling through to ASSETS instead would hand back
    // index.html, and a fetch() expecting JSON would fail on `<!doctype html>`
    // rather than on a status code.
    if (pathname.startsWith('/api/')) return proxy(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
