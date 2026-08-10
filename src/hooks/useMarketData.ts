import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeSource } from '../lib/dataSource';
import { fetchClassification } from '../lib/classification';
import type { Classification, Quote, QuoteTarget, Security } from '../types';

export interface MarketData {
  securities: Security[];
  quotes: Map<string, Quote>;
  /** Symbol → F&O / cap band. Empty until the NSE lists land. */
  classification: Map<string, Classification>;
  /** False while the classification lists are still in flight. */
  classificationReady: boolean;
  loading: boolean;
  /** Fraction of symbols that have a price yet, 0..1. */
  quoteProgress: number;
  /**
   * True once a quote pass has finished, successfully or not.
   *
   * The table needs this to tell "no price *yet*" from "no price at all". Both
   * look like a missing number, but the first should shimmer and the second must
   * read "—" — and plenty of thinly traded BSE scrips never produce a price,
   * so a row keyed on the value alone would shimmer forever.
   */
  quotesLoaded: boolean;
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
  const [quotesLoaded, setQuotesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [classification, setClassification] = useState<Map<string, Classification>>(new Map());
  const [classificationReady, setClassificationReady] = useState(false);

  // Guards against two refreshes interleaving and against setState after unmount.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadQuotes = useCallback(async (targets: QuoteTarget[]) => {
    if (targets.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setRefreshingQuotes(true);
    setQuoteProgress(0);

    let done = 0;
    try {
      await activeSource.fetchQuotes(targets, (batch) => {
        if (!mounted.current) return;
        done += batch.length;
        setQuoteProgress(Math.min(1, done / targets.length));
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
        // Set even when the pass threw: a failed fetch is still an answer, and
        // leaving every cell shimmering after an error is the worse lie.
        setQuotesLoaded(true);
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
        void loadQuotes(list.map((s) => ({ symbol: s.symbol, ticker: s.ticker })));
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

  // Independent of the equity list — these files join by symbol, so there is no
  // reason to make them wait for it, and a failure here must not block prices.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { map, failed } = await fetchClassification();
      if (cancelled) return;
      setClassification(map);
      setClassificationReady(true);
      if (failed.length > 0) {
        // Surfaced, not thrown: the table is still fully usable unclassified.
        console.warn(`Classification unavailable for: ${failed.join(', ')}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshQuotes = useCallback(() => {
    void loadQuotes(securities.map((s) => ({ symbol: s.symbol, ticker: s.ticker })));
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
    classification,
    classificationReady,
    loading,
    quoteProgress,
    quotesLoaded,
    refreshingQuotes,
    error,
    lastFetchedAt,
    dataAsOf,
    refreshQuotes,
    sourceKind: activeSource.kind,
  };
}
