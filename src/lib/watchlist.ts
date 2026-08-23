/**
 * Named watchlists, kept in `localStorage` and shared by every component that
 * renders one.
 *
 * Not a `dayCache`: everything else this app stores is an *answer* it could
 * recompute — prices, ratios, a ten-year high — so those expire in whole days
 * and are cheap to lose. A watchlist is the one thing here the user typed in,
 * and it has to survive a reload, a rebuild and a cache version bump. Hence its
 * own key, no expiry, and a codec that is just names and symbols.
 *
 * Symbols are `Security.symbol` — the app's own identity for a company (NSE
 * symbol where there is one, BSE scrip id otherwise) rather than the Yahoo
 * ticker, so a row that changes exchange listing keeps its place.
 *
 * **A symbol can be in any number of lists.** The star opens a picker naming
 * them (src/components/WatchPicker.tsx) rather than writing to one — with more
 * than one list, "which one did that go into" is a question a single click
 * cannot answer, and a wrong guess is a symbol filed somewhere you will not
 * look. The star is *filled* when the symbol is in at least one list.
 *
 * The active list is still a thing, but it now only means "the one the
 * Watchlists section is showing", plus the target for the `w` shortcut, which
 * has no anchor to hang a picker off.
 *
 * `useSyncExternalStore` is what React 18 offers for exactly this shape, so
 * there is no context, no provider and no prop-drilling. The snapshot has to be
 * referentially stable between changes or that hook loops forever, which is why
 * `state` is rebuilt on write and merely read on render.
 *
 * **The database is behind this, not in front of it.** Every change is applied
 * locally and rendered before anything is sent anywhere; src/lib/watchlistSync.ts
 * mirrors it into Postgres afterwards and is allowed to fail. That order is what
 * makes the app work offline, work with an empty .env, and never show a spinner
 * for a star. See supabase/migrations/0006_watchlists.sql for how rows are owned
 * when there is no sign-in.
 */

const KEY = 'fivealpha:watchlist';

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface WatchlistState {
  lists: Watchlist[];
  /** Always a list that exists — see `normalise`. */
  activeId: string;
}

const DEFAULT_NAME = 'My watchlist';

const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let state: WatchlistState | null = null;
const listeners = new Set<() => void>();

/**
 * Whatever was in storage, as something the app can render.
 *
 * Three shapes arrive here and all three have to work, because the second is
 * what every existing user has:
 *
 *   · `{ lists, activeId }` — what this version writes.
 *   · `["TCS", "INFY"]` — the single unnamed list the first version wrote. It
 *     becomes one named list rather than being dropped; losing someone's stars
 *     to a refactor is not a migration.
 *   · anything else — corrupt, half-written, or from a future version. One
 *     empty list, because a broken store must not take the table down with it.
 */
function normalise(raw: unknown): WatchlistState {
  const blank = (symbols: string[] = []): WatchlistState => {
    const list = { id: newId(), name: DEFAULT_NAME, symbols };
    return { lists: [list], activeId: list.id };
  };

  if (Array.isArray(raw)) {
    return blank(raw.filter((s): s is string => typeof s === 'string' && s !== ''));
  }

  const lists = (raw as WatchlistState | null)?.lists;
  if (!Array.isArray(lists)) return blank();

  const clean = lists
    .filter((l): l is Watchlist => !!l && typeof l.id === 'string' && typeof l.name === 'string')
    .map((l) => ({
      id: l.id,
      name: l.name,
      symbols: Array.isArray(l.symbols)
        ? l.symbols.filter((s): s is string => typeof s === 'string' && s !== '')
        : [],
    }));

  if (clean.length === 0) return blank();

  const activeId = (raw as WatchlistState).activeId;
  return {
    lists: clean,
    // A stored active id that no longer names a list would leave every star
    // writing into nothing.
    activeId: clean.some((l) => l.id === activeId) ? activeId : clean[0].id,
  };
}

function load(): WatchlistState {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = normalise(raw ? JSON.parse(raw) : null);
  } catch {
    // Private mode, disabled storage, or bad JSON. In-memory still works.
    state = normalise(null);
  }
  return state;
}

function write(next: WatchlistState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full quota loses the write, not the session.
  }
}

/**
 * Replaces the state, writes it through, tells everyone — and only then sends
 * it upstream.
 *
 * `changed` names the one list to push, which is the common case and one row on
 * the wire. Anything that moves more than one list (creating, deleting, and so
 * every position after it) passes nothing and re-sends the lot; a watchlist
 * table is a handful of rows, so the lazy version of that is also the right one.
 */
function commit(next: WatchlistState, changed?: string): void {
  state = next;
  write(next);
  for (const listener of listeners) listener();

  import('./watchlistSync')
    .then(({ pushAll, pushList }) => {
      const index = changed ? next.lists.findIndex((l) => l.id === changed) : -1;
      return index >= 0 ? pushList(next.lists[index], index) : pushAll(next);
    })
    .catch(() => {
      /* Offline, unconfigured, or blocked. The local copy is the app. */
    });
}

/**
 * Pulls the database copy in once per page and adopts it.
 *
 * Runs on the first read, not at import: nothing should hit the network because
 * a module was loaded. Which copy wins is decided by which one *exists* — the
 * remote if it has rows, the local if the owner has none there yet — rather
 * than by a timestamp, because there is one user and the alternative is
 * merge machinery for a conflict that does not happen.
 */
let hydrated = false;
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;

  import('./watchlistSync')
    .then(async ({ pullLists, pushAll, remoteEnabled }) => {
      if (!remoteEnabled) return;

      const remote = await pullLists();
      // Null is "could not ask" — the local copy stands and is not overwritten.
      if (remote === null) return;

      if (remote.length === 0) {
        // A first run, or this browser starring things before the table
        // existed. Send what is here rather than wiping it.
        const current = load();
        if (current.lists.some((l) => l.symbols.length > 0)) await pushAll(current);
        return;
      }

      const current = load();
      state = normalise({
        lists: remote,
        // Keep looking at the same list if it came back, since the user may
        // already have clicked a tab while this was in flight.
        activeId: remote.some((l) => l.id === current.activeId) ? current.activeId : remote[0].id,
      });
      write(state);
      for (const listener of listeners) listener();
    })
    // One line, not the error: the only thing this can catch is the sync module
    // failing to load at all, and `pullLists` logs anything that goes wrong
    // once it has. A stack trace here would be noise on every offline start.
    .catch(() => console.warn('watchlist sync unavailable — using the local copy'));
}

/** The lists and which one is active, stable between changes. */
export function watchlistSnapshot(): WatchlistState {
  const current = load();
  hydrate();
  return current;
}

export function subscribeWatchlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const activeList = (): Watchlist => {
  const { lists, activeId } = load();
  return lists.find((l) => l.id === activeId) ?? lists[0];
};

/** Is this symbol in the *active* list? */
export const isWatched = (symbol: string): boolean => activeList().symbols.includes(symbol);

/**
 * Is it in any list at all?
 *
 * What the star's fill means. A symbol filed in "Long term" should not read as
 * unstarred because you happen to be looking at "Momentum" — the star answers
 * "have I saved this", and the picker answers "where".
 */
export const isWatchedAnywhere = (symbol: string): boolean =>
  load().lists.some((l) => l.symbols.includes(symbol));

/** The ids of the lists holding this symbol — the picker's tick marks. */
export const listsWith = (symbol: string): string[] =>
  load()
    .lists.filter((l) => l.symbols.includes(symbol))
    .map((l) => l.id);

/** Adds to one named list if absent, removes if present. Returns the new state. */
export function toggleInList(listId: string, symbol: string): boolean {
  const current = load();
  const list = current.lists.find((l) => l.id === listId);
  if (!list) return false;

  const has = list.symbols.includes(symbol);
  commit(
    {
      ...current,
      lists: current.lists.map((l) =>
        l.id !== listId
          ? l
          : // Newest first: a list is read from the top, and the row you just
            // starred is the one you were looking at.
            { ...l, symbols: has ? l.symbols.filter((s) => s !== symbol) : [symbol, ...l.symbols] },
      ),
    },
    listId,
  );

  return !has;
}

/** Adds to the active list if absent, removes if present. Returns the new state. */
export const toggleWatch = (symbol: string): boolean => toggleInList(activeList().id, symbol);

export function setActiveList(id: string): void {
  const current = load();
  if (!current.lists.some((l) => l.id === id) || current.activeId === id) return;
  commit({ ...current, activeId: id });
}

/** Creates a list and makes it active — you make one in order to fill it. */
export function createList(name: string): string {
  const current = load();
  const list = { id: newId(), name: cleanName(name, current.lists.length), symbols: [] };
  commit({ lists: [...current.lists, list], activeId: list.id });
  return list.id;
}

export function renameList(id: string, name: string): void {
  const current = load();
  commit({
    ...current,
    lists: current.lists.map((l) => (l.id === id ? { ...l, name: cleanName(name, 0, l.name) } : l)),
  }, id);
}

/**
 * Removes a list. The last one is emptied instead of removed: "no lists at all"
 * is a state with no way out of it — every control that could make one hangs
 * off a list being selected.
 */
export function deleteList(id: string): void {
  const current = load();
  if (current.lists.length <= 1) {
    commit({ ...current, lists: current.lists.map((l) => ({ ...l, symbols: [] })) });
    return;
  }
  const lists = current.lists.filter((l) => l.id !== id);
  commit({ lists, activeId: id === current.activeId ? lists[0].id : current.activeId });

  // `commit` re-sends what is left, which cannot remove what is gone.
  import('./watchlistSync')
    .then(({ deleteRemoteList }) => deleteRemoteList(id))
    .catch(() => {
      /* Local is the app; a stale row upstream is harmless and re-deleted next
         time this runs online. */
    });
}

export function removeFromList(id: string, symbol: string): void {
  const current = load();
  commit({
    ...current,
    lists: current.lists.map((l) =>
      l.id === id ? { ...l, symbols: l.symbols.filter((s) => s !== symbol) } : l,
    ),
  }, id);
}

/** Empties a list without removing it. */
export function clearList(id: string): void {
  const current = load();
  commit({
    ...current,
    lists: current.lists.map((l) => (l.id === id ? { ...l, symbols: [] } : l)),
  }, id);
}

/** Trimmed, length-capped, and never blank — a nameless tab cannot be clicked. */
const MAX_NAME = 40;
const cleanName = (name: string, index: number, fallback?: string): string =>
  name.trim().slice(0, MAX_NAME) || fallback || `List ${index + 1}`;

// Another tab is the same user with the same lists, and a star that disagrees
// between two windows is the kind of thing nobody reports and everybody
// notices. The event only fires in the *other* tabs, so this cannot loop.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    state = null;
    load();
    for (const listener of listeners) listener();
  });
}
