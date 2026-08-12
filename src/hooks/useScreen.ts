import { useCallback, useMemo, useRef, useState } from 'react';
import { mapPool } from '../lib/format';
import { FUNDAMENTALS_CONCURRENCY, RateLimitedError, fetchFundamentals } from '../lib/fundamentals';
import { fetchTechnicalsCached } from '../lib/technicals';
import {
  judge,
  legsFor,
  type ScreenDef,
  type ScreenMetrics,
  type ScreenResult,
} from '../lib/screens';
import type { SecurityWithQuote } from '../types';

/**
 * Runs a screen over the rows currently on screen.
 *
 * On demand and client-side, which is a deliberate trade and worth stating: a
 * screen costs one Yahoo chart request per symbol — there is no batch endpoint
 * for a decade of bars — plus one screener.in page per symbol that survives the
 * technical legs. Chrome allows six connections per origin, so the wall-clock
 * cost is roughly `rows / 6 × 300 ms` and nothing about that improves by
 * wishing: the full ~5,200-company list is minutes, not seconds.
 *
 * That is a reason to *say so*, not to refuse. This used to reject any universe
 * above LARGE_RUN outright, which disabled the run button on the default view
 * and made a working screen look broken — a limit nobody can click past is a
 * dead end, not a guardrail. The run now always starts; a long one is announced
 * with an estimate up front, reports progress, and can be stopped at any point
 * with its partial results kept.
 */

/** Yahoo throttles above ~8 parallel connections; the quote pass uses the same. */
const TECHNICAL_CONCURRENCY = 6;

/**
 * Above this the run is worth warning about rather than just starting: ~500
 * rows is around 40 seconds, which is the point where a progress bar stops
 * being reassurance and starts being a commitment.
 */
export const LARGE_RUN = 500;

/**
 * Rows per second for phase 1, **measured** over 180 NSE symbols through the
 * dev proxy at the concurrency above: 26.1s, i.e. ~870 ms per request with six
 * in flight. Not derived from a guessed round trip — the first version of this
 * assumed 300 ms and under-promised by nearly 3×, which on the whole market is
 * the difference between "5 minutes" and a quarter of an hour.
 */
const ROWS_PER_SECOND = 6.9;

/**
 * Share of a universe that clears the technical legs and so costs a screener.in
 * request: 115 of the 2,410 NSE symbols on 2026-08-12.
 */
const SURVIVOR_RATE = 0.05;

/**
 * Seconds per surviving row in phase 2. Not a round trip — screener.in is
 * rate-limited to one request every 1.2s (see `MIN_INTERVAL_MS`), so this is
 * the pacing gate, and it no longer rounds away to a percentage: on a
 * whole-NSE run phase 2 is over two minutes on its own.
 */
const SECONDS_PER_SURVIVOR = 1.25;

/**
 * Seconds a run over `rows` should take: the Yahoo pass over everything, then
 * the paced screener.in pass over whatever survives. Deliberately rough — it
 * exists to distinguish "a moment" from "go and make tea", not to be accurate.
 */
export function estimateSeconds(rows: number): number {
  return Math.round(rows / ROWS_PER_SECOND + rows * SURVIVOR_RATE * SECONDS_PER_SURVIVOR);
}

/** "40s" / "7 min" — an estimate should not pretend to more precision. */
export function formatEstimate(rows: number): string {
  const seconds = estimateSeconds(rows);
  if (seconds < 90) return `${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Publish partway through rather than per row: every settled row would be a
 * new Map and a re-render of the table. Scaled to the run, because a fixed 12
 * means 435 full copies of a 5,229-row map on the whole-market pass — roughly
 * 60 updates is enough to read as live at any size.
 */
const publishEvery = (rows: number) => Math.max(12, Math.round(rows / 60));

export type ScreenStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface ScreenProgress {
  phase: 'technical' | 'fundamental' | null;
  done: number;
  total: number;
}

export interface ScreenCounts {
  pass: number;
  fail: number;
  unknown: number;
  screened: number;
}

export interface ScreenRun {
  screen: ScreenDef | null;
  status: ScreenStatus;
  results: Map<string, ScreenResult>;
  matches: Set<string>;
  counts: ScreenCounts;
  progress: ScreenProgress;
  error: string | null;
  /** Non-fatal: the run finished, but not everything could be reached. */
  warning: string | null;
  ranAt: Date | null;
  run: (screen: ScreenDef, rows: SecurityWithQuote[]) => void;
  cancel: () => void;
  clear: () => void;
}

const EMPTY_PROGRESS: ScreenProgress = { phase: null, done: 0, total: 0 };

export function useScreen(): ScreenRun {
  const [screen, setScreen] = useState<ScreenDef | null>(null);
  const [status, setStatus] = useState<ScreenStatus>('idle');
  const [results, setResults] = useState<Map<string, ScreenResult>>(new Map());
  const [progress, setProgress] = useState<ScreenProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<Date | null>(null);

  // The live result set. State is a snapshot of this, published every so often;
  // writing straight to state would re-render the table on every settled row.
  const draft = useRef<Map<string, ScreenResult>>(new Map());
  const abort = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
  }, []);

  const clear = useCallback(() => {
    cancel();
    draft.current = new Map();
    setScreen(null);
    setResults(new Map());
    setProgress(EMPTY_PROGRESS);
    setStatus('idle');
    setError(null);
    setWarning(null);
    setRanAt(null);
  }, [cancel]);

  const run = useCallback(
    (def: ScreenDef, rows: SecurityWithQuote[]) => {
      cancel();

      setScreen(def);
      setError(null);
      setWarning(null);

      if (rows.length === 0) {
        setStatus('error');
        setError('Nothing to screen — the current filters match no rows.');
        return;
      }

      const controller = new AbortController();
      abort.current = controller;
      const { signal } = controller;

      draft.current = new Map();
      setResults(new Map());
      setStatus('running');
      setProgress({ phase: 'technical', done: 0, total: rows.length });

      // Phase 1 judges the technical legs alone; phase 2 re-judges the row
      // against *all* of them, so the final verdict comes from one call over
      // the whole clause rather than from two half-verdicts combined by hand.
      const technicalLegs = legsFor(def, 'technical');

      const publish = () => setResults(new Map(draft.current));
      const every = publishEvery(rows.length);

      void (async () => {
        try {
          // ---- Phase 1: one Yahoo request per row -------------------------
          let done = 0;
          // Rows Yahoo would not answer for. Counted rather than only logged
          // because at whole-market volume this stops being the odd dead ticker
          // and becomes the thing the user needs told — see the warning below.
          let unreachable = 0;
          const survivors: SecurityWithQuote[] = [];

          await mapPool(rows, TECHNICAL_CONCURRENCY, async (row) => {
            if (signal.aborted) return;

            const metrics: Partial<ScreenMetrics> = {};
            try {
              const technicals = await fetchTechnicalsCached(row.ticker, signal);
              if (technicals) {
                metrics.bars = technicals.bars;
                metrics.monthlyRsi14 = technicals.monthlyRsi14;
                // The live quote is fresher than the current monthly bar's close
                // only during a session, but preferring it costs nothing and
                // keeps the screen consistent with the price in the table.
                metrics.close = row.quote?.price ?? technicals.close;
                // Left *absent* rather than zeroed when the history is too short
                // for a ten-year high: the price legs read a missing high as
                // "cannot tell", and a 0 would read as a definite failure.
                if (technicals.high10y !== null && technicals.high10y > 0) {
                  metrics.high10y = technicals.high10y;
                  metrics.pctOfHigh = (metrics.close / technicals.high10y) * 100;
                }
              }
            } catch (err) {
              // One unreachable symbol is an unjudged row, not a failed run.
              if (signal.aborted) return;
              unreachable++;
              console.warn(`No bars for ${row.symbol}`, err);
            }

            // Two judgements, and the difference between them matters. The
            // *technical* one decides whether this row is worth a screener.in
            // request. The one that gets *stored* is over the whole clause, so
            // a row that has cleared price and momentum but has not been asked
            // about market cap or ROCE yet is `unknown` — the fundamental legs
            // return null on absent metrics — rather than `pass`.
            //
            // Storing the technical verdict here was reporting rows as matches
            // on three legs out of five. It only showed up when phase 2 did not
            // finish: screener.in rate-limits after ~25 requests, the run
            // aborted, and every row it never reached stayed a "match". That is
            // how a screen reported 109 against Chartink's 64 on the same
            // universe. A row is a match once the whole clause says so.
            if (judge(technicalLegs, metrics).verdict === 'pass') survivors.push(row);

            const { verdict, decidedBy } = judge(def.legs, metrics);
            draft.current.set(row.symbol, { symbol: row.symbol, verdict, metrics, decidedBy });

            if (++done % every === 0) publish();
            setProgress({ phase: 'technical', done, total: rows.length });
          });

          if (signal.aborted) return;
          publish();

          // Yahoo simply has no history for a lot of thinly traded BSE scrips,
          // and it starts refusing outright somewhere in the thousands. Either
          // way the rows come back unjudged, and a screen that quietly reports
          // "3,100 unjudged" without saying why is not reporting at all. The
          // successful rows are cached, so the advice to re-run is real: a
          // second pass only re-asks for what failed.
          if (unreachable > 0) {
            setWarning(
              `${unreachable.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} rows had no usable price history. ` +
                'Yahoo carries nothing for many BSE-only scrips, and throttles above a few thousand requests. ' +
                'Judged rows are cached — running it again only re-asks for the ones that failed.',
            );
          }

          // ---- Phase 2: fundamentals, survivors only ----------------------
          // Rows already failed on price or momentum are never asked about, and
          // neither are the unjudged ones — an unknown cannot become a pass, so
          // a scrape for it would buy nothing.
          done = 0;
          setProgress({ phase: 'fundamental', done: 0, total: survivors.length });

          await mapPool(survivors, FUNDAMENTALS_CONCURRENCY, async (row) => {
            if (signal.aborted) return;

            const existing = draft.current.get(row.symbol)!;
            const metrics = { ...existing.metrics };
            let fundamentalsUrl: string | undefined;

            try {
              const fundamentals = await fetchFundamentals(row, signal);
              if (fundamentals) {
                metrics.marketCapCr = fundamentals.marketCapCr;
                metrics.rocePct = fundamentals.rocePct;
                fundamentalsUrl = fundamentals.url;
              }
            } catch (err) {
              if (signal.aborted) return;
              // A rate limit is about the whole run, not this row: keep going
              // and every remaining row would be refused too.
              if (err instanceof RateLimitedError) {
                controller.abort();
                setStatus('error');
                setError(err.message);
                return;
              }
              console.warn(`No fundamentals for ${row.symbol}`, err);
            }

            const { verdict, decidedBy } = judge(def.legs, metrics);
            draft.current.set(row.symbol, {
              symbol: row.symbol,
              verdict,
              metrics,
              decidedBy,
              fundamentalsUrl,
            });

            if (++done % every === 0) publish();
            setProgress({ phase: 'fundamental', done, total: survivors.length });
          });

          publish();
          if (signal.aborted) return;

          setStatus('done');
          setRanAt(new Date());
        } catch (err) {
          publish();
          if (signal.aborted) return;
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (abort.current === controller) abort.current = null;
        }
      })();
    },
    [cancel],
  );

  // Cancelling should keep whatever the run had already decided — those rows
  // are answered, and throwing them away would make the button feel punitive.
  const cancelRun = useCallback(() => {
    if (status !== 'running') return;
    cancel();
    setResults(new Map(draft.current));
    setStatus('cancelled');
    setRanAt(new Date());
  }, [cancel, status]);

  const matches = useMemo(() => {
    const out = new Set<string>();
    for (const [symbol, result] of results) if (result.verdict === 'pass') out.add(symbol);
    return out;
  }, [results]);

  const counts = useMemo<ScreenCounts>(() => {
    let pass = 0;
    let fail = 0;
    let unknown = 0;
    for (const result of results.values()) {
      if (result.verdict === 'pass') pass++;
      else if (result.verdict === 'fail') fail++;
      else unknown++;
    }
    return { pass, fail, unknown, screened: results.size };
  }, [results]);

  return {
    screen,
    status,
    results,
    matches,
    counts,
    progress,
    error,
    warning,
    ranAt,
    run,
    cancel: cancelRun,
    clear,
  };
}
