import { useEffect, useState } from 'react';
import { fetchReading, peekReading, type Mapo, type Signal } from '../lib/signals';

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
 *
 * Returns the MAPO reading alongside, because it rides the same request: the
 * oscillator is computed from bars `latestSignal` had already fetched, so a
 * separate hook for it would double the traffic to buy nothing.
 */
export function useSignal(ticker: string): {
  signal: Signal | null;
  mapo: Mapo | null;
  loaded: boolean;
} {
  const [state, setState] = useState(() => {
    const cached = peekReading(ticker);
    return { signal: cached?.signal ?? null, mapo: cached?.mapo ?? null, loaded: cached !== undefined };
  });

  useEffect(() => {
    const cached = peekReading(ticker);
    if (cached !== undefined) {
      setState({ ...cached, loaded: true });
      return;
    }

    let alive = true;
    setState({ signal: null, mapo: null, loaded: false });
    fetchReading(ticker).then(
      (reading) => alive && setState({ ...reading, loaded: true }),
      () => alive && setState({ signal: null, mapo: null, loaded: true }),
    );
    return () => {
      alive = false;
    };
  }, [ticker]);

  return state;
}
