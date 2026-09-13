import { useEffect, useState } from 'react';
import { fetchReading, peekReading } from '../lib/signals';
import { isUnknownTicker } from '../lib/yahooCandles';
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
  /** Requests that came back empty for a reason worth retrying. */
  failed: number;
  /**
   * In the list, but Yahoo has no chart for them — see `isUnknownTicker`.
   *
   * A settled answer, not a fault: the master lists carry hundreds of NSE
   * Emerge and BSE-only scrips Yahoo does not price. Counted apart from
   * `failed` because the two want opposite things said about them, and because
   * only one of them is worth asking again.
   */
  unavailable: number;
}

export function useSignals(rows: SecurityWithQuote[], enabled: boolean): SignalsProgress {
  const [state, setState] = useState<SignalsProgress>({
    version: 0,
    pending: 0,
    total: 0,
    failed: 0,
    unavailable: 0,
  });

  useEffect(() => {
    if (!enabled) return;

    /**
     * What is left to ask for, and what there is no point asking for.
     *
     * A failed reading is deliberately not cached, so that a row which errored
     * is asked again next time — right for one row scrolling into view, and a
     * loop that never ends for a list of five thousand: this effect re-runs
     * every time a quote batch changes `rows`, and the few hundred symbols
     * Yahoo does not carry were being re-asked, re-failed and re-reported on
     * every one of them. Yahoo's 404 *is* the answer, it is remembered for the
     * day, and it is read here.
     */
    const missing: SecurityWithQuote[] = [];
    let unavailable = 0;
    for (const row of rows) {
      if (peekReading(row.ticker) !== undefined) continue;
      if (isUnknownTicker(row.ticker)) unavailable++;
      else missing.push(row);
    }

    if (missing.length === 0) {
      setState((s) =>
        s.pending === 0 && s.failed === 0 && s.unavailable === unavailable
          ? s
          : { ...s, pending: 0, failed: 0, unavailable },
      );
      return;
    }

    let alive = true;
    let left = missing.length;
    /**
     * Which tickers failed, not how many.
     *
     * The tally is re-read at the end of the pass to separate "Yahoo has no
     * such symbol" from "that request went wrong", and subtracting one count
     * from another could go negative — the quote path marks unknown tickers
     * too, so a symbol can become absent without this pass failing on it.
     */
    const failures = new Set<string>();
    const total = missing.length;
    setState((s) => ({ version: s.version, pending: left, total, failed: 0, unavailable }));

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
          failures.add(row.ticker);
        })
        .then(() => {
          if (!alive) return;
          left--;
          if (left > 0) {
            if (left % step === 0) {
              setState((s) => ({
                version: s.version + 1,
                pending: left,
                total,
                failed: failures.size,
                unavailable,
              }));
            }
            return;
          }

          // The pass is done, so the 404s it discovered are settled answers now
          // rather than failures. Re-read here so the bar stops calling "Yahoo
          // does not carry this" an error it might recover from.
          let absent = 0;
          for (const ticker of failures) if (isUnknownTicker(ticker)) absent++;
          setState((s) => ({
            version: s.version + 1,
            pending: 0,
            total,
            failed: failures.size - absent,
            unavailable: unavailable + absent,
          }));
        });
    }

    return () => {
      alive = false;
    };
  }, [rows, enabled]);

  return state;
}
