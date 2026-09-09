import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

/**
 * The screen's matches, read from `public.screen_matches`.
 *
 * This replaced a 800-line client-side runner. That version re-derived the
 * Chartink clause from Yahoo bars and a screener.in scrape — roughly 2,600
 * requests and a minute of wall clock per run, to produce a verdict that
 * differed from Chartink's own at exactly the margin the screen is about. What
 * is left is a table read: sync-screen scrapes Chartink every five minutes and
 * replaces the list whole, and this hook polls it on the same beat.
 *
 * Push first, poll second. Realtime tells the browser the moment the replace
 * commits (migration 0014), because a five-minute poll against a five-minute
 * cron is not in step with it — a page that loaded at :02 asks again at :07,
 * two minutes after its list was replaced, so the worst case is a list ten
 * minutes old.
 *
 * The replace is a delete-then-insert, so it arrives as ~150 events rather than
 * one; `NUDGE_MS` collapses the burst into a single refetch. And the poll stays
 * as a fallback rather than being replaced: a websocket can drop, and a dropped
 * one must not mean a page that quietly stops updating for the rest of the day.
 */

export interface ScreenMatch {
  symbol: string;
  name: string | null;
  /** Chartink's own ordering — 1 is the top of its list. */
  rank: number | null;
  close: number | null;
  chgPct: number | null;
  volume: number | null;
}

export interface ScreenMatches {
  /** Membership test for the table filter. */
  symbols: Set<string>;
  rows: ScreenMatch[];
  /** When Chartink was last asked, not when this browser last read the table. */
  fetchedAt: Date | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fallback beat, for when the websocket is not there. The cron behind the table
 * writes every five minutes (migration 0013), so reading faster than that only
 * costs requests.
 */
const POLL_MS = 5 * 60_000;

/**
 * How long to wait for a change burst to finish before refetching.
 *
 * One replace is one transaction and ~150 row events, and refetching per event
 * would be 150 reads of the same list. Long enough to swallow the burst, short
 * enough that nobody perceives it as lag.
 */
const NUDGE_MS = 400;

interface Row {
  symbol: string;
  name: string | null;
  rank: number | null;
  close: number | null;
  chg_pct: number | null;
  volume: number | null;
  fetched_at: string;
}

const EMPTY: Set<string> = new Set();

export function useScreenMatches(): ScreenMatches {
  const [rows, setRows] = useState<ScreenMatch[]>([]);
  const [symbols, setSymbols] = useState<Set<string>>(EMPTY);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(supabase !== null);
  const [error, setError] = useState<string | null>(null);

  // A poll landing after the component is gone would set state on nothing; a
  // manual refresh landing after a newer one would show the older list.
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured, so there is no screen list to read.');
      setLoading(false);
      return;
    }

    const mine = ++seq.current;
    setLoading(true);

    const { data, error: err } = await supabase
      .from('screen_matches')
      .select('symbol, name, rank, close, chg_pct, volume, fetched_at')
      .order('rank', { nullsFirst: false });

    if (mine !== seq.current) return;

    if (err) {
      // The list already on screen is five minutes old at worst and is better
      // than an empty table, so a failed poll reports itself and changes
      // nothing else.
      setError(err.message);
      setLoading(false);
      return;
    }

    const list = (data ?? []) as Row[];
    setRows(
      list.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        rank: r.rank,
        close: r.close,
        chgPct: r.chg_pct,
        volume: r.volume,
      })),
    );
    setSymbols(new Set(list.map((r) => r.symbol)));
    setFetchedAt(list[0] ? new Date(list[0].fetched_at) : null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    // Nothing is read off the payload: a replace is a delete of every row and an
    // insert of every row, so the only useful thing an event says is "the list
    // changed, ask again". Which also means the subscription needs nothing from
    // the payload's shape and cannot break when a column is added.
    let nudge: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      ?.channel('screen_matches')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'screen_matches' },
        () => {
          clearTimeout(nudge);
          nudge = setTimeout(() => void load(), NUDGE_MS);
        },
      )
      .subscribe();

    // A tab the browser froze — backgrounded on a phone, restored from bfcache —
    // comes back with a socket that may have been closed under it and a list
    // that stopped updating while it was away. Reading once on the way back is
    // what makes returning to the tab instant instead of up to five minutes
    // behind, and it is the same thing useMarketData does with the prices.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      clearTimeout(nudge);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [load]);

  return { symbols, rows, fetchedAt, loading, error, refresh: () => void load() };
}
