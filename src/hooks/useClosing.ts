import { useCallback, useEffect, useRef, useState } from 'react';

/** Matches the exit durations in index.css. One number, two places, so it is a constant. */
const EXIT_MS = 200;

const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * Holds a dialog on screen long enough to animate out.
 *
 * Entry needs no help — the element mounts and a keyframe runs. Exit is the
 * asymmetric half: React unmounts the node the instant its condition goes
 * false, and a node that is no longer in the document cannot animate. So both
 * dialogs slid in and then simply vanished, which is the one thing that made
 * them feel like markup rather than like objects.
 *
 * The caller closes through `close()` instead of its own handler: this flips
 * `closing` (the stylesheet keys the exit off `data-closing`), waits one
 * animation, then does the real close.
 *
 * `open` is read as well as `onClose` because not every close comes through
 * here — the filter sheet shuts itself when the layout crosses its breakpoint —
 * and a run of the exit state left standing would make the next open start
 * mid-departure.
 *
 * Under `prefers-reduced-motion` the wait collapses to nothing. The point of
 * that setting is not to be shown a gentler exit; it is not to be made to wait
 * for one.
 */
export function useClosing(open: boolean, onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number>();

  useEffect(() => {
    if (open) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setClosing(false);
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = useCallback(() => {
    // Escape, the scrim and the ✕ can all arrive while the exit is already
    // running; without this the timer restarts and the dialog lingers.
    if (timer.current !== undefined) return;
    const instant = window.matchMedia?.(REDUCED).matches ?? false;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      onClose();
    }, instant ? 0 : EXIT_MS);
  }, [onClose]);

  return { closing, close };
}
