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
import { CAP_SHORT, classRank } from '../lib/classification';
import { ExchangeBadges } from './ExchangeBadges';
import { SelectMenu } from './SelectMenu';
import { formatCrore, formatDate, formatFromHigh, formatPercent, formatPrice } from '../lib/format';
import type { ScreenResult } from '../lib/screens';
import type { Classification, SecurityWithQuote } from '../types';

/**
 * Three layouts, because a 1,200px-wide screener is unusable on a phone:
 *
 *  - `wide`   — every column, horizontally scrollable.
 *  - `medium` — the seven columns worth having when the viewport can't hold
 *               thirteen; no horizontal scroll.
 *  - `mobile` — abandons the grid entirely for stacked rows, with a sort
 *               control standing in for the clickable column headers.
 */
type Layout = 'wide' | 'medium' | 'mobile';

/** Row heights per layout — must track `--row-h`, which is set from these. */
const ROW_HEIGHT: Record<Layout, number> = { wide: 48, medium: 48, mobile: 68 };

/**
 * A phone row has no columns to put the screen's numbers in, so they go on a
 * third line under the company name — which the row has to grow to hold. The
 * virtualiser positions rows by this number, so it cannot be left to the CSS.
 */
const MOBILE_SCREEN_ROW_HEIGHT = 86;

/**
 * Columns dropped in `medium`, in priority order of what matters least. `series`
 * goes too: at this width there is room for two classification columns, and
 * segment/cap plus exchange say more about a stock than EQ-vs-BE does. `exchange`
 * survives because it is the one column that distinguishes the ~2,800 BSE-only
 * rows from everything else.
 */
const MEDIUM_HIDDEN = new Set([
  'index',
  'series',
  'previousClose',
  'isin',
  'listingDate',
  'faceValue',
]);

/**
 * With a screen running there are four more columns and the same width to put
 * them in, so `medium` gives up more of the identity columns: what a row is
 * matters less than why it passed. What survives is Symbol · Company · LTP ·
 * Chg% · vs 10Y high · RSI(M) — the two screen columns that decide most rows.
 * ROCE and market cap fall away here and stay in the drawer; they are the legs
 * least likely to be the interesting one on a row that already passed.
 */
const MEDIUM_HIDDEN_SCREENING = new Set([
  ...MEDIUM_HIDDEN,
  'exchange',
  'segment',
  'change',
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
}: {
  value: number | null | undefined;
  screened: boolean;
  format: (v: number) => string;
  tone?: 'up' | 'down' | null;
}) {
  if (value === null || value === undefined) {
    return screened ? <span className="num muted-dash">—</span> : <span className="skeleton" />;
  }
  return <span className={`num${tone ? ` ${tone}` : ''}`}>{format(value)}</span>;
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
  const rowHeight =
    layout === 'mobile' && screenResults ? MOBILE_SCREEN_ROW_HEIGHT : ROW_HEIGHT[layout];

  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

  // Re-sorting or paging while scrolled halfway down would otherwise leave the
  // user in the middle of the new list, hiding the rows they just asked for.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sorting, pagination.pageIndex]);

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
        cell: (ctx) => ctx.getValue(),
      }),
      helper.accessor('name', {
        header: 'Company',
      }),
      helper.accessor('series', {
        header: 'Series',
        cell: (ctx) => <span className={`badge ${ctx.getValue()}`}>{ctx.getValue()}</span>,
      }),
      // Sorted on the joined string, which puts BSE-only rows in their own block
      // ("BSE" < "NSE,BSE") rather than interleaving them alphabetically.
      helper.accessor((r) => r.exchanges.join(','), {
        id: 'exchange',
        header: 'Exch',
        cell: (ctx) => <ExchangeBadges exchanges={ctx.row.original.exchanges} />,
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
      helper.accessor((r) => r.quote?.change ?? undefined, {
        id: 'change',
        header: 'Chg',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => {
          const v = ctx.row.original.quote?.change;
          if (v === null || v === undefined) return <Missing loaded={quotesLoaded} />;
          return (
            <span className={`num ${v >= 0 ? 'up' : 'down'}`}>
              {v >= 0 ? '+' : ''}
              {v.toFixed(2)}
            </span>
          );
        },
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
      helper.accessor((r) => r.quote?.previousClose ?? undefined, {
        id: 'previousClose',
        header: 'Prev close',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => (
          <PriceCell value={ctx.row.original.quote?.previousClose} loaded={quotesLoaded} />
        ),
      }),
      helper.accessor('isin', {
        header: 'ISIN',
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
      helper.accessor((r) => r.faceValue ?? undefined, {
        id: 'faceValue',
        header: 'FV',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => <span className="num">{ctx.row.original.faceValue ?? '—'}</span>,
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
                    // Within 5% of a decade high is the thing being looked for;
                    // colouring it is the difference between a column of
                    // numbers and a column you can skim.
                    tone={
                      result?.metrics.pctOfHigh !== undefined && result.metrics.pctOfHigh >= 95
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
    count: tableRows.length,
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
    'change',
    'changePercent',
    'previousClose',
    'faceValue',
    'pctOfHigh',
    'monthlyRsi14',
    'rocePct',
    'marketCapCr',
  ]);

  // Column visibility is filtered at render rather than through TanStack's
  // visibility state, so hidden columns stay fully sortable from the mobile
  // sort control.
  const mediumHidden = screenResults ? MEDIUM_HIDDEN_SCREENING : MEDIUM_HIDDEN;
  const isVisible = (id: string) => layout !== 'medium' || !mediumHidden.has(id);

  const cellClass = (id: string) => {
    const align = RIGHT_ALIGNED.has(id) ? ' right' : '';
    if (id === 'index') return `td idx${align}`;
    if (id === 'symbol') return 'td sym';
    if (id === 'name') return 'td name';
    if (id === 'isin' || id === 'listingDate') return 'td muted';
    if (id === 'exchange') return 'td exch';
    return `td${align}`;
  };

  const headers = table.getHeaderGroups()[0].headers.filter((h) => isVisible(h.column.id));

  // The header row doubles as the sort control on desktop; on mobile there is
  // no room for it, so sorting moves into an explicit select + direction pair.
  const sortableColumns = table
    .getAllLeafColumns()
    .filter((c) => c.id !== 'index' && c.getCanSort());
  const activeSort = sorting[0];

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
          <div className="thead grid-row">
            {headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <div
                  key={header.id}
                  className={`th${RIGHT_ALIGNED.has(header.column.id) ? ' right' : ''}`}
                  onClick={header.column.getToggleSortingHandler()}
                  title={`Sort by ${String(header.column.columnDef.header)}`}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {sorted && <span className="caret">{sorted === 'asc' ? '▲' : '▼'}</span>}
                </div>
              );
            })}
          </div>
        )}

        <div className="tbody" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            const result = screenResults?.get(row.original.symbol);
            const shared = {
              key: row.id,
              'data-selected': row.original.symbol === selectedSymbol,
              // Only meaningful when the screen's non-matches are on show; the
              // CSS dims everything that isn't a pass so the matches stay
              // findable in a mixed list.
              'data-verdict': result?.verdict,
              title: result?.decidedBy ? `Fails: ${result.decidedBy.label}` : undefined,
              style: { transform: `translateY(${virtualRow.start}px)` },
              onClick: () => onSelect(row.original),
            };

            if (layout === 'mobile') {
              const q = row.original.quote;
              return (
                <div {...shared} className="tr row-stack">
                  <div className="stack-main">
                    <span className="stack-sym">
                      {row.original.symbol}
                      {row.original.cls?.fno && <span className="badge fno">F&amp;O</span>}
                      {/* Only the exception is worth a badge here — a phone row
                          has space for three chips at most, and most rows are on
                          NSE, so marking those says nothing. */}
                      {!row.original.exchanges.includes('NSE') && (
                        <span className="badge exch exch-BSE">BSE</span>
                      )}
                      <span className={`badge ${row.original.series}`}>{row.original.series}</span>
                    </span>
                    <span className="stack-name">{row.original.name}</span>
                    {result && (
                      <span className="stack-screen num">
                        {formatFromHigh(result.metrics.pctOfHigh)} from 10Y high
                        {result.metrics.monthlyRsi14 !== null &&
                          result.metrics.monthlyRsi14 !== undefined &&
                          ` · RSI ${result.metrics.monthlyRsi14.toFixed(0)}`}
                        {result.metrics.rocePct !== null &&
                          result.metrics.rocePct !== undefined &&
                          ` · ROCE ${result.metrics.rocePct.toFixed(0)}%`}
                      </span>
                    )}
                  </div>
                  <div className="stack-side">
                    <span className="stack-price num">
                      {q?.price === null || q?.price === undefined ? (
                        <Missing loaded={quotesLoaded} />
                      ) : (
                        formatPrice(q.price)
                      )}
                    </span>
                    <ChangeChip value={q?.changePercent} loaded={quotesLoaded} />
                  </div>
                </div>
              );
            }

            return (
              <div {...shared} className="tr grid-row">
                {row
                  .getVisibleCells()
                  .filter((cell) => isVisible(cell.column.id))
                  .map((cell) => (
                    <div key={cell.id} className={cellClass(cell.column.id)}>
                      {cell.column.id === 'index'
                        ? // Position in the whole result, not within the page.
                          pagination.pageIndex * pagination.pageSize + virtualRow.index + 1
                        : flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
              </div>
            );
          })}
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
