import { useSyncExternalStore } from 'react';
import {
  activeList,
  isWatchedAnywhere,
  subscribeWatchlist,
  watchlistSnapshot,
  type Watchlist,
  type WatchlistState,
} from '../lib/watchlist';

/**
 * Whether the symbol is in *any* list — what a star's fill means, and the only
 * thing a table full of stars subscribes to.
 *
 * The lists themselves are read by the picker, which exists only while one is
 * open. That split is the whole performance story here: 250 rows watching a
 * boolean each re-render one row per change; 250 rows watching the state object
 * re-render the page.
 */
export const useWatchedAnywhere = (symbol: string): boolean =>
  useSyncExternalStore(
    subscribeWatchlist,
    () => isWatchedAnywhere(symbol),
    () => false,
  );

/** Every list and which one is active — the Watchlists section reads this. */
export const useWatchlists = (): WatchlistState =>
  useSyncExternalStore(subscribeWatchlist, watchlistSnapshot, () => EMPTY_STATE);

/** The list the star writes to. */
export const useActiveList = (): Watchlist =>
  useSyncExternalStore(subscribeWatchlist, activeList, () => EMPTY_LIST);

/** Server render has no localStorage; stable empties keep the hook quiet. */
const EMPTY_LIST: Watchlist = { id: '', name: '', symbols: [] };
const EMPTY_STATE: WatchlistState = { lists: [EMPTY_LIST], activeId: '' };
