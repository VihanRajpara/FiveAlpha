import { useEffect, useState } from 'react';
import { fetchReading, peekReading } from '../lib/signals';
import type { SecurityWithQuote } from '../types';

/**
 * Fills the signal cache for a whole list, rather than for the cells on screen.
 *
 * `useSignal` fetches per visible cell, which is right for *showing* the column
 * and useless for *filtering* on it: a filter has to judge every row, including
 * the ones the user would have to scroll past to trigger. So when a signal
 * filter is switched on, this walks the list and fills the same day-cache the
 * cells read from — nothing is duplicated, and rows already seen cost nothing.
 *
 * Returns how many are still outstanding, so the UI can say why the table is
 * short of answers. `version` exists only to re-run the caller's filter as
 * answers land; the answers themselves are read back through `peekSignal`.
 *
 * Failures are not cached (see `fetchSignal`), so a row that errored is asked
 * again the next time the list changes.
 */
export function useSignals(
  rows: SecurityWithQuote[],
  enabled: boolean,
): { version: number; pending: number } {
  const [state, setState] = useState({ version: 0, pending: 0 });

  useEffect(() => {
    if (!enabled) return;

    const missing = rows.filter((r) => peekReading(r.ticker) === undefined);
    if (missing.length === 0) {
      setState((s) => (s.pending === 0 ? s : { ...s, pending: 0 }));
      return;
    }

    let alive = true;
    let left = missing.length;
    setState((s) => ({ version: s.version, pending: left }));

    for (const row of missing) {
      // `fetchReading` is already gated to 8 in flight, so this loop queues
      // rather than opening a socket per row.
      fetchReading(row.ticker)
        .catch(() => null)
        .then(() => {
          if (!alive) return;
          left--;
          // Batched: re-filtering 2,000 rows on every one of 600 arrivals is
          // the difference between a list that fills in and a locked tab.
          if (left === 0 || left % 10 === 0) {
            setState((s) => ({ version: s.version + 1, pending: left }));
          }
        });
    }

    return () => {
      alive = false;
    };
  }, [rows, enabled]);

  return state;
}
