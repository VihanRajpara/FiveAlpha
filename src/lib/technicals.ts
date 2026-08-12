import type { Candle } from '../types';
import { SPARK_BATCH_SIZE, fetchYahooBars, fetchYahooSparkBars } from './yahooCandles';

/**
 * The technical half of a screen: the ten-year high a price is measured
 * against, and monthly RSI.
 *
 * Both come out of a *single* request — ten years of monthly bars — which is
 * the whole reason this module exists as its own thing. A screen run costs one
 * Yahoo request per symbol and there is no batch endpoint for chart data (the
 * 20-per-call `spark` endpoint returns a day of closes, not a decade), so the
 * request count is the budget and everything derivable from one response has to
 * be derived from one response.
 *
 * 10y/1mo is ~120 bars and ~14 KB per symbol, versus ~2,500 bars and ~250 KB
 * for the daily series over the same window. Monthly bars carry the true
 * intra-month high in `high`, so the ten-year high they yield is exactly the one
 * the daily series would give — the resolution is lost only inside a month,
 * which nothing here asks about.
 *
 * What the response cannot be trusted about is its own shape. Yahoo returns the
 * current month twice and its Indian history carries occasional bad ticks, both
 * of which move a screen verdict; `collapseMonths` and `SPIKE_RATIO` below are
 * the two corrections, and both are calibrated against Chartink's own numbers
 * rather than guessed.
 */

const RANGE = '10y';
const INTERVAL = '1mo';

/** Wilder's RSI needs one bar to seed the first delta plus `period` deltas. */
const RSI_PERIOD = 14;
const MIN_BARS = RSI_PERIOD + 2;

export interface Technicals {
  /**
   * Highest high over the ten-year window, i.e. Chartink's
   * `yearly max( 10 , yearly high )`. The max of the monthly highs and the max
   * of the yearly highs are the same number — a yearly high is itself the max
   * of its months.
   *
   * **Null when the history does not span ten calendar years.** See
   * `DECADE_YEARS` — a two-year-old listing has no ten-year high, and inventing
   * one from the history that exists is what made this screen match three times
   * as many rows as Chartink's.
   */
  high10y: number | null;
  /** Close of the most recent monthly bar: during a session, the live price. */
  close: number;
  /** Wilder RSI(14) on monthly closes. Null when fewer than 16 bars exist. */
  monthlyRsi14: number | null;
  /** Bars the figures were computed from — a freshly listed share has few. */
  bars: number;
  /** Date of the first bar, so a short history is visible rather than implied. */
  since: string;
}

/**
 * Wilder's RSI over a close series, returning the *latest* value.
 *
 * Wilder smoothing, not a simple moving average of gains and losses: the two
 * diverge by several points on a 14-period RSI, and Chartink's `rsi( 14 )` is
 * Wilder's. The seed is the simple mean of the first `period` deltas, which is
 * the conventional start and what every charting package does.
 */
export function rsi(closes: number[], period = RSI_PERIOD): number | null {
  if (closes.length < period + 2) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  // A window with no down-closes at all: RS is infinite and RSI saturates.
  // Returning 100 rather than dividing by zero matters because this is exactly
  // the shape a share pinned at a new high has, which is what the screen hunts.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Yahoo reports the current month *twice*: a `1mo` series ends with a monthly
 * bar whose close is a day or two stale, followed by a second bar dated today
 * carrying the live price. Measured over the 133 NSE symbols Chartink's
 * technical legs matched on 2026-08-12, **132 of them came back this way** — it
 * is the normal shape of the response, not an edge case.
 *
 * Left alone that pair is an extra delta in the close series, and Wilder RSI
 * cannot tell it from a real month's move. It read ADOR at 64.49 against
 * Chartink's 65.57 and PANAMAPET at 63.07 against 67.91 — on a `>= 65` leg,
 * the difference between a match and a miss, and the single largest source of
 * rows this screen was dropping. Collapsing the pair reproduces Chartink to
 * within 0.03 on every name checked.
 *
 * The merge is what a month's bar would have been: first open, highest high,
 * lowest low, latest close. Volume takes the larger of the two rather than the
 * sum, because the trailing bar re-reports part of the same month rather than
 * adding to it.
 */
export function collapseMonths(bars: Candle[]): Candle[] {
  const out: Candle[] = [];

  for (const bar of bars) {
    const prev = out[out.length - 1];
    if (!prev || prev.date.slice(0, 7) !== bar.date.slice(0, 7)) {
      out.push({ ...bar });
      continue;
    }
    prev.high = merge(prev.high, bar.high, Math.max);
    prev.low = merge(prev.low, bar.low, Math.min);
    prev.close = bar.close ?? prev.close;
    prev.volume = merge(prev.volume, bar.volume, Math.max);
  }

  return out;
}

/**
 * Null-preserving, which matters only for the close-only bars the scan pass
 * builds: `Math.max(null ?? -Infinity, null ?? -Infinity)` would quietly turn a
 * "there is no high here" into `-Infinity` and hand it on as if it were a price.
 */
const merge = (
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null => (a === null ? b : b === null ? a : pick(a, b));

/**
 * A monthly high above this multiple of its own close is a bad tick, not a
 * price. Yahoo's Indian history carries a scattering of them — THYROCARE's
 * October 2020 bar reports a high of 1090 in a month that ranged 313–366, and
 * January 2020 reports 578 against a low of 180.
 *
 * That matters here out of all proportion to how often it happens, because the
 * ten-year high is a `max` over 120 bars: one bogus high anywhere in the decade
 * sets the level every later close is measured against. THYROCARE read as 59%
 * of its ten-year high on the strength of that one bar, failing the 25% band;
 * against Chartink's high of 662 it is at 97%, which is the whole point of the
 * screen.
 *
 * Two is deliberately loose. It only discards a high that the bar's own close
 * says the stock more than halved from within the month, and across those 133
 * symbols it changed exactly one verdict and reversed none.
 *
 * It does not catch the other shape of bad history — a split Yahoo never
 * applied, where a whole stretch of bars is uniformly scaled and each one is
 * internally consistent. Those rows (`UEL`, `CLCIND`, `IVZINGOLD` at the time
 * of writing) still read far below their true position and are why this screen
 * is not a drop-in replacement for Chartink's.
 */
const SPIKE_RATIO = 2;

/**
 * `yearly max( 10 , yearly high )` is a max over **ten yearly bars**, and a
 * company that has not existed for ten years does not have ten of them. Chartink
 * rejects those rows outright; this used to take the max of whatever history it
 * had, which quietly redefines the leg as "within 25% of the high since listing"
 * — a condition almost every recent IPO passes, because a share that has only
 * ever traded in one bull market is always near its own high.
 *
 * That single difference accounted for **91 of the 214 NSE rows** this screen
 * passed on its technical legs against Chartink's 136; 90 of the 91 had under
 * ten years of history, and Chartink rejected all 91 on this leg while agreeing
 * with the RSI leg on 84 of them.
 *
 * The count is of distinct calendar years, not bars, because that is the unit
 * the clause is written in. **Eleven** rather than ten: the max itself does
 * include the current, part-finished year — Chartink's ten-year high for
 * THYROCARE today is its 2026 high — but a row is only judged once ten
 * *completed* years sit behind it. That number is calibrated against Chartink
 * rather than reasoned out, and the calibration is unambiguous. Over all 2,401
 * NSE symbols, against Chartink's 136:
 *
 * | minimum years | matches | agreed | spurious | missed |
 * |---|---|---|---|---|
 * | none (the old behaviour) | 214 | 123 | 91 | 13 |
 * | 10 | 128 | 120 | 8 | 16 |
 * | **11** | **115** | **114** | **1** | **22** |
 *
 * The cost is real and worth naming: Yahoo's history is shorter than the
 * exchange's for a handful of long-listed shares — `DEEPINDS` and `ARIHANT`
 * start in 2021 here — so those become **unjudged rather than matched**, which
 * is most of the 22. That is the honest answer, and the screen reports how many
 * rows it could not judge.
 */
const DECADE_YEARS = 11;

export function computeTechnicals(rawBars: Candle[]): Technicals | null {
  const bars = collapseMonths(rawBars);

  // `close` is non-null by construction — fetchYahooBars drops the others — but
  // `high` is not, and a null there would poison Math.max into NaN.
  const closes: number[] = [];
  const highs: number[] = [];
  const years = new Set<string>();
  for (const bar of bars) {
    if (typeof bar.close !== 'number') continue;
    closes.push(bar.close);
    years.add(bar.date.slice(0, 4));
    if (typeof bar.high === 'number' && bar.high <= bar.close * SPIKE_RATIO) highs.push(bar.high);
  }

  if (closes.length === 0 || highs.length === 0) return null;

  return {
    high10y: years.size >= DECADE_YEARS ? Math.max(...highs) : null,
    close: closes[closes.length - 1],
    monthlyRsi14: closes.length >= MIN_BARS ? rsi(closes) : null,
    bars: bars.length,
    since: bars[0]?.date ?? '',
  };
}

/** One request. Throws what `fetchYahooBars` throws, including on abort. */
export async function fetchTechnicals(
  ticker: string,
  signal?: AbortSignal,
): Promise<Technicals | null> {
  return computeTechnicals(await fetchYahooBars(ticker, RANGE, INTERVAL, signal));
}

const cache = new Map<string, Promise<Technicals | null>>();

/**
 * Same fetch, remembered for the life of the tab.
 *
 * Re-running a screen after widening a filter should only pay for the symbols
 * it has not already priced, and monthly bars are the right thing to hold: over
 * a session the ten-year high and a 14-period *monthly* RSI do not meaningfully
 * move. The one figure that does — the latest close — is taken from the live
 * quote by the caller wherever there is one, so nothing stale reaches the
 * price legs.
 *
 * Failures are dropped rather than cached, so a flaky request is retried on the
 * next run instead of being remembered as a verdict.
 */
export function fetchTechnicalsCached(
  ticker: string,
  signal?: AbortSignal,
): Promise<Technicals | null> {
  const hit = cache.get(ticker);
  if (hit) return hit;

  const pending = fetchTechnicals(ticker, signal);
  pending.catch(() => cache.delete(ticker));
  cache.set(ticker, pending);
  return pending;
}

/**
 * Whether the *exact* figures for a ticker are already in hand or in flight.
 *
 * The runner asks before scanning: a bound on a number we already know exactly
 * is pure cost, so a re-run skips straight to the confirmed value.
 */
export const hasTechnicals = (ticker: string): boolean => cache.has(ticker);

// ---------------------------------------------------------------------------
// The scan pass
// ---------------------------------------------------------------------------

/**
 * What twenty symbols' worth of monthly *closes* can answer.
 *
 * This is the cheap half of the two-pass screen, and the split is drawn exactly
 * where Yahoo's own endpoints draw it. `spark` batches twenty symbols per
 * request but carries closes alone; `chart` carries the full OHLC but costs one
 * request per symbol. So:
 *
 *   · **Exact** here — RSI (Wilder's runs on closes and nothing else), the bar
 *     count, the first date, and how many calendar years the history spans.
 *     These are computed from the same collapsed series `computeTechnicals`
 *     uses, so the two passes cannot disagree about them.
 *   · **Bounded** here — the ten-year high. `closeHigh` is the highest monthly
 *     close, and a month's close is never above its high, so
 *     `closeHigh <= high10y` **always**. That inequality is the entire basis on
 *     which the runner is allowed to reject a row without paying for its bars.
 */
export interface CoarseTechnicals {
  /**
   * Highest monthly close in the window: a **lower bound** on `high10y`, never
   * the thing itself. Usable to prove a share is far from its high; useless —
   * and actively dangerous — for proving it is near one, because understating
   * the high overstates how close the price is to it.
   */
  closeHigh: number;
  /** Close of the most recent monthly bar. */
  close: number;
  /**
   * Wilder RSI(14) on monthly closes — identical to the exact pass's figure
   * **when `density` is 1**, and not otherwise. See `density`.
   */
  monthlyRsi14: number | null;
  bars: number;
  since: string;
  /** History spans `DECADE_YEARS`, i.e. a ten-year high exists at all. */
  decade: boolean;
  /**
   * Bars present as a fraction of the calendar months the history spans.
   *
   * The one place the two endpoints genuinely disagree, and it took measuring to
   * find: for thinly traded shares `spark` **omits months altogether** where
   * `chart` carries a close. AHLWEST comes back with 76 monthly bars against the
   * chart's 120 over the same window, and an RSI computed on the survivors is
   * not an approximation of the real one — it is a different series. Measured
   * over 800 NSE symbols the two RSIs agree to 1e-6 wherever `density` is 1 and
   * diverge by up to 20 points where it is not.
   *
   * So this is not a quality score, it is a licence: at 1 the RSI may be used to
   * reject a row, below it the figure is unusable and the row has to be
   * confirmed. The `closeHigh` bound is unaffected — dropping bars can only
   * lower a maximum, which leaves it a lower bound.
   */
  density: number;
}

/**
 * Highest close, ignoring single-bar spikes.
 *
 * The same problem `SPIKE_RATIO` solves for highs, in the direction that hurts
 * here: `closeHigh` is only ever used to *reject* rows, so one bad tick in a
 * decade would push the bound up and throw away a share that is genuinely at
 * its high. A close more than double both neighbouring months is that tick.
 *
 * The RSI is deliberately left unguarded. It is computed from the same closes
 * in both passes, so a tick that moves it moves it identically in each; filtering
 * one and not the other would make the cheap pass disagree with the exact one.
 */
function maxCleanClose(closes: number[]): number {
  let max = 0;

  for (let i = 0; i < closes.length; i++) {
    const before = closes[i - 1];
    const after = closes[i + 1];
    const neighbour = Math.max(before ?? 0, after ?? 0);
    if (neighbour > 0 && closes[i] > neighbour * SPIKE_RATIO) continue;
    if (closes[i] > max) max = closes[i];
  }

  return max;
}

/** Calendar months from one `yyyy-mm` to another, inclusive of both. */
function monthsSpanned(first: string, last: string): number {
  const [y0, m0] = first.split('-').map(Number);
  const [y1, m1] = last.split('-').map(Number);
  return (y1 - y0) * 12 + (m1 - m0) + 1;
}

export function computeCoarseTechnicals(rawBars: Candle[]): CoarseTechnicals | null {
  const bars = collapseMonths(rawBars);

  const closes: number[] = [];
  const years = new Set<string>();
  const months: string[] = [];
  for (const bar of bars) {
    if (typeof bar.close !== 'number') continue;
    closes.push(bar.close);
    years.add(bar.date.slice(0, 4));
    months.push(bar.date.slice(0, 7));
  }

  if (closes.length === 0) return null;

  const span = monthsSpanned(months[0], months[months.length - 1]);

  return {
    closeHigh: maxCleanClose(closes),
    close: closes[closes.length - 1],
    monthlyRsi14: closes.length >= MIN_BARS ? rsi(closes) : null,
    bars: bars.length,
    since: bars[0]?.date ?? '',
    decade: years.size >= DECADE_YEARS,
    density: span > 0 ? closes.length / span : 0,
  };
}

/**
 * Re-exported because it is the unit callers have to chunk by, and they should
 * not need to know that the reason is Yahoo's spark endpoint: `fetchCoarseTechnicals`
 * passes the list straight through, and Yahoo 400s the whole request above this.
 */
export { SPARK_BATCH_SIZE };

const coarseCache = new Map<string, CoarseTechnicals>();

/**
 * One request per `SPARK_BATCH_SIZE` tickers, remembered for the life of the tab.
 *
 * A null value means Yahoo returned nothing for that ticker. Unlike the settled
 * answers, those are **not** cached: the sampled ones are dead symbols that a
 * re-run would find dead again, but remembering an absence as a verdict is how
 * a transient drop becomes permanent, and re-asking costs a twentieth of a
 * request. Throwing — a batch that failed outright — caches nothing at all.
 */
export async function fetchCoarseTechnicals(
  tickers: string[],
  signal?: AbortSignal,
): Promise<Map<string, CoarseTechnicals | null>> {
  const out = new Map<string, CoarseTechnicals | null>();

  const wanted: string[] = [];
  for (const ticker of tickers) {
    const hit = coarseCache.get(ticker);
    if (hit) out.set(ticker, hit);
    else wanted.push(ticker);
  }
  if (wanted.length === 0) return out;

  const series = await fetchYahooSparkBars(wanted, RANGE, INTERVAL, signal);

  for (const ticker of wanted) {
    const bars = series.get(ticker);
    const coarse = bars ? computeCoarseTechnicals(bars) : null;
    if (coarse) coarseCache.set(ticker, coarse);
    out.set(ticker, coarse);
  }

  return out;
}
