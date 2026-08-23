import { useLayoutEffect, useRef, useState } from 'react';
import { useWatchedAnywhere, useWatchlists } from '../hooks/useWatchlist';
import { createList, toggleInList } from '../lib/watchlist';
import { PopMenu } from './PopMenu';

/**
 * The star, and the menu of lists behind it.
 *
 * With one list a star could be a toggle. With several it cannot: "which one
 * did that go into" is a question a single click has no way to answer, and a
 * wrong guess files a symbol somewhere its owner will not look. So the star
 * opens the lists with the ones holding this symbol ticked, and every row in it
 * is a checkbox of its own.
 *
 * It borrows `.menu` for its shell — the same portal, shadow and rounding as
 * every other popup here — and nothing else. The rows are checkboxes, not
 * options, so they are their own control with their own states rather than
 * `.menu-item` (which is styled for a `div`) with a tick glyph wedged in.
 *
 * Portalled to `<body>` and positioned from the trigger's rect, the same way
 * `SelectMenu` does it and for the same reason: the trigger lives in a table
 * card that clips its overflow to keep its rounded corners, so an absolutely
 * positioned menu would be sliced off at the card's edge.
 *
 * **Creating a list is inside the menu, not before it.** The moment someone
 * wants a second list is the moment they are looking at the row that belongs in
 * it, and sending them to another section to make one first loses both the row
 * and the thought.
 */

const MENU_W = 268;
/** Heading, the "new list" action and the list's own padding — what is not rows. */
const CHROME_H = 92;

interface Props {
  symbol: string;
  /** `lg` is the drawer's copy: a header control rather than a cell decoration. */
  size?: 'sm' | 'lg';
}

export function WatchPicker({ symbol, size = 'sm' }: Props) {
  // A boolean, not the lists: see `useWatchedAnywhere`. The menu is what
  // subscribes to the lists, and it exists only while it is open.
  const watched = useWatchedAnywhere(symbol);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const px = size === 'lg' ? 19 : 15;

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`star${size === 'lg' ? ' star-lg' : ''}`}
        data-on={watched}
        data-open={open}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          watched ? `Change which watchlists hold ${symbol}` : `Save ${symbol} to a watchlist`
        }
        title={`${watched ? 'Saved — click to change' : 'Save to a watchlist'}${
          size === 'lg' ? ' · shortcut: w' : ''
        }`}
        onClick={(e) => {
          // The whole row opens the drawer; starring is not opening.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {/* Filled when it is in a list, outline when it is not — the shape is
            the state, so a column of 50 rows reads without relying on colour. */}
        <svg width={px} height={px} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" fill={watched ? 'currentColor' : 'none'} aria-hidden>
          <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" strokeLinejoin="round" />
        </svg>
      </button>

      {open && <WatchMenu symbol={symbol} trigger={btnRef} onClose={close} />}
    </>
  );
}

/**
 * The rows of the menu, and the field that makes another one.
 *
 * A separate component because it is the only thing here that needs the lists
 * themselves: it mounts when the menu opens and unmounts when it closes, so the
 * table's stars never subscribe to anything larger than a boolean.
 *
 * Focus lives on the menu itself and a roving `active` index draws the
 * highlight, which is how `SelectMenu` does it — one focus stop, arrow keys to
 * move, and no tabbing through twenty checkboxes to reach what is below.
 */
function WatchMenu({
  symbol,
  trigger,
  onClose,
}: {
  symbol: string;
  trigger: React.RefObject<HTMLButtonElement>;
  onClose: (refocus?: boolean) => void;
}) {
  const { lists } = useWatchlists();
  // Straight into the field when there is nothing to tick — with no lists, "add
  // to which one" has exactly one useful answer.
  const [creating, setCreating] = useState(lists.length === 0);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  /** Creates the list *and* puts the symbol in it — one action, not two. */
  function commitNew() {
    const name = draft.trim();
    if (name !== '') toggleInList(createList(name), symbol);
    setCreating(false);
    setDraft('');
  }

  /** The rows plus the "new list" action, which the arrow keys treat as last. */
  const stops = lists.length + 1;

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (i + 1) % stops);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (i - 1 + stops) % stops);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(stops - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= lists.length) setCreating(true);
        else toggleInList(lists[active].id, symbol);
        break;
      // Nothing inside is a tab stop of its own, so Tab leaves the menu instead
      // of walking every checkbox to get past it.
      case 'Tab':
        onClose();
        break;
    }
  }

  return (
    <PopMenu
      trigger={trigger}
      rows={lists.length}
      chrome={CHROME_H}
      width={MENU_W}
      ariaLabel={`Watchlists for ${symbol}`}
      onClose={onClose}
      onKeyDown={onKeyDown}
    >
      <div className="wl-menu-head">
        Save <b>{symbol}</b> to
      </div>

      {lists.length > 0 && (
        <div className="wl-menu-list">
          {lists.map((list, i) => {
            const has = list.symbols.includes(symbol);
            return (
              <button
                key={list.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={has}
                className="wl-opt"
                data-active={i === active}
                onPointerEnter={() => setActive(i)}
                // Stays open: putting one symbol in two lists is the reason this
                // menu exists, and closing after the first tick would make that
                // two trips.
                onClick={() => toggleInList(list.id, symbol)}
              >
                <span className="wl-box" data-on={has} aria-hidden>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m4 12.5 5.5 5.5L20 6.5" />
                  </svg>
                </span>
                <span className="wl-opt-name">{list.name}</span>
                <span className="wl-opt-count num">{list.symbols.length}</span>
              </button>
            );
          })}
        </div>
      )}

      {creating ? (
        <div className="wl-menu-new">
          <input
            ref={inputRef}
            value={draft}
            maxLength={40}
            placeholder="Name this list"
            aria-label="New watchlist name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Stopped before the menu's own handler: keys typed into a field
              // are text, and Escape here should leave the field, not the menu.
              e.stopPropagation();
              if (e.key === 'Enter') commitNew();
              else if (e.key === 'Escape') {
                setCreating(false);
                setDraft('');
              }
            }}
            onBlur={commitNew}
          />
        </div>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="wl-opt wl-menu-add"
          data-active={active >= lists.length}
          onPointerEnter={() => setActive(lists.length)}
          onClick={() => setCreating(true)}
        >
          <span className="wl-add-icon" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="wl-opt-name">New list</span>
        </button>
      )}
    </PopMenu>
  );
}
