import type { DataSource, Exchange, Quote, Security } from '../types';
import { supabase } from './supabaseClient';
import { toNseTicker } from './listings';
import { fetchYahooCandles } from './yahooCandles';

/** PostgREST caps a response at 1000 rows by default, so paginate explicitly. */
const PAGE_SIZE = 1000;

function client() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

interface SecurityRow {
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
}

interface QuoteRow {
  symbol: string;
  price: number | null;
  previous_close: number | null;
  /** Vendor timestamp of the price itself. Null before migration 0003. */
  price_time?: string | null;
  updated_at: string | null;
}

function toQuote(row: QuoteRow): Quote {
  const change =
    row.price !== null && row.previous_close !== null ? row.price - row.previous_close : null;
  const changePercent =
    change !== null && row.previous_close ? (change / row.previous_close) * 100 : null;

  return {
    symbol: row.symbol,
    price: row.price,
    previousClose: row.previous_close,
    change,
    changePercent,
    // Prefer the vendor's print time; fall back to the row write time so this
    // still degrades sensibly on a project that hasn't run migration 0003.
    updatedAt: row.price_time ?? row.updated_at,
  };
}

/** Pulls every row of a table in PAGE_SIZE slices. */
async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const out: T[] = [];

  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await client()
      .from(table)
      .select(columns)
      .order(orderBy)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`${table}: ${error.message}`);

    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

export const supabaseSource: DataSource = {
  kind: 'supabase',

  /**
   * The rows are already merged — `sync-securities` folds BSE into NSE before
   * writing, so this stays a plain read. `*` rather than a column list for the
   * same reason as `fetchQuotes` below: naming `exchanges` explicitly would 400
   * on a database that hasn't run migration 0005 yet.
   */
  async listSecurities(): Promise<Security[]> {
    const rows = await fetchAll<SecurityRow>('securities', '*', 'symbol');

    return rows.map((r) => ({
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
    }));
  },

  async fetchQuotes(_targets, onBatch): Promise<Quote[]> {
    // The sync-quotes function already refreshed these; just read the table.
    // `*` rather than a column list: naming `price_time` explicitly would 400 on
    // a project that hasn't run migration 0003 yet, and the table is narrow
    // enough that the extra columns cost nothing.
    const rows = await fetchAll<QuoteRow>('quotes', '*', 'symbol');
    const quotes = rows.map(toQuote);
    if (quotes.length > 0) onBatch?.(quotes);
    return quotes;
  },

  /**
   * Not from the database. Supabase holds the master list and the current
   * prices — both small and read by every page load — while history is fetched
   * live through the /api/yahoo proxy, exactly as in direct mode. Storing it was
   * ~500k rows for something one open drawer reads one symbol of.
   */
  fetchCandles: fetchYahooCandles,
};
