import { dayCache } from './dayCache';
import type { Security } from '../types';

/**
 * Market cap and ROCE, scraped from screener.in company pages.
 *
 * This is the one data source in the app that is neither an exchange nor a
 * quote feed, and it exists for one reason: the Chartink clause in
 * src/lib/screens.ts has a `return on capital employed` leg and a market-cap
 * band, and nothing already wired up can answer either. NSE and BSE publish
 * listings, not financials; Yahoo's `quoteSummary` — which does carry shares
 * outstanding and margins — now answers **401 Invalid Crumb** to an
 * unauthenticated call, so the market cap cannot be reconstructed from a price
 * either.
 *
 * What is scraped is the ratio strip at the top of a company page, which is
 * plain server-rendered HTML:
 *
 *   <ul id="top-ratios">
 *     <li><span class="name">Market Cap</span>
 *         <span class="value">₹ <span class="number">1,800,557</span> Cr.</span></li>
 *     <li><span class="name">ROCE</span> … <span class="number">10.3</span> % …
 *
 * Being a scrape, it is the most fragile thing here: a markup change breaks it,
 * and it is the only source with no documented contract at all. Everything
 * downstream therefore treats a null as "unknown", never as "fails the test" —
 * a screen reports how many rows it could not judge rather than quietly
 * dropping them.
 */

/** Requests go through the same-origin proxy — see vite.config.ts / worker/index.ts. */
const BASE = '/api/screener/company';

/**
 * Screener.in is somebody's server and a screen run is a burst of requests at
 * it. Four in flight bounds the sockets, but it is no longer what governs the
 * pace — `MIN_INTERVAL_MS` is, and with that gate in place rarely more than one
 * request is actually open at a time.
 */
export const FUNDAMENTALS_CONCURRENCY = 4;

/**
 * Minimum gap between two screener.in requests, anywhere in the app.
 *
 * The limit is on **rate, not quota**, which is worth knowing because the two
 * call for opposite responses — a quota means give up, a rate means slow down.
 * Measured 2026-08-12, serial requests to distinct company pages:
 *
 * | gap | outcome |
 * |---|---|
 * | none | 429 from the 17th request |
 * | 250 ms | 429 from the ~25th |
 * | 600 ms | 429 from the 35th |
 * | **1.2 s** | **60 of 60, no 429** |
 * | 2.5 s | 40 of 40, no 429 |
 *
 * At four unthrottled connections a screen used to hit the wall about twenty
 * rows in and abort, which on a 2,410-row NSE universe meant the fundamental
 * legs were effectively never evaluated. 1.2 s is the measured floor with a
 * little room under it; a run over the ~115 rows that survive the technical
 * legs costs a little over two minutes, which is the price of the leg working
 * at all.
 */
const MIN_INTERVAL_MS = 1200;

/**
 * Requests that may go out back-to-back before the interval above applies.
 *
 * The same measurements say the limit is a bucket rather than a metronome: with
 * *no* delay at all the 429 came on the **17th** request, i.e. sixteen were
 * allowed through at once and the refill is what the 1.2s figure describes.
 * Spending that allowance is free — the screen has its whole shortlist queued
 * within seconds of the price stages finishing — and it takes ~14s off the
 * front of every run that has a dozen rows to scrape.
 *
 * Twelve rather than sixteen: the bucket was measured once, on one day, from
 * one address, and the cost of being wrong about it is a 429 that stops the
 * stage dead.
 */
const BURST = 12;

/** Waits out a 429 rather than giving up on the first one. */
const BACKOFF_MS = [10_000, 30_000, 60_000];

/** Start time reserved for the next request; shared by every caller. */
let nextSlotAt = 0;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) return fail();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One request, paced and retried.
 *
 * A 429 pushes *every* queued caller back, not just this one: the limit is on
 * the origin, so one request backing off while the rest keep firing would only
 * hold the block open.
 */
export async function fetchPaced(url: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();

    // Virtual scheduling. `nextSlotAt` is where the *metronome* is, which is
    // allowed to lag real time by up to `BURST` intervals — that lag is the
    // unspent bucket, and a stage that has been idle spends it at once.
    //
    // The advance below is from the metronome, not from the moment the request
    // actually goes out. Advancing from `slot` would reset the lag on the first
    // burst request and pace every one after it, which is the bug this shape
    // exists to avoid.
    nextSlotAt = Math.max(nextSlotAt, now - MIN_INTERVAL_MS * BURST);
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt += MIN_INTERVAL_MS;

    await sleep(slot - now, signal);

    const res = await fetch(url, { signal });
    if (res.status !== 429) return res;
    if (attempt >= BACKOFF_MS.length) return res;

    nextSlotAt = Math.max(nextSlotAt, Date.now() + BACKOFF_MS[attempt]);
    await sleep(BACKOFF_MS[attempt], signal);
  }
}

export interface Fundamentals {
  /** ₹ crore, matching the units Chartink's `market cap` is written in. */
  marketCapCr: number | null;
  /** Latest annual return on capital employed, in percent. */
  rocePct: number | null;
  /** The page the numbers came from — shown in the UI so a figure is checkable. */
  url: string;
}

/** Thrown on a 429 so a run can stop as a whole instead of hammering on. */
export class RateLimitedError extends Error {
  constructor() {
    super(
      'screener.in is still rate-limiting after backing off for a minute and a half. ' +
        'Wait a few minutes and run the screen again — judged rows are cached, so it resumes where it stopped.',
    );
    this.name = 'RateLimitedError';
  }
}

/**
 * Screener.in keys companies by NSE symbol where one exists and by BSE scrip
 * code otherwise — the same either/or the app already resolved into
 * `Security.ticker`, so it is read off `exchanges` rather than guessed.
 *
 * `/consolidated/` matters more than it looks. The standalone page of a holding
 * company reports a materially different ROCE — Reliance is 7.78% standalone
 * against 10.3% consolidated, i.e. opposite sides of this screen's `> 10` test.
 * Screener.in serves the consolidated URL with a 200 even for companies that
 * have no consolidated statements, falling back to the standalone figures
 * itself, so there is no redirect to follow and no second request to make.
 */
export function screenerPath(security: Pick<Security, 'symbol' | 'bseCode' | 'exchanges'>): string | null {
  if (security.exchanges.includes('NSE')) {
    return `${BASE}/${encodeURIComponent(security.symbol)}/consolidated/`;
  }
  return security.bseCode ? `${BASE}/${encodeURIComponent(security.bseCode)}/consolidated/` : null;
}

/** Pulls `#top-ratios` into a name → numbers map. Exported for the tests. */
export function parseTopRatios(html: string): Map<string, number[]> {
  const out = new Map<string, number[]>();

  const start = html.indexOf('id="top-ratios"');
  if (start < 0) return out;
  const end = html.indexOf('</ul>', start);
  const block = html.slice(start, end < 0 ? undefined : end);

  // `<li` split rather than a single regex over the whole block: the entries are
  // multi-line and one `.` -based pattern per field would need `s` flags and
  // still couple the two spans' order.
  for (const item of block.split('<li').slice(1)) {
    const name = /class="name"[^>]*>([\s\S]*?)<\/span>/.exec(item)?.[1];
    if (!name) continue;

    const numbers = [...item.matchAll(/class="number"[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => Number(m[1].replace(/[,\s]/g, '')))
      .filter((n) => Number.isFinite(n));

    out.set(name.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), numbers);
  }

  return out;
}

/**
 * How long a scraped page is worth keeping.
 *
 * A month, because of what this scrape is now *for*. Market cap comes from
 * Yahoo in batches of two hundred (see src/lib/marketCap.ts), so what remains
 * here is ROCE — a figure computed from annual statements, which changes when a
 * company files and not otherwise. Asking again tomorrow for a number that
 * moves once a year is what made this the slowest thing in the app.
 *
 * The market cap parsed alongside it ages badly over a month, and is kept
 * anyway: it is only ever read for symbols Yahoo has no figure for at all,
 * which are dead or near-dead scrips whose band is not in doubt.
 */
const KEEP_DAYS = 30;

/** Settled answers, kept across reloads for as long as they are worth keeping. */
const settled = dayCache<Fundamentals | null>(
  'fundamentals',
  {
    encode: (f) => (f === null ? 0 : [f.marketCapCr, f.rocePct, f.url]),
    decode: (raw) => {
      if (raw === 0) return null;
      if (!Array.isArray(raw) || raw.length !== 3) return undefined;
      const [marketCapCr, rocePct, url] = raw as [number | null, number | null, string];
      return { marketCapCr, rocePct, url };
    },
  },
  KEEP_DAYS,
);

/** Requests in flight, so two rows resolving to one page share a single fetch. */
const inflight = new Map<string, Promise<Fundamentals | null>>();

/** Writes the store out now — called when a run finishes. */
export const persistFundamentals = (): void => settled.flush();

/**
 * Null means "no page for this company" (404 — unlisted, renamed, or an SME
 * scrip screener.in doesn't carry), which is a normal outcome for a few hundred
 * of the BSE-only rows and not an error. It is cached like any other answer.
 *
 * Keyed by URL rather than by symbol: dual-listed rows and re-runs after a
 * filter change resolve to the same page, and should only pay for it once.
 */
export function fetchFundamentals(
  security: Pick<Security, 'symbol' | 'bseCode' | 'exchanges'>,
  signal?: AbortSignal,
): Promise<Fundamentals | null> {
  const url = screenerPath(security);
  if (!url) return Promise.resolve(null);

  if (settled.has(url)) return Promise.resolve(settled.get(url) ?? null);

  const hit = inflight.get(url);
  if (hit) return hit;

  const pending = (async (): Promise<Fundamentals | null> => {
    const res = await fetchPaced(url, signal);

    if (res.status === 404) return null;
    // Only after the backoffs above are spent. At that point the block is not
    // something this run can wait out.
    if (res.status === 429) throw new RateLimitedError();
    if (!res.ok) throw new Error(`screener.in returned ${res.status} for ${security.symbol}`);

    const ratios = parseTopRatios(await res.text());
    return {
      marketCapCr: ratios.get('Market Cap')?.[0] ?? null,
      rocePct: ratios.get('ROCE')?.[0] ?? null,
      url,
    };
  })()
    .then((fundamentals) => {
      settled.set(url, fundamentals);
      inflight.delete(url);
      return fundamentals;
    });

  // A failed request must not be remembered as a failure: the next run should
  // retry it. Only a settled *answer* — including the 404 null — is worth
  // keeping.
  pending.catch(() => inflight.delete(url));

  inflight.set(url, pending);
  return pending;
}
