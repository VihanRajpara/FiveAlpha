import { useMemo, useRef, useState } from 'react';
import type { Candle } from '../types';
import { formatPrice } from '../lib/format';

const W = 560;
const H = 220;
const PAD = { top: 14, right: 52, bottom: 18, left: 8 };

interface Props {
  candles: Candle[];
  /** Colours the line green/red relative to the first close in the window. */
  positive: boolean;
}

interface Point {
  x: number;
  y: number;
  candle: Candle;
}

export function PriceChart({ candles, positive }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Point | null>(null);

  const model = useMemo(() => {
    const values = candles
      .map((c) => c.close)
      .filter((c): c is number => typeof c === 'number');
    if (values.length < 2) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series would divide by zero; give it an artificial band.
    const span = max - min || Math.abs(max) * 0.02 || 1;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const yOf = (v: number) => PAD.top + (1 - (v - min) / span) * plotH;

    const points: Point[] = candles
      .filter((c): c is Candle & { close: number } => typeof c.close === 'number')
      .map((c, i, arr) => ({
        x: PAD.left + (i / (arr.length - 1)) * plotW,
        y: yOf(c.close),
        candle: c,
      }));

    // The opening close of the window is the reference the return is measured
    // against, so it gets Finance's dotted baseline.
    return { points, min, max, baselineY: yOf(values[0]), baseline: values[0] };
  }, [candles]);

  if (!model) {
    return (
      <div className="center-msg" style={{ padding: '48px 12px' }}>
        No price history available for this symbol.
      </div>
    );
  }

  const { points, min, max, baselineY, baseline } = model;
  const stroke = positive ? 'var(--up)' : 'var(--down)';
  const gradientId = positive ? 'grad-up' : 'grad-down';

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(2)},${H - PAD.bottom} L${points[0].x.toFixed(2)},${H - PAD.bottom} Z`;

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // The SVG is scaled by viewBox, so map client px back into viewBox units.
    const x = ((event.clientX - rect.left) / rect.width) * W;

    let nearest = points[0];
    for (const p of points) {
      if (Math.abs(p.x - x) < Math.abs(nearest.x - x)) nearest = p;
    }
    setHover(nearest);
  }

  const label = hover ?? points[points.length - 1];
  // Keep the bubble inside the plot instead of letting it hang off either edge.
  const tipLeft = Math.min(88, Math.max(12, (label.x / W) * 100));

  return (
    <div className="chart-box">
      <div className="chart-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Price history, ${formatPrice(min)} to ${formatPrice(max)}`}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* High / low guide rails */}
          {[
            { key: 'max', v: max, y: PAD.top },
            { key: 'min', v: min, y: H - PAD.bottom },
          ].map(({ key, v, y }) => (
            <g key={key}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--outline-faint)" />
              <text
                x={W - PAD.right + 8}
                y={y + 4}
                fill="var(--on-surface-faint)"
                className="num"
                style={{ fontSize: 11 }}
              >
                {formatPrice(v)}
              </text>
            </g>
          ))}

          {/* Window-open reference line */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--on-surface-faint)"
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.7"
          />
          <text
            x={W - PAD.right + 8}
            y={baselineY + 4}
            fill="var(--on-surface-faint)"
            className="num"
            style={{ fontSize: 11 }}
          >
            {formatPrice(baseline)}
          </text>

          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {hover && (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--on-surface-faint)"
              strokeWidth="1"
            />
          )}
          <circle cx={label.x} cy={label.y} r="4" fill={stroke} stroke="var(--surface)" strokeWidth="2" />
        </svg>

        {hover && (
          <div className="chart-tip" style={{ left: `${tipLeft}%` }}>
            <span>{hover.candle.date}</span>
            <b className="num">{formatPrice(hover.candle.close)}</b>
          </div>
        )}
      </div>

      <div className="chart-dates">
        <span>{points[0].candle.date}</span>
        <span>{points[points.length - 1].candle.date}</span>
      </div>
    </div>
  );
}
