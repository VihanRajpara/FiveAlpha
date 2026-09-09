// Replaces public.screen_matches with the current result set of the Chartink
// screen, every five minutes.
//
// Chartink has no API. It has a page and the XHR that page makes, and this is
// that XHR: `POST /screener/process` with the screen's `scan_clause`, which
// answers JSON. Two things make it more than a fetch:
//
//   · **CSRF.** The endpoint is Laravel-protected. The token is in a
//     `<meta name="csrf-token">` on the screen page and must be presented
//     together with the cookies that same response set — either alone is a 419.
//   · **The clause.** It is embedded in the page as `atlas_query`, so it is
//     read from there rather than pasted here. If the screen's author edits it
//     on Chartink, the next run follows; the copy in src/lib/screens.ts is for
//     display and is the fallback, not the source of truth.
//
// Everything else is Chartink's own answer, stored verbatim. Nothing here
// judges a row — that was the point of moving off the client-side screen.
import {
  adminClient,
  assertAuthorized,
  BROWSER_UA,
  CORS_HEADERS,
  fetchWithTimeout,
  json,
} from '../_shared/edge.ts';

const SCREEN_URL = 'https://chartink.com/screener/all-time-high-breakout-9032071';
const PROCESS_URL = 'https://chartink.com/screener/process';

/**
 * Used only when the page renders without an `atlas_query` — a layout change on
 * Chartink's side, most likely. Kept identical to `ALL_TIME_HIGH_BREAKOUT.clause`
 * in src/lib/screens.ts, which is what the UI shows the user.
 */
const FALLBACK_CLAUSE =
  '( {cash} ( daily close > yearly max( 10 , yearly high ) * 0.75 and ' +
  'daily close <= yearly max( 10 , yearly high ) * 1 and ' +
  'yearly return on capital employed percentage > 10 and ' +
  'market cap >= 500 and market cap <= 50000 and monthly rsi( 14 ) >= 65 ) )';

/** One row of Chartink's `data` array. */
interface ChartinkRow {
  sr?: number;
  nsecode?: string;
  name?: string;
  close?: number;
  per_chg?: number;
  volume?: number;
}

/**
 * The page carries the clause twice HTML-escaped — once for the attribute, once
 * for the JSON blob inside it — so `&gt;` arrives as `&amp;gt;`. Decoding is
 * therefore two passes, and only of the five named entities Laravel's `e()`
 * produces; a general entity decoder would be more code for characters that
 * cannot appear in a scan clause.
 */
function decodeEntities(text: string): string {
  const once = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, '&');
  return once(once(text));
}

interface Session {
  csrf: string;
  cookie: string;
  clause: string;
}

async function openSession(): Promise<Session> {
  const res = await fetchWithTimeout(SCREEN_URL, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`screen page ${res.status}`);

  // getSetCookie is the only way to read *all* of them — `get('set-cookie')`
  // folds multiple headers into one comma-joined string that no server parses
  // back. The fallback is for a runtime that lacks it; Chartink sets the
  // XSRF-TOKEN and session cookies in that order, and both are required.
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const cookie = raw
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');

  const html = await res.text();
  const csrf = html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('no csrf-token on the screen page');
  if (!cookie) throw new Error('the screen page set no cookies');

  const clause = html.match(/&quot;atlas_query&quot;:&quot;(.*?)&quot;,/)?.[1];
  return { csrf, cookie, clause: clause ? decodeEntities(clause) : FALLBACK_CLAUSE };
}

async function runScreen(session: Session): Promise<ChartinkRow[]> {
  const res = await fetchWithTimeout(PROCESS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      // Laravel answers a redirect to the HTML page without this; the endpoint
      // only speaks JSON to what it believes is the page's own XHR.
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': session.csrf,
      Cookie: session.cookie,
      Referer: SCREEN_URL,
      Origin: 'https://chartink.com',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: new URLSearchParams({ scan_clause: session.clause }).toString(),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`process ${res.status}: ${text.slice(0, 200)}`);

  // It answers `text/html` while sending JSON, so the content type says nothing
  // and a thrown SyntaxError would hide the actual body. A 419 or a login wall
  // lands here, and the first 200 characters of it are what identifies which.
  let payload: { data?: ChartinkRow[] };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`process returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(payload.data)) throw new Error('process returned no data array');
  return payload.data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const session = await openSession();
    const data = await runScreen(session);

    const rows = data
      .filter((r) => typeof r.nsecode === 'string' && r.nsecode.trim() !== '')
      .map((r) => ({
        symbol: r.nsecode!.trim(),
        name: r.name ?? null,
        rank: r.sr ?? null,
        close: r.close ?? null,
        chg_pct: r.per_chg ?? null,
        volume: r.volume ?? null,
      }));

    if (rows.length === 0) {
      // Not an error upstream — a 200 with an empty list. Still refused, for the
      // reason written on screen_matches_replace: an empty screen is far more
      // often a broken scrape than a market with no matches.
      return json({ error: 'chartink returned no rows — leaving the stored list alone' }, 502);
    }

    // Delete-and-insert inside one transaction (migration 0013), so the browser
    // polling this table on the same beat never reads it mid-replace.
    const { data: inserted, error } = await adminClient().rpc('screen_matches_replace', { rows });
    if (error) return json({ error: error.message, stage: 'replace' }, 500);

    return json({ ok: true, matched: data.length, stored: inserted, clause: session.clause });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
