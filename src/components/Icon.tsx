import { forwardRef, type SVGProps } from 'react';

/**
 * The app's one icon set.
 *
 * Geometry from Lucide (ISC), drawn on its 24px grid at one stroke weight, so
 * every glyph in the interface is the same family — the text characters that
 * used to stand in for icons (✕ ✓ ▲ ⤢) each came from whatever font happened
 * to be rendering them and never matched each other or the SVGs beside them.
 *
 * Inlined rather than a dependency: the app uses about twenty of them.
 * `up`/`down` are the exception — filled triangles, the market's own glyph
 * for direction, which reads at 8px where a stroked arrow does not.
 */
const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  filters: <path d="M4 6h16M7 12h10M10 18h4" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronsLeft: <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />,
  chevronsRight: <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  star: <path d="M11.5 2.8a.6.6 0 0 1 1 0l2.6 5.3 5.8.8a.6.6 0 0 1 .3 1l-4.2 4.1 1 5.8a.6.6 0 0 1-.8.6L12 17.7l-5.2 2.7a.6.6 0 0 1-.8-.6l1-5.8-4.2-4.1a.6.6 0 0 1 .3-1l5.8-.8z" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.7 6L3 15.7" />
      <path d="M3 12a9 9 0 0 1 15.7-6L21 8.3" />
      <path d="M21 3v5.3h-5.3M3 21v-5.3h5.3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  maximize: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  minimize: <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  logOut: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  wifiOff: (
    <>
      <path d="M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8a15 15 0 0 0-11.3-3.8M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-1.7-1.3" />
      <path d="m2 2 20 20" />
    </>
  ),
  palette: (
    <>
      <path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4.5-4.6 4.5h-1.9a1.8 1.8 0 0 0-1.3 3.1A1.6 1.6 0 0 1 12 22Z" />
      <circle cx="7.5" cy="11" r="1.1" />
      <circle cx="10.5" cy="6.8" r="1.1" />
      <circle cx="15.5" cy="7.5" r="1.1" />
    </>
  ),
  pipette: (
    <>
      <path d="m2 22 1-1h3l9-9" />
      <path d="M3 21v-3l9-9" />
      <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
} as const;

/** Filled, no stroke — see the note above. */
const SOLID = {
  up: <path d="M12 6 20 18H4z" />,
  down: <path d="M12 18 4 6h16z" />,
} as const;

export type IconName = keyof typeof PATHS | keyof typeof SOLID;

type Props = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  name: IconName;
  size?: number;
  /** Stroke weight in grid units; 1.75 reads as the body text's weight at 16–20px. */
  weight?: number;
};

export const Icon = forwardRef<SVGSVGElement, Props>(function Icon(
  { name, size = 18, weight = 1.75, className, ...rest },
  ref,
) {
  const solid = name in SOLID;
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? 'currentColor' : 'none'}
      stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className ? `icon ${className}` : 'icon'}
      {...rest}
    >
      {solid ? SOLID[name as keyof typeof SOLID] : PATHS[name as keyof typeof PATHS]}
    </svg>
  );
});
