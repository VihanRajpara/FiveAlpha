import type { Exchange, Security } from '../types';
import { parseCsvObjects } from './csv';
import { parseNseDate, toNumber } from './format';

/**
 * The master list, assembled from both Indian cash exchanges.
 *
 * NSE publishes a CSV; BSE publishes JSON from its site's own API. Neither knows
 * about the other, and most large companies are on both — so the two lists are
 * merged on ISIN, which is the only identifier the exchanges genuinely share.
 * The result is one row per *company*.
 *
 * This module is used by `directSource` (browser, through the dev/Worker proxy).
 * `sync-securities` and `scripts/seed.mjs` reimplement the same merge server-side
 * so Supabase stores rows that are already merged, exactly as the older
 * NSE-only ingestion mirrored EQUITY_L.csv.
 */

const EQUITY_LIST_URL = '/api/nse/content/equities/EQUITY_L.csv';

/**
 * BSE's scrip master. `segment=Equity&status=Active` is what the exchange's own
 * "List of Securities" page requests, and it returns every live equity scrip
 * (~5,100) in one 1.8 MB response. The empty Group/Scripcode/industry params are
 * required — the endpoint 400s if they are absent rather than treating them as
 * unfiltered.
 */
const BSE_LIST_URL =
  '/api/bse/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active';

/** One row of BSE's scrip master, narrowed to the fields worth keeping. */
interface BseScripRow {
  /** Numeric scrip code, e.g. "500325". BSE's own primary key. */
  SCRIP_CD?: string;
  /** Alphabetic ticker, e.g. "RELIANCE". This is what Yahoo keys `.BO` on. */
  scrip_id?: string;
  Scrip_Name?: string;
  ISIN_NUMBER?: string;
  /** Settlement group: A, B, X, XT, T, Z, M, MT, … */
  GROUP?: string;
  FACE_VALUE?: string;
  Status?: string;
  Segment?: string;
}

export interface BseScrip {
  code: string;
  /** BSE ticker; also the Yahoo `.BO` stem. */
  id: string;
  name: string;
  isin: string;
  group: string;
  faceValue: number | null;
}

/**
 * An ISIN is 12 alphanumerics. BSE ships a couple of placeholder rows carrying
 * the literal string "NA", which would otherwise merge two unrelated companies
 * into one on their shared "ISIN".
 */
function isUsableIsin(value: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(value);
}

export function toNseTicker(symbol: string): string {
  return `${symbol}.NS`;
}

/**
 * Yahoo keys BSE listings on the alphabetic scrip id, not the numeric scrip
 * code: `TANFACIND.BO` resolves, and so does `504346.BO` for older scrips, but
 * anything listed recently (scrip codes in the 5445xx range and up) is only
 * reachable by id. The id form covered every scrip sampled, so it is the one
 * used throughout.
 */
export function toBseTicker(scripId: string): string {
  return `${scripId}.BO`;
}

export async function fetchNseSecurities(): Promise<Security[]> {
  const res = await fetch(EQUITY_LIST_URL);
  if (!res.ok) {
    throw new Error(`NSE returned ${res.status} for the equity list. Is the dev proxy running?`);
  }

  return parseCsvObjects(await res.text())
    .map((row) => {
      const symbol = row['SYMBOL'] ?? '';
      return {
        symbol,
        name: row['NAME OF COMPANY'] ?? '',
        series: row['SERIES'] ?? '',
        isin: row['ISIN NUMBER'] ?? '',
        listingDate: parseNseDate(row['DATE OF LISTING'] ?? ''),
        faceValue: toNumber(row['FACE VALUE']),
        paidUpValue: toNumber(row['PAID UP VALUE']),
        marketLot: toNumber(row['MARKET LOT']),
        exchanges: ['NSE'] as Exchange[],
        ticker: toNseTicker(symbol),
        bseCode: null,
      };
    })
    .filter((s) => s.symbol !== '');
}

export async function fetchBseScrips(): Promise<BseScrip[]> {
  const res = await fetch(BSE_LIST_URL);
  if (!res.ok) throw new Error(`BSE returned ${res.status} for the scrip list`);

  const rows = (await res.json()) as BseScripRow[];
  if (!Array.isArray(rows)) throw new Error('BSE returned an unexpected payload');

  return rows
    .filter((r) => (r.Segment ?? '').trim() === 'Equity' && (r.Status ?? '').trim() === 'Active')
    .map((r) => ({
      code: (r.SCRIP_CD ?? '').trim(),
      id: (r.scrip_id ?? '').trim(),
      name: (r.Scrip_Name ?? '').trim(),
      isin: (r.ISIN_NUMBER ?? '').trim(),
      group: (r.GROUP ?? '').trim(),
      faceValue: toNumber(r.FACE_VALUE ?? ''),
    }))
    .filter((s) => s.code !== '' && s.id !== '');
}

/**
 * Folds the BSE scrip master into the NSE list.
 *
 * Dual-listed companies (~2,300) enrich their existing NSE row: the row gains
 * `BSE` in `exchanges` and the scrip code, but keeps NSE's symbol, series and
 * listing date, and keeps pricing off `.NS` — the NSE book is the more liquid of
 * the two, so its last trade is the better one to show.
 *
 * BSE-only companies (~2,800) become new rows keyed on their scrip id.
 */
export function mergeListings(nse: Security[], bse: BseScrip[]): Security[] {
  const byIsin = new Map<string, BseScrip>();
  for (const scrip of bse) {
    // First scrip wins. BSE occasionally lists a second line (partly paid, a
    // second class of share) against one ISIN; the merge only needs to know
    // *that* the company trades on BSE, so the extra line adds nothing.
    if (isUsableIsin(scrip.isin) && !byIsin.has(scrip.isin)) byIsin.set(scrip.isin, scrip);
  }

  const merged: Security[] = [];
  const matched = new Set<string>();
  const taken = new Set<string>();

  for (const security of nse) {
    const scrip = isUsableIsin(security.isin) ? byIsin.get(security.isin) : undefined;
    taken.add(security.symbol);
    if (scrip) matched.add(scrip.code);

    merged.push(
      scrip
        ? { ...security, exchanges: ['NSE', 'BSE'], bseCode: scrip.code }
        : security,
    );
  }

  for (const scrip of bse) {
    if (matched.has(scrip.code)) continue;

    // A BSE ticker can collide with an unrelated NSE one — BSE's FOCUS is Focus
    // Business Solution, NSE's is Focus Lighting and Fixtures. `symbol` is the
    // key quotes are joined on, so the loser falls back to its scrip code, which
    // is numeric and therefore can never collide with an NSE symbol. Yahoo is
    // still queried by scrip id via `ticker`, so this only changes the label.
    const symbol = taken.has(scrip.id) ? scrip.code : scrip.id;
    taken.add(symbol);

    merged.push({
      symbol,
      name: scrip.name,
      series: scrip.group,
      isin: isUsableIsin(scrip.isin) ? scrip.isin : '',
      // BSE's scrip master carries neither listing date, paid-up value nor
      // market lot. Left null rather than faked — the columns render as "—".
      listingDate: null,
      faceValue: scrip.faceValue,
      paidUpValue: null,
      marketLot: null,
      exchanges: ['BSE'],
      ticker: toBseTicker(scrip.id),
      bseCode: scrip.code,
    });
  }

  return merged;
}

export const EXCHANGE_LABEL: Record<Exchange, string> = {
  NSE: 'National Stock Exchange',
  BSE: 'Bombay Stock Exchange',
};

/**
 * What the `series` column means, for both exchanges.
 *
 * NSE publishes a settlement *series* (EQ/BE/BZ); BSE publishes a settlement
 * *group* (A/B/X/…). They occupy the same column because they answer the same
 * question, but the vocabularies are disjoint — which is why the series filter
 * is built from the data rather than from a fixed list.
 *
 * Only the groups whose meaning is well established are described. The rest get
 * a generic label rather than an invented one: a wrong explanation of a
 * settlement group is worse than none, because it reads as authoritative.
 */
const SERIES_MEANING: Record<string, string> = {
  // NSE settlement series.
  EQ: 'NSE rolling settlement',
  BE: 'NSE trade-to-trade — delivery compulsory',
  BZ: 'NSE trade-to-trade, under surveillance',
  // BSE settlement groups.
  A: 'BSE Group A — rolling settlement, the most actively traded',
  B: 'BSE Group B — rolling settlement',
  T: 'BSE Group T — trade-to-trade, delivery compulsory',
  X: 'BSE Group X — rolling settlement, thinly traded',
  XT: 'BSE Group XT — trade-to-trade',
  Z: 'BSE Group Z — not compliant with the listing agreement',
  M: 'BSE SME platform',
  MT: 'BSE SME platform, trade-to-trade',
  MS: 'BSE SME platform',
  IP: 'BSE startup / innovators platform',
};

export function describeSeries(code: string): string {
  return SERIES_MEANING[code] ?? `BSE settlement group ${code}`;
}

/** NSE's three come first; BSE's groups follow alphabetically. */
const NSE_SERIES_ORDER = ['EQ', 'BE', 'BZ'];

export function compareSeries(a: string, b: string): number {
  const ia = NSE_SERIES_ORDER.indexOf(a);
  const ib = NSE_SERIES_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}
