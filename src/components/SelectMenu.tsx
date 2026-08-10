import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuOption {
  value: string;
  label: string;
  /** Optional second line. Used where the label alone is a bare code. */
  hint?: string;
}

interface Props {
  id?: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  /** Announced to screen readers in place of a visible <label>. */
  ariaLabel: string;
  /** Floor for the popup width; it never goes narrower than its trigger. */
  minMenuWidth?: number;
}

const ITEM_H = 40;
/** A hint adds a second line, so the height used to size the popup must grow. */
const ITEM_H_WITH_HINT = 58;
const MAX_MENU_H = 320;

/**
 * A listbox that replaces `<select>`.
 *
 * A native select's popup is drawn by the operating system, so no amount of
 * CSS reaches it — on a dark theme it renders as a bright system list that
 * belongs to no design system at all. This draws the list itself.
 *
 * The menu is portalled to `<body>` because its trigger lives inside the table
 * card, which clips its overflow to keep the rounded corners; an absolutely
 * positioned menu would be cut off at the card edge.
 */
export function SelectMenu({ id, value, options, onChange, ariaLabel, minMenuWidth = 200 }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[selectedIndex];

  function openMenu() {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.max(r.width, minMenuWidth);
    const itemH = options.some((o) => o.hint) ? ITEM_H_WITH_HINT : ITEM_H;
    const wanted = Math.min(MAX_MENU_H, options.length * itemH + 12);

    // Drop upward when there isn't room below — on a phone the sort bar can sit
    // low enough that a downward menu would run off the viewport. Whichever
    // side wins, the height is capped to the space actually available so the
    // menu scrolls internally instead of overflowing the screen.
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    const dropDown = below >= wanted || below >= above;
    const maxHeight = Math.max(140, Math.min(wanted, dropDown ? below : above));

    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: dropDown ? r.bottom + 6 : r.top - maxHeight - 6,
      width,
      maxHeight,
    });
    setActive(selectedIndex);
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  function commit(index: number) {
    onChange(options[index].value);
    close();
  }

  // Move focus into the menu so arrow keys and Escape land there, and bring the
  // current selection into view when the list is longer than the popup.
  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
    menuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      close(false);
    };
    // The trigger's position is captured on open, so anything that moves it
    // invalidates the menu — simplest correct response is to dismiss. Scrolling
    // *inside* the menu moves nothing, so it must not count: this listener is
    // on the capture phase and sees the menu's own scroll events too.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    const onResize = () => close(false);

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(active);
        break;
      case 'Tab':
        close(false);
        break;
    }
  }

  return (
    <>
      <button
        id={id}
        ref={btnRef}
        type="button"
        className="menu-btn"
        data-open={open}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <span>{current?.label ?? ''}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="menu"
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={i === selectedIndex}
                data-active={i === active}
                data-selected={i === selectedIndex}
                className="menu-item"
                onPointerEnter={() => setActive(i)}
                onClick={() => commit(i)}
              >
                <span className="menu-check" aria-hidden>
                  {i === selectedIndex ? '✓' : ''}
                </span>
                {o.hint ? (
                  <span className="menu-text">
                    <span>{o.label}</span>
                    <span className="menu-hint">{o.hint}</span>
                  </span>
                ) : (
                  o.label
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
