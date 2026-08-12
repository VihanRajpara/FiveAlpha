import type { Candle } from '../types';
import { fetchYahooBars } from './yahooCandles';

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
    prev.high = Math.max(prev.high ?? -Infinity, bar.high ?? -Infinity);
    prev.low = Math.min(prev.low ?? Infinity, bar.low ?? Infinity);
    prev.close = bar.close ?? prev.close;
    prev.volume = Math.max(prev.volume ?? 0, bar.volume ?? 0);
  }

  return out;
}

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
