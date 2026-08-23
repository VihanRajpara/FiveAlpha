import { useEffect, useRef, useState } from 'react';
import { useWatchlists } from '../hooks/useWatchlist';
import { PopMenu } from './PopMenu';
import { clearList, createList, deleteList, renameList, setActiveList } from '../lib/watchlist';

/**
 * The Watchlists section's control: which list you are looking at, and what you
 * can do to it.
 *
 * It stands where the screen bar stands in the other section and borrows its
 * shell, because it is the same kind of object — the thing that decides what
 * the table below is showing. The lists themselves are tabs rather than a
 * dropdown: there are two or three of them, they are the primary navigation of
 * this section, and a dropdown hides the count that tells you which one you
 * meant.
 *
 * Renaming and creating share one inline field. A `prompt()` would have been
 * two lines and is what this nearly was, but it is the one dialog a browser
 * still renders as an alert box, and it is blocked outright in some embeds —
 * an inline input is a few lines more and cannot be turned off.
 */
/** The actions menu's heading and padding — see `PopMenu`. */
const MORE_CHROME = 48;

export function WatchlistBar({ shown }: { shown: number }) {
  const { lists, activeId } = useWatchlists();
  const active = lists.find((l) => l.id === activeId) ?? lists[0];

  /** `null` when idle, otherwise the list being renamed or `'new'`. */
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startNew = () => {
    setDraft('');
    setEditing('new');
  };

  const startRename = () => {
    setDraft(active.name);
    setEditing(active.id);
  };

  const commit = () => {
    if (editing === 'new') createList(draft);
    else if (editing) renameList(editing, draft);
    setEditing(null);
  };

  return (
    <div className="screenbar">
      <div className="screenbar-row wl-row">
        <span className="filter-label">Watchlists</span>

        <div className="wl-tabs" role="tablist" aria-label="Watchlists">
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              role="tab"
              className="wl-tab"
              aria-selected={list.id === activeId}
              data-active={list.id === activeId}
              onClick={() => setActiveList(list.id)}
              onDoubleClick={() => list.id === activeId && startRename()}
              title={
                list.id === activeId
                  ? 'The list the star adds to — double-click to rename'
                  : `Switch to ${list.name}`
              }
            >
              {list.name}
              <span className="wl-tab-count num">{list.symbols.length}</span>
            </button>
          ))}

          {editing === null && (
            <button type="button" className="wl-tab wl-new" onClick={startNew} title="New watchlist">
              + New
            </button>
          )}
        </div>

        {editing !== null && (
          <span className="wl-edit">
            <input
              ref={inputRef}
              value={draft}
              autoFocus
              maxLength={40}
              placeholder={editing === 'new' ? 'New list name' : 'Rename list'}
              aria-label={editing === 'new' ? 'New watchlist name' : 'Rename watchlist'}
              onChange={(e) => setDraft(e.target.value)}
              // Enter and Escape, because a one-field form has no buttons worth
              // reaching for. Blur commits too — clicking away from a name you
              // have typed should not throw it away.
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={commit}
            />
          </span>
        )}

        <span className="spacer" />

        {/* One control, not three. Rename, Empty and Delete are things you do
            to a list occasionally and two of them are destructive — a toolbar
            that shouts "Delete" at you on every visit is a toolbar you stop
            reading. */}
        <div className="wl-more">
          <button
            ref={moreRef}
            type="button"
            className="icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${active.name}`}
            title={`Actions for ${active.name}`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>

          {menuOpen && (
            <PopMenu
              trigger={moreRef}
              rows={3}
              chrome={MORE_CHROME}
              width={236}
              ariaLabel={`Actions for ${active.name}`}
              onClose={() => setMenuOpen(false)}
            >
              <div className="wl-menu-head">
                <b>{active.name}</b>
              </div>
              <div className="wl-menu-list">
                <button type="button" role="menuitem" className="wl-opt" onClick={() => { setMenuOpen(false); startRename(); }}>
                  <span className="wl-opt-name">Rename</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="wl-opt"
                  disabled={active.symbols.length === 0}
                  onClick={() => {
                    setMenuOpen(false);
                    if (confirm(`Remove all ${active.symbols.length} symbols from “${active.name}”?`)) {
                      clearList(active.id);
                    }
                  }}
                >
                  <span className="wl-opt-name">Remove all symbols</span>
                  <span className="wl-opt-count num">{active.symbols.length}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="wl-opt wl-opt-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    // The last list is emptied rather than removed — see `deleteList`.
                    const last = lists.length <= 1;
                    const ask = last
                      ? `“${active.name}” is your only list, so it will be emptied rather than deleted. Continue?`
                      : `Delete “${active.name}” and its ${active.symbols.length} symbols?`;
                    if (confirm(ask)) deleteList(active.id);
                  }}
                >
                  <span className="wl-opt-name">Delete list</span>
                </button>
              </div>
            </PopMenu>
          )}
        </div>
      </div>

      {active.symbols.length === 0 ? (
        <p className="screen-note">
          Nothing in <b>{active.name}</b> yet. Star a row anywhere in the app — in Screener, or in
          a company drawer, or with <kbd>w</kbd> while one is open — and it lands in whichever list
          is selected here.
        </p>
      ) : (
        shown < active.symbols.length && (
          <p className="screen-note">
            {shown.toLocaleString('en-IN')} of {active.symbols.length.toLocaleString('en-IN')}{' '}
            shown — the filters and the search box apply here too.
          </p>
        )
      )}
    </div>
  );
}
