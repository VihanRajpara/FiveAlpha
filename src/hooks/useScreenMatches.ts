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
 * "Polls" rather than "subscribes" deliberately: a realtime channel would be a
 * websocket held open all day to learn about a row set that changes on a
 * five-minute cron, and the replace is a delete-then-insert, so the change feed
 * for it is ~150 events rather than one.
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

/** The cron behind the table (migration 0013). Reading faster only costs requests. */
const POLL_MS = 5 * 60_000;

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
    return () => clearInterval(timer);
  }, [load]);

  return { symbols, rows, fetchedAt, loading, error, refresh: () => void load() };
}
