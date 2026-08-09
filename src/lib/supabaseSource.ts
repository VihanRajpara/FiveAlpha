import type { Candle, ChartRange, DataSource, Quote, Security } from '../types';
import { supabase } from './supabaseClient';

/** PostgREST caps a response at 1000 rows by default, so paginate explicitly. */
const PAGE_SIZE = 1000;

const RANGE_DAYS: Record<ChartRange, number> = {
  '1mo': 31,
  '6mo': 186,
  '1y': 366,
  '5y': 1830,
};

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
}

interface QuoteRow {
  symbol: string;
  price: number | null;
  previous_close: number | null;
  /** Vendor timestamp of the price itself. Null before migration 0003. */
  price_time?: string | null;
  updated_at: string | null;
}

interface CandleRow {
  bar_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
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

  async listSecurities(): Promise<Security[]> {
    const rows = await fetchAll<SecurityRow>(
      'securities',
      'symbol,name,series,isin,listing_date,face_value,paid_up_value,market_lot',
      'symbol',
    );

    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      series: r.series,
      isin: r.isin,
      listingDate: r.listing_date,
      faceValue: r.face_value,
      paidUpValue: r.paid_up_value,
      marketLot: r.market_lot,
    }));
  },

  async fetchQuotes(_symbols, onBatch): Promise<Quote[]> {
    // The sync-quotes function already refreshed these; just read the table.
    // `*` rather than a column list: naming `price_time` explicitly would 400 on
    // a project that hasn't run migration 0003 yet, and the table is narrow
    // enough that the extra columns cost nothing.
    const rows = await fetchAll<QuoteRow>('quotes', '*', 'symbol');
    const quotes = rows.map(toQuote);
    if (quotes.length > 0) onBatch?.(quotes);
    return quotes;
  },

  async fetchCandles(symbol, range): Promise<Candle[]> {
    const since = new Date();
    since.setDate(since.getDate() - RANGE_DAYS[range]);

    const { data, error } = await client()
      .from('candles')
      .select('bar_date,open,high,low,close,volume')
      .eq('symbol', symbol)
      .gte('bar_date', since.toISOString().slice(0, 10))
      .order('bar_date');

    if (error) throw new Error(`candles: ${error.message}`);

    return ((data ?? []) as unknown as CandleRow[]).map((r) => ({
      date: r.bar_date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  },
};
