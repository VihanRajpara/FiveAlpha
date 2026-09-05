import type { Candle } from '../types';
import { dayCache } from './dayCache';
import { createGate, isMarketOpen } from './format';
import { fetchYahooBars } from './yahooCandles';

/**
 * The buy/sell leg of the TradingView study `SVMKR_UT_HMA_ORB 6 1 31 5 1010-1015`,
 * transcribed from its Pine v4 source rather than inferred from its name.
 *
 * The study is three independent parts stacked on one chart, and only the first
 * produces a signal:
 *
 *   1. **UT Bot** — an ATR trailing stop on `close`. A signal is the bar on which
 *      the close crosses that stop. This is the whole of the buy/sell logic.
 *   2. **A Hull moving average**, plotted and coloured by its own slope. It is an
 *      *overlay*: `xATRTrailingStop` never reads it. The earlier version of this
 *      file fed the HMA into the UT Bot as its source, which is a different rule
 *      from the one on the chart. It survives here only as `trend` — the same
 *      rising/falling test the script uses to colour the line green or red.
 *   3. **An opening-range breakout** between 10:10 and 10:15, gated upstream on
 *      `timeframe.isintraday and timeframe.multiplier <= 5`. On a daily chart
 *      both its plots are `na`, so it contributes nothing to reproduce. This is
 *      why the signal carries a date rather than a clock time.
 *
 * A fourth part, `UCS_LRS`, is commented out in the source in its entirety.
 *
 * The parameters below come from the chart label, whose five values map onto the
 * script's inputs in declaration order: `a=6`, `c=1`, `n=31`, `inputMax=5`,
 * `sess=1010-1015` (the boolean `h` is not printed). The last three match their
 * declared defaults exactly, which pins the order and settles that `6 1` is the
 * key value and then the ATR period — not the other way round.
 *
 * ## What the flip on its own does not say
 *
 * The flip is a crossing, and a crossing is not a trade. Everything under
 * `Signal.stop` downwards exists because the same crossing means different
 * things depending on facts that come free with the bars already fetched, and
 * without them the column was ranking a ₹4 lakh-a-day shell that crossed on
 * eleven shares alongside RELIANCE:
 *
 *   · **It can repaint.** Mid-session the last daily bar is still moving, so a
 *     flip dated today may not survive the close — `provisional`.
 *   · **One bad tick moves it.** Yahoo's Indian history carries them, and at
 *     `atr(1)` a bar's own true range *is* the stop distance — one 2× high
 *     throws the stop by six times a price that never traded — `cleanBars`,
 *     the same lesson `technicals.ts` already learned.
 *   · **It ignores the trend it fires into.** A BUY while the Hull line is
 *     still falling is the same arithmetic as one while it rises and not the
 *     same signal — `trend`.
 *   · **It ignores who was there.** A cross on a third of average volume is one
 *     participant — `volumeRatio`.
 *   · **It ignores whether the name can be traded at all** — `turnover`.
 *   · **It never says where it is wrong.** UT Bot's whole content is a trailing
 *     stop and the number was thrown away after the crossing test — `stop`.
 *   · **It never says whether this rule has ever worked here.** Every earlier
 *     flip in the same window is a completed round trip — `history`.
 *
 * None of that changes the flip: side, price and date still agree bar-for-bar
 * with the chart. It is context carried alongside, folded into one `score`.
 */
export const UT_BOT = {
  /**
   * `a` — the ATR multiple the trailing stop sits away by, and the only knob
   * the script's own input label calls "sensitivity".
   *
   * Six of them against a one-bar ATR is a stop roughly a tenth of the price
   * away on a typical NSE name. That is a wide, slow trend follower: it is
   * meant to sit through the noise a 1×ATR(6) stop would trade against.
   */
  keyValue: 6,
  /**
   * `c` — ATR lookback, Wilder-smoothed.
   *
   * One. Pine's `rma(tr, 1)` is `tr` itself, so there is no averaging here at
   * all: the stop distance is six times *this bar's* true range. Which is why
   * `cleanBars` is not optional.
   */
  atrPeriod: 1,
  /**
   * `n` — Hull moving average length.
   *
   * Plotted by the script, read by nothing in it. Used here only for `trend`.
   */
  hmaLength: 31,
};

/**
 * Two years of daily bars, set by measurement rather than by taste.
 *
 * A 6×ATR(1) stop is roughly a tenth of the price wide, so this rule flips
 * about **5 times a year** per name — and `history` needs `MIN_TRADES` closed
 * round trips, which is four flips. Over nineteen NSE large- and mid-caps a one
 * year window left **6 of 19** with no track record at all (one name flipped
 * once); two years leaves none.
 *
 * It is the same single Yahoo request either way — the window is a query
 * parameter — so the cost is response size, not round trips. The measurement
 * that first said a year was enough was taken before `cleanBars` learned to
 * drop Yahoo's holiday bars, and was counting phantom flips.
 */
const RANGE = '2y';

/** How far back `history` looks, for the places that have to say so. */
export const SIGNAL_RANGE_LABEL = '2y';
const INTERVAL = '1d';

/** Volume and turnover are averaged over a month of sessions. */
const VOL_WINDOW = 20;

/**
 * Median daily turnover below which a signal is not actionable, in rupees.
 *
 * ₹25 lakh a day is roughly the floor at which a retail-sized order is the
 * market rather than in it. NSE lists ~2,400 symbols and several hundred trade
 * under this; their flips are arithmetically identical to everyone else's and
 * mean nothing, which is exactly the failure a score has to catch.
 */
const TURNOVER_FLOOR = 2_500_000;

/**
 * A high more than this multiple of the bar's own body is a bad tick, not a
 * price — the same ratio and the same reasoning as `SPIKE_RATIO` in
 * `technicals.ts`, applied here because an ATR is even more sensitive to one
 * than a decade `max` is: the spike widens the trailing stop for the whole
 * smoothing window after it, which suppresses a real flip rather than inventing
 * a fake one.
 */
const SPIKE_RATIO = 2;

/**
 * How the context is weighted into `Signal.score`, which starts at `base`.
 *
 * Deliberately a flat table of points rather than a fitted model: these are
 * priors about what makes a trend-following crossing worth acting on, not
 * coefficients measured against a labelled set, and writing them as a table is
 * what makes them arguable. Tune them here; nothing else reads the numbers.
 */
export const SCORE = {
  base: 50,
  /** Fires with the Hull line's own direction, or against it. */
  trend: 20,
  /** Flip bar traded at least `VOLUME_STRONG`× its 20-bar average. */
  volume: 10,
  /** ...or under `VOLUME_THIN`× of it, which is nobody. */
  volumeThin: -10,
  /** This symbol's own hit rate on this rule, scaled ±. */
  history: 20,
  /** Median turnover under `TURNOVER_FLOOR`. */
  illiquid: -25,
  /** The flip bar has not closed yet. */
  provisional: -10,
};

/**
 * Measured, not assumed. Re-measured 2026-09-05 against the corrected rule, over
 * the 197 flips it produced in two years of daily bars across nineteen NSE
 * large- and mid-caps: flip-bar volume against its own 20-bar average ran median
 * **1.34**, quartiles 0.94 / 1.98, p90 2.98.
 *
 * The previous pair (1.5 / 0.7) was measured against the HMA-sourced rule, whose
 * median was **0.90** — below one, because a 31-period HMA crosses several bars
 * *after* the thrust that caused it and the flip bar was quiet by construction.
 * On `close` the crossing lands on the thrust itself and the whole distribution
 * moves up, which retired both the number and the reasoning: at 1.5, 40% of
 * flips now count as strong, and a bonus two flips in five collect is not a
 * distinction.
 *
 * So: 2.0 marks the 24% that traded at twice their own month, just clear of the
 * upper quartile; 0.7 the 10% that had nobody, well under the lower one. The
 * 66% between them scores nothing rather than being interpolated — the band is
 * the ordinary case and the score should be silent about it.
 */
const VOLUME_STRONG = 2;
const VOLUME_THIN = 0.7;

/** Completed round trips needed before a symbol's own hit rate means anything. */
const MIN_TRADES = 3;

export interface Signal {
  side: 'BUY' | 'SELL';
  /** Close of the bar that flipped the trailing stop. */
  price: number;
  /** ISO date of that bar. */
  date: string;
  /** Bars since the flip — 0 means it fired on the latest bar. */
  age: number;
  /**
   * The trailing stop as of the latest bar: the level the study flips back at.
   *
   * The signal's own risk statement, and the one number UT Bot exists to
   * produce. It was being computed and discarded — only the crossing survived —
   * which left a BUY with no answer to "wrong below what?".
   */
  stop: number;
  /**
   * The flip fires with the prevailing trend (`1`), against it (`-1`), or the
   * history is too short to have one (`0`).
   *
   * The trend is the study's own second plot: `c1 = n1 > n1[1]`, the Hull
   * moving average rising or falling, which is what colours that line green or
   * red on the chart. Signed by side, so `1` always means agreement.
   *
   * It was the 200-day SMA, which is a perfectly good regime filter and not one
   * the chart shows. Since the HMA stopped feeding the signal there is no reason
   * to prefer an indicator the user cannot see over the one they can.
   */
  trend: 1 | 0 | -1;
  /**
   * Flip-bar volume over the average of the 20 bars ending on it. Null when
   * Yahoo carries no volume for the window.
   */
  volumeRatio: number | null;
  /** Median daily turnover (₹) over the last 20 bars — is this tradeable. */
  turnover: number | null;
  /**
   * Every earlier flip in the window, taken as a completed round trip that
   * ended at the next flip. Null under `MIN_TRADES`, because a hit rate over
   * two trades is a coin.
   */
  history: { trades: number; wins: number; avgPct: number } | null;
  /**
   * The flip is on a bar that is still trading and may not survive the close.
   *
   * Not cached, unlike every settled answer here: a provisional signal is the
   * one thing in this file that changes within the day.
   */
  provisional: boolean;
  /** 0–100, from `SCORE`. Context only — it never moves side, price or date. */
  score: number;
}

/**
 * How far the current price has travelled since the flip, in percent.
 *
 * Signed the same way for both sides: positive means the price is above where
 * the signal fired. On a BUY that is the move you missed; on a SELL it is the
 * move that went against it. Not folded into the side, because "which way did
 * it go" is the question being asked and the badge next to it already says
 * which side it is.
 */
export function signalGapPct(
  signal: Signal,
  price: number | null | undefined,
): number | null {
  if (price === null || price === undefined || !signal.price) return null;
  return ((price - signal.price) / signal.price) * 100;
}

/**
 * Room left before the study flips back, in percent of the current price.
 *
 * Signed by side rather than by direction: positive is always cushion, negative
 * always means price has already crossed back and the flip is about to be
 * replaced. Unlike `signalGapPct` this is a statement about risk now, not about
 * what happened since, which is why the two are separate numbers.
 */
export function stopDistancePct(
  signal: Signal,
  price: number | null | undefined,
): number | null {
  if (price === null || price === undefined || !price || !signal.stop) return null;
  const away = signal.side === 'BUY' ? price - signal.stop : signal.stop - price;
  return (away / price) * 100;
}

/**
 * A gap, as it is printed everywhere it appears.
 *
 * One decimal, not two: a day's change is ±3% and wants the precision, while a
 * gap since the signal routinely runs past ±80%, where the second decimal is
 * noise in a column meant to be skimmed.
 */
export const formatGap = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;

/** The score as a word, for the places a bare number would need a legend. */
export const scoreLabel = (score: number) =>
  score >= 75 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Mixed' : 'Weak';

/** Filter presets: bars since the flip, at most. */
export const SIGNAL_AGE_MAX: Record<string, number> = { '5': 5, '10': 10, '20': 20, '60': 60 };

/** Filter presets: where the price now sits relative to the signal, `[min, max)`. */
export const SIGNAL_GAP_BANDS: Record<string, [number, number]> = {
  BELOW: [-Infinity, 0],
  '0_5': [0, 5],
  '5_15': [5, 15],
  '15': [15, Infinity],
};

/**
 * How many rows may be judged on their signals at once.
 *
 * A signal is one chart request per symbol, so filtering or sorting on one has
 * to fetch the whole list rather than the page on screen — see `useSignals`.
 * Past this many rows that is a fetch storm, and the controls disable
 * themselves rather than start one: narrow the list with a screen or the other
 * filters first.
 */
export const SIGNAL_FILTER_MAX = 400;

/** Filter presets: minimum `score`. */
export const SIGNAL_SCORE_MIN: Record<string, number> = { '60': 60, '75': 75 };

/** The signal filters. `'ALL'` in any slot means "don't filter on this". */
export interface SignalFilter {
  /** `'BUY'`, `'SELL'` or `'ALL'`. */
  side: string;
  /** A key of `SIGNAL_AGE_MAX`, or `'ALL'`. */
  age: string;
  /** A key of `SIGNAL_GAP_BANDS`, or `'ALL'`. */
  gap: string;
  /** A key of `SIGNAL_SCORE_MIN`, or `'ALL'`. Absent counts as `'ALL'`. */
  score?: string;
}

/** True when nothing in the filter would reject anything. */
export const signalFilterIsEmpty = (f: SignalFilter) =>
  f.side === 'ALL' && f.age === 'ALL' && f.gap === 'ALL' && (f.score ?? 'ALL') === 'ALL';

/**
 * Does one row's signal pass the side, age, gap and score filters?
 *
 * A row with no signal — never fetched, or a history too short for one — fails
 * any active filter rather than passing it. Filtering on the signal is asking
 * for rows whose signal says something, and a row that has nothing to say is
 * not an answer.
 */
export function matchesSignalFilter(
  signal: Signal | null | undefined,
  price: number | null | undefined,
  filter: SignalFilter,
): boolean {
  if (signalFilterIsEmpty(filter)) return true;
  if (!signal) return false;

  if (filter.side !== 'ALL' && signal.side !== filter.side) return false;

  const maxAge = SIGNAL_AGE_MAX[filter.age];
  if (maxAge !== undefined && signal.age > maxAge) return false;

  const minScore = filter.score ? SIGNAL_SCORE_MIN[filter.score] : undefined;
  if (minScore !== undefined && signal.score < minScore) return false;

  const band = SIGNAL_GAP_BANDS[filter.gap];
  if (band) {
    const pct = signalGapPct(signal, price);
    if (pct === null || pct < band[0] || pct >= band[1]) return false;
  }

  return true;
}

/** Weighted moving average, null until `len` consecutive numbers are in hand. */
function wma(values: (number | null)[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const denom = (len * (len + 1)) / 2;

  for (let i = len - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const v = values[i - k];
      if (v === null) {
        ok = false;
        break;
      }
      sum += v * (len - k);
    }
    if (ok) out[i] = sum / denom;
  }

  return out;
}

/**
 * `wma(2 * wma(src, round(n/2)) - wma(src, n), round(sqrt(n)))`, as the script
 * writes it.
 *
 * Both derived lengths are **rounded**, not floored. This file previously
 * floored them on the reasoning that Pine's `int()` truncates — true of
 * `int()`, but the source calls `round()`, and at n=31 the two disagree on
 * both: 16 vs 15 and 6 vs 5. Which is a different curve, and the point of this
 * file is to agree with a chart.
 */
export function hma(values: (number | null)[], len: number): (number | null)[] {
  const half = wma(values, Math.max(1, Math.round(len / 2)));
  const full = wma(values, len);
  const raw = values.map((_, i) =>
    half[i] === null || full[i] === null ? null : 2 * (half[i] as number) - (full[i] as number),
  );
  return wma(raw, Math.max(1, Math.round(Math.sqrt(len))));
}

/**
 * Pine's `atr(period)`, which is `rma(tr, period)`. Bars must carry
 * high/low/close — see `cleanBars`.
 *
 * The seed is `sma(tr, period)` and it lands at index `period - 1`, over
 * `period` true ranges. An earlier version seeded at index `period` over
 * `period + 1` of them, which is off by one bar for the whole series and, at
 * the `period = 1` this study actually uses, is the difference between an
 * average of two bars and the identity: `rma(tr, 1)` is `tr`.
 */
export function atr(bars: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period) return out;

  const trueRange = (i: number) => {
    const { high, low } = bars[i] as { high: number; low: number };
    // Pine's `tr` at bar 0 is `high - low`: there is no previous close to gap
    // against.
    if (i === 0) return high - low;
    const prev = bars[i - 1].close as number;
    return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  };

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRange(i);
  let value = sum / period;
  out[period - 1] = value;

  for (let i = period; i < bars.length; i++) {
    value = (value * (period - 1) + trueRange(i)) / period;
    out[i] = value;
  }

  return out;
}

/**
 * Complete bars, with a single bad tick clamped back onto the bar's own body.
 *
 * The series used to be filtered for nulls and handed straight to the ATR,
 * which trusts `high` and `low` completely. Yahoo's Indian history does not
 * deserve that: `technicals.ts` documents monthly bars reporting a high of
 * 1090 in a month that ranged 313–366, and the daily bars those are built from
 * carry the same ticks. One 2× high is an inflated trailing stop for the whole
 * smoothing window after it, and the flip that suppresses is a real signal that
 * never appears — invisible in a way a false one is not.
 *
 * Clamping rather than dropping the bar: the day traded, and deleting it would
 * shift every window that spans it. The high is pulled down to the bar's own
 * open/close body, which is the most conservative thing that is certainly true.
 * The opposite clamp is applied too — a `high` below the body, or a `low` above
 * it, is the same corruption in the direction that understates the range.
 *
 * ## Sessions that never happened
 *
 * The other half of this function, and the more damaging one. Yahoo pads NSE
 * holidays with a bar repeating the previous close in all four fields and no
 * volume behind it — 2026-01-15, 05-01, 05-28 and 06-26 in the last year alone,
 * the same dates for every symbol on the exchange.
 *
 * At `atr(1)` that is not cosmetic. A zero true range makes `nLoss` zero, which
 * puts the trailing stop *exactly* on the close, and the next real session is
 * then a guaranteed crossing whatever it does. ADOR's flip read 29 Jun 2026
 * against the chart's 20 Apr for precisely this reason: the 26 Jun holiday
 * collapsed the stop and manufactured a BUY three days later. Four unrelated
 * names flipped on that same date, which is the signature — a market-wide
 * event does not send RELIANCE and ICICIBANK opposite ways on one day.
 *
 * The discriminator is volume, not the flat shape. A genuine circuit lock is
 * also `open == high == low == close` and must keep its bar: it is a real
 * session that traded, sometimes heavily — SUZLON locked twice on 11–14 million
 * shares. A holiday traded nothing.
 */
export function cleanBars(rawBars: Candle[]): Candle[] {
  const out: Candle[] = [];

  for (const bar of rawBars) {
    const { high, low, close } = bar;
    if (typeof close !== 'number' || close <= 0) continue;
    if (typeof high !== 'number' || typeof low !== 'number' || low <= 0) continue;
    // A session Yahoo invented: no range and nothing traded. See above.
    if (high === low && !(typeof bar.volume === 'number' && bar.volume > 0)) continue;

    const open = typeof bar.open === 'number' && bar.open > 0 ? bar.open : close;
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);

    out.push({
      ...bar,
      high: high > bodyHigh * SPIKE_RATIO ? bodyHigh : Math.max(high, bodyHigh),
      low: low < bodyLow / SPIKE_RATIO ? bodyLow : Math.min(low, bodyLow),
    });
  }

  return out;
}

/** One crossing of the trailing stop, as the run produces it. */
interface Flip {
  index: number;
  side: 'BUY' | 'SELL';
  price: number;
  date: string;
}

/**
 * Every flip in the series, plus where the trailing stop ended up.
 *
 * The stop update is Pine's `xATRTrailingStop` verbatim: it ratchets towards the
 * source while the source stays on the same side of it, and jumps to the other
 * side of the source when it doesn't.
 *
 * **The source is `close`.** Not the HMA — the script's UT Bot leg reads
 * `close` and the HMA is a separate plot it never consults. Feeding the HMA in
 * here, as this function used to, is a smoother and much lazier rule than the
 * one the chart draws.
 *
 * A flip is Pine's `crossover`, which the script writes through the identity
 * `ema(src, 1) == src`:
 *
 *     buy  = crossover(src, stop)  ==  src > stop  and src[1] <= stop[1]
 *     sell = crossunder(src, stop) ==  src < stop  and src[1] >= stop[1]
 *
 * Each side of the comparison is taken against **its own bar's** stop, which is
 * why `prevStop` is carried rather than reusing `prev`. And there is no
 * position filter: a `crossover` cannot fire on two consecutive bars, because
 * firing on `i` requires `src[i] > stop[i]` and firing on `i+1` requires the
 * negation of it. Pine's `pos` variable exists only to colour bars.
 *
 * Split out from `latestSignal` because the earlier flips are not waste: each
 * consecutive pair is a completed round trip of this exact rule on this exact
 * symbol, which is the only evidence available for whether the latest one is
 * worth anything. The loop was already computing them and throwing them away.
 */
export function runUtBot(
  bars: Candle[],
  cfg = UT_BOT,
): { flips: Flip[]; stop: number | null } {
  const ranges = atr(bars, cfg.atrPeriod);

  const flips: Flip[] = [];
  /** `xATRTrailingStop[1]`, or null before the series has started. */
  let prevStop: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const range = ranges[i];
    if (range === null) continue;

    const now = bars[i].close as number;
    // `src[1]` — na on the first bar, which sends Pine's nested `iff` to its
    // final arm and makes `crossover` na rather than true.
    const before = i > 0 ? (bars[i - 1].close as number) : null;
    // Pine's `nz(xATRTrailingStop[1], 0)`: zero on the first bar, which puts
    // the source above it and seeds a long stop.
    const prev: number = prevStop ?? 0;
    const nLoss = cfg.keyValue * range;

    const stop =
      before !== null && now > prev && before > prev
        ? Math.max(prev, now - nLoss)
        : before !== null && now < prev && before < prev
          ? Math.min(prev, now + nLoss)
          : now > prev
            ? now - nLoss
            : now + nLoss;

    if (prevStop !== null && before !== null) {
      const side =
        now > stop && before <= prevStop
          ? 'BUY'
          : now < stop && before >= prevStop
            ? 'SELL'
            : null;
      if (side) flips.push({ index: i, side, price: now, date: bars[i].date });
    }

    prevStop = stop;
  }

  return { flips, stop: prevStop };
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** Median, not mean: one halted or block-dealt session is not a typical day. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How this rule has done on this symbol inside the window.
 *
 * Each flip is closed by the next one — the study is always in the market and
 * reverses rather than exiting, so a round trip really is flip-to-flip. The
 * open trade (the latest flip) is excluded: judging it by where the price
 * happens to be today is what makes every backtest look like a bull market.
 *
 * Costs and slippage are not modelled and this is a year of daily bars, so it
 * is evidence and not a track record — hence `MIN_TRADES` and hence a weight in
 * `SCORE` rather than a verdict of its own.
 */
function summarise(flips: Flip[]): Signal['history'] {
  const returns: number[] = [];
  for (let i = 0; i + 1 < flips.length; i++) {
    const entry = flips[i];
    const exit = flips[i + 1];
    if (!entry.price) continue;
    const move = ((exit.price - entry.price) / entry.price) * 100;
    returns.push(entry.side === 'BUY' ? move : -move);
  }

  if (returns.length < MIN_TRADES) return null;
  return {
    trades: returns.length,
    wins: returns.filter((r) => r > 0).length,
    avgPct: mean(returns) as number,
  };
}

/**
 * The most recent flip of UT Bot's trailing stop, with the context that decides
 * whether it is worth acting on. Null if the history is too short for one.
 *
 * Side, price and date are the study and nothing here touches them. Everything
 * else is measured from the same bars — no second request — and folded into
 * `score`; see the note at the top of this file for why each one is there.
 */
export function latestSignal(rawBars: Candle[], cfg = UT_BOT): Signal | null {
  const bars = cleanBars(rawBars);
  // The UT Bot alone needs almost nothing — `atr(1)` exists on bar 0. The floor
  // is set by the context instead: a Hull trend and a full volume window.
  if (bars.length < cfg.hmaLength + VOL_WINDOW) return null;

  const { flips, stop } = runUtBot(bars, cfg);
  const flip = flips[flips.length - 1];
  if (!flip || stop === null) return null;

  const last = bars.length - 1;
  const volumeAt = (i: number) => (typeof bars[i].volume === 'number' ? (bars[i].volume as number) : null);

  // Volume on the flip bar against the month ending on it — the average has to
  // end there rather than at the latest bar, or a signal is judged against
  // trading that had not happened when it fired.
  const window: number[] = [];
  for (let i = Math.max(0, flip.index - VOL_WINDOW + 1); i <= flip.index; i++) {
    const v = volumeAt(i);
    if (v !== null && v > 0) window.push(v);
  }
  const avgVolume = window.length >= VOL_WINDOW / 2 ? mean(window) : null;
  const flipVolume = volumeAt(flip.index);
  const volumeRatio = avgVolume && flipVolume ? flipVolume / avgVolume : null;

  // The regime the flip fired into, judged now rather than then: the question a
  // signal has to answer is whether to act on it today. `c1` in the script —
  // the Hull line rising or falling, which is the colour it is drawn in.
  const hull = hma(bars.map((b) => b.close), cfg.hmaLength);
  const rising = hull[last] !== null && hull[last - 1] !== null ? hull[last]! > hull[last - 1]! : null;
  const trend: Signal['trend'] =
    rising === null ? 0 : (((rising ? 1 : -1) * (flip.side === 'BUY' ? 1 : -1)) as 1 | -1);

  const turnover = median(
    bars
      .slice(-VOL_WINDOW)
      .map((b) => (typeof b.volume === 'number' ? b.volume * (b.close as number) : null))
      .filter((v): v is number => v !== null && v > 0),
  );

  const history = summarise(flips);
  // The last daily bar is still trading, so a flip dated on it is not yet a
  // fact. `isMarketOpen` already knows the session, holidays aside.
  const provisional = flip.index === last && isMarketOpen();

  let score = SCORE.base;
  score += trend * SCORE.trend;
  if (volumeRatio !== null) {
    if (volumeRatio >= VOLUME_STRONG) score += SCORE.volume;
    else if (volumeRatio < VOLUME_THIN) score += SCORE.volumeThin;
  }
  if (history) score += (history.wins / history.trades - 0.5) * 2 * SCORE.history;
  if (turnover !== null && turnover < TURNOVER_FLOOR) score += SCORE.illiquid;
  if (provisional) score += SCORE.provisional;

  return {
    side: flip.side,
    price: flip.price,
    date: flip.date,
    age: last - flip.index,
    stop,
    trend,
    volumeRatio,
    turnover,
    history,
    provisional,
    score: Math.round(Math.max(0, Math.min(100, score))),
  };
}

/**
 * One chart request per symbol, kept for the trading day.
 *
 * Requested per visible cell rather than per row in the table, so a page of 50
 * costs 50 requests and scrolling back costs none. The gate is what stops a
 * fast scroll opening a hundred sockets at Yahoo at once.
 *
 * Stored as a positional tuple: ~2,400 of these share a 5 MB localStorage quota
 * with the screen's own caches, and the field names cost more than the numbers.
 */
/**
 * The discontinued rule's store, deleted on load.
 *
 * `utbot-v2` is a new key because every entry the old one holds was produced by
 * the pre-source rule — HMA as the source, the parameters the wrong way round —
 * and a rename retires them at once, where bumping `VERSION` in dayCache.ts is
 * global and would also throw away the thirty-day fundamentals cache at 1.2s a
 * row to refill.
 *
 * But a renamed store is only unread, not gone: ~2,400 dead signals would sit in
 * a 5 MB quota shared with the screen's caches until the browser was cleared,
 * and nothing would ever collect them. The old rule is discontinued, so its
 * entries go with it.
 */
try {
  localStorage.removeItem('fivealpha:utbot:v4');
} catch {
  // Private mode, storage disabled, quota games — nothing to clean up then.
}

const store = dayCache<Signal | null>('utbot-v2', {
  encode: (s) =>
    s === null
      ? 0
      : [
          s.side === 'BUY' ? 1 : -1,
          s.price,
          s.date,
          s.age,
          s.stop,
          s.trend,
          s.volumeRatio,
          s.turnover,
          s.history ? [s.history.trades, s.history.wins, s.history.avgPct] : 0,
          s.score,
        ],
  decode: (raw) => {
    if (raw === 0) return null;
    // Length is the version check: an entry written before the context existed
    // is rejected and refetched rather than read as a signal with no stop.
    if (!Array.isArray(raw) || raw.length !== 10) return undefined;
    const [side, price, date, age, stop, trend, volumeRatio, turnover, history, score] = raw as [
      number,
      number,
      string,
      number,
      number,
      1 | 0 | -1,
      number | null,
      number | null,
      [number, number, number] | 0,
      number,
    ];
    return {
      side: side === 1 ? 'BUY' : 'SELL',
      price,
      date,
      age,
      stop,
      trend,
      volumeRatio,
      turnover,
      history: Array.isArray(history)
        ? { trades: history[0], wins: history[1], avgPct: history[2] }
        : null,
      // Never stored — see `fetchSignal`, which does not cache one.
      provisional: false,
      score,
    };
  },
});

const gate = createGate(8);
const inflight = new Map<string, Promise<Signal | null>>();

/** A cached answer if there is one, without starting a fetch. */
export const peekSignal = (ticker: string): Signal | null | undefined => store.get(ticker);

export function fetchSignal(ticker: string): Promise<Signal | null> {
  if (store.has(ticker)) return Promise.resolve(store.get(ticker) ?? null);

  const hit = inflight.get(ticker);
  if (hit) return hit;

  const pending = gate(() => fetchYahooBars(ticker, RANGE, INTERVAL))
    .then((bars) => {
      const signal = latestSignal(bars);
      // A flip on a bar that is still trading is the one answer here that is
      // not settled for the day: it can be gone by the close. Caching it would
      // freeze a maybe into a verdict until midnight.
      if (!signal?.provisional) store.set(ticker, signal);
      inflight.delete(ticker);
      return signal;
    })
    // A failed request is not an answer — drop it so the next look retries.
    .catch((err) => {
      inflight.delete(ticker);
      throw err;
    });

  inflight.set(ticker, pending);
  return pending;
}
