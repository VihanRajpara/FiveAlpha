/**
 * Yahoo's batch quote endpoint, which is the only one here that needs a
 * credential.
 *
 * `/v8/finance/chart` and `/v8/finance/spark` are open: a User-Agent is enough,
 * which is why they go through the plain allow-listed proxy alongside NSE and
 * BSE. `/v7/finance/quote` is not — it answers an unauthenticated call with
 * **401 Invalid Crumb** — and it is the one endpoint that carries `marketCap`,
 * for up to a few hundred symbols in a single request.
 *
 * That matters because market cap is one of the two things the screens in
 * src/lib/screens.ts scrape screener.in for, one company page at a time, paced
 * 1.2s apart because that is what screener.in tolerates. Answering the market
 * cap leg from ten batch requests instead of a thousand paced ones is most of
 * what makes a whole-market screen finish in a minute rather than three.
 *
 * The credential is a cookie/crumb pair, obtained the way Yahoo's own site
 * does:
 *
 *   1. `GET https://fc.yahoo.com` — answers 404 with the `A1`/`A3` cookies.
 *   2. `GET /v1/test/getcrumb` with those cookies — answers an 11-character
 *      token in the body.
 *   3. Every quote request then carries both.
 *
 * It is unofficial and could stop working, so the client treats a failure here
 * as "market cap unknown" rather than as an error: the screen falls back to
 * scraping the figure per company, which is exactly what it did before. See
 * `fetchMarketCaps` in src/lib/marketCap.ts.
 *
 * This module is shared by the two things that host the proxy — the Vite dev
 * middleware and the Cloudflare Worker — so the credential dance exists once.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const QUOTE_ORIGIN = 'https://query1.finance.yahoo.com';

/**
 * Yahoo accepts far more than this per request — 250 came back whole when
 * measured — but the URL is the constraint at the top end and there is nothing
 * to win past the point where the response stops fitting comfortably in one
 * round trip.
 */
export const QUOTE_BATCH_SIZE = 200;

/** Same charset the other upstreams allow: `%` because `M&M` arrives encoded. */
const SYMBOL = /^[A-Za-z0-9.\-&%^=]+$/;

interface Credential {
  cookie: string;
  crumb: string;
}

/**
 * Held for the life of the process (the dev server) or the isolate (the
 * Worker). A crumb outlives a screen run comfortably; when it does expire the
 * quote request comes back 401 and the next attempt takes a fresh one.
 */
let credential: Promise<Credential> | null = null;

function cookiesFrom(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];

  return raw
    .filter(Boolean)
    // Only the `name=value` pair matters to the server that set it; Path,
    // Expires and the rest are instructions to a browser we are not.
    .map((line) => line.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function acquire(): Promise<Credential> {
  // 404s, and is supposed to: the response body is worthless and the Set-Cookie
  // header is the point.
  const seed = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'follow',
  });

  const cookie = cookiesFrom(seed);
  if (!cookie) throw new Error('Yahoo set no cookie');

  const res = await fetch(`${QUOTE_ORIGIN}/v1/test/getcrumb`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain', Cookie: cookie },
  });
  const crumb = (await res.text()).trim();

  // An expired or refused attempt answers with an HTML page rather than a
  // token, which would otherwise be passed along as a crumb and 401 forever.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new Error(`Yahoo returned no crumb (${res.status})`);
  }

  return { cookie, crumb };
}

function credentials(fresh = false): Promise<Credential> {
  if (fresh || !credential) {
    credential = acquire().catch((err) => {
      // Never remember a failure: the next caller should try again rather than
      // inherit a rejected promise for the life of the process.
      credential = null;
      throw err;
    });
  }
  return credential;
}

/**
 * Quotes for a comma-separated symbol list, as Yahoo's own JSON.
 *
 * Returns the upstream body untouched so the caller can read whatever fields it
 * likes; validation here is limited to what stops this being an open proxy.
 */
export async function fetchYahooQuotes(symbols: string): Promise<Response> {
  const list = symbols.split(',').filter(Boolean);

  if (list.length === 0 || list.length > QUOTE_BATCH_SIZE) {
    return new Response(`Ask for 1 to ${QUOTE_BATCH_SIZE} symbols`, { status: 400 });
  }
  if (!list.every((symbol) => SYMBOL.test(symbol))) {
    return new Response('Bad symbol', { status: 400 });
  }

  const query = `symbols=${encodeURIComponent(list.join(','))}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let auth: Credential;
    try {
      // The second pass takes a fresh credential — see below.
      auth = await credentials(attempt > 0);
    } catch (err) {
      return new Response(`Yahoo credential failed: ${err instanceof Error ? err.message : err}`, {
        status: 502,
      });
    }

    const res = await fetch(`${QUOTE_ORIGIN}/v7/finance/quote?${query}&crumb=${encodeURIComponent(auth.crumb)}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: auth.cookie,
      },
    });

    // The two ways a stale pair shows up. Retried once with a new one, because
    // a crumb does expire and the alternative is a dead endpoint until the
    // process restarts.
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;

    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        // Prices move; a screen run reads each batch once. This is here so a
        // double-click on Run does not repeat the whole set.
        'Cache-Control': res.ok ? 'public, max-age=120' : 'no-store',
      },
    });
  }

  return new Response('Yahoo refused the crumb twice', { status: 502 });
}
