import { useCallback, useMemo, useRef, useState } from 'react';
import { chunk, mapPool } from '../lib/format';
import { FUNDAMENTALS_CONCURRENCY, RateLimitedError, fetchFundamentals } from '../lib/fundamentals';
import {
  SPARK_BATCH_SIZE,
  fetchCoarseTechnicals,
  fetchTechnicalsCached,
  hasTechnicals,
  type CoarseTechnicals,
} from '../lib/technicals';
import {
  judge,
  judgeScan,
  legsFor,
  type ScreenDef,
  type ScreenMetrics,
  type ScreenResult,
} from '../lib/screens';
import type { SecurityWithQuote } from '../types';

/**
 * Runs a screen over the rows currently on screen.
 *
 * On demand and client-side, in three passes, ordered cheapest-first:
 *
 *   1. **Scan** — twenty symbols per Yahoo request, ten years of monthly
 *      closes. Answers RSI and the length of the history exactly, and bounds
 *      the ten-year high from below. Most rows are decided here and cost a
 *      twentieth of a request each.
 *   2. **Confirm** — one full chart request per row the bound could not decide,
 *      for the true intra-month highs. Typically a few percent of the universe.
 *   3. **Fundamentals** — one screener.in page per row still standing, paced.
 *
 * This used to be pass 2 alone, over everything, on the stated grounds that
 * there was no batch endpoint for a decade of bars. There is: `spark` takes the
 * same range/interval and answers twenty symbols at a time, 19× the throughput
 * measured through the same proxy at the same concurrency. The whole ~5,200
 * company list went from about a quarter of an hour to under two minutes of
 * price work, and what remains dominant is the paced fundamentals pass.
 *
 * A long run is still announced with an estimate up front, reports progress,
 * and can be stopped at any point with its partial results kept — a limit
 * nobody can click past is a dead end, not a guardrail.
 */

/**
 * Six is not a tuning choice, it is Chrome's per-origin connection limit over
 * HTTP/1.1 — which is what `npm run dev` serves, so raising it there buys
 * nothing. The deployed Worker answers over HTTP/2: one connection, ~100
 * concurrent streams, and the ceiling becomes Yahoo's patience rather than the
 * browser's.
 *
 * Yahoo's patience was **measured** rather than assumed, because the figure
 * this codebase carried — "throttles aggressively above ~8 parallel
 * connections" — turns out not to hold. 200 chart requests at a time,
 * 2026-08-12, direct:
 *
 * | in flight | rows/s | non-200 |
 * |---|---|---|
 * | 6 | 8.3 | none |
 * | 12 | 54.1 | none |
 * | 24 | 106.6 | none |
 * | 32 | 144.1 | none |
 *
 * 24 rather than 32 because the scan pass carries twenty symbols per request,
 * so 24 in flight is already 480 symbols being priced at once, and there is no
 * reason to stand as close to an untested edge as the measurement allows.
 */
const TECHNICAL_CONCURRENCY = import.meta.env.DEV ? 6 : 24;

/**
 * Above this the run is worth warning about rather than just starting: ~1,000
 * rows is around a minute and a half, which is the point where a progress bar
 * stops being reassurance and starts being a commitment.
 */
export const LARGE_RUN = 1000;

/**
 * Rows per second for the confirm pass, **measured** over 180 NSE symbols
 * through the dev proxy at six in flight: 26.1s, i.e. ~870 ms per request. Not
 * derived from a guessed round trip — the first version of this assumed 300 ms
 * and under-promised by nearly 3×.
 */
const ROWS_PER_SECOND = 6.9;

/**
 * Rows per second for the scan pass. Measured 2026-08-12 through the dev proxy
 * at the same concurrency as the figure above, over 600 NSE symbols: 19× the
 * per-symbol call. Stated as a multiple rather than as its own absolute number
 * because the two were measured against each other in one sitting, and the
 * ratio survives a change of network where 130 rows/s would not.
 */
const SCAN_ROWS_PER_SECOND = ROWS_PER_SECOND * 19;

/**
 * Share of a universe the scan cannot decide by itself, and which therefore
 * costs a full chart request. Rows with a decade of history, momentum above the
 * RSI leg, and a price near even the *lowest possible* reading of their
 * ten-year high — a superset of the eventual matches, and an estimate rather
 * than a measurement, unlike the rate above it.
 */
const CONFIRM_RATE = 0.08;

/**
 * Share of a universe that clears the technical legs and so costs a screener.in
 * request: 115 of the 2,410 NSE symbols on 2026-08-12.
 */
const SURVIVOR_RATE = 0.05;

/**
 * Seconds per surviving row in the fundamentals pass. Not a round trip —
 * screener.in is rate-limited to one request every 1.2s (see `MIN_INTERVAL_MS`),
 * so this is the pacing gate. Now that the price work is batched it is also the
 * bulk of a whole-market run: three quarters of it, and the obvious next thing
 * to attack.
 */
const SECONDS_PER_SURVIVOR = 1.25;

/**
 * Seconds a run over `rows` should take, summed over the three passes.
 * Deliberately rough — it exists to distinguish "a moment" from "go and make
 * tea", not to be accurate.
 */
export function estimateSeconds(rows: number): number {
  return Math.round(
    rows / SCAN_ROWS_PER_SECOND +
      (rows * CONFIRM_RATE) / ROWS_PER_SECOND +
      rows * SURVIVOR_RATE * SECONDS_PER_SURVIVOR,
  );
}

/** "40s" / "7 min" — an estimate should not pretend to more precision. */
export function formatEstimate(rows: number): string {
  const seconds = estimateSeconds(rows);
  if (seconds < 90) return `${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Publish partway through rather than per row: every settled row would be a new
 * Map and a re-render of the table. Scaled to the pass, because a fixed 12 means
 * 435 full copies of a 5,229-row map on the whole-market scan — roughly 60
 * updates is enough to read as live at any size.
 *
 * The progress counter is gated on the same interval and for the same reason.
 * It used to be set on *every* settled row: 5,229 React state updates over a
 * whole-market run, each one re-rendering the bar, to move a number nobody can
 * read at that rate.
 */
const publishEvery = (rows: number) => Math.max(12, Math.round(rows / 60));

export type ScreenStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

/**
 * `scan` and `technical` are the two halves of the price work — twenty symbols
 * a request, then one a request for the rows the first could not decide. They
 * are reported separately because they run at wildly different speeds, and a
 * single bar covering both would appear to stall the moment it crossed over.
 */
export interface ScreenProgress {
  phase: 'scan' | 'technical' | 'fundamental' | null;
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
      setProgress({ phase: 'scan', done: 0, total: rows.length });

      // The price passes judge the technical legs alone; the fundamentals pass
      // re-judges the row against *all* of them, so the final verdict comes from
      // one call over the whole clause rather than from two half-verdicts
      // combined by hand.
      const technicalLegs = legsFor(def, 'technical');

      const store = (
        symbol: string,
        metrics: Partial<ScreenMetrics>,
        judged: ReturnType<typeof judge>,
        approx?: boolean,
      ) => {
        draft.current.set(symbol, {
          symbol,
          metrics,
          verdict: judged.verdict,
          decidedBy: judged.decidedBy,
          approx,
        });
      };

      // One gate for both the table and the progress bar — see `publishEvery`.
      // `interval` is set per pass, since a 300-row confirm and a 5,000-row scan
      // want very different strides, and the last row of a pass always reports
      // so a bar never stops short of its end.
      let published = 0;
      let interval = 1;
      const publish = () => setResults(new Map(draft.current));
      const tick = (phase: ScreenProgress['phase'], done: number, total: number) => {
        if (done - published < interval && done !== total) return;
        published = done;
        publish();
        setProgress({ phase, done, total });
      };
      const startPass = (phase: ScreenProgress['phase'], total: number) => {
        published = 0;
        interval = publishEvery(total);
        setProgress({ phase, done: 0, total });
      };

      void (async () => {
        try {
          // Rows Yahoo would not answer for. Counted rather than only logged
          // because at whole-market volume this stops being the odd dead ticker
          // and becomes the thing the user needs told — see the warning below.
          let unreachable = 0;

          // ---- Pass 1: the scan, twenty symbols per request ---------------
          // Rows whose exact figures are already cached from an earlier run are
          // not scanned at all: a bound on a number we have is pure cost.
          const known = rows.filter((row) => hasTechnicals(row.ticker));
          const fresh = rows.filter((row) => !hasTechnicals(row.ticker));

          // Everything the scan could not settle, confirmed one request each.
          const confirm: SecurityWithQuote[] = [...known];

          startPass('scan', rows.length);
          // Cached rows are already past this pass; on a re-run of the same
          // universe that is all of them and the bar goes straight to full.
          let done = known.length;
          tick('scan', done, rows.length);

          await mapPool(
            chunk(fresh, SPARK_BATCH_SIZE),
            TECHNICAL_CONCURRENCY,
            async (batch) => {
              if (signal.aborted) return;

              let coarse: Map<string, CoarseTechnicals | null>;
              try {
                coarse = await fetchCoarseTechnicals(
                  batch.map((row) => row.ticker),
                  signal,
                );
              } catch (err) {
                if (signal.aborted) return;
                // A batch that failed outright is twenty rows Yahoo could not be
                // asked about, not twenty unjudged rows: fall back to the exact
                // pass, where a failure costs one row instead of twenty. In the
                // worst case — Yahoo refusing everything — this degrades to the
                // per-symbol behaviour this pass replaced, which is the right
                // floor to fail to.
                confirm.push(...batch);
                done += batch.length;
                console.warn(`Scan batch failed (${batch.length} rows)`, err);
                return;
              }

              for (const row of batch) {
                const scanned = coarse.get(row.ticker) ?? null;

                if (!scanned) {
                  unreachable++;
                  store(row.symbol, {}, judge(def.legs, {}));
                  continue;
                }

                // The rule itself lives in `judgeScan`, next to the legs it
                // reasons about — what a close-only series may and may not
                // conclude is a statement about the clause, not about this loop.
                const outcome = judgeScan(def, scanned, row.quote?.price);
                if (outcome.kind === 'confirm') {
                  confirm.push(row);
                  continue;
                }

                store(row.symbol, outcome.metrics, outcome, outcome.approx);
              }

              done += batch.length;
              tick('scan', done, rows.length);
            },
          );

          if (signal.aborted) return;
          publish();

          // ---- Pass 2: confirm, one request per undecided row -------------
          startPass('technical', confirm.length);
          done = 0;

          const survivors: SecurityWithQuote[] = [];

          await mapPool(confirm, TECHNICAL_CONCURRENCY, async (row) => {
            if (signal.aborted) return;

            const metrics: Partial<ScreenMetrics> = {};
            try {
              const technicals = await fetchTechnicalsCached(row.ticker, signal);
              if (technicals) {
                metrics.bars = technicals.bars;
                metrics.monthlyRsi14 = technicals.monthlyRsi14;
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
            // on three legs out of five. It only showed up when the fundamentals
            // pass did not finish: screener.in rate-limits after ~25 requests,
            // the run aborted, and every row it never reached stayed a "match".
            // That is how a screen reported 109 against Chartink's 64 on the
            // same universe. A row is a match once the whole clause says so.
            if (judge(technicalLegs, metrics).verdict === 'pass') survivors.push(row);

            store(row.symbol, metrics, judge(def.legs, metrics));

            tick('technical', ++done, confirm.length);
          });

          if (signal.aborted) return;
          publish();

          // Yahoo simply has no history for a lot of thinly traded BSE scrips.
          // Either way the rows come back unjudged, and a screen that quietly
          // reports "3,100 unjudged" without saying why is not reporting at all.
          if (unreachable > 0) {
            setWarning(
              `${unreachable.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} rows had no usable price history. ` +
                'Yahoo carries nothing for many BSE-only scrips — every one sampled is a dead ticker rather than a request worth repeating. ' +
                'Judged rows are cached, so running it again is near-instant.',
            );
          }

          // ---- Pass 3: fundamentals, survivors only -----------------------
          // Rows already failed on price or momentum are never asked about, and
          // neither are the unjudged ones — an unknown cannot become a pass, so
          // a scrape for it would buy nothing.
          startPass('fundamental', survivors.length);
          done = 0;

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

            tick('fundamental', ++done, survivors.length);
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
