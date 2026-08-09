import { useEffect, useMemo, useRef } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Row,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDate, formatPercent, formatPrice } from '../lib/format';
import type { SecurityWithQuote } from '../types';

const ROW_HEIGHT = 40;

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

/** Renders a price cell, or a shimmer while that symbol's quote is still in flight. */
function PriceCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="skeleton" />;
  return <span className="num">{formatPrice(value)}</span>;
}

interface Props {
  rows: SecurityWithQuote[];
  sorting: SortingState;
  onSortingChange: React.Dispatch<React.SetStateAction<SortingState>>;
  selectedSymbol: string | null;
  onSelect: (row: SecurityWithQuote) => void;
}

export function StockTable({ rows, sorting, onSortingChange, selectedSymbol, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-sorting while scrolled halfway down would otherwise leave the user in the
  // middle of the new order, hiding the rows they just sorted for.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sorting]);

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
      // `?? undefined` lets TanStack push symbols without a quote to the bottom
      // instead of sorting them as if they were priced at zero.
      helper.accessor((r) => r.quote?.price ?? undefined, {
        id: 'price',
        header: 'LTP',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => <PriceCell value={ctx.row.original.quote?.price} />,
      }),
      helper.accessor((r) => r.quote?.change ?? undefined, {
        id: 'change',
        header: 'Chg',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => {
          const v = ctx.row.original.quote?.change;
          if (v === null || v === undefined) return <span className="skeleton" />;
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
        cell: (ctx) => {
          const v = ctx.row.original.quote?.changePercent;
          if (v === null || v === undefined) return <span className="skeleton" />;
          return (
            <span className={`chg-chip num ${v >= 0 ? 'up' : 'down'}`}>{formatPercent(v)}</span>
          );
        },
      }),
      helper.accessor((r) => r.quote?.previousClose ?? undefined, {
        id: 'previousClose',
        header: 'Prev close',
        sortUndefined: 'last',
        sortingFn: numericSort,
        cell: (ctx) => <PriceCell value={ctx.row.original.quote?.previousClose} />,
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
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange,
    // Without this a third click clears sorting entirely, which reads as a bug
    // on a screener — cycle asc ↔ desc instead.
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const RIGHT_ALIGNED = new Set([
    'index',
    'price',
    'change',
    'changePercent',
    'previousClose',
    'faceValue',
  ]);

  const cellClass = (id: string) => {
    const align = RIGHT_ALIGNED.has(id) ? ' right' : '';
    if (id === 'index') return `td idx${align}`;
    if (id === 'symbol') return 'td sym';
    if (id === 'name') return 'td name';
    if (id === 'isin' || id === 'listingDate') return 'td muted';
    return `td${align}`;
  };

  return (
    <div className="table-wrap" ref={scrollRef}>
      <div className="thead grid-row">
        {table.getHeaderGroups()[0].headers.map((header) => {
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

      <div className="tbody" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = tableRows[virtualRow.index];
          return (
            <div
              key={row.id}
              className="tr grid-row"
              data-selected={row.original.symbol === selectedSymbol}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              onClick={() => onSelect(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <div key={cell.id} className={cellClass(cell.column.id)}>
                  {cell.column.id === 'index'
                    ? virtualRow.index + 1
                    : flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
