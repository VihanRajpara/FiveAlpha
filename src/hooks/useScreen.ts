import { useCallback, useMemo, useRef, useState } from 'react';
import { chunk, createGate, createQueue, drain, mapPool } from '../lib/format';
import {
  FUNDAMENTALS_CONCURRENCY,
  RateLimitedError,
  fetchFundamentals,
  persistFundamentals,
} from '../lib/fundamentals';
import {
  SPARK_BATCH_SIZE,
  fetchCoarseTechnicals,
  fetchTechnicalsCached,
  hasTechnicals,
  persistTechnicals,
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
 * On demand and client-side, in three stages, ordered cheapest-first:
 *
 *   1. **Scan** — twenty symbols per Yahoo request, ten years of monthly
 *      closes. Answers RSI and the length of the history exactly, and bounds
 *      the ten-year high from below. Most rows are decided here and cost a
 *      twentieth of a request each.
 *   2. **Confirm** — one full chart request per row the bound could not decide,
 *      for the true intra-month highs. Typically a few percent of the universe.
 *   3. **Fundamentals** — one screener.in page per row still standing, paced at
 *      1.2s apart because that is what screener.in tolerates.
 *
 * The stages **run at the same time**, joined by queues rather than by `await`.
 * That is the whole shape of the thing, and it is not a micro-optimisation:
 * stage 3 is rate-limited rather than bandwidth-limited, so its cost is the
 * number of rows that reach it multiplied by 1.2s no matter what else is
 * happening. Run strictly after the price work, a 2,410-row NSE screen was
 * ~45s of Yahoo requests followed by ~2½ minutes of paced scraping. Run
 * alongside it, the first survivors reach screener.in within a second or two of
 * the click and the price work disappears inside the wait — the same run is the
 * length of its slowest stage rather than the sum of all three.
 *
 * The other half of the cost is not paying twice. Both price stages and the
 * fundamentals scrape write through `dayCache`, so a second run — after a
 * filter change, a reload, or tomorrow morning's first look at the same
 * universe — asks the network for the rows it has not seen and nothing else.
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
 * so this is the pacing gate rather than a network cost, and it is why that
 * stage sets the length of a whole-market run.
 */
const SECONDS_PER_SURVIVOR = 1.25;

/**
 * What is left to do, in seconds, split the way the run actually spends them.
 *
 * The two are returned apart rather than added because the stages overlap: the
 * price work and the paced scraping happen at the same time, so the wall clock
 * left is the *slower* of them, while the share of the job done — what the bar
 * wants — is over their sum.
 *
 * Work not yet discovered is estimated: rows the scan has not reached will
 * produce confirms at `CONFIRM_RATE` and survivors at `SURVIVOR_RATE`, so the
 * totals below grow as the run learns what it is actually dealing with.
 */
function remaining(stage: Stages): { price: number; fundamentals: number } {
  const scanLeft = Math.max(0, stage.scan.total - stage.scan.done);
  const confirmLeft =
    Math.max(0, stage.confirm.total - stage.confirm.done) + scanLeft * CONFIRM_RATE;
  const survivorsLeft =
    Math.max(0, stage.fundamental.total - stage.fundamental.done) + scanLeft * SURVIVOR_RATE;

  return {
    price: scanLeft / SCAN_ROWS_PER_SECOND + confirmLeft / ROWS_PER_SECOND,
    fundamentals: survivorsLeft * SECONDS_PER_SURVIVOR,
  };
}

/** Seconds already spent, in the same units, so the bar can be a ratio. */
const spent = (stage: Stages): number =>
  stage.scan.done / SCAN_ROWS_PER_SECOND +
  stage.confirm.done / ROWS_PER_SECOND +
  stage.fundamental.done * SECONDS_PER_SURVIVOR;

/**
 * Seconds a run over `rows` should take. The stages overlap, so this is the
 * longest of them rather than their sum. Deliberately rough — it exists to
 * distinguish "a moment" from "go and make tea", not to be accurate.
 */
export function estimateSeconds(rows: number): number {
  const { price, fundamentals } = remaining({
    scan: { done: 0, total: rows },
    confirm: { done: 0, total: 0 },
    fundamental: { done: 0, total: 0 },
  });
  return Math.round(Math.max(price, fundamentals));
}

/** "40s" / "7 min" — an estimate should not pretend to more precision. */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  return `${Math.round(seconds / 60)} min`;
}

export const formatEstimate = (rows: number): string => formatDuration(estimateSeconds(rows));

/**
 * The two numbers the UI shows, from the counters the stages keep.
 *
 * `fraction` is over the *sum* of the work and `secondsLeft` over the *slower
 * half* of it, which is not an inconsistency: one answers "how much of this job
 * is behind me", the other "how long until it stops", and with overlapping
 * stages those have different denominators.
 */
function snapshot(stage: Stages): ScreenProgress {
  const left = remaining(stage);
  const done = spent(stage);
  const total = done + left.price + left.fundamentals;

  return {
    scan: { ...stage.scan },
    confirm: { ...stage.confirm },
    fundamental: { ...stage.fundamental },
    fraction: total > 0 ? Math.min(1, done / total) : 0,
    secondsLeft: Math.round(Math.max(left.price, left.fundamentals)),
  };
}

/**
 * How often the table and the progress bar are brought up to date.
 *
 * Publishing per settled row would be a fresh copy of a 5,229-entry map and a
 * re-render for each one. This used to be counted in rows, which cannot work
 * now that three stages settle rows at wildly different rates at the same time
 * — a clock is the thing they have in common. Four updates a second reads as
 * live and costs a few milliseconds of it.
 */
const PUBLISH_INTERVAL_MS = 250;

export type ScreenStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface StageProgress {
  done: number;
  /**
   * Rows the stage knows about *so far*. Only the scan's total is known at the
   * start; the other two are fed by the stage above them and grow as it finds
   * their work.
   */
  total: number;
}

/**
 * The three stages are reported separately because they run at once and at
 * wildly different speeds — a single "37 of 2,410" covering all of them would
 * be three different jobs sharing one misleading number.
 */
export interface Stages {
  /** Twenty symbols a request: the bound that decides most rows. */
  scan: StageProgress;
  /** One request each for the rows the bound could not decide. */
  confirm: StageProgress;
  /** One paced screener.in page per row that cleared the technical legs. */
  fundamental: StageProgress;
}

export interface ScreenProgress extends Stages {
  /** 0–1 over the whole job, weighted by what each stage actually costs. */
  fraction: number;
  /** Wall clock left, which is the slowest stage rather than the sum. */
  secondsLeft: number;
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

const EMPTY_PROGRESS: ScreenProgress = {
  scan: { done: 0, total: 0 },
  confirm: { done: 0, total: 0 },
  fundamental: { done: 0, total: 0 },
  fraction: 0,
  secondsLeft: 0,
};

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

      const stage: Stages = {
        scan: { done: 0, total: rows.length },
        confirm: { done: 0, total: 0 },
        fundamental: { done: 0, total: 0 },
      };
      setProgress(snapshot(stage));

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

      // One gate for both the table and the progress bar — see
      // `PUBLISH_INTERVAL_MS`. Every stage calls `tick`; whichever one happens
      // to cross the interval publishes all of them.
      let publishedAt = 0;
      const publish = () => {
        publishedAt = Date.now();
        setResults(new Map(draft.current));
        setProgress(snapshot(stage));
      };
      const tick = () => {
        if (Date.now() - publishedAt >= PUBLISH_INTERVAL_MS) publish();
      };

      // The two queues that join the stages. A row moves scan → confirm →
      // fundamentals, and each stage starts on an item the moment the one above
      // it produces one rather than when the whole stage above finishes.
      const confirmQueue = createQueue<SecurityWithQuote>();
      const fundamentalQueue = createQueue<SecurityWithQuote>();

      // Both price stages talk to Yahoo, and now they do it at the same time —
      // so the ceiling belongs to the pair of them, not to each.
      const yahoo = createGate(TECHNICAL_CONCURRENCY);

      // Abort has to reach the queues: a consumer parked on an empty one is
      // waiting for a producer that is never coming back.
      signal.addEventListener(
        'abort',
        () => {
          confirmQueue.close();
          fundamentalQueue.close();
        },
        { once: true },
      );

      void (async () => {
        // Rows Yahoo would not answer for. Counted rather than only logged
        // because at whole-market volume this stops being the odd dead ticker
        // and becomes the thing the user needs told — see the warning below.
        let unreachable = 0;
        // A rate limit ends the fundamentals stage, not the run: the price work
        // is unaffected by it and is most of what the table shows.
        let rateLimit: string | null = null;

        try {
          // ---- Stage 1: the scan, twenty symbols per request --------------
          // Rows whose exact figures are already cached from an earlier run are
          // not scanned at all: a bound on a number we have is pure cost. After
          // a re-run of the same universe that is every row, and this stage is
          // over before it starts.
          const known = rows.filter((row) => hasTechnicals(row.ticker));
          const fresh = rows.filter((row) => !hasTechnicals(row.ticker));

          // A stage's total only counts rows it will actually reach, so every
          // producer below counts what the queue *accepted* — after an abort or
          // a rate limit it accepts nothing, and a total that kept growing
          // would leave a bar that can never fill.
          const toConfirm = (row: SecurityWithQuote) => {
            if (confirmQueue.push(row)) stage.confirm.total++;
          };

          for (const row of known) toConfirm(row);
          stage.scan.done = known.length;
          publish();

          const scan = (async () => {
            try {
              await mapPool(chunk(fresh, SPARK_BATCH_SIZE), TECHNICAL_CONCURRENCY, async (batch) => {
                if (signal.aborted) return;

                let coarse: Map<string, CoarseTechnicals | null>;
                try {
                  coarse = await yahoo(() =>
                    fetchCoarseTechnicals(
                      batch.map((row) => row.ticker),
                      signal,
                    ),
                  );
                } catch (err) {
                  if (signal.aborted) return;
                  // A batch that failed outright is twenty rows Yahoo could not
                  // be asked about, not twenty unjudged rows: fall back to the
                  // exact stage, where a failure costs one row instead of
                  // twenty. In the worst case — Yahoo refusing everything —
                  // this degrades to the per-symbol behaviour the scan
                  // replaced, which is the right floor to fail to.
                  for (const row of batch) toConfirm(row);
                  stage.scan.done += batch.length;
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
                  // conclude is a statement about the clause, not this loop.
                  const outcome = judgeScan(def, scanned, row.quote?.price);
                  if (outcome.kind === 'confirm') {
                    toConfirm(row);
                    continue;
                  }

                  store(row.symbol, outcome.metrics, outcome, outcome.approx);
                }

                stage.scan.done += batch.length;
                tick();
              });
            } finally {
              // On every path, including a throw: the stage below ends when
              // this closes and nothing else will do it.
              confirmQueue.close();
            }
          })();

          // ---- Stage 2: confirm, one request per undecided row ------------
          const confirm = (async () => {
            try {
              await drain(confirmQueue, TECHNICAL_CONCURRENCY, async (row) => {
                if (signal.aborted) return;

                const metrics: Partial<ScreenMetrics> = {};
                try {
                  const technicals = await yahoo(() =>
                    fetchTechnicalsCached(row.ticker, signal),
                  );
                  if (technicals) {
                    metrics.bars = technicals.bars;
                    metrics.monthlyRsi14 = technicals.monthlyRsi14;
                    metrics.close = row.quote?.price ?? technicals.close;
                    // Left *absent* rather than zeroed when the history is too
                    // short for a ten-year high: the price legs read a missing
                    // high as "cannot tell", and a 0 would read as a definite
                    // failure.
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
                // *technical* one decides whether this row is worth a
                // screener.in request. The one that gets *stored* is over the
                // whole clause, so a row that has cleared price and momentum
                // but has not been asked about market cap or ROCE yet is
                // `unknown` — the fundamental legs return null on absent
                // metrics — rather than `pass`.
                //
                // Storing the technical verdict here was reporting rows as
                // matches on three legs out of five. It only showed up when the
                // fundamentals stage did not finish: screener.in rate-limits
                // after ~25 requests, the run aborted, and every row it never
                // reached stayed a "match". That is how a screen reported 109
                // against Chartink's 64 on the same universe. A row is a match
                // once the whole clause says so.
                store(row.symbol, metrics, judge(def.legs, metrics));

                // Stored before it is queued: the stage below reads the row's
                // existing metrics back out of the draft.
                if (
                  judge(technicalLegs, metrics).verdict === 'pass' &&
                  fundamentalQueue.push(row)
                ) {
                  stage.fundamental.total++;
                }

                stage.confirm.done++;
                tick();
              });
            } finally {
              fundamentalQueue.close();
            }
          })();

          // ---- Stage 3: fundamentals, survivors only ----------------------
          // Rows already failed on price or momentum are never asked about, and
          // neither are the unjudged ones — an unknown cannot become a pass, so
          // a scrape for it would buy nothing.
          const fundamental = drain(fundamentalQueue, FUNDAMENTALS_CONCURRENCY, async (row) => {
            if (signal.aborted) return;

            // Closing the queue stops new rows arriving but does not empty it,
            // and every row still in there would spend a minute and a half in
            // `fetchPaced`'s backoffs before failing the same way. Give them
            // back instead, so the counts describe what was actually done.
            if (rateLimit !== null) {
              stage.fundamental.total--;
              return;
            }

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
              // A rate limit is about the stage, not this row: every queued row
              // would be refused too, so stop asking. The price stages carry on
              // — they are a different upstream and most of the table.
              if (err instanceof RateLimitedError) {
                rateLimit = err.message;
                fundamentalQueue.close();
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

            stage.fundamental.done++;
            tick();
          });

          await Promise.all([scan, confirm, fundamental]);

          publish();
          if (signal.aborted) return;

          // Yahoo simply has no history for a lot of thinly traded BSE scrips.
          // Either way the rows come back unjudged, and a screen that quietly
          // reports "3,100 unjudged" without saying why is not reporting at all.
          if (unreachable > 0) {
            setWarning(
              `${unreachable.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} rows had no usable price history. ` +
                'Yahoo carries nothing for many BSE-only scrips — every one sampled is a dead ticker rather than a request worth repeating. ' +
                'Judged rows are cached for the rest of the day, so running it again is near-instant.',
            );
          }

          if (rateLimit) setError(rateLimit);
          setStatus('done');
          setRanAt(new Date());
        } catch (err) {
          publish();
          if (signal.aborted) return;
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          // Whatever happened, nothing below is waiting on a queue any more.
          confirmQueue.close();
          fundamentalQueue.close();
          // Hold on to what the run learned: a reload should not re-buy it.
          persistTechnicals();
          persistFundamentals();
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
