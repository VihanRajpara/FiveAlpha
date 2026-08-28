import { owner, supabase } from './supabaseClient';
import type { Watchlist, WatchlistState } from './watchlist';

/**
 * The database half of the watchlists.
 *
 * Split from the store itself so that the store stays a plain, synchronous,
 * testable thing and this stays the only place that knows a network exists.
 *
 * **Local first, always.** Every mutation lands in `localStorage` and on screen
 * immediately, and is pushed here afterwards; nothing in the UI ever waits for
 * a round trip, and nothing breaks when the request fails, when the project is
 * unconfigured (`npm run dev` with an empty .env) or when the browser is
 * offline. The database is durability, not availability — clearing site data on
 * a laptop should not be how someone loses a year of starred names.
 *
 * **Last write wins, per list.** There is one user and usually one tab, so
 * anything cleverer than that is machinery for a conflict that does not happen.
 * The `storage` event already keeps two tabs on one machine in step.
 */

const TABLE = 'watchlists';

/** Configured or not, decided once. */
export const remoteEnabled = supabase !== null;

/** Best-effort by design: a failed sync is logged and forgotten, never thrown. */
function warn(what: string, error: unknown): void {
  console.warn(`watchlist ${what} failed — keeping the local copy`, error);
}

/**
 * Everything this owner has, or null if there is nothing to say.
 *
 * Null and "an empty array of lists" are different answers and the caller
 * treats them differently: null means the database could not be reached or is
 * not configured, so the local copy stands. An empty array means this owner
 * genuinely has no rows yet — a first run, or a fresh browser — and the local
 * copy is what should be pushed up to fill it.
 */
export async function pullLists(): Promise<Watchlist[] | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, symbols, position')
    .order('position');

  if (error) {
    warn('pull', error);
    return null;
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: (row.name as string) ?? '',
    symbols: Array.isArray(row.symbols) ? (row.symbols as string[]) : [],
  }));
}

/**
 * Writes one list.
 *
 * `position` is the list's index, so the tab order survives a reload on another
 * machine. It is sent on every upsert rather than being maintained separately —
 * reordering is then just another write of the whole state.
 */
export async function pushList(list: Watchlist, position: number): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase.from(TABLE).upsert(
    {
      id: list.id,
      owner: owner(),
      name: list.name,
      symbols: list.symbols,
      position,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );

  if (error) warn('save', error);
}

export async function deleteRemoteList(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) warn('delete', error);
}

/**
 * Makes the remote copy match the local one, in one pass.
 *
 * Used after the first pull, when a browser that has lists locally meets an
 * owner that has none stored — and as the catch-all for any change that moves
 * more than one list (a delete reorders the rest).
 */
export async function pushAll(state: WatchlistState): Promise<void> {
  if (!supabase) return;
  await Promise.all(state.lists.map((list, index) => pushList(list, index)));
}
