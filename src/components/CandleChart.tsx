import { useMemo, useRef, useState } from 'react';
import type { Candle } from '../types';
import { formatPrice, formatVolume } from '../lib/format';
import { MAPO_HIGH, MAPO_LOW, MAPO_MID, UT_BOT } from '../lib/signals';

/**
 * Candles, with the two studies the screener actually runs drawn on them.
 *
 * The line chart this replaces answered "did it go up". A screener that decides
 * on a trailing-stop crossing has to answer "where is the stop, and where did it
 * cross" — which is a question about a rule, and a rule can only be checked by
 * being drawn. Same for the oscillator: a column saying `77` is a number to
 * trust; a pane showing eighteen months of it either supports the number or
 * plainly does not.
 *
 * Hand-rolled SVG rather than a charting library, for the same reason the line
 * chart was: this needs candles, one overlay and one pane, all in tokens the
 * rest of the app already defines. A library would arrive with its own palette,
 * its own type and 45kB, and would still have to be told all three.
 */

const W = 620;
const PRICE_H = 250;
const MAPO_H = 78;
const PAD = { top: 12, right: 54, bottom: 16, left: 6 };

/** Above this many candles a daily bar is under a pixel wide; aggregate first. */
const MAX_CANDLES = 340;

export interface ChartSeries {
  bars: Candle[];
  /** UT Bot trailing stop, aligned to `bars` by index. */
  stop: (number | null)[];
  /** MAPO `above`, aligned to `bars` by index. */
  above: (number | null)[];
}

interface Props extends ChartSeries {
  showStop: boolean;
  showMapo: boolean;
}

/**
 * A polyline that lifts the pen over gaps.
 *
 * Both series here start `null` — the ATR needs its period before the stop
 * exists, and the oscillator needs a hundred bars before the fan does — so a
 * naive path would draw a straight line from the origin to the first real
 * value and invent a reading that was never taken.
 */
function brokenPath(points: ({ x: number; y: number } | null)[]) {
  let d = '';
  let drawing = false;
  for (const p of points) {
    if (!p) {
      drawing = false;
      continue;
    }
    d += `${drawing ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    drawing = true;
  }
  return d.trim();
}

interface Bucket {
  bar: Candle;
  stop: number | null;
  above: number | null;
  /** How many source bars folded into this one — 1 unless aggregated. */
  span: number;
}

/**
 * Fold a long daily window into fewer, wider candles.
 *
 * Five years of dailies is ~1,250 bars in ~560px — half a pixel each, which is
 * not a candle, it is a smear. Open comes from the first bar of the group and
 * close from the last, high and low are the extremes, volume sums: the ordinary
 * OHLC roll-up.
 *
 * The studies are *sampled at the group's last bar* rather than averaged. They
 * are daily-calibrated — the same 2y daily series the table's signal reads — and
 * a mean of a trailing stop is not a trailing stop. Sampling keeps every drawn
 * value a real value the rule actually produced.
 */
function bucket(series: ChartSeries): Bucket[] {
  const { bars, stop, above } = series;
  const step = Math.max(1, Math.ceil(bars.length / MAX_CANDLES));
  if (step === 1) {
    return bars.map((bar, i) => ({ bar, stop: stop[i], above: above[i], span: 1 }));
  }

  const out: Bucket[] = [];
  for (let i = 0; i < bars.length; i += step) {
    const group = bars.slice(i, i + step);
    const last = group.length - 1;
    const highs = group.map((b) => b.high).filter((v): v is number => v !== null);
    const lows = group.map((b) => b.low).filter((v): v is number => v !== null);
    const vols = group.map((b) => b.volume).filter((v): v is number => v !== null);
    out.push({
      bar: {
        date: group[last].date,
        open: group[0].open ?? group[0].close,
        close: group[last].close,
        high: highs.length ? Math.max(...highs) : null,
        low: lows.length ? Math.min(...lows) : null,
        volume: vols.length ? vols.reduce((a, b) => a + b, 0) : null,
      },
      stop: stop[i + last],
      above: above[i + last],
      span: group.length,
    });
  }
  return out;
}

export function CandleChart({ bars, stop, above, showStop, showMapo }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const cells = bucket({ bars, stop, above }).filter((c) => c.bar.close !== null);
    if (cells.length < 2) return null;

    const plotW = W - PAD.left - PAD.right;
    const plotH = PRICE_H - PAD.top - PAD.bottom;

    // The stop is inside the price scale only when it is drawn — otherwise a
    // stop far from the candles would flatten them against one edge.
    const values: number[] = [];
    for (const c of cells) {
      if (c.bar.high !== null) values.push(c.bar.high);
      if (c.bar.low !== null) values.push(c.bar.low);
      if (showStop && c.stop !== null) values.push(c.stop);
    }
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || Math.abs(hi) * 0.02 || 1;
    // A little air top and bottom, so a wick never touches the frame.
    const pad = span * 0.06;
    const yOf = (v: number) =>
      PAD.top + (1 - (v - (lo - pad)) / (span + pad * 2)) * plotH;

    const step = plotW / cells.length;
    // Never below 1px, and never so wide the candles touch — the gap is what
    // makes a run of them countable.
    const body = Math.max(1, Math.min(step * 0.68, 11));
    const xOf = (i: number) => PAD.left + step * (i + 0.5);

    const mapoTop = PRICE_H + 4;
    const mapoPlot = MAPO_H - 20;
    const mapoY = (v: number) => mapoTop + (1 - v / 100) * mapoPlot;

    return { cells, yOf, xOf, step, body, lo: lo - pad, hi: hi + pad, mapoY, mapoTop, mapoPlot };
  }, [bars, stop, above, showStop]);

  if (!model) {
    return <div className="center-msg chart-empty">Not enough price history to draw.</div>;
  }

  const { cells, yOf, xOf, step, body, lo, hi, mapoY, mapoTop, mapoPlot } = model;
  const height = PRICE_H + (showMapo ? MAPO_H : 0);

  const stopPath = showStop
    ? brokenPath(cells.map((c, i) => (c.stop === null ? null : { x: xOf(i), y: yOf(c.stop) })))
    : '';

  const mapoPath = showMapo
    ? brokenPath(cells.map((c, i) => (c.above === null ? null : { x: xOf(i), y: mapoY(c.above) })))
    : '';

  function locate(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round((x - PAD.left) / step - 0.5);
    setHover(Math.max(0, Math.min(cells.length - 1, i)));
  }

  const at = hover ?? cells.length - 1;
  const cell = cells[at];
  const c = cell.bar;
  const rising = (c.close ?? 0) >= (c.open ?? 0);

  return (
    <div className="chart-box">
      <div className="chart-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label={`Candlestick chart, ${formatPrice(lo)} to ${formatPrice(hi)}`}
          // Vertical gestures still scroll the panel; only the horizontal scrub
          // belongs to the chart.
          style={{ touchAction: 'pan-y' }}
          onPointerMove={(e) => locate(e.clientX)}
          onPointerDown={(e) => locate(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          {/* Price gridlines, at the extremes only — the reader is comparing
              shapes here, not reading values off the axis. */}
          {[hi, lo].map((v, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yOf(v)}
                y2={yOf(v)}
                stroke="var(--outline-faint)"
              />
              <text
                x={W - PAD.right + 7}
                y={yOf(v) + 4}
                className="num chart-axis"
                fill="var(--on-surface-faint)"
              >
                {formatPrice(v)}
              </text>
            </g>
          ))}

          {cells.map((cl, i) => {
            const b = cl.bar;
            if (b.close === null || b.high === null || b.low === null) return null;
            const open = b.open ?? b.close;
            const up = b.close >= open;
            const x = xOf(i);
            const top = yOf(Math.max(open, b.close));
            const bot = yOf(Math.min(open, b.close));
            return (
              <g key={b.date} className={up ? 'candle up' : 'candle down'}>
                <line x1={x} x2={x} y1={yOf(b.high)} y2={yOf(b.low)} strokeWidth="1" />
                <rect
                  x={x - body / 2}
                  y={top}
                  width={body}
                  // A doji still has to be visible; 1px is the floor.
                  height={Math.max(1, bot - top)}
                />
              </g>
            );
          })}

          {/* The trailing stop the whole screener turns on. Dashed, so it never
              reads as another price series. */}
          {showStop && stopPath && (
            <path
              d={stopPath}
              className="ut-stop"
              fill="none"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}

          {showMapo && (
            <g>
              <rect
                x={PAD.left}
                y={mapoY(MAPO_HIGH)}
                width={W - PAD.left - PAD.right}
                height={mapoY(MAPO_LOW) - mapoY(MAPO_HIGH)}
                className="mapo-band"
              />
              {[MAPO_HIGH, MAPO_MID, MAPO_LOW].map((v) => (
                <line
                  key={v}
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={mapoY(v)}
                  y2={mapoY(v)}
                  stroke="var(--outline-faint)"
                  strokeDasharray={v === MAPO_MID ? undefined : '2 3'}
                />
              ))}
              {mapoPath && <path d={mapoPath} className="mapo-line" fill="none" strokeWidth="1.5" />}
              <text
                x={W - PAD.right + 7}
                y={mapoTop + 10}
                className="num chart-axis"
                fill="var(--on-surface-faint)"
              >
                {MAPO_HIGH}
              </text>
              <text
                x={W - PAD.right + 7}
                y={mapoTop + mapoPlot}
                className="num chart-axis"
                fill="var(--on-surface-faint)"
              >
                {MAPO_LOW}
              </text>
            </g>
          )}

          {hover !== null && (
            <line
              x1={xOf(at)}
              x2={xOf(at)}
              y1={PAD.top}
              y2={height - 6}
              stroke="var(--on-surface-faint)"
              strokeWidth="1"
            />
          )}
        </svg>

        <div className="chart-read">
          <span className="chart-read-date">{c.date}</span>
          {(['open', 'high', 'low', 'close'] as const).map((k) => (
            <span key={k}>
              <em>{k[0].toUpperCase()}</em>
              <b className={`num ${rising ? 'up' : 'down'}`}>{formatPrice(c[k])}</b>
            </span>
          ))}
          {c.volume !== null && (
            <span>
              <em>Vol</em>
              <b className="num">{formatVolume(c.volume)}</b>
            </span>
          )}
          {showStop && cell.stop !== null && (
            <span>
              <em>Stop</em>
              <b className="num">{formatPrice(cell.stop)}</b>
            </span>
          )}
          {showMapo && cell.above !== null && (
            <span>
              <em>MAPO</em>
              <b className={`num ${cell.above > MAPO_MID ? 'up' : 'down'}`}>
                {cell.above.toFixed(0)}
              </b>
            </span>
          )}
        </div>
      </div>

      <div className="chart-dates">
        <span>{cells[0].bar.date}</span>
        {cells[0].span > 1 && (
          <span className="chart-agg">{cells[0].span}-day candles</span>
        )}
        <span>{cells[cells.length - 1].bar.date}</span>
      </div>

      <p className="chart-legend">
        {showStop && (
          <span>
            <i className="key-stop" /> UT Bot stop · {UT_BOT.keyValue}× ATR {UT_BOT.atrPeriod}
          </span>
        )}
        {showMapo && (
          <span>
            <i className="key-mapo" /> MAPO · % of 5–100d averages price is above
          </span>
        )}
      </p>
    </div>
  );
}
