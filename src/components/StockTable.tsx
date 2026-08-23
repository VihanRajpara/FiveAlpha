import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type PaginationState,
  type Row,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSignal } from '../hooks/useSignal';
import { CAP_SHORT, classRank } from '../lib/classification';
import { SelectMenu } from './SelectMenu';
import {
  formatCrore,
  formatDate,
  formatFromHigh,
  formatPercent,
  formatPrice,
  formatVolume,
} from '../lib/format';
import { UT_BOT, formatGap, scoreLabel, signalGapPct, type Signal } from '../lib/signals';
import type { ScreenResult } from '../lib/screens';
import type { Classification, SecurityWithQuote } from '../types';

/**
 * Three layouts, none of which scrolls sideways — a wall of thirteen columns
 * was the thing people couldn't read:
 *
 *  - `wide`   — # · Symbol · Company · Type · LTP · Chg% · Listed · Signal.
 *  - `medium` — Symbol · Company · LTP · Chg% · Signal.
 *  - `mobile` — abandons the grid entirely for stacked rows, with a sort
 *               control standing in for the clickable column headers.
 *
 * Everything cut (series, exchanges, ISIN, face value, prev close, rupee
 * change) is in the detail drawer, one click away on the row.
 */
type Layout = 'wide' | 'medium' | 'mobile';

/**
 * Row heights per layout — must track `--row-h`, which is set from these. The
 * mobile figure is only a floor: those rows size to their content (see
 * `virtualise`), and the CSS carries the same number as `min-height`.
 */
const ROW_HEIGHT: Record<Layout, number> = { wide: 48, medium: 48, mobile: 64 };

const NONE: Set<string> = new Set();

/**
 * Wide while screening: the four screen columns arrive and the two weakest
 * identity columns leave, so the table still fits without side-scrolling. On a
 * row that already passed a screen, why it passed beats what it is.
 */
const WIDE_HIDDEN_SCREENING = new Set(['segment', 'listingDate']);

/** `medium` keeps Symbol · Company · LTP · Chg% · Side · Gap. */
const MEDIUM_HIDDEN = new Set(['index', 'segment', 'listingDate', 'sigAt']);

/**
 * …and while screening adds the two screen legs that decide most rows,
 * dropping ROCE, market cap and the signal's gap to pay for them. The side and
 * its date stay: a screen shortlist with no verdict on it is half an answer.
 */
const MEDIUM_HIDDEN_SCREENING = new Set([
  ...MEDIUM_HIDDEN,
  'sigGap',
  'rocePct',
  'marketCapCr',
]);

const PAGE_SIZES = [25, 50, 100, 250];

const helper = createColumnHelper<SecurityWithQuote>();

/**
 * Explicit numeric comparator for every price column.
 *
 * Left to itself TanStack picks a comparator by sampling the first rows' values.
 * That inference is correct here today, but it depends on the top-of-list rows
 * happening to carry numbers — a batch of unpriced symbols at the head of the
 * data would yield `undefined` and could tip it to the alphanumeric comparator.
 * Stating the numeric one removes the guesswork; `sortUndefined: 'last'` then
 * parks unpriced rows at the bottom instead of treating them as zero.
 */
function numericSort(
  a: Row<SecurityWithQuote>,
  b: Row<SecurityWithQuote>,
  columnId: string,
): number {
  const av = a.getValue<number | undefined>(columnId);
  const bv = b.getValue<number | undefined>(columnId);
  if (av === undefined || Number.isNaN(av)) return bv === undefined ? 0 : 1;
  if (bv === undefined || Number.isNaN(bv)) return -1;
  return av - bv;
}

/**
 * A missing number means one of two different things, and they must not look
 * alike: before the quote pass finishes it means "not fetched yet" (shimmer),
 * and afterwards it means "this symbol has no price" (an em dash).
 *
 * The second case is not an edge case since BSE was added. Yahoo answers a
 * thinly traded scrip with a previous close but no traded bar for the session,
 * so `price`, `change` and `changePercent` stay null while `previousClose` has
 * a value — a row that shimmered in three columns forever while showing a
 * number in the fourth.
 */
function Missing({ loaded }: { loaded: boolean }) {
  return loaded ? <span className="num muted-dash">—</span> : <span className="skeleton" />;
}

function PriceCell({ value, loaded }: { value: number | null | undefined; loaded: boolean }) {
  if (value === null || value === undefined) return <Missing loaded={loaded} />;
  return <span className="num">{formatPrice(value)}</span>;
}

function ChevronIcon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const FIRST = 'M18 18 12 12l6-6M11 18 5 12l6-6';
const PREV = 'm15 18-6-6 6-6';
const NEXT = 'm9 18 6-6-6-6';
const LAST = 'm6 18 6-6-6-6M13 18l6-6-6-6';

/**
 * Symbol plus the two facts that used to own a column each.
 *
 * Both are marked only when they are the exception — most rows are NSE and
 * most are EQ, so badging those says nothing and costs a column of noise. The
 * full picture (series, both exchanges, ISIN, listing date, face value, prev
 * close) is a click away in the detail drawer.
 */
function SymbolCell({ row }: { row: SecurityWithQuote }) {
  return (
    <>
      {row.symbol}
      {!row.exchanges.includes('NSE') && <span className="badge exch exch-BSE">BSE</span>}
      {row.series !== 'EQ' && <span className={`badge ${row.series}`}>{row.series}</span>}
    </>
  );
}

/**
 * Segment + cap band. The F&O mark is the one that earns colour — it is the
 * distinction people scan for, and only ~200 of 2,400 rows carry it.
 */
function TypeCell({ cls }: { cls: Classification | undefined }) {
  if (!cls) return <span className="skeleton" />;
  return (
    <span className="type-cell">
      {cls.fno && <span className="badge fno">F&amp;O</span>}
      <span className={`badge cap cap-${cls.capBand}`}>{CAP_SHORT[cls.capBand]}</span>
    </span>
  );
}

/**
 * One screen number on a phone row: the figure carries the weight, the label
 * stays out of the way. Reading down a list of rows means comparing the
 * numbers, and a sentence of grey text made them all look the same.
 *
 * An unmeasured metric shows an em dash rather than disappearing. These sit in
 * fixed columns now, and a missing one that rendered nothing would shift the
 * two beside it — which is the alignment the columns exist for.
 */
function Metric({ label, value }: { label: string; value: string | undefined }) {
  return (
    <span className="metric">
      <b className={value === undefined ? 'num muted-dash' : 'num'}>{value ?? '—'}</b>
      {label}
    </span>
  );
}

/** The tonal up/down chip, shared by the grid cell and the mobile row. */
function ChangeChip({ value, loaded }: { value: number | null | undefined; loaded: boolean }) {
  if (value === null || value === undefined) return <Missing loaded={loaded} />;
  return (
    <span className={`chg-chip num ${value >= 0 ? 'up' : 'down'}`}>
      <span className="arrow" aria-hidden>
        {value >= 0 ? '▲' : '▼'}
      </span>
      {formatPercent(value)}
    </span>
  );
}

/**
 * The screen's numbers for one row, or a dash once the run has passed it by.
 *
 * A blank here is not the same absence as a missing price: the row was either
 * screened or it wasn't, and `screened` says which. While a run is in flight
 * most rows are simply not reached yet.
 */
function ScreenCell({
  value,
  screened,
  format,
  tone,
  approx,
}: {
  value: number | null | undefined;
  screened: boolean;
  format: (v: number) => string;
  tone?: 'up' | 'down' | null;
  /** See `ScreenResult.approx` — a bound from the scan pass, not a measured high. */
  approx?: boolean;
}) {
  if (value === null || value === undefined) {
    return screened ? <span className="num muted-dash">—</span> : <span className="skeleton" />;
  }
  return (
    <span
      className={`num${tone ? ` ${tone}` : ''}`}
      title={
        approx
          ? 'Approximate: measured against the highest monthly close rather than the true high, ' +
            'which the screen only pays for on rows it cannot otherwise decide. The real figure is this or lower.'
          : undefined
      }
    >
      {approx && '≈'}
      {format(value)}
    </span>
  );
}

/**
 * The UT-Bot-on-HMA verdict for one row: which way it flipped, the close that
 * flipped it, and when.
 *
 * A component rather than a value on the row because it fetches its own bars —
 * see `useSignal`. Daily bars, so "when" is a date; the study's intraday
 * opening-range leg is not part of this (see src/lib/signals.ts).
 */
/**
 * Everything behind the score, in one hover.
 *
 * A tooltip rather than more columns: the table already spends three tracks on
 * the signal, and these are the *reasons* for it — read once, when a row looks
 * interesting, not scanned down the page.
 */
function signalHint(signal: Signal): string {
  return [
    `Score ${signal.score} · ${scoreLabel(signal.score)}`,
    `UT Bot (ATR ${UT_BOT.atrPeriod} × ${UT_BOT.keyValue}) on HMA ${UT_BOT.hmaLength}, daily bars`,
    `${signal.side} at ${formatPrice(signal.price)} on ${formatDate(signal.date)}, ${
      signal.age === 0 ? 'today' : `${signal.age} bars ago`
    }`,
    `Flips back at ${formatPrice(signal.stop)}`,
    signal.trend === 0
      ? 'Trend unknown — short history'
      : signal.trend === 1
        ? 'With the 200-day trend'
        : 'Against the 200-day trend',
    signal.volumeRatio === null
      ? 'No volume reported'
      : `Flip volume ${signal.volumeRatio.toFixed(1)}× its 20-day average`,
    signal.turnover === null
      ? 'Turnover unknown'
      : `Turnover ₹${formatVolume(signal.turnover)} a day (20d median)`,
    signal.history
      ? `This rule here: ${signal.history.wins}/${signal.history.trades} won, avg ${formatGap(signal.history.avgPct)}`
      : 'Too few past flips to judge the rule on this name',
    signal.provisional ? 'Today’s bar is still open — this flip can reverse' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function SignalStrip({ ticker, price }: { ticker: string; price: number | null | undefined }) {
  const { signal, loaded } = useSignal(ticker);

  if (!loaded) {
    return (
      <div className="sig-strip">
        <span className="skeleton" />
      </div>
    );
  }

  // Stated rather than left blank. A row that simply stopped after the company
  // name read as a row still loading, which is a different thing entirely.
  if (!signal) return <div className="sig-strip muted">No signal in the last year</div>;

  const gap = signalGapPct(signal, price);
  return (
    <div className={`sig-strip ${signal.side === 'BUY' ? 'up' : 'down'}`}>
      <span className="sig-strip-head">
        <span className="sig-badge">{signal.side}</span>
        <span className="num">{formatPrice(signal.price)}</span>
        {gap !== null && (
          <span className={`num sig-strip-gap ${gap >= 0 ? 'up' : 'down'}`}>{formatGap(gap)}</span>
        )}
      </span>
      <span className="sig-strip-when">
        {/* Bars, not days: 20 sessions is a calendar month. The column used to
            print "20d" for both. */}
        {formatDate(signal.date)} ·{' '}
        {signal.age === 0 ? 'today' : `${signal.age} ${signal.age === 1 ? 'bar' : 'bars'}`} ·{' '}
        <span className="sig-score" title={signalHint(signal)}>
          {signal.score} {scoreLabel(signal.score)}
        </span>
        {signal.provisional && ' · live'}
      </span>
    </div>
  );
}

/**
 * The grid's three signal cells.
 *
 * Each calls `useSignal` for the same ticker, which looks like three fetches
 * and is one: the hook reads a shared day-cache and `fetchSignal` collapses
 * concurrent callers onto a single promise. Three subscriptions per row is the
 * price of three real columns, and it is cheaper than the truncation was.
 */
function SignalSide({ ticker }: { ticker: string }) {
  const { signal, loaded } = useSignal(ticker);
  if (!loaded) return <span className="skeleton" />;
  if (!signal) return <span className="num muted-dash">—</span>;

  return (
    <span
      className={`sig sig-inline ${signal.side === 'BUY' ? 'up' : 'down'}`}
      title={signalHint(signal)}
    >
      <span className="sig-badge">{signal.side}</span>
      {/* Date only. The age went with it into the tooltip: the date already
          says when, and "01 Jun 2026 · 596d" was two ways of saying one thing
          in a track that could hold neither. */}
      <span className="sig-when">{formatDate(signal.date)}</span>
      {/* Two digits, because a BUY against the trend on no volume is not the
          same row as a BUY with both, and the badge alone said they were. */}
      <span className={`sig-score ${signal.score >= 60 ? 'strong' : ''}`}>{signal.score}</span>
    </span>
  );
}

function SignalAt({ ticker }: { ticker: string }) {
  const { signal, loaded } = useSignal(ticker);
  if (!loaded) return <span className="skeleton" />;
  if (!signal) return <span className="num muted-dash">—</span>;
  return <span className="num">{formatPrice(signal.price)}</span>;
}

function SignalGap({ ticker, price }: { ticker: string; price: number | null | undefined }) {
  const { signal, loaded } = useSignal(ticker);
  if (!loaded) return <span className="skeleton" />;
  const gap = signal ? signalGapPct(signal, price) : null;
  if (gap === null) return <span className="num muted-dash">—</span>;
  return <span className={`num ${gap >= 0 ? 'up' : 'down'}`}>{formatGap(gap)}</span>;
}

interface Props {
  rows: SecurityWithQuote[];
  /** False until the first quote pass settles — see `Missing`. */
  quotesLoaded: boolean;
  /**
   * Screen output keyed by symbol, or null when no screen has been run. Its
   * presence is what adds the screen columns — the table has no opinion about
   * which screen produced them.
   */
  screenResults: Map<string, ScreenResult> | null;
  sorting: SortingState;
  onSortingChange: React.Dispatch<React.SetStateAction<SortingState>>;
  selectedSymbol: string | null;
  onSelect: (row: SecurityWithQuote) => void;
}

export function StockTable({
  rows,
  quotesLoaded,
  screenResults,
  sorting,
  onSortingChange,
  selectedSymbol,
  onSelect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const isMobile = useMediaQuery('(max-width: 700px)');
  const isMedium = useMediaQuery('(max-width: 1239px)');
  const layout: Layout = isMobile ? 'mobile' : isMedium ? 'medium' : 'wide';
  const rowHeight = ROW_HEIGHT[layout];

  /**
   * Only the desktop layouts virtualise.
   *
   * A phone has no room for a fixed-height shell with a scrolling panel inside
   * it — the chrome above the table eats the viewport and the panel is left
   * with a row and a half. So on mobile the page itself scrolls (see the
   * `max-width: 700px` block in index.css) and the list runs at its natural
   * length, which rules out a virtualiser measuring a scroll container that no
   * longer exists. A page is at most 250 stacked rows, which the DOM does not
   * notice.
   */
  const virtualise = layout !== 'mobile';

  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

  // Re-sorting or paging while scrolled halfway down would otherwise leave the
  // user in the middle of the new list, hiding the rows they just asked for.
  // On mobile the scroller is the page, so the list is scrolled back into view
  // instead — `scroll-margin-top` keeps it clear of the sticky sort bar. The
  // first run is skipped: on mobile it would scroll the header off screen
  // before the user has touched anything.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    if (virtualise) scrollRef.current?.scrollTo({ top: 0 });
    else scrollRef.current?.scrollIntoView({ block: 'start' });
  }, [sorting, pagination.pageIndex, virtualise]);

  // A new filter usually means a shorter list; staying on page 12 of what is
  // now a three-page result would show an empty table. Keyed on row count
  // rather than on `rows` itself, because a price refresh rebuilds that array
  // without changing which securities are listed — and being thrown back to
  // page 1 every time quotes land would be maddening.
  useEffect(() => {
    setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  }, [rows.length, sorting]);

  const columns = useMemo(
    () => [
      // Rendered from the virtual row position, not row.index — row.index is the
      // position in the unsorted data, which would jump around after sorting.
      helper.display({ id: 'index', header: '#', cell: () => null }),
      helper.accessor('symbol', {
        header: 'Symbol',
        cell: (ctx) => <SymbolCell row={ctx.row.original} />,
      }),
      helper.accessor('name', {
        header: 'Company',
      }),
      // Sorted on a rank rather than a label, so the order is F&O-first and then
      // largest-to-smallest instead of alphabetical.
      helper.accessor((r) => classRank(r.cls), {
        id: 'segment',
        header: 'Type',
        sortingFn: numericSort,
        cell: (ctx) => <TypeCell cls={ctx.row.original.cls} />,
      }),
      // `?? undefined` lets TanStack push symbols without a quote to the bottom
      // instead of sorting them as if they were priced at zero.
      helper.accessor((r) => r.quote?.price ?? undefined, {
        id: 'price',
        header: 'LTP',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => <PriceCell value={ctx.row.original.quote?.price} loaded={quotesLoaded} />,
      }),
      helper.accessor((r) => r.quote?.changePercent ?? undefined, {
        id: 'changePercent',
        header: 'Chg %',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => (
          <ChangeChip value={ctx.row.original.quote?.changePercent} loaded={quotesLoaded} />
        ),
      }),
      helper.accessor((r) => r.listingDate ?? undefined, {
        id: 'listingDate',
        header: 'Listed',
        sortUndefined: 'last',
        // Values are ISO `yyyy-mm-dd`, which already sorts correctly as text —
        // the numeric comparator would subtract two strings and yield NaN.
        sortingFn: 'text',
        cell: (ctx) => formatDate(ctx.row.original.listingDate),
      }),
      // Three columns under one heading, rather than one column holding three
      // numbers: at any width that fits the rest of the table, a badge plus a
      // price plus a percentage in a single track truncates the price, which is
      // the number the whole column exists for.
      //
      // None of them sorts: the values are fetched per visible cell, so the
      // table never holds the whole column and could only sort the part it has
      // seen.
      helper.group({
        id: 'signal',
        header: 'Signal',
        columns: [
          helper.display({
            id: 'sigSide',
            header: 'Side',
            cell: (ctx) => <SignalSide ticker={ctx.row.original.ticker} />,
          }),
          helper.display({
            id: 'sigAt',
            header: 'At',
            cell: (ctx) => <SignalAt ticker={ctx.row.original.ticker} />,
          }),
          helper.display({
            id: 'sigGap',
            header: 'Gap',
            cell: (ctx) => (
              <SignalGap
                ticker={ctx.row.original.ticker}
                price={ctx.row.original.quote?.price}
              />
            ),
          }),
        ],
      }),
      // The screen's own numbers, appended so they read as an extra section
      // rather than interleaving with the listing data. Present only while a
      // screen is loaded: four permanently empty columns would be worse than
      // none, and the widths in index.css are keyed on the same condition.
      ...(screenResults
        ? [
            helper.accessor((r) => screenResults.get(r.symbol)?.metrics.pctOfHigh ?? undefined, {
              id: 'pctOfHigh',
              header: 'vs 10Y high',
              sortUndefined: 'last',
              sortingFn: numericSort,
              cell: (ctx) => {
                const result = screenResults.get(ctx.row.original.symbol);
                return (
                  <ScreenCell
                    value={result?.metrics.pctOfHigh}
                    screened={result !== undefined}
                    format={formatFromHigh}
                    approx={result?.approx}
                    // Within 5% of a decade high is the thing being looked for;
                    // colouring it is the difference between a column of
                    // numbers and a column you can skim. Never on an approximate
                    // figure: those are bounds on rows the screen already
                    // rejected, and a green one would read as a near miss.
                    tone={
                      !result?.approx &&
                      result?.metrics.pctOfHigh !== undefined &&
                      result.metrics.pctOfHigh >= 95
                        ? 'up'
                        : null
                    }
                  />
                );
              },
            }),
            helper.accessor((r) => screenResults.get(r.symbol)?.metrics.monthlyRsi14 ?? undefined, {
              id: 'monthlyRsi14',
              header: 'RSI(M)',
              sortUndefined: 'last',
              sortingFn: numericSort,
              cell: (ctx) => {
                const result = screenResults.get(ctx.row.original.symbol);
                return (
                  <ScreenCell
                    value={result?.metrics.monthlyRsi14}
                    screened={result !== undefined}
                    format={(v) => v.toFixed(1)}
                  />
                );
              },
            }),
            helper.accessor((r) => screenResults.get(r.symbol)?.metrics.rocePct ?? undefined, {
              id: 'rocePct',
              header: 'ROCE',
              sortUndefined: 'last',
              sortingFn: numericSort,
              cell: (ctx) => {
                const result = screenResults.get(ctx.row.original.symbol);
                return (
                  <ScreenCell
                    value={result?.metrics.rocePct}
                    // Only rows that cleared the price and momentum legs are
                    // ever scraped, so an em dash here usually means "never
                    // asked", not "screener.in had nothing".
                    screened={result?.metrics.rocePct !== undefined}
                    format={(v) => `${v.toFixed(1)}%`}
                  />
                );
              },
            }),
            helper.accessor((r) => screenResults.get(r.symbol)?.metrics.marketCapCr ?? undefined, {
              id: 'marketCapCr',
              header: 'M.Cap ₹Cr',
              sortUndefined: 'last',
              sortingFn: numericSort,
              cell: (ctx) => {
                const result = screenResults.get(ctx.row.original.symbol);
                return (
                  <ScreenCell
                    value={result?.metrics.marketCapCr}
                    screened={result?.metrics.marketCapCr !== undefined}
                    format={formatCrore}
                  />
                );
              },
            }),
          ]
        : []),
    ],
    [quotesLoaded, screenResults],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, pagination },
    onSortingChange,
    onPaginationChange: setPagination,
    // Without this a third click clears sorting entirely, which reads as a bug
    // on a screener — cycle asc ↔ desc instead.
    enableSortingRemoval: false,
    // Page resets are handled above, deliberately narrower than TanStack's
    // default of resetting on any data change.
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const pageCount = table.getPageCount();

  // Belt and braces for any narrowing the row-count effect can't see (a filter
  // that happens to leave the same number of rows across a shorter list).
  useEffect(() => {
    if (pageCount > 0 && pagination.pageIndex > pageCount - 1) {
      setPagination((p) => ({ ...p, pageIndex: pageCount - 1 }));
    }
  }, [pageCount, pagination.pageIndex]);

  const total = rows.length;
  const firstOnPage = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const lastOnPage = Math.min(total, (pagination.pageIndex + 1) * pagination.pageSize);

  const virtualizer = useVirtualizer({
    // Zero on mobile: the rows are rendered in full there, and a virtualiser
    // with no scroll container of its own would measure nothing useful.
    count: virtualise ? tableRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Measured sizes are cached, so a breakpoint change has to invalidate them or
  // rows keep the previous layout's height and overlap.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const RIGHT_ALIGNED = new Set([
    'index',
    'price',
    'changePercent',
    'sigAt',
    'sigGap',
    'pctOfHigh',
    'monthlyRsi14',
    'rocePct',
    'marketCapCr',
  ]);

  // Column visibility is filtered at render rather than through TanStack's
  // visibility state, so hidden columns stay fully sortable from the mobile
  // sort control.
  const hidden =
    layout === 'medium'
      ? screenResults
        ? MEDIUM_HIDDEN_SCREENING
        : MEDIUM_HIDDEN
      : layout === 'wide' && screenResults
        ? WIDE_HIDDEN_SCREENING
        : NONE;
  const isVisible = (id: string) => !hidden.has(id);

  /**
   * The signal block's outer edges, so a hairline can run down both sides of it
   * through the header and the body. The heading alone was doing all the work
   * of saying "these belong together", from a long way above the numbers.
   */
  const visibleSignalIds = ['sigSide', 'sigAt', 'sigGap'].filter(isVisible);
  const groupEdge = (id: string) => {
    const edges = [];
    if (id === visibleSignalIds[0]) edges.push('group-start');
    if (id === visibleSignalIds.at(-1)) edges.push('group-end');
    return edges;
  };

  const cellClass = (id: string) => {
    const parts = ['td', ...groupEdge(id)];
    if (RIGHT_ALIGNED.has(id)) parts.push('right');
    if (id === 'index') parts.push('idx');
    else if (id === 'symbol') parts.push('sym');
    else if (id === 'name') parts.push('name');
    else if (id === 'listingDate') parts.push('muted');
    else if (id === 'sigSide') parts.push('sig-td');
    return parts.join(' ');
  };

  // The leaf columns, in the order they are laid out — the grid tracks are
  // numbered from this, and so is every header's placement below.
  const headers = table
    .getHeaderGroups()
    .at(-1)!
    .headers.filter((h) => isVisible(h.column.id));
  const leafIndex = new Map(headers.map((h, i) => [h.column.id, i]));

  // The header row doubles as the sort control on desktop; on mobile there is
  // no room for it, so sorting moves into an explicit select + direction pair.
  const sortableColumns = table
    .getAllLeafColumns()
    .filter((c) => c.id !== 'index' && c.getCanSort());
  const activeSort = sorting[0];

  /**
   * One row, in whichever shape the layout calls for.
   *
   * `pageOffset` is the row's position on the current page; the virtualised and
   * plain paths number rows the same way from it. `style` carries the
   * virtualiser's placement and is absent when the rows sit in normal flow.
   */
  function renderRow(
    row: Row<SecurityWithQuote>,
    pageOffset: number,
    style?: React.CSSProperties,
  ) {
    const result = screenResults?.get(row.original.symbol);
    // `key` is deliberately *not* in here. It is not a prop — React reads it
    // off the element before rendering — so spreading it warns and, in a list
    // this one virtualises, would be the one attribute that must not go
    // astray. It is passed explicitly at both call sites below.
    const shared = {
      'data-selected': row.original.symbol === selectedSymbol,
      // Only meaningful when the screen's non-matches are on show; the CSS dims
      // everything that isn't a pass so the matches stay findable in a mixed
      // list.
      'data-verdict': result?.verdict,
      title: result?.decidedBy ? `Fails: ${result.decidedBy.label}` : undefined,
      style,
      onClick: () => onSelect(row.original),
    };

    if (layout === 'mobile') {
      const q = row.original.quote;
      return (
        /**
         * Three bands down the card rather than two columns across it.
         *
         * The two-column shape put the price, the day's change and the whole
         * signal into a right-hand gutter about a third of the row wide, which
         * is what was cramming `+83.13% 774.25 BUY` onto one line. Stacked, each
         * band gets the full width: identity over price, name over change, then
         * the signal as its own strip, then the screen's numbers.
         */
        <div key={row.id} {...shared} className="tr row-stack">
          <div className="stack-line">
            <span className="stack-sym">
              <SymbolCell row={row.original} />
              {row.original.cls?.fno && <span className="badge fno">F&amp;O</span>}
            </span>
            <span className="stack-price num">
              {q?.price === null || q?.price === undefined ? (
                <Missing loaded={quotesLoaded} />
              ) : (
                formatPrice(q.price)
              )}
            </span>
          </div>

          <div className="stack-line">
            <span className="stack-name">{row.original.name}</span>
            <ChangeChip value={q?.changePercent} loaded={quotesLoaded} />
          </div>

          {/* The bottom band, on the same two rails as the lines above it: what
              the company *is* down the left, what it is doing today down the
              right. The screen's metrics join the symbol and name on the left;
              the signal joins the price and the day's change on the right. */}
          <div className="stack-foot">
            {result && (
              <span className="stack-screen">
                <Metric
                  label="10Y high"
                  value={`${result.approx ? '≈' : ''}${formatFromHigh(result.metrics.pctOfHigh)}`}
                />
                <Metric label="RSI" value={result.metrics.monthlyRsi14?.toFixed(0)} />
                <Metric
                  label="ROCE"
                  value={
                    result.metrics.rocePct === null || result.metrics.rocePct === undefined
                      ? undefined
                      : `${result.metrics.rocePct.toFixed(0)}%`
                  }
                />
              </span>
            )}

            <SignalStrip ticker={row.original.ticker} price={q?.price} />
          </div>
        </div>
      );
    }

    return (
      <div key={row.id} {...shared} className="tr grid-row">
        {row
          .getVisibleCells()
          .filter((cell) => isVisible(cell.column.id))
          .map((cell) => (
            <div key={cell.id} className={cellClass(cell.column.id)}>
              {cell.column.id === 'index'
                ? // Position in the whole result, not within the page.
                  pagination.pageIndex * pagination.pageSize + pageOffset + 1
                : flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          ))}
      </div>
    );
  }

  return (
    <>
      {layout === 'mobile' && (
        <div className="sortbar">
          <span className="sortbar-label">Sort</span>
          <SelectMenu
            ariaLabel="Sort column"
            value={activeSort?.id ?? 'symbol'}
            options={sortableColumns.map((c) => ({
              value: c.id,
              label: String(c.columnDef.header),
            }))}
            // Keep the current direction when switching column — re-picking
            // "descending" after every change would be busywork.
            onChange={(id) => onSortingChange((prev) => [{ id, desc: prev[0]?.desc ?? false }])}
          />
          <button
            type="button"
            className="dir"
            onClick={() =>
              onSortingChange((prev) =>
                prev.length === 0
                  ? [{ id: 'symbol', desc: true }]
                  : [{ id: prev[0].id, desc: !prev[0].desc }],
              )
            }
            aria-label={activeSort?.desc ? 'Sort ascending' : 'Sort descending'}
            title={activeSort?.desc ? 'Descending — tap for ascending' : 'Ascending — tap for descending'}
          >
            {activeSort?.desc ? '↓' : '↑'}
          </button>
        </div>
      )}

      <div
        className="table-wrap"
        data-layout={layout}
        // Widths differ once the screen columns are in, and the grid template
        // lives in CSS, so the condition has to be visible from there too.
        data-screen={screenResults ? 'true' : undefined}
        ref={scrollRef}
        style={{ '--row-h': `${rowHeight}px` } as React.CSSProperties}
      >
        {layout !== 'mobile' && (
          /**
           * Two header rows in one grid, not two stacked grids — a column with
           * no group heading has to span both rows, and `grid-row: span 2` only
           * spans rows of the grid it is in. Every cell is placed explicitly
           * from `leafIndex`, so auto-placement never has to guess around the
           * spans.
           */
          <div className="thead grid-row">
            {table.getHeaderGroups().flatMap((group, depth) =>
              group.headers.map((header) => {
                // A placeholder is the empty slot under an ungrouped column;
                // the column itself takes both rows instead.
                if (header.isPlaceholder) return null;

                const leaves = header
                  .getLeafHeaders()
                  .filter((leaf) => isVisible(leaf.column.id));
                const start = leaves.length > 0 ? leafIndex.get(leaves[0].column.id) : undefined;
                // Every leaf hidden at this layout — the heading has nothing
                // left to sit over.
                if (start === undefined) return null;

                const grouped = header.subHeaders.length > 0;
                const sorted = header.column.getIsSorted();
                const end = start + leaves.length;
                return (
                  <div
                    key={header.id}
                    className={[
                      'th',
                      RIGHT_ALIGNED.has(header.column.id) ? 'right' : '',
                      grouped ? 'th-group group-start group-end' : '',
                      // An ungrouped column has no label in the second row, so
                      // it takes both — sat on the same baseline as the ones
                      // that do, not floating in the middle of the band.
                      depth === 0 && !grouped ? 'th-span' : '',
                      ...(grouped ? [] : groupEdge(header.column.id)),
                      start === 0 ? 'edge-start' : '',
                      end === headers.length ? 'edge-end' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      gridColumn: `${start + 1} / span ${leaves.length}`,
                      gridRow: depth === 0 && !grouped ? '1 / span 2' : depth + 1,
                    }}
                    onClick={header.column.getToggleSortingHandler()}
                    title={
                      header.column.getCanSort()
                        ? `Sort by ${String(header.column.columnDef.header)}`
                        : // The signal columns are fetched per visible cell, so
                          // there is no full column to sort.
                          'UT Bot on HMA, daily bars'
                    }
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted && <span className="caret">{sorted === 'asc' ? '▲' : '▼'}</span>}
                  </div>
                );
              }),
            )}
          </div>
        )}

        <div className="tbody" style={virtualise ? { height: virtualizer.getTotalSize() } : undefined}>
          {virtualise
            ? virtualizer
                .getVirtualItems()
                .map((virtualRow) =>
                  renderRow(tableRows[virtualRow.index], virtualRow.index, {
                    transform: `translateY(${virtualRow.start}px)`,
                  }),
                )
            : tableRows.map((row, i) => renderRow(row, i))}
        </div>
      </div>

      <div className="pagebar">
        <div className="pagebar-group">
          <span className="pagebar-label">Rows per page</span>
          <SelectMenu
            ariaLabel="Rows per page"
            value={String(pagination.pageSize)}
            options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            // Changing page size mid-list has no sensible landing spot, so go
            // back to the top rather than guess.
            onChange={(v) => setPagination({ pageIndex: 0, pageSize: Number(v) })}
            minMenuWidth={96}
          />
        </div>

        <span className="num pagebar-range">
          {total === 0
            ? 'No matches'
            : `${firstOnPage.toLocaleString('en-IN')}–${lastOnPage.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}`}
        </span>

        <div className="pagebar-group">
          <button
            type="button"
            className="page-btn"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
            title="First page"
          >
            <ChevronIcon d={FIRST} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronIcon d={PREV} />
          </button>
          <span className="pagebar-page num">
            {pageCount === 0 ? '0 of 0' : `${pagination.pageIndex + 1} of ${pageCount.toLocaleString('en-IN')}`}
          </span>
          <button
            type="button"
            className="page-btn"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronIcon d={NEXT} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => table.setPageIndex(pageCount - 1)}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
            title="Last page"
          >
            <ChevronIcon d={LAST} />
          </button>
        </div>
      </div>
    </>
  );
}
