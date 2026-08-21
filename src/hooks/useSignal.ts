import { useEffect, useState } from 'react';
import { fetchSignal, peekSignal, type Signal } from '../lib/signals';

/**
 * The UT Bot signal for one ticker, fetched on first sight.
 *
 * Per *cell* rather than per table, deliberately: the rows are virtualised, so
 * only what is on screen mounts, and a page of 50 costs 50 requests once a day
 * instead of the whole filtered universe costing thousands. `peekSignal` keeps
 * a re-scroll from flashing a skeleton over an answer already in hand.
 *
 * A failed request reads as "no signal" here and is not cached, so the next
 * time the row scrolls into view it is asked for again.
 */
export function useSignal(ticker: string): { signal: Signal | null; loaded: boolean } {
  const [state, setState] = useState(() => {
    const cached = peekSignal(ticker);
    return { signal: cached ?? null, loaded: cached !== undefined };
  });

  useEffect(() => {
    const cached = peekSignal(ticker);
    if (cached !== undefined) {
      setState({ signal: cached, loaded: true });
      return;
    }

    let alive = true;
    setState({ signal: null, loaded: false });
    fetchSignal(ticker).then(
      (signal) => alive && setState({ signal, loaded: true }),
      () => alive && setState({ signal: null, loaded: true }),
    );
    return () => {
      alive = false;
    };
  }, [ticker]);

  return state;
}
