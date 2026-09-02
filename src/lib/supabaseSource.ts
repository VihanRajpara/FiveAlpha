import type { DataSource, Exchange, Quote, Security } from '../types';
import { supabase } from './supabaseClient';
import { toNseTicker } from './listings';
import { fetchYahooCandles } from './yahooCandles';

/** PostgREST caps a response at 1000 rows by default, so paginate explicitly. */
const PAGE_SIZE = 1000;

/**
 * Pages requested at once after the first.
 *
 * The old `fetchAll` walked pages strictly in sequence — read a page, look at
 * its length, decide whether to ask for another. On ~5,200 securities and
 * ~5,100 quotes that is six round trips per table and twelve in total, each one
 * a full transatlantic wait before the next could start, and the two tables were
 * *also* sequential to each other because quotes were only fetched after the
 * list resolved. That serial chain was the load time.
 *
 * Asking for the count alongside the first page turns the rest into one
 * parallel burst: two round trips instead of six per table.
 */
const PAGE_CONCURRENCY = 6;

function client() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

/**
 * One row of `securities_with_quotes`.
 *
 * The joined view rather than the two tables separately: it is one read instead
 * of two, and — since migration 0008 — it is the only place the precomputed
 * RSI and ROCE are joined onto the row, so reading the tables directly would
 * mean a third request for them.
 */
interface Row {
  symbol: string;
  name: string;
  series: string;
  isin: string;
  listing_date: string | null;
  face_value: number | null;
  paid_up_value: number | null;
  market_lot: number | null;
  /** Null before migration 0005 — everything was NSE-only then. */
  exchanges?: Exchange[] | null;
  yahoo_ticker?: string | null;
  bse_code?: string | null;
  price: number | null;
  previous_close: number | null;
  /** Null before migration 0003. */
  price_time?: string | null;
  updated_at: string | null;
  /** All three null before migration 0008. */
  market_cap_cr?: number | null;
  monthly_rsi14?: number | null;
  roce_pct?: number | null;
}

function toSecurity(r: Row): Security {
  return {
    symbol: r.symbol,
    name: r.name,
    series: r.series,
    isin: r.isin,
    listingDate: r.listing_date,
    faceValue: r.face_value,
    paidUpValue: r.paid_up_value,
    marketLot: r.market_lot,
    // Pre-0005 databases hold NSE listings and nothing else, so that is the
    // honest reading of a missing column — not "exchange unknown".
    exchanges: r.exchanges?.length ? r.exchanges : ['NSE'],
    ticker: r.yahoo_ticker || toNseTicker(r.symbol),
    bseCode: r.bse_code ?? null,
  };
}

function toQuote(r: Row): Quote {
  const change = r.price !== null && r.previous_close !== null ? r.price - r.previous_close : null;
  const changePercent =
    change !== null && r.previous_close ? (change / r.previous_close) * 100 : null;

  return {
    symbol: r.symbol,
    price: r.price,
    previousClose: r.previous_close,
    change,
    changePercent,
    // Prefer the vendor's print time; fall back to the row write time so this
    // still degrades sensibly on a project that hasn't run migration 0003.
    updatedAt: r.price_time ?? r.updated_at,
    marketCapCr: r.market_cap_cr ?? null,
    monthlyRsi14: r.monthly_rsi14 ?? null,
    rocePct: r.roce_pct ?? null,
    // Not stored. The server-side screener.in scrape is gone (migration 0010
    // dropped its column, which had been null on every row since), so the
    // drawer's link comes from the live client scrape in lib/fundamentals.ts
    // or not at all — same as direct mode.
    fundamentalsUrl: null,
  };
}

/**
 * Every row of the view, first page and count together, the rest in parallel.
 *
 * `count: 'estimated'` rather than `'exact'` deliberately: an exact count is a
 * sequential scan of the table on every page load to answer a question we only
 * need approximately — how many more pages to ask for. The estimate comes off
 * the planner's statistics for free. Under-counting is handled by the trailing
 * check below rather than by paying for precision up front.
 */
async function fetchRows(): Promise<Row[]> {
  const page = (from: number) =>
    client()
      .from('securities_with_quotes')
      .select('*', from === 0 ? { count: 'estimated' } : undefined)
      .order('symbol')
      .range(from, from + PAGE_SIZE - 1);

  const first = await page(0);
  if (first.error) throw new Error(`securities_with_quotes: ${first.error.message}`);

  const rows = (first.data ?? []) as unknown as Row[];
  if (rows.length < PAGE_SIZE) return rows;

  const total = first.count ?? 0;
  const out = [...rows];

  // Ask for the pages the estimate implies, then keep going while the last
  // burst came back full — which is what covers an estimate that was low.
  for (let from = PAGE_SIZE; ; ) {
    const remaining = Math.max(total - from, 0);
    const wanted = Math.max(Math.ceil(remaining / PAGE_SIZE), 1);
    const burst = Math.min(wanted, PAGE_CONCURRENCY);

    const pages = await Promise.all(
      Array.from({ length: burst }, (_, i) => page(from + i * PAGE_SIZE)),
    );

    let full = 0;
    for (const result of pages) {
      if (result.error) throw new Error(`securities_with_quotes: ${result.error.message}`);
      const batch = (result.data ?? []) as unknown as Row[];
      out.push(...batch);
      if (batch.length === PAGE_SIZE) full++;
    }

    from += burst * PAGE_SIZE;
    // A short page anywhere in the burst means the table ended inside it.
    if (full < burst) return out;
  }
}

/**
 * One read for the whole dataset, cached for the life of the module.
 *
 * `listSecurities` and `fetchQuotes` are both called once on load, against the
 * same view, for the same rows. Reading it twice was the second half of the
 * load cost. They now share a single in-flight promise: whichever is called
 * first pays for the read and the other joins it.
 *
 * Cleared by `fetchQuotes` when it is called again, which is what the refresh
 * button does — a refresh must actually re-read.
 */
let pending: Promise<Row[]> | null = null;

function rows(): Promise<Row[]> {
  if (!pending) {
    pending = fetchRows().catch((err) => {
      // Never remember a failure: a retry should re-ask rather than inherit a
      // rejected promise for the life of the tab.
      pending = null;
      throw err;
    });
  }
  return pending;
}

export const supabaseSource: DataSource = {
  kind: 'supabase',

  /**
   * The rows are already merged — `sync-securities` folds BSE into NSE before
   * writing, so this stays a plain read.
   */
  async listSecurities(): Promise<Security[]> {
    return (await rows()).map(toSecurity);
  },

  async fetchQuotes(_targets, onBatch): Promise<Quote[]> {
    // The sync functions already refreshed these; just read the view. On a cold
    // load this rides on the read `listSecurities` started, so the whole page
    // costs one trip rather than two.
    const data = await rows();
    // Consumed: the refresh button must go back to the database rather than
    // hand back the rows it already showed.
    pending = null;

    const quotes = data.map(toQuote);
    if (quotes.length > 0) onBatch?.(quotes);
    return quotes;
  },

  /**
   * Not from the database. Supabase holds the master list, the current prices
   * and the precomputed metrics — all small and read by every page load — while
   * history is fetched live through the /api/yahoo proxy, exactly as in direct
   * mode. Storing it was ~500k rows for something one open drawer reads one
   * symbol of.
   */
  fetchCandles: fetchYahooCandles,
};
