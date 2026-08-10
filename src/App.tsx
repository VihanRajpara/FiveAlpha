import { useEffect, useMemo, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { StockTable } from './components/StockTable';
import { StockDetail } from './components/StockDetail';
import { useMarketData } from './hooks/useMarketData';
import { formatAge, formatIstDateTime, isMarketOpen } from './lib/format';
import type { SecurityWithQuote } from './types';

/** Prices older than this during a live session are worth flagging. */
const STALE_AFTER_MS = 15 * 60 * 1000;

const SERIES_FILTERS = ['ALL', 'EQ', 'BE', 'BZ'] as const;
type SeriesFilter = (typeof SERIES_FILTERS)[number];

const SERIES_HINT: Record<string, string> = {
  ALL: 'Every listed share',
  EQ: 'Rolling settlement',
  BE: 'Trade-to-trade',
  BZ: 'Surveillance / T2T',
};

export default function App() {
  const {
    securities,
    quotes,
    loading,
    quoteProgress,
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
  const [series, setSeries] = useState<SeriesFilter>('ALL');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'symbol', desc: false }]);
  const [selected, setSelected] = useState<SecurityWithQuote | null>(null);

  const joined = useMemo<SecurityWithQuote[]>(
    () => securities.map((s) => ({ ...s, quote: quotes.get(s.symbol) })),
    [securities, quotes],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return joined.filter((row) => {
      if (series !== 'ALL' && row.series !== series) return false;
      if (q === '') return true;
      return (
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.isin.toLowerCase().includes(q)
      );
    });
  }, [joined, search, series]);

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
          <span className="logo" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17l5.5-6 4 4L21 6" />
              <path d="M15 6h6v6" />
            </svg>
          </span>
          <div>
            <h1>NSE Listed Shares</h1>
            <span className="count num">
              {loading
                ? 'Loading…'
                : `${rows.length.toLocaleString('en-IN')} of ${securities.length.toLocaleString('en-IN')} securities`}
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
        <div className="segmented">
          {SERIES_FILTERS.map((s) => (
            <button key={s} data-active={s === series} onClick={() => setSeries(s)} title={SERIES_HINT[s]}>
              {s}
            </button>
          ))}
        </div>

        <div className="spacer" />

        <span className="pill">
          <span className={`dot${refreshingQuotes ? ' busy' : ''}`} />
          {sourceKind === 'supabase' ? 'Supabase' : 'Direct (dev proxy)'}
        </span>

        <span
          className="pill"
          title={marketOpen ? 'NSE 09:15–15:30 IST' : 'Outside 09:15–15:30 IST, Mon–Fri'}
        >
          <span className={`dot${marketOpen ? '' : ' off'}`} />
          Market {marketOpen ? 'open' : 'closed'}
        </span>
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
              <strong>Fetching the NSE equity list…</strong>
              <span>
                {sourceKind === 'supabase'
                  ? 'Reading the securities table from Supabase.'
                  : 'Reading EQUITY_L.csv straight from NSE archives.'}
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
                  NSE, or configure Supabase in <code>.env</code>.
                </span>
              )}
            </div>
          ) : (
            <StockTable
              rows={rows}
              sorting={sorting}
              onSortingChange={setSorting}
              selectedSymbol={selectedRow?.symbol ?? null}
              onSelect={setSelected}
            />
          )}
        </div>
      </main>

      <footer className="statusbar">
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
          List: NSE EQUITY_L.csv · Prices: Yahoo Finance · ~15 min delayed, not for trading
        </span>
      </footer>

      {selectedRow && (
        <StockDetail
          security={selectedRow}
          quote={selectedRow.quote}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
