import { useEffect, useRef } from 'react';

/**
 * Entries pushed by overlays that have closed but whose entry is still on the
 * stack. Module-level because the claim below crosses component instances.
 */
let debt = 0;

/**
 * Take an entry for an overlay that is opening.
 *
 * Claims the entry a just-closed overlay left behind rather than stacking a
 * second one on top of it. Two things do that: StrictMode's
 * mount/unmount/mount in dev, and closing one overlay to open another in the
 * same tick. Both would otherwise cost two back presses to undo one.
 */
export function enter() {
  if (debt > 0) debt--;
  else history.pushState({ overlay: true }, '');
}

/**
 * Give back the entry of an overlay that is closing.
 *
 * `popped` means back is what closed it, so the entry is already gone and
 * going back again would leave the app. Otherwise it is still on the stack:
 * dropped a task later, so a remount in the same tick can claim it instead.
 */
export function leave(popped: boolean) {
  if (popped) return;
  debt++;
  setTimeout(() => {
    if (debt > 0) {
      debt--;
      history.back();
    }
  });
}

/**
 * Makes the device back button close an overlay instead of leaving the app.
 *
 * Installed as a PWA there is no browser chrome, so the only "back" is the
 * system one, and with a single history entry that means "quit". Every open
 * overlay pushes one entry; back pops it and closes the overlay, so back walks
 * out of the drawer, the sheet and the menus one at a time the way it does in
 * a native app, and only leaves once the screen is what it started as.
 *
 * Nothing else in the app is routed — the screener is one page and its state
 * belongs in memory, not the URL — so these entries carry no state and nothing
 * reads them back.
 *
 * `open` alone drives the effect: `close` is read through a ref so a handler
 * rebuilt every render does not tear the history entry down and push a new one.
 */
export function useBackClose(open: boolean, close: () => void) {
  const cb = useRef(close);
  cb.current = close;

  useEffect(() => {
    if (!open) return;

    enter();

    let popped = false;
    const onPop = () => {
      popped = true;
      cb.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      leave(popped);
    };
  }, [open]);
}
