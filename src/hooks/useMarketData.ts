import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeSource } from '../lib/dataSource';
import { fetchClassification } from '../lib/classification';
import { isMarketOpen } from '../lib/format';
import type { Classification, Quote, QuoteTarget, Security } from '../types';

/**
 * How often to look for new prices during a live session.
 *
 * `sync-quotes` writes every five minutes, so this is deliberately shorter than
 * the thing it watches: the interval bounds *latency*, not cost. Volume is set
 * by how often the data actually changes, because a poll that finds nothing new
 * transfers nothing.
 */
const POLL_INTERVAL_MS = 60_000;

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

  /**
   * `quiet` is for the poll: it does the same read but leaves the busy dot, the
   * progress bar and the button label alone. Without it the status bar would
   * flash every minute all session for a refresh nobody asked for, which reads
   * as the app struggling rather than working.
   */
  const loadQuotes = useCallback(async (targets: QuoteTarget[], quiet = false) => {
    if (targets.length === 0 || inFlight.current) return;
    inFlight.current = true;
    if (!quiet) {
      setRefreshingQuotes(true);
      setQuoteProgress(0);
    }

    let done = 0;
    try {
      // `quiet` and `incremental` travel together on purpose: the poll is the
      // only caller that wants a delta, and the only one that must not disturb
      // the status bar. A manual refresh stays a full reload.
      await activeSource.fetchQuotes(targets, (batch) => {
        if (!mounted.current || batch.length === 0) return;
        done += batch.length;
        if (!quiet) setQuoteProgress(Math.min(1, done / targets.length));
        // Replace the map so React sees a new reference and re-renders the rows.
        setQuotes((prev) => {
          const next = new Map(prev);
          for (const q of batch) {
            const held = next.get(q.symbol);
            // Spread, not replace. A poll returns price fields only, and the
            // metrics (market cap, RSI, ROCE) it omits must survive the merge —
            // they came from the full read and are not in a delta.
            next.set(q.symbol, held ? { ...held, ...q } : q);
          }
          return next;
        });
      }, quiet);
      if (mounted.current) setLastFetchedAt(new Date());
    } catch (err) {
      // A failed background poll is not worth a banner: the prices on screen are
      // still the last good ones, and the next tick will try again.
      if (mounted.current && !quiet) setError(err instanceof Error ? err.message : String(err));
      else if (quiet) console.warn('Quote poll failed; keeping the prices on screen', err);
    } finally {
      inFlight.current = false;
      if (mounted.current && !quiet) {
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
   * Picks up new prices without anyone pressing anything.
   *
   * Supabase mode only. In direct mode a "refresh" is thousands of live Yahoo
   * requests through the dev proxy, which is a thing to do on purpose and not
   * on a timer.
   *
   * Three gates, each removing work that would otherwise be pure waste:
   *
   *   · **Market closed** — `sync-quotes` only runs on weekdays during the
   *     session, so outside it there is provably nothing new to read.
   *   · **Tab hidden** — a background tab has no one looking at it. Polling
   *     resumes on the way back, and the immediate read on becoming visible is
   *     what makes returning to the tab feel instant rather than up to a minute
   *     behind.
   *   · **A read already in flight** — `loadQuotes` guards this itself.
   *
   * A minute against a five-minute write cadence means a price is on screen
   * within a minute of being stored, while four polls in five cost one empty
   * PostgREST response, because the read asks only for rows newer than the last
   * one it saw.
   */
  useEffect(() => {
    if (activeSource.kind !== 'supabase' || securities.length === 0) return;

    const targets = securities.map((s) => ({ symbol: s.symbol, ticker: s.ticker }));
    const poll = () => {
      if (document.visibilityState !== 'visible' || !isMarketOpen()) return;
      void loadQuotes(targets, true);
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Coming back to the tab should not wait out the rest of the interval —
    // that is exactly the moment the prices on screen are most likely stale.
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
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
