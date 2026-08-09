import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeSource } from '../lib/dataSource';
import type { Quote, Security } from '../types';

export interface MarketData {
  securities: Security[];
  quotes: Map<string, Quote>;
  loading: boolean;
  /** Fraction of symbols that have a price yet, 0..1. */
  quoteProgress: number;
  refreshingQuotes: boolean;
  error: string | null;
  /**
   * When the app last finished *asking* for quotes. In Supabase mode this is
   * only when the table was last read — it says nothing about price freshness.
   */
  lastFetchedAt: Date | null;
  /**
   * When the prices themselves were captured — the newest `updatedAt` present
   * in the data. This is the honest freshness figure and the one to show:
   *   · direct mode   → Yahoo's last print timestamp
   *   · Supabase mode → when sync-quotes/the seeder last wrote the row
   * Reading the table again moves `lastFetchedAt` but leaves this untouched,
   * which is exactly the distinction the old single timestamp hid.
   */
  dataAsOf: Date | null;
  refreshQuotes: () => void;
  sourceKind: 'direct' | 'supabase';
}

export function useMarketData(): MarketData {
  const [securities, setSecurities] = useState<Security[]>([]);
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshingQuotes, setRefreshingQuotes] = useState(false);
  const [quoteProgress, setQuoteProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Guards against two refreshes interleaving and against setState after unmount.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadQuotes = useCallback(async (symbols: string[]) => {
    if (symbols.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setRefreshingQuotes(true);
    setQuoteProgress(0);

    let done = 0;
    try {
      await activeSource.fetchQuotes(symbols, (batch) => {
        if (!mounted.current) return;
        done += batch.length;
        setQuoteProgress(Math.min(1, done / symbols.length));
        // Replace the map so React sees a new reference and re-renders the rows.
        setQuotes((prev) => {
          const next = new Map(prev);
          for (const q of batch) next.set(q.symbol, q);
          return next;
        });
      });
      if (mounted.current) setLastFetchedAt(new Date());
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRefreshingQuotes(false);
        setQuoteProgress(1);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await activeSource.listSecurities();
        if (cancelled) return;
        setSecurities(list);
        setLoading(false);
        void loadQuotes(list.map((s) => s.symbol));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadQuotes]);

  const refreshQuotes = useCallback(() => {
    void loadQuotes(securities.map((s) => s.symbol));
  }, [loadQuotes, securities]);

  /**
   * Newest capture time across all quotes. Derived from the data rather than
   * tracked alongside it, so re-reading the same rows cannot make them look
   * fresher than they are.
   */
  const dataAsOf = useMemo(() => {
    let newest = 0;
    for (const q of quotes.values()) {
      if (!q.updatedAt) continue;
      const t = Date.parse(q.updatedAt);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    return newest > 0 ? new Date(newest) : null;
  }, [quotes]);

  return {
    securities,
    quotes,
    loading,
    quoteProgress,
    refreshingQuotes,
    error,
    lastFetchedAt,
    dataAsOf,
    refreshQuotes,
    sourceKind: activeSource.kind,
  };
}
