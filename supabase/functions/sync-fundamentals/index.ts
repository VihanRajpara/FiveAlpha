// Fills public.metrics.roce_pct by scraping screener.in, a slice per invocation.
//
// **Why this moved to the server.** ROCE was the one figure the app could never
// really show. It is scraped one company page at a time and screener.in tolerates
// about one request every 1.2s, so the whole 5,229-row universe is roughly an
// hour and three quarters of wall clock. A browser cannot spend that, which is
// why `useScreen` only ever asked for the handful of rows that survived every
// technical leg — a few dozen out of five thousand — and the ROCE column was an
// em dash for ~95% of the table by construction, not by accident.
//
// Server-side and incremental, the arithmetic works: this takes the least
// recently scraped rows each run, so the universe fills over a couple of days
// and then rotates. That is comfortably often enough for a figure computed from
// **annual** statements, which is the other half of why the browser was the
// wrong place for it — it was re-fetching, at 1.2s a row, a number that changes
// when a company files its accounts and not otherwise.
import {
  adminClient,
  assertAuthorized,
  BROWSER_UA,
  CORS_HEADERS,
  fetchWithTimeout,
  json,
} from '../_shared/upstream.ts';

/**
 * Minimum gap between two screener.in requests. Measured from the browser and
 * recorded in src/lib/fundamentals.ts: no delay 429s from the 17th request,
 * 600ms from the 35th, 1.2s completed 60 of 60. The limit is on **rate, not
 * quota** — which calls for slowing down rather than giving up.
 */
const MIN_INTERVAL_MS = 1200;

/**
 * Rows per invocation.
 *
 * Bounded by the function's wall clock, not by politeness: at 1.2s apart, 90
 * rows is under two minutes with headroom for the slow pages. Hourly, that is
 * ~2,160 rows a day and a first full pass in about two and a half days;
 * thereafter every row is re-read roughly every 60 hours. Override with
 * `?limit=` for a manual backfill run.
 */
const DEFAULT_SLICE = 90;

/** Wait this out rather than giving up — see the rate-vs-quota note above. */
const BACKOFF_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target {
  symbol: string;
  bse_code: string | null;
  exchanges: string[] | null;
}

/**
 * The company's page, consolidated first and standalone behind it.
 *
 * `/consolidated/` matters: a holding company's standalone ROCE is materially
 * different — Reliance is 7.78% standalone against 10.3% consolidated. But
 * screener.in does **not** fall back for companies that file no consolidated
 * statements; it serves those a 200 with the ratio strip rendered and every
 * value empty. That is most small and micro caps, so the page to use is decided
 * by what came back rather than assumed. Mirrors `screenerPaths` in
 * src/lib/fundamentals.ts.
 */
function screenerPaths(target: Target): string[] {
  const key = (target.exchanges ?? []).includes('NSE') ? target.symbol : target.bse_code;
  if (!key) return [];
  const base = `https://www.screener.in/company/${encodeURIComponent(key)}/`;
  return [`${base}consolidated/`, base];
}

/** Pulls `#top-ratios` into a name → numbers map. Mirrors `parseTopRatios`. */
function parseTopRatios(html: string): Map<string, number[]> {
  const out = new Map<string, number[]>();

  const start = html.indexOf('id="top-ratios"');
  if (start < 0) return out;
  const end = html.indexOf('</ul>', start);
  const block = html.slice(start, end < 0 ? undefined : end);

  for (const item of block.split('<li').slice(1)) {
    const name = /class="name"[^>]*>([\s\S]*?)<\/span>/.exec(item)?.[1];
    if (!name) continue;

    // The empty span has to be discarded before `Number` sees it: `Number('')`
    // is **0**, not NaN, so a company with no consolidated statements — served
    // `<span class="number"></span>` for every ratio — used to read as
    // "ROCE 0", a definite *fail* rather than an unknown.
    const numbers = [...item.matchAll(/class="number"[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/[,\s]/g, ''))
      .filter((text) => text !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));

    out.set(name.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), numbers);
  }

  return out;
}

const hasFigures = (ratios: Map<string, number[]>): boolean =>
  [...ratios.values()].some((numbers) => numbers.length > 0);

interface Scraped {
  roce_pct: number | null;
  url: string | null;
}

/**
 * One company, at most two requests.
 *
 * A 404 on the first path is the whole company missing rather than that variant
 * of it — screener.in 404s both URLs for a symbol it does not carry — so there
 * is nothing to gain by asking again and one paced request per dead scrip to
 * lose. Returns `null` only for a rate limit, which is about the *stage* and
 * must stop the run rather than mark this row as answered.
 */
async function scrape(target: Target): Promise<Scraped | 'rate-limited'> {
  let last: Scraped = { roce_pct: null, url: null };

  for (const url of screenerPaths(target)) {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' } },
      20_000,
    );

    if (res.status === 429) return 'rate-limited';
    // A 404 or any other refusal is an answer about this company, recorded as
    // "no figure" so the row is not retried every hour forever.
    if (!res.ok) return { roce_pct: null, url: null };

    const ratios = parseTopRatios(await res.text());
    const page: Scraped = { roce_pct: ratios.get('ROCE')?.[0] ?? null, url };
    if (hasFigures(ratios)) return page;
    last = page;

    await sleep(MIN_INTERVAL_MS);
  }

  return last;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  try {
    const supabase = adminClient();
    const slice = Number(new URL(req.url).searchParams.get('limit')) || DEFAULT_SLICE;

    // Least recently scraped first. `metrics` may have no row for a symbol yet,
    // so the queue is built from `securities` left-joined to it — a symbol with
    // no metrics row has never been scraped and must outrank every stale one.
    //
    // Paged rather than given a large `limit`: PostgREST caps a response at 1000
    // rows whatever the limit says, so a single call would quietly consider only
    // the alphabetical first thousand symbols and never scrape anything after
    // ~BAJAJ. The whole list has to be in hand before it can be sorted by
    // staleness, because the sort key lives in the embedded resource.
    const rows: (Target & { metrics: { roce_at: string | null }[] | null })[] = [];
    for (let page = 0; ; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('securities')
        .select('symbol, bse_code, exchanges, metrics(roce_at)')
        .order('symbol')
        .range(from, from + 999);
      if (error) return json({ error: error.message, stage: 'read-symbols' }, 500);
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < 1000) break;
    }

    const queue = rows
      .map((r) => ({
        target: { symbol: r.symbol, bse_code: r.bse_code, exchanges: r.exchanges },
        // Nulls sort first: never-scraped beats stale, always.
        at: r.metrics?.[0]?.roce_at ?? '',
      }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, slice);

    const now = new Date().toISOString();
    const out: { symbol: string; roce_pct: number | null; fundamentals_url: string | null; roce_at: string }[] = [];
    let rateLimited = false;

    // Strictly serial. The pacing above is the whole point — running these in
    // parallel is what earns a 429, and a 429 costs more than the time saved.
    for (const { target } of queue) {
      const result = await scrape(target);
      if (result === 'rate-limited') {
        rateLimited = true;
        break;
      }
      out.push({
        symbol: target.symbol,
        roce_pct: result.roce_pct,
        fundamentals_url: result.url,
        // Stamped even when the figure is null: "asked, nothing there" is an
        // answer, and without the stamp the row would be retried every run and
        // starve every symbol behind it in the queue.
        roce_at: now,
      });
      await sleep(MIN_INTERVAL_MS);
    }

    if (out.length > 0) {
      const { error: upsertError } = await supabase
        .from('metrics')
        .upsert(out, { onConflict: 'symbol' });
      if (upsertError) return json({ error: upsertError.message, stage: 'upsert' }, 500);
    }

    if (rateLimited) await sleep(BACKOFF_MS);

    return json({
      ok: true,
      queued: queue.length,
      scraped: out.length,
      withRoce: out.filter((r) => r.roce_pct !== null).length,
      rateLimited,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
