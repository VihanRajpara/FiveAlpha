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
 * again the next time the list changes — but they are *counted*, because at the
 * size this now runs at (the whole market, not a 400-row shortlist) some of a
 * few thousand requests will fail, and a row left blank with nothing said about
 * it reads as a signal that does not exist rather than one that was not read.
 */
export interface SignalsProgress {
  version: number;
  pending: number;
  /** How many this pass set out to read. `pending` is measured against it. */
  total: number;
  /** Requests that came back empty. Not cached, so the next pass asks again. */
  failed: number;
}

export function useSignals(rows: SecurityWithQuote[], enabled: boolean): SignalsProgress {
  const [state, setState] = useState<SignalsProgress>({
    version: 0,
    pending: 0,
    total: 0,
    failed: 0,
  });

  useEffect(() => {
    if (!enabled) return;

    const missing = rows.filter((r) => peekReading(r.ticker) === undefined);
    if (missing.length === 0) {
      setState((s) => (s.pending === 0 && s.failed === 0 ? s : { ...s, pending: 0, failed: 0 }));
      return;
    }

    let alive = true;
    let left = missing.length;
    let failed = 0;
    const total = missing.length;
    setState((s) => ({ version: s.version, pending: left, total, failed: 0 }));

    /**
     * How many arrivals between renders.
     *
     * Every render re-filters and re-sorts the list, so the update rate has to
     * scale with the list rather than sit at a constant. Ten was right for the
     * four hundred rows this used to be capped at; on the whole market it is
     * two hundred re-sorts of five thousand rows. A fortieth of the pass is
     * ~40 updates however long it runs — still a bar that visibly moves.
     */
    const step = Math.max(10, Math.round(total / 40));

    for (const row of missing) {
      // `fetchReading` is already gated to 8 in flight, so this loop queues
      // rather than opening a socket per row.
      fetchReading(row.ticker)
        .catch(() => {
          failed++;
        })
        .then(() => {
          if (!alive) return;
          left--;
          if (left === 0 || left % step === 0) {
            setState((s) => ({ version: s.version + 1, pending: left, total, failed }));
          }
        });
    }

    return () => {
      alive = false;
    };
  }, [rows, enabled]);

  return state;
}
