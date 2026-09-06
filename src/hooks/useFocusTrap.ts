import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * What `aria-modal="true"` promises and neither dialog was keeping: focus
 * starts inside, Tab cannot leave, and it goes back where it came from on
 * close. Without it a keyboard user tabs straight out of the sheet into the
 * table behind it, which is still there, still focusable and now invisible
 * under a scrim.
 *
 * Escape stays with the caller — each dialog already closes itself, and the
 * two do it differently.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, open: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;

    // Captured before focus moves, so it is the control that opened the dialog.
    const restore = document.activeElement as HTMLElement | null;
    // `offsetParent` is null for anything `display: none` — the sheet's groups
    // are all rendered, but the layout hides some of them at some widths.
    const items = () =>
      [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);

    (items()[0] ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = items();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const edge = e.shiftKey ? f[0] : f[f.length - 1];
      // Also fires when focus has escaped entirely (browser chrome, or the page
      // behind), which is the case that puts it back rather than merely wrapping.
      if (document.activeElement === edge || !root.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? f[f.length - 1] : f[0]).focus();
      }
    };

    // Capture, so a handler on the focused control cannot swallow it first.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Guard the restore: the row a drawer opened from can be gone by the time
      // it closes (a refresh reorders the table), and focusing a detached node
      // silently drops focus to <body>.
      if (restore?.isConnected) restore.focus();
    };
  }, [ref, open]);
}

/**
 * Arrow keys for a `role="tablist"`. The role tells a screen reader the arrows
 * will move between the tabs and announces "1 of 2"; both bars claimed that and
 * neither did it, so the promise was the only part that shipped.
 *
 * Automatic activation — the selected tab follows focus — which is the right
 * variant here because switching costs nothing but a re-render.
 */
export function onTabListKeys(e: ReactKeyboardEvent<HTMLElement>) {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;

  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i === -1) return;

  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;

  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
