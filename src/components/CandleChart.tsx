import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../types';
import {
  MAPO,
  MAPO_HIGH,
  MAPO_LOW,
  MAPO_MID,
  UT_BOT,
  type Flip,
  type Mapo,
} from '../lib/signals';
import { formatPrice, formatVolume } from '../lib/format';

/**
 * Candles, with the two studies the screener decides on drawn over them.
 *
 * TradingView's own Lightweight Charts, which is the honest answer to "can we
 * have TradingView": the *widget* would plot TradingView's prices and
 * TradingView's indicators, and this app's bars go through `cleanBars` while its
 * studies are local transcriptions of the Pine — the chart would have
 * contradicted the column beside it.
 *
 * Laid out the way the scripts plot themselves: price and volume in one pane,
 * the oscillator in its own, `per` as a histogram about its histbase with `len`
 * as a line over it.
 *
 * One deliberate difference from the TradingView setup this mirrors: that chart
 * runs UT Bot over an HMA(31), this app runs it over the close (`hmaLength` is
 * computed here but, as its own comment says, read by nothing in the rule). The
 * stop drawn here is the one the table's column actually used. Matching the
 * picture would have meant changing every signal in the screener.
 *
 * Canvas, not SVG, so the palette cannot be inherited from CSS — see `palette`.
 */

export interface ChartSeries {
  bars: Candle[];
  /** UT Bot trailing stop, aligned to `bars` by index. */
  stop: (number | null)[];
  /** Both MAPO outputs, aligned to `bars` by index. */
  mapo: (Mapo | null)[];
  /** Crossings of the full history, already filtered to this window. */
  flips: Flip[];
}

interface Props extends ChartSeries {
  showStop: boolean;
  showMapo: boolean;
}

/** Bars are dated `yyyy-mm-dd`; the library wants seconds. Parsed as UTC noon so
 *  no timezone can round a session onto the day before. */
const asTime = (iso: string) => (Date.parse(`${iso}T12:00:00Z`) / 1000) as UTCTimestamp;

/**
 * The design system, handed to a canvas.
 *
 * Read through a throwaway element rather than off `documentElement`, and that
 * detail is the whole function. `getPropertyValue('--up')` returns a custom
 * property's *declared* value — here the literal string
 * `light-dark(#0f7b45, #4ed08a)` — because `light-dark()` only resolves when the
 * property is actually used. Handing that to a canvas gets it silently rejected
 * and the context keeps its previous colour: black candles, and no error.
 *
 * Assigning `color: var(--up)` to a real element and reading `.color` back
 * forces the resolution and yields a plain `rgb()` the canvas accepts.
 */
function palette() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
  document.body.appendChild(probe);

  const v = (token: string, fallback: string) => {
    probe.style.color = '';
    probe.style.color = `var(${token})`;
    const resolved = getComputedStyle(probe).color;
    return resolved && resolved.startsWith('rgb') ? resolved : fallback;
  };

  const out = {
    up: v('--up', '#4ed08a'),
    down: v('--down', '#ff6b76'),
    accent: v('--primary', '#a5aeff'),
    faint: v('--on-surface-faint', '#858e9c'),
    line: v('--outline-faint', 'rgba(255,255,255,0.065)'),
  };
  probe.remove();
  return out;
}

/** The same colour at low alpha — for fills that sit behind their own line. */
const soften = (rgb: string, alpha: number) =>
  rgb.startsWith('rgba')
    ? rgb.replace(/[\d.]+\)$/, `${alpha})`)
    : rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);

/** What the status line shows — the hovered bar, or the last one. */
interface Readout {
  bar: Candle;
  stop: number | null;
  mapo: Mapo | null;
}

export function CandleChart({ bars, stop, mapo, flips, showStop, showMapo }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const stopRef = useRef<ISeriesApi<'Line'> | null>(null);
  const histRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const proxRef = useRef<ISeriesApi<'Line'> | null>(null);
  const [read, setRead] = useState<Readout | null>(null);

  // --- create once ---------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = palette();

    const api = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: c.faint,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 10,
        panes: { separatorColor: c.line, separatorHoverColor: c.line, enableResize: true },
        // The licence is met by the credited link under the chart, and the
        // built-in mark lands on top of the oscillator pane.
        attributionLogo: false,
      },
      grid: {
        // Horizontal only — the time axis already says where the bars are, and
        // vertical rules against candles this narrow read as bars themselves.
        vertLines: { visible: false },
        horzLines: { color: c.line, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.MagnetOHLC,
        vertLine: {
          color: c.faint,
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: c.accent,
        },
        horzLine: {
          color: c.faint,
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: c.accent,
        },
      },
      // Room at the bottom for the volume histogram to live under the candles
      // without either intruding on the other.
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.26 } },
      timeScale: { borderVisible: false, rightOffset: 4, fixLeftEdge: true },
      localization: {
        priceFormatter: (p: number) =>
          p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    });

    priceRef.current = api.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });

    /**
     * Volume, on a scale of its own in the bottom quarter of the price pane.
     *
     * `priceScaleId: 'vol'` is how the library says "not the price axis": a
     * share printing 27,000 shares and one printing ₹1,674 must never share a
     * range. That is the dual-axis trap, avoided the way it is meant to be.
     */
    volRef.current = api.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    api.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });

    chart.current = api;

    // The status line follows the crosshair and falls back to the last bar, so
    // the row is never empty and the layout never jumps as the pointer arrives.
    api.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setRead(null);
        return;
      }
      const i = bars.findIndex((b) => asTime(b.date) === param.time);
      if (i >= 0) setRead({ bar: bars[i], stop: stop[i] ?? null, mapo: mapo[i] ?? null });
    });

    return () => {
      api.remove();
      chart.current = null;
      priceRef.current = null;
      volRef.current = null;
      stopRef.current = null;
      histRef.current = null;
      proxRef.current = null;
    };
    // Rebuilt when the window changes, so the crosshair handler closes over the
    // right bars. One canvas, not a re-render of the panel.
  }, [bars, stop, mapo]);

  // --- repaint on theme change --------------------------------------------
  useEffect(() => {
    const apply = () => {
      const api = chart.current;
      if (!api) return;
      const c = palette();
      api.applyOptions({
        layout: { textColor: c.faint, panes: { separatorColor: c.line } },
        grid: { horzLines: { color: c.line } },
        crosshair: {
          vertLine: { color: c.faint, labelBackgroundColor: c.accent },
          horzLine: { color: c.faint, labelBackgroundColor: c.accent },
        },
      });
      priceRef.current?.applyOptions({
        upColor: c.up,
        downColor: c.down,
        borderUpColor: c.up,
        borderDownColor: c.down,
        wickUpColor: c.up,
        wickDownColor: c.down,
      });
      stopRef.current?.applyOptions({ color: c.accent });
      proxRef.current?.applyOptions({ color: c.accent });
    };
    // The toggle writes `data-theme`; following the OS writes nothing, so the
    // media query has to be watched as well.
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', apply);
    };
  }, []);

  // --- price, volume, flips ------------------------------------------------
  useEffect(() => {
    const api = chart.current;
    const price = priceRef.current;
    const vol = volRef.current;
    if (!api || !price || !vol) return;
    const c = palette();

    const candles: CandlestickData<Time>[] = [];
    const volume: HistogramData<Time>[] = [];
    for (const b of bars) {
      if (b.close === null || b.high === null || b.low === null) continue;
      const open = b.open ?? b.close;
      candles.push({ time: asTime(b.date), open, high: b.high, low: b.low, close: b.close });
      if (b.volume !== null) {
        volume.push({
          time: asTime(b.date),
          value: b.volume,
          // Tinted by the session's own direction, so the volume reads with the
          // candle above it rather than as a separate opinion.
          color: soften(b.close >= open ? c.up : c.down, 0.4),
        });
      }
    }
    price.setData(candles);
    vol.setData(volume);

    createSeriesMarkers(
      price,
      flips.map(
        (f): SeriesMarker<Time> => ({
          time: asTime(f.date),
          position: f.side === 'BUY' ? 'belowBar' : 'aboveBar',
          shape: f.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          color: f.side === 'BUY' ? c.up : c.down,
          text: f.side === 'BUY' ? 'Buy' : 'Sell',
        }),
      ),
    );

    api.timeScale().fitContent();
  }, [bars, flips]);

  // --- the trailing stop ---------------------------------------------------
  useEffect(() => {
    const api = chart.current;
    if (!api) return;

    if (!showStop) {
      if (stopRef.current) api.removeSeries(stopRef.current);
      stopRef.current = null;
      return;
    }

    const c = palette();
    const series =
      stopRef.current ??
      api.addSeries(LineSeries, {
        color: c.accent,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        /**
         * Excluded from the price scale's autoscale.
         *
         * A 6×ATR(1) stop is six times *one bar's* true range, so a single wide
         * session throws it hundreds of points from price. Letting that drive
         * the range squeezed every candle into the middle third of the pane —
         * the chart was fitting the outlier instead of the data. It still draws
         * in full; it just no longer votes on the scale.
         */
        autoscaleInfoProvider: () => null,
      });
    stopRef.current = series;

    // Gaps stay gaps: the ATR has no value until its period is met, and a line
    // drawn across that would be a stop the rule never produced.
    const data: LineData<Time>[] = [];
    bars.forEach((b, i) => {
      const v = stop[i];
      if (v !== null && v !== undefined) data.push({ time: asTime(b.date), value: v });
    });
    series.setData(data);
  }, [bars, stop, showStop]);

  // --- the oscillator, in its own pane ------------------------------------
  useEffect(() => {
    const api = chart.current;
    if (!api) return;

    if (!showMapo) {
      if (histRef.current) api.removeSeries(histRef.current);
      if (proxRef.current) api.removeSeries(proxRef.current);
      histRef.current = null;
      proxRef.current = null;
      return;
    }

    const c = palette();
    let hist = histRef.current;
    if (!hist) {
      // Pane 1, created on demand by index. A bounded 0–100 oscillator cannot
      // share the price scale.
      hist = api.addSeries(
        HistogramSeries,
        {
          // Its own histbase, exactly as the script draws it: bars grow up from
          // 50 when price is above most of the fan, and down from it when below.
          base: MAPO_MID,
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
          priceLineVisible: false,
        },
        1,
      );

      for (const level of [MAPO_HIGH, MAPO_LOW]) {
        hist.createPriceLine({
          price: level,
          color: c.line,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '',
        });
      }

      // `len` — which average in the fan the close sits nearest — layered over
      // the histogram, the way the script stacks them.
      proxRef.current = api.addSeries(
        LineSeries,
        {
          color: c.accent,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        },
        1,
      );

      api.panes()[1]?.setHeight(96);
    }
    histRef.current = hist;

    const bins: HistogramData<Time>[] = [];
    const prox: LineData<Time>[] = [];
    bars.forEach((b, i) => {
      const m = mapo[i];
      if (!m) return;
      const time = asTime(b.date);
      bins.push({ time, value: m.above, color: soften(m.above > MAPO_MID ? c.up : c.down, 0.55) });
      prox.push({ time, value: m.proximity });
    });
    hist.setData(bins);
    proxRef.current?.setData(prox);
  }, [bars, mapo, showMapo]);

  const last = bars.length ? bars[bars.length - 1] : null;
  const shown: Readout | null =
    read ??
    (last
      ? {
          bar: last,
          stop: stop[stop.length - 1] ?? null,
          mapo: mapo[mapo.length - 1] ?? null,
        }
      : null);
  const rising = shown ? (shown.bar.close ?? 0) >= (shown.bar.open ?? 0) : true;

  return (
    <div className="chart-box">
      {/* The status line, kept the way TradingView keeps one: fixed above the
          plot rather than a bubble that has to be chased and that covers the
          candles it is describing. */}
      {shown && (
        <div className="chart-read">
          <span className="chart-read-date">{shown.bar.date}</span>
          {(['open', 'high', 'low', 'close'] as const).map((k) => (
            <span key={k}>
              <em>{k[0].toUpperCase()}</em>
              <b className={`num ${rising ? 'up' : 'down'}`}>{formatPrice(shown.bar[k])}</b>
            </span>
          ))}
          {shown.bar.volume !== null && (
            <span>
              <em>Vol</em>
              <b className="num">{formatVolume(shown.bar.volume)}</b>
            </span>
          )}
          {showStop && shown.stop !== null && (
            <span>
              <em>Stop</em>
              <b className="num">{formatPrice(shown.stop)}</b>
            </span>
          )}
          {showMapo && shown.mapo && (
            <span>
              <em>MAPO</em>
              <b className={`num ${shown.mapo.above > MAPO_MID ? 'up' : 'down'}`}>
                {shown.mapo.above.toFixed(1)}
              </b>
              <b className="num chart-read-dim">{shown.mapo.proximity.toFixed(1)}</b>
            </span>
          )}
        </div>
      )}

      <div ref={host} className="tv-chart" data-mapo={showMapo || undefined} />

      <p className="chart-legend">
        {showStop && (
          <span>
            <i className="key-stop" /> UT Bot · {UT_BOT.keyValue}× ATR {UT_BOT.atrPeriod} on close
          </span>
        )}
        {showMapo && (
          <span>
            <i className="key-mapo" /> MAPO · {MAPO.minLength}–{MAPO.maxLength}d fan, smoothed{' '}
            {MAPO.smooth}
          </span>
        )}
        {/* Required by the Apache-2.0 terms the library ships under. */}
        <a
          className="tv-attrib"
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer noopener"
        >
          Charts by TradingView
        </a>
      </p>
    </div>
  );
}
