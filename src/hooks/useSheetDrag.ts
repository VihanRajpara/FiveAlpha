import { useCallback, useRef, type RefObject } from 'react';

/** Past this much travel the sheet goes, however slowly it got there. */
const DISTANCE_DISMISS = 96;
/** …and under it, a flick still counts. px per ms. */
const VELOCITY_DISMISS = 0.35;
/** Matches the CSS exit. */
const SETTLE_MS = 200;

/**
 * UIScrollView's rubber band, which is the reason an over-dragged iOS sheet
 * feels like it is attached to something rather than hitting a wall.
 *
 * Resistance rises with distance instead of being a constant divisor: the first
 * few pixels come almost free, and by 200px the sheet has barely moved 40. `c`
 * is Apple's own 0.55.
 */
export function rubberBand(distance: number, dimension: number) {
  return (distance * 0.55 * dimension) / (dimension + 0.55 * distance);
}

/**
 * Distance *or* speed, never distance alone.
 *
 * A sheet that only listens to how far you dragged forces a deliberate haul
 * down the whole screen to do a thing you have already clearly asked for. A
 * quick flick is an unambiguous dismissal at 20px, and this is what makes the
 * gesture feel like it is reading intent rather than measuring pixels.
 */
export function shouldDismiss(offset: number, elapsedMs: number) {
  if (offset <= 0) return false;
  return offset >= DISTANCE_DISMISS || offset / Math.max(elapsedMs, 1) > VELOCITY_DISMISS;
}

/**
 * Drag-to-dismiss for the phone's bottom sheet.
 *
 * The handle at the top of the sheet has been drawn since the sheet existed and
 * has never done anything — an affordance that promises a gesture and does not
 * have one is worse than no affordance, because the reader learns the interface
 * lies. This is the gesture.
 *
 * Driven from the header only, deliberately. The body below it is a scroller,
 * and a drag that starts there is far more likely to mean "scroll" than
 * "dismiss"; fighting the scroller for the same pixels is how sheets end up
 * feeling possessed. The header is a fixed, non-scrolling grab bar and the
 * handle sits on it.
 *
 * Transforms are written straight onto the element rather than through a CSS
 * variable on a parent. A variable would be inherited, and changing an
 * inherited property recalculates styles for every descendant — on a sheet
 * holding a chart and three financial tables, on every pointer move.
 */
export function useSheetDrag(
  sheet: RefObject<HTMLElement>,
  scrim: RefObject<HTMLElement>,
  onDismiss: () => void,
  enabled: boolean,
) {
  const start = useRef<{ y: number; at: number } | null>(null);
  const offset = useRef(0);

  const paint = useCallback(
    (y: number) => {
      const el = sheet.current;
      if (!el) return;
      el.style.transform = y === 0 ? '' : `translateY(${y}px)`;
      // The scrim thins as the sheet leaves, so the page behind comes back at
      // the pace the finger sets. Tied to travel, not to a timer.
      if (scrim.current) {
        scrim.current.style.opacity = `${Math.max(0, 1 - y / (el.offsetHeight || 1))}`;
      }
    },
    [sheet, scrim],
  );

  const settle = useCallback(
    (to: 'back' | 'gone') => {
      const el = sheet.current;
      if (!el) return;
      el.style.transition = `transform ${SETTLE_MS}ms var(--ease-drawer)`;
      if (scrim.current) scrim.current.style.transition = `opacity ${SETTLE_MS}ms var(--ease-out)`;

      if (to === 'gone') {
        el.style.transform = 'translateY(100%)';
        if (scrim.current) scrim.current.style.opacity = '0';
        // Unmount only after it has actually left. Calling the close handler
        // now would drop the node mid-flight and the sheet would blink out from
        // wherever the finger left it.
        window.setTimeout(onDismiss, SETTLE_MS);
        return;
      }

      paint(0);
      if (scrim.current) scrim.current.style.opacity = '1';
      // Hand the element back to the stylesheet once it has arrived, or the
      // inline transition would still be sitting on it next time it opens.
      window.setTimeout(() => {
        if (!el) return;
        el.style.transition = '';
        el.style.transform = '';
        if (scrim.current) {
          scrim.current.style.transition = '';
          scrim.current.style.opacity = '';
        }
      }, SETTLE_MS);
    },
    [sheet, scrim, onDismiss, paint],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!enabled) return;
      // The star and the close button live on this bar and are controls, not
      // grab area.
      if ((e.target as HTMLElement).closest('button')) return;
      // A second finger arriving mid-drag would otherwise take over and the
      // sheet would jump to it.
      if (start.current) return;

      const el = sheet.current;
      if (!el) return;
      start.current = { y: e.clientY, at: performance.now() };
      offset.current = 0;
      el.style.transition = 'none';
      // Keeps the move/up events coming even once the finger leaves the header.
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [enabled, sheet],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const dy = e.clientY - start.current.y;
      // Upward is resisted rather than forbidden. Things in the world slow down
      // before they stop; an invisible wall is the tell that this is a div.
      offset.current = dy >= 0 ? dy : -rubberBand(-dy, window.innerHeight);
      paint(offset.current);
    },
    [paint],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const elapsed = performance.now() - start.current.at;
      const travelled = offset.current;
      start.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      settle(shouldDismiss(travelled, elapsed) ? 'gone' : 'back');
    },
    [settle],
  );

  return enabled ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } : {};
}
