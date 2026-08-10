import { useEffect, useMemo, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { StockTable } from './components/StockTable';
import { StockDetail } from './components/StockDetail';
import { ThemeToggle } from './components/ThemeToggle';
import { Filters, type FilterGroupSpec } from './components/Filters';
import { useMarketData } from './hooks/useMarketData';
import { formatAge, formatIstDateTime, isMarketOpen } from './lib/format';
import { UNCLASSIFIED } from './lib/classification';
import { compareSeries, describeSeries } from './lib/listings';
import type { CapBand, SecurityWithQuote } from './types';

/** Prices older than this during a live session are worth flagging. */
const STALE_AFTER_MS = 15 * 60 * 1000;

const EXCHANGE_FILTERS = ['ALL', 'NSE', 'BSE', 'BSE_ONLY'] as const;
type ExchangeFilter = (typeof EXCHANGE_FILTERS)[number];

const EXCHANGE_LABEL: Record<ExchangeFilter, string> = {
  ALL: 'All',
  NSE: 'NSE',
  BSE: 'BSE',
  BSE_ONLY: 'BSE only',
};

const EXCHANGE_HINT: Record<ExchangeFilter, string> = {
  ALL: 'Both exchanges',
  NSE: 'Listed on NSE (may also be on BSE)',
  BSE: 'Listed on BSE (may also be on NSE)',
  BSE_ONLY: 'On BSE and not on NSE',
};

const SEGMENT_FILTERS = ['ALL', 'FNO', 'CASH'] as const;
type SegmentFilter = (typeof SEGMENT_FILTERS)[number];

const SEGMENT_LABEL: Record<SegmentFilter, string> = {
  ALL: 'All',
  FNO: 'F&O',
  CASH: 'Cash only',
};

const SEGMENT_HINT: Record<SegmentFilter, string> = {
  ALL: 'Both segments',
  FNO: 'Futures & options available on this underlying',
  CASH: 'No listed derivatives — cash market only',
};

// `satisfies` ties these to CapBand, so a typo here fails the build rather than
// silently matching no rows.
const CAP_FILTERS = ['ALL', 'large', 'mid', 'small', 'micro'] as const satisfies readonly (
  | 'ALL'
  | CapBand
)[];
type CapFilter = (typeof CAP_FILTERS)[number];

const CAP_FILTER_LABEL: Record<CapFilter, string> = {
  ALL: 'All',
  large: 'Large',
  mid: 'Mid',
  small: 'Small',
  micro: 'Micro',
};

const CAP_FILTER_HINT: Record<CapFilter, string> = {
  ALL: 'Every cap band',
  large: 'NIFTY 100 constituents',
  mid: 'NIFTY Midcap 150 constituents',
  small: 'NIFTY Smallcap 250 constituents',
  micro: 'Outside the NIFTY 500',
};

export default function App() {
  const {
    securities,
    quotes,
    classification,
    classificationReady,
    loading,
    quoteProgress,
    quotesLoaded,
    refreshingQuotes,
    error,
    lastFetchedAt,
    dataAsOf,
    refreshQuotes,
    sourceKind,
  } = useMarketData();

  // Re-render every 30s so the "12 min ago" label ages by itself rather than
  // freezing at whatever it read when the quotes landed.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [search, setSearch] = useState('');
  const [exchange, setExchange] = useState<ExchangeFilter>('ALL');
  // Not a closed union any more: the available series depend on which exchange
  // is selected, and BSE's group letters are data, not a list we can enumerate.
  const [series, setSeries] = useState<string>('ALL');
  const [segment, setSegment] = useState<SegmentFilter>('ALL');
  const [cap, setCap] = useState<CapFilter>('ALL');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'symbol', desc: false }]);
  const [selected, setSelected] = useState<SecurityWithQuote | null>(null);

  const joined = useMemo<SecurityWithQuote[]>(
    () =>
      securities.map((s) => ({
        ...s,
        quote: quotes.get(s.symbol),
        // Absence from both NSE lists is itself the answer — cash-only, outside
        // the NIFTY 500 — so unmatched symbols get the default rather than
        // undefined. Before the lists land, `cls` is left undefined so the UI
        // can tell "not classified yet" from "classified as micro/cash".
        cls: classificationReady ? classification.get(s.symbol) ?? UNCLASSIFIED : undefined,
      })),
    [securities, quotes, classification, classificationReady],
  );

  /**
   * Everything the exchange filter admits, before the other filters run.
   *
   * Split out because the series options are derived from it: NSE publishes
   * EQ/BE/BZ and BSE publishes A/B/X/XT/T/Z/M/…, and which vocabulary applies
   * depends entirely on the exchange selection. Offering the union would put
   * fourteen chips on screen that match nothing for the current exchange.
   */
  const exchangeRows = useMemo(
    () =>
      joined.filter((row) => {
        if (exchange === 'NSE') return row.exchanges.includes('NSE');
        if (exchange === 'BSE') return row.exchanges.includes('BSE');
        if (exchange === 'BSE_ONLY') return !row.exchanges.includes('NSE');
        return true;
      }),
    [joined, exchange],
  );

  /** Series present in the current exchange selection, with their row counts. */
  const seriesOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of exchangeRows) {
      if (row.series) counts.set(row.series, (counts.get(row.series) ?? 0) + 1);
    }

    return [
      { value: 'ALL', label: 'All', hint: 'Every settlement series and group' },
      ...[...counts.keys()].sort(compareSeries).map((code) => ({
        value: code,
        label: code,
        hint: `${describeSeries(code)} · ${counts.get(code)!.toLocaleString('en-IN')}`,
      })),
    ];
  }, [exchangeRows]);

  // Switching exchange can retire the selected series — picking EQ and then
  // "BSE only" would otherwise leave a filter applied that matches nothing, and
  // an empty table with no visible cause.
  useEffect(() => {
    if (series !== 'ALL' && !seriesOptions.some((o) => o.value === series)) setSeries('ALL');
  }, [seriesOptions, series]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exchangeRows.filter((row) => {
      if (series !== 'ALL' && row.series !== series) return false;
      if (segment !== 'ALL' && (row.cls?.fno ?? false) !== (segment === 'FNO')) return false;
      if (cap !== 'ALL' && row.cls?.capBand !== cap) return false;
      if (q === '') return true;
      return (
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.isin.toLowerCase().includes(q) ||
        // BSE-only names are far better known by scrip code than by ticker.
        (row.bseCode?.includes(q) ?? false)
      );
    });
  }, [exchangeRows, search, series, segment, cap]);

  /**
   * One description of the filters, rendered as inline chips on wide screens
   * and as a sheet on narrow ones. Keeping it in a single place is what stops
   * the two layouts diverging as filters get added.
   */
  const filterGroups = useMemo<FilterGroupSpec[]>(
    () => [
      // First, because it is the widest cut: it decides whether you are looking
      // at ~2,400 NSE rows or all ~5,200.
      {
        key: 'exchange',
        label: 'Exchange',
        value: exchange,
        options: EXCHANGE_FILTERS.map((e) => ({
          value: e,
          label: EXCHANGE_LABEL[e],
          hint: EXCHANGE_HINT[e],
        })),
        onChange: (v) => setExchange(v as ExchangeFilter),
      },
      {
        key: 'series',
        label: 'Series',
        value: series,
        options: seriesOptions,
        onChange: setSeries,
      },
      // Segment and cap read from the NSE lists, so they stay disabled until
      // those land — offering an "F&O" filter that matches nothing would look
      // like the app had lost the data.
      {
        key: 'segment',
        label: 'Segment',
        value: segment,
        disabled: !classificationReady,
        options: SEGMENT_FILTERS.map((s) => ({
          value: s,
          label: SEGMENT_LABEL[s],
          hint: SEGMENT_HINT[s],
        })),
        onChange: (v) => setSegment(v as SegmentFilter),
      },
      {
        key: 'cap',
        label: 'Cap',
        value: cap,
        disabled: !classificationReady,
        options: CAP_FILTERS.map((c) => ({
          value: c,
          label: CAP_FILTER_LABEL[c],
          hint: CAP_FILTER_HINT[c],
        })),
        onChange: (v) => setCap(v as CapFilter),
      },
    ],
    [exchange, series, seriesOptions, segment, cap, classificationReady],
  );

  const breadth = useMemo(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const row of rows) {
      const c = row.quote?.change;
      if (c === null || c === undefined) continue;
      if (c > 0) up++;
      else if (c < 0) down++;
      else flat++;
    }
    return { up, down, flat, priced: up + down + flat };
  }, [rows]);

  // Honest about which lists actually loaded: if BSE's API was unreachable the
  // merge falls back to NSE alone, and the header should say so rather than
  // claim coverage the table doesn't have.
  const listedOn = useMemo(
    () => (securities.some((s) => s.exchanges.includes('BSE')) ? 'NSE + BSE' : 'NSE'),
    [securities],
  );

  const marketOpen = isMarketOpen(now);

  // Only worth flagging during a live session — outside market hours prices are
  // *supposed* to be hours old, and shouting about it would be noise.
  const stale =
    marketOpen && dataAsOf !== null && now.getTime() - dataAsOf.getTime() > STALE_AFTER_MS;

  // PostgREST answers PGRST205 ("Could not find the table … in the schema cache")
  // when the migration hasn't been run — worth calling out by name, because the
  // raw message reads like a bug rather than a missing setup step.
  const missingTable = /schema cache|PGRST205/i.test(error ?? '');

  // Keep the drawer showing live prices as refreshes land.
  const selectedRow = selected ? joined.find((r) => r.symbol === selected.symbol) ?? selected : null;

  const pct = (n: number) =>
    breadth.priced === 0 ? '—' : `${Math.round((n / breadth.priced) * 100)}% of priced`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {/* Same three ascending bars as the favicon — the tab and the header
              should be recognisably the same mark. */}
          <span className="logo" aria-hidden>
            <svg width="19" height="19" viewBox="0 0 100 100" fill="currentColor">
              <rect x="8" y="56" width="20" height="26" rx="4.5" />
              <rect x="40" y="38" width="20" height="44" rx="4.5" />
              <rect x="72" y="18" width="20" height="64" rx="4.5" />
            </svg>
          </span>
          <div>
            <h1>FiveAlpha</h1>
            <span className="count num">
              {loading
                ? 'Loading…'
                : `${listedOn} · ${rows.length.toLocaleString('en-IN')} of ${securities.length.toLocaleString('en-IN')} companies`}
            </span>
          </div>
        </div>

        <div className="spacer" />

        <div className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol, company or ISIN"
            aria-label="Search shares"
          />
        </div>

        <div className="spacer" />

        <ThemeToggle />

        {/* Named for what it actually does. In Supabase mode this re-reads the
            quotes table — it does not fetch from Yahoo, so it cannot make
            prices newer than whatever last wrote to the table. */}
        <button
          className="btn"
          onClick={refreshQuotes}
          disabled={refreshingQuotes || loading}
          title={
            sourceKind === 'supabase'
              ? 'Re-reads the quotes table. New prices only arrive when sync-quotes or npm run seed:quotes writes them.'
              : 'Fetches current prices from Yahoo Finance (~15 min delayed).'
          }
        >
          {refreshingQuotes
            ? sourceKind === 'supabase'
              ? 'Reloading…'
              : 'Refreshing…'
            : sourceKind === 'supabase'
              ? 'Reload from DB'
              : 'Refresh prices'}
        </button>
      </header>

      <div className="subbar">
        <Filters groups={filterGroups} resultCount={rows.length} />
      </div>

      {/* Breadth across whatever the current filter selects — the closest thing
          this dataset has to a market summary. */}
      <section className="summary" aria-label="Market breadth">
        <div className="stat">
          <div className="stat-label">Advancing</div>
          <div className="stat-value num up">{breadth.up.toLocaleString('en-IN')}</div>
          <div className="stat-sub">{pct(breadth.up)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Declining</div>
          <div className="stat-value num down">{breadth.down.toLocaleString('en-IN')}</div>
          <div className="stat-sub">{pct(breadth.down)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unchanged</div>
          <div className="stat-value num">{breadth.flat.toLocaleString('en-IN')}</div>
          <div className="stat-sub">{pct(breadth.flat)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Priced</div>
          <div className="stat-value num">{breadth.priced.toLocaleString('en-IN')}</div>
          <div className="stat-sub">of {rows.length.toLocaleString('en-IN')} shown</div>
        </div>
      </section>

      <main className="content">
        <div className="card">
          {loading ? (
            <div className="center-msg" style={{ flex: 1 }}>
              <div className="spinner" />
              <strong>Fetching the NSE and BSE equity lists…</strong>
              <span>
                {sourceKind === 'supabase'
                  ? 'Reading the securities table from Supabase.'
                  : 'Reading EQUITY_L.csv from NSE archives and the scrip master from BSE.'}
              </span>
            </div>
          ) : error && securities.length === 0 ? (
            <div className="center-msg" style={{ flex: 1 }}>
              <strong>Couldn’t load the equity list</strong>
              <span>{error}</span>
              {/* The fix differs entirely by mode, and in Supabase mode the most
                  common cause by far is that the migration hasn't been run yet. */}
              {sourceKind === 'supabase' ? (
                missingTable ? (
                  <span>
                    The tables don’t exist yet. Paste{' '}
                    <code>supabase/migrations/0001_init.sql</code> into the Supabase SQL Editor and
                    run it, then seed with <code>npm run seed</code>.
                  </span>
                ) : (
                  <span>
                    Check <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>{' '}
                    in <code>.env</code>, and that the read policies from <code>0001_init.sql</code>{' '}
                    were applied.
                  </span>
                )
              ) : (
                <span>
                  Run <code>npm run dev</code> so the proxy in <code>vite.config.ts</code> can reach
                  NSE and BSE, or configure Supabase in <code>.env</code>.
                </span>
              )}
            </div>
          ) : (
            <StockTable
              rows={rows}
              quotesLoaded={quotesLoaded}
              sorting={sorting}
              onSortingChange={setSorting}
              selectedSymbol={selectedRow?.symbol ?? null}
              onSelect={setSelected}
            />
          )}
        </div>
      </main>

      {/* Source and market state are status, not filters — they live beside the
          other provenance rather than competing with the filter chips. */}
      <footer className="statusbar">
        <span className="pill">
          <span className={`dot${refreshingQuotes ? ' busy' : ''}`} />
          {sourceKind === 'supabase' ? 'Supabase' : 'Direct (dev proxy)'}
        </span>

        <span
          className="pill"
          title={
            marketOpen ? 'NSE & BSE 09:15–15:30 IST' : 'Outside 09:15–15:30 IST, Mon–Fri'
          }
        >
          <span className={`dot${marketOpen ? '' : ' off'}`} />
          Market {marketOpen ? 'open' : 'closed'}
        </span>

        {refreshingQuotes && (
          <>
            <span className="progress" aria-hidden>
              <i style={{ width: `${Math.round(quoteProgress * 100)}%` }} />
            </span>
            <span className="num">{Math.round(quoteProgress * 100)}%</span>
          </>
        )}

        {error && securities.length > 0 && <span style={{ color: 'var(--down)' }}>{error}</span>}

        {/* The age of the prices themselves — NOT when they were last fetched.
            In Supabase mode those differ by however long ago the sync ran. */}
        <span
          style={stale ? { color: 'var(--down)', fontWeight: 600 } : undefined}
          title={
            dataAsOf
              ? `Price captured ${dataAsOf.toISOString()}${
                  lastFetchedAt ? ` · table read ${lastFetchedAt.toLocaleTimeString('en-IN')}` : ''
                }`
              : undefined
          }
        >
          {dataAsOf
            ? `Prices as of ${formatIstDateTime(dataAsOf)} · ${formatAge(dataAsOf, now)}`
            : 'Prices pending'}
        </span>

        <div className="spacer" />

        <span style={{ color: 'var(--on-surface-faint)' }}>
          Lists: NSE EQUITY_L.csv + BSE scrip master, merged on ISIN · Prices: Yahoo Finance
          (NSE book where dual-listed) · ~15 min delayed, not for trading
        </span>
      </footer>

      {selectedRow && (
        <StockDetail
          security={selectedRow}
          quote={selectedRow.quote}
          cls={selectedRow.cls}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
