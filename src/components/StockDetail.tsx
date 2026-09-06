import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { CAP_LABEL } from '../lib/classification';
import { formatDate, formatPercent, formatPrice, formatVolume } from '../lib/format';
import type { ChartRange, Classification, Quote, Security } from '../types';
import { useSignal } from '../hooks/useSignal';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useClosing } from '../hooks/useClosing';
import { useSheetDrag } from '../hooks/useSheetDrag';
import { WatchPicker } from './WatchPicker';
import {
  MAPO,
  MAPO_HIGH,
  fetchChartSeries,
  windowChart,
  type ChartData,
  MAPO_LOW,
  MAPO_MID,
  SIGNAL_RANGE_LABEL,
  UT_BOT,
  formatGap,
  scoreLabel,
  signalGapPct,
  stopDistancePct,
} from '../lib/signals';
import { CompanyFundamentals } from './CompanyFundamentals';
import { ExchangeBadges } from './ExchangeBadges';
import { CandleChart } from './CandleChart';

const RANGES: ChartRange[] = ['1mo', '6mo', '1y', '5y'];
const RANGE_LABEL: Record<ChartRange, string> = {
  '1mo': '1M',
  '6mo': '6M',
  '1y': '1Y',
  '5y': '5Y',
};

/**
 * The row's signal, opened up.
 *
 * The table has room for a side, a price and a percentage; here there is room
 * for what the study actually is and how stale its verdict has got. Same hook
 * as the table cells, so opening a row that was already on screen costs
 * nothing — the answer is in the day-cache.
 */
function SignalPanel({ ticker, price }: { ticker: string; price: number | null | undefined }) {
  const { signal, mapo, loaded } = useSignal(ticker);

  const study = `UT Bot on close · ${UT_BOT.keyValue}× ATR ${UT_BOT.atrPeriod}, daily bars`;

  if (!loaded) {
    return (
      <section className="company">
        <div className="company-head">
          <h3>Signal</h3>
          <span className="sig-study">{study}</span>
        </div>
        <div className="center-msg" style={{ padding: '24px 12px' }}>
          <div className="spinner" />
          Reading bars…
        </div>
      </section>
    );
  }

  const gap = signal ? signalGapPct(signal, price) : null;
  const room = signal ? stopDistancePct(signal, price ?? signal.price) : null;

  return (
    <section className="company">
      <div className="company-head">
        <h3>Signal</h3>
        <span className="sig-study">{study}</span>
      </div>

      {/* Its own block, below the flip: MAPO is a second indicator that
          happens to ride the same request, not another fact about the UT Bot.
          Shown even where there is no flip, because it does not depend on one. */}
      {mapo && (
        <>
          <p className="sig-study">
            MAPO [LuxAlgo] {MAPO.minLength} {MAPO.maxLength} {MAPO.smooth} close
          </p>
          <dl className="facts">
            <div className="fact">
              <dt>MAPO · above</dt>
              <dd className={`num ${mapo.above > MAPO_MID ? 'up' : 'down'}`}>
                {mapo.above.toFixed(1)}
                {mapo.above >= MAPO_HIGH ? ` · over ${MAPO_HIGH}` : mapo.above <= MAPO_LOW ? ` · under ${MAPO_LOW}` : ''}
              </dd>
            </div>
            <div className="fact">
              <dt>MAPO · proximity</dt>
              <dd className="num">{mapo.proximity.toFixed(1)}</dd>
            </div>
            <div className="fact">
              <dt>Moving average fan</dt>
              <dd className="num">
                {MAPO.minLength}–{MAPO.maxLength}d, smoothed {MAPO.smooth}
              </dd>
            </div>
          </dl>
        </>
      )}

      {!signal ? (
        <p className="sig-none">
          No flip in {SIGNAL_RANGE_LABEL} of daily bars — the history is too short, or the
          trailing stop has not been crossed.
        </p>
      ) : (
        <>
          <div className={`sig-banner ${signal.side === 'BUY' ? 'up' : 'down'}`}>
            <span className="sig-badge">{signal.side}</span>
            <span className="sig-banner-price num">{formatPrice(signal.price)}</span>
            <span className="sig-banner-when">
              {formatDate(signal.date)} · {signal.age === 0 ? 'today' : `${signal.age} bars ago`}
            </span>
          </div>

          {/* Said out loud rather than left to be discovered: a flip on a bar
              that is still trading can be gone by the close. */}
          {signal.provisional && (
            <p className="sig-none">
              Today&rsquo;s bar is still open — this flip can reverse before the close.
            </p>
          )}

          <dl className="facts">
            <div className="fact">
              <dt>Signal price</dt>
              <dd className="num">{formatPrice(signal.price)}</dd>
            </div>
            <div className="fact">
              <dt>Since signal</dt>
              <dd className={`num ${gap === null ? '' : gap >= 0 ? 'up' : 'down'}`}>
                {gap === null ? '—' : formatGap(gap)}
              </dd>
            </div>
            <div className="fact">
              <dt>Fired on</dt>
              <dd>{formatDate(signal.date)}</dd>
            </div>
            <div className="fact">
              <dt>Bars since</dt>
              <dd className="num">{signal.age}</dd>
            </div>
            {/* The study is a trailing stop, so this is the level it flips back
                at — the signal's own statement of where it is wrong. */}
            <div className="fact">
              <dt>Trailing stop</dt>
              <dd className="num">{formatPrice(signal.stop)}</dd>
            </div>
            <div className="fact">
              <dt>Room to stop</dt>
              <dd className={`num ${room === null ? '' : room >= 0 ? 'up' : 'down'}`}>
                {room === null ? '—' : formatGap(room)}
              </dd>
            </div>
            <div className="fact">
              <dt>Confidence</dt>
              <dd className="num">
                {signal.score} · {scoreLabel(signal.score)}
              </dd>
            </div>
            <div className="fact">
              <dt>Trend</dt>
              <dd className={signal.trend === 1 ? 'up' : signal.trend === -1 ? 'down' : ''}>
                {signal.trend === 0
                  ? 'Too little history'
                  : signal.trend === 1
                    ? `With the Hull ${UT_BOT.hmaLength}`
                    : `Against the Hull ${UT_BOT.hmaLength}`}
              </dd>
            </div>
            <div className="fact">
              <dt>Volume on flip</dt>
              <dd className="num">
                {signal.volumeRatio === null ? '—' : `${signal.volumeRatio.toFixed(1)}× 20d avg`}
              </dd>
            </div>
            <div className="fact">
              <dt>Turnover (20d median)</dt>
              <dd className="num">
                {signal.turnover === null ? '—' : `₹${formatVolume(signal.turnover)}`}
              </dd>
            </div>
            {/* Every earlier flip in the window closed at the next one, so this
                is the same rule's record on this name — evidence, not a
                backtest: no costs, no slippage, one year of bars. */}
            <div className="fact">
              <dt>This rule here ({SIGNAL_RANGE_LABEL})</dt>
              <dd className="num">
                {signal.history
                  ? `${signal.history.wins}/${signal.history.trades} won · avg ${formatGap(signal.history.avgPct)}`
                  : 'Too few flips'}
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}

interface Props {
  security: Security;
  quote?: Quote;
  /** Undefined until the NSE segment/index lists have loaded. */
  cls?: Classification;
  onClose: () => void;
  /** Beside the table rather than over it — see `docked` in App. */
  docked?: boolean;
}

export function StockDetail({ security, quote, cls, onClose, docked = false }: Props) {
  const [range, setRange] = useState<ChartRange>('1y');
  const [series, setSeries] = useState<ChartData | null>(null);
  /**
   * Which studies are drawn. Both on by default: they are the two rules this
   * screener actually decides on, and a chart of a screener that does not show
   * them is a chart of something else.
   */
  const [showStop, setShowStop] = useState(true);
  const [showMapo, setShowMapo] = useState(true);
  const [showVolume, setShowVolume] = useState(true);

  /**
   * The chart, over the whole page.
   *
   * A 680px panel is enough to see that a stop was crossed and not enough to
   * study why. An in-page overlay rather than the Fullscreen API:
   * `requestFullscreen` is refused on non-video elements by iOS Safari, which
   * is exactly the device with the least room to spare.
   */
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    // Captured, so Escape leaves the chart before it reaches the panel's own
    // handler — the one key that means "back" should not skip a level.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setFull(false);
    };
    window.addEventListener('keydown', onKey, true);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previous;
    };
  }, [full]);

  // A panel that changes subject underneath an open chart would strand it.
  useEffect(() => setFull(false), [security.symbol]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const drawerRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Trapped only while it is actually modal.
   *
   * Docked, this is a second column, not a dialog over one — trapping focus
   * would strand a keyboard user in a panel they never asked to be moved into,
   * and it would kill the best thing about the docked mode: arrow keys keep
   * driving the table while the panel follows the highlighted row.
   */
  useFocusTrap(drawerRef, !docked);

  // Every way out routes through `close` rather than `onClose`, so the panel
  // leaves the way it arrived instead of blinking out. See useClosing.
  const { closing, close } = useClosing(true, onClose);

  const scrimRef = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery('(max-width: 700px)');
  // Dismissal by drag skips `close`: the sheet is already part-way down under
  // the finger, and the keyframe exit would snap it back to nought first.
  const drag = useSheetDrag(drawerRef, scrimRef, onClose, isPhone);

  /**
   * Whether the price has scrolled out from under the header.
   *
   * The body runs to five screens on a company with financials, and the header
   * alone says only *which* share you are reading — not what it costs, which is
   * the number the panel was opened for. Past the price block the header grows
   * one, the way a large title collapses into an inline one.
   *
   * An observer on a sentinel rather than a scroll listener: this fires twice
   * per visit instead of on every frame of every scroll.
   */
  const [condensed, setCondensed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = sentinelRef.current;
    const root = bodyRef.current;
    if (!mark || !root) return;
    const io = new IntersectionObserver(([e]) => setCondensed(!e.isIntersecting), { root });
    io.observe(mark);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);

    // The page behind this scrolls on a phone, where the drawer is a bottom
    // sheet — without the lock the list moves under the finger while the sheet
    // is open, and closing it lands somewhere else entirely.
    //
    // Docked, the page behind is the point: locking it would freeze the table
    // the panel exists to describe.
    const previous = document.body.style.overflow;
    if (!docked) document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      if (!docked) document.body.style.overflow = previous;
    };
  }, [close, docked]);

  /**
   * Back to the top when the subject changes.
   *
   * Docked, the panel is not remounted between symbols — the same component
   * takes new props — so without this, arrowing from a row you had scrolled to
   * the financials on lands you in the middle of the next company's, with its
   * price somewhere above the fold.
   */
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    setCondensed(false);
  }, [security.symbol]);

  /**
   * One fetch per symbol, not per range.
   *
   * `range` is deliberately not a dependency. The series is five years of
   * dailies with both studies already computed over all of it, so every range
   * button is a slice of what is in hand — the old chart re-requested on each
   * press, and three of the four presses asked for a subset of what it had just
   * been given.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSeries(null);

    fetchChartSeries(security.ticker)
      .then((data) => {
        if (!cancelled) setSeries(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [security.ticker]);

  /**
   * The chart and its controls, in the panel or over the whole page.
   *
   * Portalled to `document.body` when full, and that is not stylistic.
   * `position: fixed` is only viewport-relative while no ancestor establishes a
   * containing block — and two ancestors here do. `.drawer-body` carries
   * `container-type: inline-size` for the three-column facts, which implies
   * layout containment; on a phone `.drawer` carries `will-change: transform`
   * for the drag. Either alone is enough to trap it, and left in place "full
   * screen" filled the drawer body and nothing else.
   *
   * A plain function, not a component declared in render: a nested component
   * would be a new type on every render and would remount the chart on each
   * one. This re-parents only when `full` actually flips — the single moment
   * when losing the zoom is the right behaviour anyway.
   */
  const chartStage = (children: ReactNode) => {
    const stage = (
      <div className="chart-full" data-full={full || undefined}>
        {/* Full screen leaves the panel's own header behind, and a chart with no
            name on it is a chart of nothing. The subject and its price come
            along — the two facts you cannot work without. */}
        {full && (
          <header className="chart-full-head">
            <div className="chart-full-id">
              <h2>{security.symbol}</h2>
              <p>{security.name}</p>
            </div>
            <div className="chart-full-px">
              <span className="num">{formatPrice(quote?.price)}</span>
              {change !== null && (
                <span className={`chg-chip num ${trendClass}`}>
                  <span className="arrow" aria-hidden>
                    {positive ? '▲' : '▼'}
                  </span>
                  {formatPercent(quote?.changePercent)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setFull(false)}
              aria-label="Exit full screen"
              title="Exit full screen (Esc)"
            >
              ✕
            </button>
          </header>
        )}
        {children}
      </div>
    );
    return full ? createPortal(stage, document.body) : stage;
  };

  const shown = useMemo(
    () => (series ? windowChart(series, range) : null),
    [series, range],
  );
  const candles = shown?.bars ?? [];

  const change = quote?.change ?? null;
  const positive = (change ?? 0) >= 0;
  const trendClass = change === null ? '' : positive ? 'up' : 'down';

  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const windowReturn =
    candles.length > 1 && candles[0].close && last?.close
      ? ((last.close - candles[0].close) / candles[0].close) * 100
      : null;

  return (
    <>
      {/* No scrim when docked: nothing behind is being blocked, and dimming a
          table the reader is still using would be a lie about its state. */}
      {!docked && (
        <div
          ref={scrimRef}
          className="drawer-scrim"
          data-closing={closing || undefined}
          onClick={close}
        />
      )}
      <aside
        ref={drawerRef}
        className="drawer"
        data-closing={closing || undefined}
        role="dialog"
        // Docked it is genuinely not modal, and claiming otherwise tells a
        // screen reader the rest of the page is unavailable when it is not.
        aria-modal={!docked}
        tabIndex={-1}
        aria-label={`${security.symbol} details`}
      >
        {/* The grab bar as well as the title. Everything the drag needs is on
            this element and nothing below it, so the gesture and the scroller
            never contend for the same pixels. */}
        <header className="drawer-head" {...drag}>
          <div className="drawer-id">
            <h2>{security.symbol}</h2>
            <p>{security.name}</p>
            {/* Off the control line and onto their own: these are what the
                share *is*, which is a different question from what you can do
                to it, and six items on one row made both hard to find. */}
            <div className="drawer-meta">
              {cls?.fno && <span className="badge fno">F&amp;O</span>}
              <ExchangeBadges exchanges={security.exchanges} />
              <span className={`badge ${security.series}`}>{security.series}</span>
            </div>
          </div>

          {/* The price, once the real one has scrolled away. `aria-hidden` while
              it is invisible so a screen reader is not read two prices. */}
          <div className="drawer-live" data-shown={condensed || undefined} aria-hidden={!condensed}>
            <span className="num">{formatPrice(quote?.price)}</span>
            {change !== null && (
              <span className={`num ${trendClass}`}>{formatPercent(quote?.changePercent)}</span>
            )}
          </div>

          <div className="drawer-actions">
            {/* The same star as the row behind it, and the visible half of the
                `w` shortcut — a keystroke with nothing on screen to point at is
                a keystroke only its author knows about. */}
            <WatchPicker symbol={security.symbol} size="lg" />
            <button className="icon-btn" onClick={close} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {/* Everything below the header scrolls, in normal block flow.
            The drawer itself used to be the scroller *and* a flex column, which
            made every section a shrinkable flex item — and the ones that carry
            their own `overflow` (the chart, the financial tables) have an
            automatic minimum size of zero, so a long company was silently
            crushed: sections painted over one another, taps landed on whichever
            crushed box happened to lie under the finger, and the last table had
            no height at all. */}
        <div className="drawer-body" ref={bodyRef}>
          <div className="drawer-price">
            <span className="ltp num">{formatPrice(quote?.price)}</span>
            {change === null ? (
              <span style={{ color: 'var(--on-surface-faint)' }}>No quote yet</span>
            ) : (
              <span className={`chg-chip num ${trendClass}`}>
                <span className="arrow" aria-hidden>
                  {positive ? '▲' : '▼'}
                </span>
                {`${change >= 0 ? '+' : ''}${change.toFixed(2)} (${formatPercent(
                  quote?.changePercent,
                )})`}
              </span>
            )}
          </div>

          <div ref={sentinelRef} className="drawer-sentinel" aria-hidden />

          {chartStage(
            <>
              {loading ? (
            <div className="center-msg" style={{ padding: '56px 12px' }}>
              <div className="spinner" />
              Loading {RANGE_LABEL[range]} history…
            </div>
          ) : error ? (
            <div className="center-msg" style={{ padding: '48px 12px' }}>
              Couldn’t load history — {error}
            </div>
          ) : (
            shown && (
              <CandleChart
                bars={shown.bars}
                stop={shown.stop}
                mapo={shown.mapo}
                flips={shown.flips}
                showStop={showStop}
                showMapo={showMapo}
                showVolume={showVolume}
                full={full}
                onToggleFull={() => setFull((v) => !v)}
              />
            )
          )}

          <div className="range-row">
            <div className="segmented">
              {RANGES.map((r) => (
                <button key={r} data-active={r === range} onClick={() => setRange(r)}>
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>

            {/* Toggles, not a second range control: these add and remove layers
                rather than choosing between them, so they are independent
                switches and each says what it is drawing. */}
            <div className="study-toggles">
              <button
                type="button"
                className="study"
                data-on={showStop}
                aria-pressed={showStop}
                onClick={() => setShowStop((v) => !v)}
              >
                <i className="key-stop" /> UT Bot
              </button>
              <button
                type="button"
                className="study"
                data-on={showMapo}
                aria-pressed={showMapo}
                onClick={() => setShowMapo((v) => !v)}
              >
                <i className="key-mapo" /> MAPO
              </button>
              {/* Volume is a layer like the other two, so it is dismissed like
                  them rather than being the one thing you cannot turn off. */}
              <button
                type="button"
                className="study"
                data-on={showVolume}
                aria-pressed={showVolume}
                onClick={() => setShowVolume((v) => !v)}
              >
                <i className="key-vol" /> Vol
              </button>
            </div>
            {windowReturn !== null && (
              <span className={`range-return num ${windowReturn >= 0 ? 'up' : 'down'}`}>
                {formatPercent(windowReturn)}
                <span className="range-over"> over {RANGE_LABEL[range]}</span>
              </span>
            )}
              </div>
            </>,
          )}

          {/* Three groups, not thirteen tiles.
              Ungrouped, ISIN carried the same weight as Day range and the reader
              had to scan all thirteen to find either. These are three different
              questions — what it did today, what kind of share it is, and what
              the registry says — asked at different times. Today comes first,
              because it is why the panel was opened. */}
          <div className="factset">
            <h3 className="factset-label">Today</h3>
            <dl className="facts">
              <div className="fact">
                <dt>Previous close</dt>
                <dd className="num">{formatPrice(quote?.previousClose)}</dd>
              </div>
              <div className="fact">
                <dt>Day range</dt>
                <dd className="num">
                  {last?.low && last?.high
                    ? `${formatPrice(last.low)} – ${formatPrice(last.high)}`
                    : '—'}
                </dd>
              </div>
              <div className="fact">
                <dt>Volume</dt>
                <dd className="num">{formatVolume(last?.volume)}</dd>
              </div>
            </dl>
          </div>

          <div className="factset">
            <h3 className="factset-label">Classification</h3>
            <dl className="facts">
              <div className="fact">
                <dt>Segment</dt>
                <dd>
                  {cls ? cls.fno ? <span className="up">F&amp;O + Cash</span> : 'Cash only' : '—'}
                </dd>
              </div>
              <div className="fact">
                <dt>Cap band</dt>
                <dd>{cls ? CAP_LABEL[cls.capBand] : '—'}</dd>
              </div>
              <div className="fact">
                <dt>Exchanges</dt>
                <dd>{security.exchanges.join(' + ')}</dd>
              </div>
            </dl>
          </div>

          <div className="factset">
            <h3 className="factset-label">Listing</h3>
            <dl className="facts">
              {/* Which book the price above came from. For a dual-listed name the
                  two exchanges quote within a few paise of each other, but saying
                  so beats leaving the reader to guess.

                  Filed under Listing rather than Classification because it names
                  a *feed*, not a property of the share — and because it leaves
                  both of the groups above at exactly three, which is one full
                  row at the width a laptop gives this panel. */}
              <div className="fact">
                <dt>Price feed</dt>
                <dd className="num">{security.ticker}</dd>
              </div>
              <div className="fact">
                <dt>ISIN</dt>
                <dd className="num">{security.isin || '—'}</dd>
              </div>
              <div className="fact">
                <dt>Listed on</dt>
                <dd>{formatDate(security.listingDate)}</dd>
              </div>
              {security.bseCode && (
                <div className="fact">
                  <dt>BSE scrip code</dt>
                  <dd className="num">{security.bseCode}</dd>
                </div>
              )}
              <div className="fact">
                <dt>Face value</dt>
                <dd className="num">{formatPrice(security.faceValue)}</dd>
              </div>
              <div className="fact">
                <dt>Paid up value</dt>
                <dd className="num">{formatPrice(security.paidUpValue)}</dd>
              </div>
              <div className="fact">
                <dt>Market lot</dt>
                <dd className="num">{security.marketLot ?? '—'}</dd>
              </div>
            </dl>
          </div>

          {/* Sits between the listing facts and screener.in's: it is derived from
            the same price history as the chart above, not fetched from either. */}
          <SignalPanel ticker={security.ticker} price={quote?.price} />

          {/* Everything above is the exchange lists and Yahoo; everything below is
            screener.in, fetched when the drawer opens. */}
          <CompanyFundamentals security={security} />
        </div>
      </aside>
    </>
  );
}
