import { useEffect, useState } from 'react';
import { activeSource } from '../lib/dataSource';
import { CAP_LABEL } from '../lib/classification';
import { formatDate, formatPercent, formatPrice, formatVolume } from '../lib/format';
import type { Candle, ChartRange, Classification, Quote, Security } from '../types';
import { useSignal } from '../hooks/useSignal';
import { UT_BOT, signalGapPct } from '../lib/signals';
import { CompanyFundamentals } from './CompanyFundamentals';
import { ExchangeBadges } from './ExchangeBadges';
import { PriceChart } from './PriceChart';

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
  const { signal, loaded } = useSignal(ticker);

  const study = `UT Bot · ATR ${UT_BOT.atrPeriod} × ${UT_BOT.keyValue} on HMA ${UT_BOT.hmaLength}, daily bars`;

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

  return (
    <section className="company">
      <div className="company-head">
        <h3>Signal</h3>
        <span className="sig-study">{study}</span>
      </div>

      {!signal ? (
        <p className="sig-none">
          No flip in the last year of daily bars — the history is too short, or the trailing stop
          has not been crossed.
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

          <dl className="facts">
            <div className="fact">
              <dt>Signal price</dt>
              <dd className="num">{formatPrice(signal.price)}</dd>
            </div>
            <div className="fact">
              <dt>Since signal</dt>
              <dd className={`num ${gap === null ? '' : gap >= 0 ? 'up' : 'down'}`}>
                {gap === null ? '—' : `${gap >= 0 ? '+' : '−'}${Math.abs(gap).toFixed(1)} %`}
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
}

export function StockDetail({ security, quote, cls, onClose }: Props) {
  const [range, setRange] = useState<ChartRange>('1y');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);

    // The page behind this scrolls on a phone, where the drawer is a bottom
    // sheet — without the lock the list moves under the finger while the sheet
    // is open, and closing it lands somewhere else entirely.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    activeSource
      .fetchCandles(security.ticker, range)
      .then((rows) => {
        if (!cancelled) setCandles(rows);
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
  }, [security.ticker, range]);

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
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${security.symbol} details`}>
        <header className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{security.symbol}</h2>
            <p>{security.name}</p>
          </div>
          {cls?.fno && <span className="badge fno">F&amp;O</span>}
          <ExchangeBadges exchanges={security.exchanges} />
          <span className={`badge ${security.series}`}>{security.series}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

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
          <PriceChart candles={candles} positive={windowReturn === null || windowReturn >= 0} />
        )}

        <div className="range-row">
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r} data-active={r === range} onClick={() => setRange(r)}>
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          {windowReturn !== null && (
            <span className={`num ${windowReturn >= 0 ? 'up' : 'down'}`} style={{ fontWeight: 600 }}>
              {formatPercent(windowReturn)}
              <span style={{ color: 'var(--on-surface-variant)', fontWeight: 400 }}>
                {' '}
                over {RANGE_LABEL[range]}
              </span>
            </span>
          )}
        </div>

        <dl className="facts">
          <div className="fact">
            <dt>Previous close</dt>
            <dd className="num">{formatPrice(quote?.previousClose)}</dd>
          </div>
          <div className="fact">
            <dt>Day range</dt>
            <dd className="num">
              {last?.low && last?.high ? `${formatPrice(last.low)} – ${formatPrice(last.high)}` : '—'}
            </dd>
          </div>
          <div className="fact">
            <dt>Volume</dt>
            <dd className="num">{formatVolume(last?.volume)}</dd>
          </div>
          <div className="fact">
            <dt>Segment</dt>
            <dd>
              {cls ? (
                cls.fno ? (
                  <span className="up">F&amp;O + Cash</span>
                ) : (
                  'Cash only'
                )
              ) : (
                '—'
              )}
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
          {/* Which book the price above came from. For a dual-listed name the two
              exchanges quote within a few paise of each other, but saying so
              beats leaving the reader to guess. */}
          <div className="fact">
            <dt>Price feed</dt>
            <dd className="num">{security.ticker}</dd>
          </div>
          {security.bseCode && (
            <div className="fact">
              <dt>BSE scrip code</dt>
              <dd className="num">{security.bseCode}</dd>
            </div>
          )}
          <div className="fact">
            <dt>ISIN</dt>
            <dd className="num">{security.isin || '—'}</dd>
          </div>
          <div className="fact">
            <dt>Listed on</dt>
            <dd>{formatDate(security.listingDate)}</dd>
          </div>
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

        {/* Sits between the listing facts and screener.in's: it is derived from
            the same price history as the chart above, not fetched from either. */}
        <SignalPanel ticker={security.ticker} price={quote?.price} />

        {/* Everything above is the exchange lists and Yahoo; everything below is
            screener.in, fetched when the drawer opens. */}
        <CompanyFundamentals security={security} />
      </aside>
    </>
  );
}
