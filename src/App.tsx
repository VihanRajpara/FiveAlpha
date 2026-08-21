import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { StockTable } from './components/StockTable';
import { StockDetail } from './components/StockDetail';
import { ThemeToggle } from './components/ThemeToggle';
import { Filters, type FilterGroupSpec } from './components/Filters';
import { ScreenBar } from './components/ScreenBar';
import { useMarketData } from './hooks/useMarketData';
import { useScreen } from './hooks/useScreen';
import { useSignals } from './hooks/useSignals';
import { SCREENS } from './lib/screens';
import {
  matchesSignalFilter,
  peekSignal,
  signalFilterIsEmpty,
  type SignalFilter,
} from './lib/signals';
import { ANY, NUMERIC_FILTERS, matchesBands } from './lib/filters';
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

/**
 * The three signal filters. Their values are the keys `matchesSignalFilter`
 * reads — `SIGNAL_AGE_MAX` and `SIGNAL_GAP_BANDS` — so the thresholds live next
 * to the arithmetic and only the labels live here.
 */
const SIGNAL_SIDE_OPTIONS = [
  { value: 'ALL', label: 'Any', hint: 'Both sides of the trailing stop' },
  { value: 'BUY', label: 'Buy', hint: 'Last flip was a buy' },
  { value: 'SELL', label: 'Sell', hint: 'Last flip was a sell' },
];

const SIGNAL_AGE_OPTIONS = [
  { value: 'ALL', label: 'Any', hint: 'However long ago the signal fired' },
  { value: '5', label: '≤5d', hint: 'Flipped within the last 5 trading sessions' },
  { value: '10', label: '≤10d', hint: 'Flipped within the last 10 trading sessions' },
  { value: '20', label: '≤20d', hint: 'Flipped within the last 20 trading sessions' },
  { value: '60', label: '≤60d', hint: 'Flipped within the last 60 trading sessions' },
];

const SIGNAL_GAP_OPTIONS = [
  { value: 'ALL', label: 'Any', hint: 'Wherever the price sits now' },
  { value: 'BELOW', label: 'Below', hint: 'Price is under the signal price' },
  { value: '0_5', label: '0–5%', hint: 'Up to 5% above the signal price — the entry is still close' },
  { value: '5_15', label: '5–15%', hint: '5–15% above the signal price' },
  { value: '15', label: '>15%', hint: 'More than 15% above — most of the move has happened' },
];

/**
 * Signals are one chart request per symbol, so filtering on them fetches the
 * whole list — see `useSignals`. Past this many rows that is a fetch storm, and
 * the controls disable themselves rather than start one: narrow the list with a
 * screen or the other filters first.
 */
const SIGNAL_FILTER_MAX = 400;

type BreadthKey = 'up' | 'down' | 'flat' | 'priced';

const BREADTH_MATCH: Record<BreadthKey, (change: number | null | undefined) => boolean> = {
  up: (c) => c != null && c > 0,
  down: (c) => c != null && c < 0,
  flat: (c) => c === 0,
  priced: (c) => c != null,
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
  const [exchange, setExchange] = useState<ExchangeFilter>('NSE');
  // Not a closed union any more: the available series depend on which exchange
  // is selected, and BSE's group letters are data, not a list we can enumerate.
  const [series, setSeries] = useState<string>('ALL');
  const [segment, setSegment] = useState<SegmentFilter>('ALL');
  const [cap, setCap] = useState<CapFilter>('ALL');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'symbol', desc: false }]);
  const [selected, setSelected] = useState<SecurityWithQuote | null>(null);
  // Clicking a breadth tile cuts the table to that bucket; clicking it again
  // clears. The counts themselves stay computed from the unfiltered set, or
  // picking one would zero the other three.
  const [breadthFilter, setBreadthFilter] = useState<BreadthKey | null>(null);
  // Signal filters, applied after the screen rather than with the other
  // filters: they cost a request per row, so they run over the shortlist.
  const [signal, setSignal] = useState<SignalFilter>({ side: 'ALL', age: 'ALL', gap: 'ALL' });
  // The numeric band filters, keyed by `NUMERIC_FILTERS[].key`. One bag rather
  // than a `useState` each: they are all the same shape, and adding the next
  // one should be a row of data, not another hook.
  const [bands, setBands] = useState<Record<string, string>>({});

  const screenRun = useScreen();
  // Pre-selected rather than 'none': there is one screen, and the shortlist is
  // the point of the page — see the auto-run below.
  const [screenId, setScreenId] = useState<string>(SCREENS[0]?.id ?? 'none');
  // The point of running a screen is the shortlist, so the table cuts to it by
  // default; the toggle in the bar puts the rejected rows back, dimmed, for
  // anyone checking the screen's work rather than trusting it.
  const [matchesOnly, setMatchesOnly] = useState(true);
  const selectedScreen = useMemo(
    () => SCREENS.find((s) => s.id === screenId) ?? null,
    [screenId],
  );

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
   * What the table actually shows: the filtered rows, cut to the screen's
   * matches when one has run and the toggle is on.
   *
   * Kept separate from `rows` because the two answer different questions —
   * `rows` is the universe a run would cover and what the filter controls
   * count, `screened` is the shortlist. Collapsing them would make the filter
   * sheet's "Show 12" button report the screen's verdict instead of the
   * filters'.
   */
  const screening = screenRun.status === 'running' || screenRun.results.size > 0;

  const screened = useMemo(
    () =>
      // Cutting from the first moment of a run rather than from the first
      // published batch: the table then fills up with matches as they are
      // found, instead of showing the whole list and suddenly collapsing.
      matchesOnly && screening ? rows.filter((row) => screenRun.matches.has(row.symbol)) : rows,
    [rows, matchesOnly, screening, screenRun.matches],
  );

  const bandFilterOn = Object.values(bands).some((v) => v !== ANY);
  const signalFilterOn = !signalFilterIsEmpty(signal);
  const signalFilterAffordable = screened.length <= SIGNAL_FILTER_MAX;

  // A filter left on while the list widens past the cap would keep filtering on
  // signals nothing is fetching any more, which reads as a table that has
  // quietly lost rows.
  useEffect(() => {
    if (!signalFilterAffordable && signalFilterOn) {
      setSignal({ side: 'ALL', age: 'ALL', gap: 'ALL' });
    }
  }, [signalFilterAffordable, signalFilterOn]);

  const signals = useSignals(screened, signalFilterOn && signalFilterAffordable);

  const runScreen = useCallback(() => {
    if (selectedScreen) {
      setMatchesOnly(true);
      screenRun.run(selectedScreen, rows);
    }
  }, [selectedScreen, screenRun, rows]);

  // Runs the default screen on landing, once the universe is priced. Guarded by
  // a ref because `rows` changes with every filter keystroke, and re-running on
  // each change would be a fetch storm.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || loading || !quotesLoaded || rows.length === 0) return;
    autoRan.current = true;
    runScreen();
  }, [loading, quotesLoaded, rows.length, runScreen]);

  const selectScreen = useCallback(
    (id: string) => {
      setScreenId(id);
      // Leaving a previous screen's columns and shortlist behind after picking
      // "None" would be a table showing the result of something not selected.
      if (id !== screenRun.screen?.id) screenRun.clear();
    },
    [screenRun],
  );

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

  /**
   * The second question, behind the "More" button: what the numbers say, once
   * the four groups above have settled what you are looking at.
   *
   * Three of them read the signal column, which costs a request per row — hence
   * the affordability guard. The last four read the screen's own metrics and
   * stay disabled until one has run, because a filter on a number nothing has
   * measured would empty the table and look broken.
   */
  const advancedGroups = useMemo<FilterGroupSpec[]>(
    () => [
      {
        key: 'signalSide',
        label: 'Signal',
        value: signal.side,
        disabled: !signalFilterAffordable,
        options: SIGNAL_SIDE_OPTIONS,
        onChange: (v) => setSignal((s) => ({ ...s, side: v })),
      },
      {
        key: 'signalAge',
        label: 'Signal age',
        value: signal.age,
        disabled: !signalFilterAffordable,
        options: SIGNAL_AGE_OPTIONS,
        onChange: (v) => setSignal((s) => ({ ...s, age: v })),
      },
      {
        key: 'signalGap',
        label: 'From signal',
        value: signal.gap,
        disabled: !signalFilterAffordable,
        options: SIGNAL_GAP_OPTIONS,
        onChange: (v) => setSignal((s) => ({ ...s, gap: v })),
      },
      ...NUMERIC_FILTERS.map((f) => ({
        key: f.key,
        label: f.label,
        value: bands[f.key] ?? ANY,
        disabled: f.needsScreen && !screening,
        options: f.bands.map((b) => ({ value: b.value, label: b.label, hint: b.hint })),
        onChange: (v: string) => setBands((prev) => ({ ...prev, [f.key]: v })),
      })),
    ],
    [signal, signalFilterAffordable, bands, screening],
  );

  const breadth = useMemo(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const row of screened) {
      const c = row.quote?.change;
      if (c === null || c === undefined) continue;
      if (c > 0) up++;
      else if (c < 0) down++;
      else flat++;
    }
    return { up, down, flat, priced: up + down + flat };
  }, [screened]);

  /** What the table shows: breadth tile and signal filters applied on top. */
  const visible = useMemo(() => {
    let out = breadthFilter
      ? screened.filter((row) => BREADTH_MATCH[breadthFilter](row.quote?.change))
      : screened;

    if (bandFilterOn) {
      out = out.filter((row) => matchesBands(row, screenRun.results.get(row.symbol), bands));
    }

    if (signalFilterOn) {
      // Read back through `peekSignal` rather than through a second copy of the
      // answers — `useSignals` fills the same cache the cells read from, and
      // `signals.version` is what brings us back here as it fills.
      out = out.filter((row) =>
        matchesSignalFilter(peekSignal(row.ticker), row.quote?.price, signal),
      );
    }

    return out;
  }, [
    screened,
    breadthFilter,
    bandFilterOn,
    bands,
    screenRun.results,
    signalFilterOn,
    signal,
    signals.version,
  ]);

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
                : `${listedOn} · ${visible.length.toLocaleString('en-IN')} of ${securities.length.toLocaleString('en-IN')} companies`}
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
        <Filters groups={filterGroups} advanced={advancedGroups} resultCount={visible.length} />
        {/* Without this the table looks like it is losing rows: a signal filter
            excludes rows whose signal has not arrived, and they arrive over a
            few seconds. */}
        {signals.pending > 0 && (
          <span className="subbar-note num">
            Reading signals · {signals.pending.toLocaleString('en-IN')} left
          </span>
        )}
      </div>

      <ScreenBar
        screens={SCREENS}
        selected={selectedScreen}
        onSelect={selectScreen}
        run={screenRun}
        universeCount={rows.length}
        onRun={runScreen}
        matchesOnly={matchesOnly}
        onMatchesOnlyChange={setMatchesOnly}
      />

      {/* Breadth across whatever the current filter selects — the closest thing
          this dataset has to a market summary. */}
      <section className="summary" aria-label="Market breadth">
        {(
          [
            ['up', 'Advancing', breadth.up, 'up', pct(breadth.up)],
            ['down', 'Declining', breadth.down, 'down', pct(breadth.down)],
            ['flat', 'Unchanged', breadth.flat, '', pct(breadth.flat)],
            [
              'priced',
              'Priced',
              breadth.priced,
              '',
              `of ${screened.length.toLocaleString('en-IN')} shown`,
            ],
          ] as [BreadthKey, string, number, string, string][]
        ).map(([key, label, value, tone, sub]) => (
          <button
            key={key}
            type="button"
            className={`stat${breadthFilter === key ? ' active' : ''}`}
            aria-pressed={breadthFilter === key}
            title={`Show only ${label.toLowerCase()} shares`}
            onClick={() => setBreadthFilter((f) => (f === key ? null : key))}
          >
            <div className="stat-label">{label}</div>
            <div className={`stat-value num ${tone}`}>{value.toLocaleString('en-IN')}</div>
            <div className="stat-sub">{sub}</div>
          </button>
        ))}
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
              rows={visible}
              quotesLoaded={quotesLoaded}
              // Present from the start of a run, empty, so the screen columns
              // appear shimmering rather than popping in mid-pass.
              screenResults={screening ? screenRun.results : null}
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
