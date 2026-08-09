import { useMemo, useRef, useState } from 'react';
import type { Candle } from '../types';
import { formatPrice } from '../lib/format';

const W = 520;
const H = 190;
const PAD = { top: 12, right: 46, bottom: 20, left: 8 };

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

    const points: Point[] = candles
      .filter((c): c is Candle & { close: number } => typeof c.close === 'number')
      .map((c, i, arr) => ({
        x: PAD.left + (i / (arr.length - 1)) * plotW,
        y: PAD.top + (1 - (c.close - min) / span) * plotH,
        candle: c,
      }));

    return { points, min, max, plotH };
  }, [candles]);

  if (!model) {
    return (
      <div className="center-msg" style={{ padding: '48px 12px' }}>
        No price history available for this symbol.
      </div>
    );
  }

  const { points, min, max } = model;
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

  return (
    <div className="chart-box">
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
            <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* High / low guide rails */}
        {[
          { v: max, y: PAD.top },
          { v: min, y: H - PAD.bottom },
        ].map(({ v, y }) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <text
              x={W - PAD.right + 6}
              y={y + 3.5}
              fontSize="10"
              fill="var(--text-faint)"
              className="num"
            >
              {formatPrice(v)}
            </text>
          </g>
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />

        {hover && (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="var(--text-faint)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}
        <circle cx={label.x} cy={label.y} r="3.4" fill={stroke} stroke="var(--panel)" strokeWidth="1.6" />
      </svg>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--text-dim)',
          padding: '2px 8px 0',
        }}
      >
        <span>{points[0].candle.date}</span>
        <span className="num" style={{ fontWeight: 600, color: 'var(--text)' }}>
          {label.candle.date} · {formatPrice(label.candle.close)}
        </span>
        <span>{points[points.length - 1].candle.date}</span>
      </div>
    </div>
  );
}
