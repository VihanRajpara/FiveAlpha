import type { CapBand, SecurityWithQuote } from '../types';
import { MAPO_HIGH, MAPO_LOW, stopDistancePct, type Reading } from './signals';

/**
 * The Watchlists section's opening report: one pass over a hand-picked list,
 * answering the questions the table underneath can only answer by being read
 * row by row.
 *
 * It exists because a watchlist is the one list in this app small enough to
 * judge whole. The screener cannot do this — a signal is a chart request per
 * symbol, so 5,000 rows cannot all be read (see `SIGNAL_FILTER_MAX`) — but
 * twenty starred names can, which makes the stance of the list, its risk and
 * what changed since yesterday computable rather than something you scroll for.
 *
 * Pure, and takes its readings through a lookup rather than importing the
 * cache, so the arithmetic is checkable without a browser — see
 * scripts/check-report.mjs. Everything here is *counting*; the wording of each
 * count belongs to the component.
 */

/** Bars since the flip that still counts as news. Matches the '5' filter preset. */
export const FRESH_BARS = 5;

/** Rows the attention list will name. Past this it is the table, not a summary. */
export const ATTENTION_MAX = 6;

/** Names shown on each side of the movers panel. */
const MOVERS = 3;

/**
 * Why a row is worth looking at today, most urgent first.
 *
 * Ordered deliberately: `stop` is money at risk right now, `fresh` is a rule
 * that just changed its mind, and the rest are context. A row can qualify
 * several ways and is listed once, under the worst of them.
 */
export type AttentionKind = 'stop' | 'fresh' | 'screen' | 'hot' | 'cold';

const SEVERITY: Record<AttentionKind, number> = { stop: 0, fresh: 1, screen: 2, hot: 3, cold: 4 };

export interface Attention {
  row: SecurityWithQuote;
  kind: AttentionKind;
  /** The signal's side, where the reason has one. Lets the chip say BUY or SELL. */
  side: 'BUY' | 'SELL' | null;
}

export interface Report {
  count: number;
  /** How many carry a price at all — the denominator for every day figure. */
  priced: number;
  up: number;
  down: number;
  flat: number;
  /** Equal-weighted mean day move. No quantities are stored, so no other weighting is honest. */
  avgChangePct: number | null;
  /** How many rows have had their chart read. The signal figures are over these. */
  read: number;
  buy: number;
  sell: number;
  /** Read, but the rule has not flipped inside its window. */
  quiet: number;
  fresh: number;
  belowStop: number;
  avgScore: number | null;
  overbought: number;
  oversold: number;
  /** How many of the list the screen currently matches. */
  matches: number;
  gainers: SecurityWithQuote[];
  losers: SecurityWithQuote[];
  attention: Attention[];
  cap: Record<CapBand, number>;
  fno: number;
}

/** One symbol's place across the lists, and the rows behind them. */
export interface Grouped {
  /** Every symbol in every list, once, resolved to a row. The roll-up's universe. */
  union: SecurityWithQuote[];
  /** Which lists hold each symbol, in list order. Present even for symbols with no row. */
  memberOf: Map<string, string[]>;
  /** Symbols held, counted once however many lists hold them. */
  held: number;
  /** Filings — the same symbol in three lists is three. */
  filed: number;
  /** Each list's rows, in list order, for a report per list. */
  rowsOf: SecurityWithQuote[][];
}

/**
 * Flattens every watchlist against the market, once.
 *
 * The two halves of the report page disagree on purpose — the roll-up counts a
 * symbol once however many lists hold it, and the per-list cards count it in
 * each — so both numbers come from here rather than from two passes that could
 * drift apart. It is also what decides which charts get read, so a second
 * version of this in the caller would be a page reporting on symbols nothing
 * fetched.
 *
 * A symbol with no row yet (the market has not loaded, or it was delisted) is
 * still a filing and still a member: it is in the list, and a report that
 * silently forgot it would be the app losing something the user put there.
 */
export function groupLists(
  lists: { name: string; symbols: string[] }[],
  bySymbol: Map<string, SecurityWithQuote>,
): Grouped {
  const memberOf = new Map<string, string[]>();
  const union: SecurityWithQuote[] = [];
  const rowsOf: SecurityWithQuote[][] = [];
  let filed = 0;

  for (const list of lists) {
    const rows: SecurityWithQuote[] = [];
    for (const symbol of list.symbols) {
      filed++;
      const row = bySymbol.get(symbol);
      if (row) rows.push(row);

      const held = memberOf.get(symbol);
      if (held) {
        held.push(list.name);
        continue;
      }
      memberOf.set(symbol, [list.name]);
      if (row) union.push(row);
    }
    rowsOf.push(rows);
  }

  return { union, memberOf, held: memberOf.size, filed, rowsOf };
}

const chgOf = (row: SecurityWithQuote): number | null => row.quote?.changePercent ?? null;

export function buildReport(
  rows: SecurityWithQuote[],
  read: (ticker: string) => Reading | undefined,
  matchSymbols: Set<string>,
): Report {
  const cap: Record<CapBand, number> = { large: 0, mid: 0, small: 0, micro: 0 };
  const attention: Attention[] = [];
  let priced = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  let sumChg = 0;
  let readCount = 0;
  let buy = 0;
  let sell = 0;
  let quiet = 0;
  let fresh = 0;
  let belowStop = 0;
  let scoreSum = 0;
  let scoreN = 0;
  let overbought = 0;
  let oversold = 0;
  let matches = 0;
  let fno = 0;

  for (const row of rows) {
    const chg = chgOf(row);
    if (chg !== null) {
      priced++;
      sumChg += chg;
      if (chg > 0) up++;
      else if (chg < 0) down++;
      else flat++;
    }

    if (row.cls) {
      cap[row.cls.capBand]++;
      if (row.cls.fno) fno++;
    }

    const matched = matchSymbols.has(row.symbol);
    if (matched) matches++;

    const reading = read(row.ticker);
    if (reading === undefined) continue;
    readCount++;

    const { signal, mapo } = reading;
    const hot = mapo !== null && mapo.above >= MAPO_HIGH;
    const cold = mapo !== null && mapo.above <= MAPO_LOW;
    if (hot) overbought++;
    if (cold) oversold++;

    if (signal === null) {
      quiet++;
    } else {
      if (signal.side === 'BUY') buy++;
      else sell++;
      scoreSum += signal.score;
      scoreN++;
    }

    // A stop already crossed outranks a flip that is merely recent: one is the
    // rule about to reverse, the other is the rule working.
    const room = signal ? stopDistancePct(signal, row.quote?.price) : null;
    const crossed = room !== null && room < 0;
    if (crossed) belowStop++;
    if (signal !== null && signal.age <= FRESH_BARS) fresh++;

    const kind: AttentionKind | null = crossed
      ? 'stop'
      : signal !== null && signal.age <= FRESH_BARS
        ? 'fresh'
        : matched
          ? 'screen'
          : hot
            ? 'hot'
            : cold
              ? 'cold'
              : null;
    if (kind !== null) attention.push({ row, kind, side: signal?.side ?? null });
  }

  // Severity decides the order; the day's move breaks ties, so equally urgent
  // rows arrive with the one that has actually moved at the top.
  attention.sort(
    (a, b) =>
      SEVERITY[a.kind] - SEVERITY[b.kind] ||
      Math.abs(chgOf(b.row) ?? 0) - Math.abs(chgOf(a.row) ?? 0) ||
      a.row.symbol.localeCompare(b.row.symbol),
  );

  const moved = rows.filter((r) => chgOf(r) !== null);
  const byMove = [...moved].sort((a, b) => (chgOf(b) ?? 0) - (chgOf(a) ?? 0));
  const gainers = byMove.filter((r) => (chgOf(r) ?? 0) > 0).slice(0, MOVERS);
  const losers = byMove
    .filter((r) => (chgOf(r) ?? 0) < 0)
    .slice(-MOVERS)
    .reverse();

  return {
    count: rows.length,
    priced,
    up,
    down,
    flat,
    avgChangePct: priced === 0 ? null : sumChg / priced,
    read: readCount,
    buy,
    sell,
    quiet,
    fresh,
    belowStop,
    avgScore: scoreN === 0 ? null : scoreSum / scoreN,
    overbought,
    oversold,
    matches,
    gainers,
    losers,
    attention: attention.slice(0, ATTENTION_MAX),
    cap,
    fno,
  };
}
