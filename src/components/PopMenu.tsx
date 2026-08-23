import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A menu anchored to a button, portalled to `<body>`.
 *
 * Everything a popup here has to get right and nothing about what is in it:
 * where it opens, that it stays on screen, that it dismisses on an outside
 * click, a scroll, a resize or Escape, and that focus lands in it.
 *
 * It exists because the second popover in this app was written by hand —
 * `position: absolute; right: 0` inside its bar — and did what hand-rolled
 * popovers do: on a phone it opened over unrelated rows, off the left edge of
 * the window. The placement below is the same code the star's list picker uses,
 * and it is tested rather than eyeballed.
 *
 * Portalled rather than absolutely positioned because triggers live inside the
 * table card and the filter bar, both of which clip their overflow to keep
 * their rounded corners — an in-flow menu is sliced off at the card edge.
 */

const ROW_H = 38;
const MAX_H = 340;
const GAP = 6;
/** Kept clear of the viewport edge on both axes. */
const EDGE = 8;

export interface Anchor {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * How tall a menu of `rows` items wants to be, capped.
 *
 * `chrome` is everything that is not a row — a heading, a footer action, the
 * list's own padding — and differs per menu, so the caller states it rather
 * than this guessing.
 */
export const menuHeight = (rows: number, chrome: number): number =>
  Math.min(MAX_H, rows * ROW_H + chrome);

/**
 * Where the menu goes, given its trigger, the viewport and how tall it wants to
 * be.
 *
 * Pure and exported because getting it wrong is not cosmetic and is invisible
 * in a build. The first version of this reserved the 340px cap for a menu that
 * needed 140, which made "is there room below?" false for any row in the lower
 * half of a phone screen — the menu then opened hundreds of pixels above the
 * star that summoned it. So the height is settled *before* the side is chosen:
 * below unless it genuinely does not fit, then above, then whichever side has
 * more room, with the height capped to what is actually there so the content
 * scrolls inside the menu rather than off the screen.
 */
export function placeMenu(
  trigger: { left: number; top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  wanted: number,
  width: number,
): Anchor {
  const below = viewport.height - trigger.bottom - GAP - EDGE;
  const above = trigger.top - GAP - EDGE;
  const down = below >= wanted || below >= above;

  // Never a floor: a minimum height applied *after* this clamp is a menu that
  // hangs off the bottom of the screen. What the content wants, or what there
  // is room for — whichever is smaller.
  const maxHeight = Math.min(wanted, down ? below : above);

  return {
    // Clamped to the viewport on both axes: a trigger in a right-hand column,
    // or one near the top with a tall menu above it, would otherwise open off
    // the edge. Aligned to the trigger's left where there is room, because a
    // right-aligned menu on a narrow window runs off the *other* side.
    left: Math.max(EDGE, Math.min(trigger.left - 8, viewport.width - width - EDGE)),
    top: Math.max(EDGE, down ? trigger.bottom + GAP : trigger.top - maxHeight - GAP),
    maxHeight,
  };
}

interface Props {
  /** The button it hangs off. Must be mounted — render this only when open. */
  trigger: React.RefObject<HTMLElement>;
  /** Items the menu will show, for sizing it before it has rendered. */
  rows: number;
  /** Everything that is not a row: heading, footer action, padding. */
  chrome: number;
  width: number;
  ariaLabel: string;
  className?: string;
  onClose: (refocus?: boolean) => void;
  /** The menu's own keys — arrowing a list, say. Escape is handled here. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
}

export function PopMenu({
  trigger,
  rows,
  chrome,
  width,
  ariaLabel,
  className = '',
  onClose,
  onKeyDown,
  children,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Placed on the first render rather than in an effect: the trigger is already
  // mounted (this component only exists while the menu is open), so there is
  // nothing to wait for, and measuring afterwards would paint it in the wrong
  // place first.
  const [anchor] = useState<Anchor>(() => {
    const r = trigger.current?.getBoundingClientRect();
    const box = r ?? { left: 0, top: 0, right: 0, bottom: 0 };
    return placeMenu(
      box,
      { width: window.innerWidth, height: window.innerHeight },
      menuHeight(rows, chrome),
      width,
    );
  });

  useLayoutEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || trigger.current?.contains(target)) return;
      onClose();
    };
    // The trigger's position was measured on open, so anything that moves it
    // invalidates the menu. Scrolling *inside* the menu moves nothing, and this
    // listener is on the capture phase so it sees those events too.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const dismiss = () => onClose();

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, trigger]);

  return createPortal(
    <div
      ref={menuRef}
      className={`menu wl-menu ${className}`.trim()}
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      style={{ left: anchor.left, top: anchor.top, width, maxHeight: anchor.maxHeight }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
          return;
        }
        onKeyDown?.(e);
      }}
      // Clicks inside must not reach whatever is underneath — in the table that
      // is a row, and it would open the detail drawer behind the menu.
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
