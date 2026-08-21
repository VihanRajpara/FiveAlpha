import type { Candle } from '../types';
import { dayCache } from './dayCache';
import { createGate } from './format';
import { fetchYahooBars } from './yahooCandles';

/**
 * UT Bot on an HMA — the buy/sell leg of the TradingView study labelled
 * `SVMKR_UT_HMA_ORB 6 1 31 5 1010-1015`.
 *
 * The script itself is private, so what is implemented here is the public
 * arithmetic its name is made of: an ATR trailing stop (UT Bot Alerts) fed by a
 * Hull moving average instead of raw closes. A signal is the bar on which the
 * source crosses its own trailing stop; the "amount" is that bar's close and the
 * "time" is that bar's date.
 *
 * **The ORB half is not implemented.** An opening-range breakout between 10:10
 * and 10:15 is an intraday rule, and Yahoo carries intraday bars for 60 days at
 * one request per symbol per timeframe — a table of 2,400 rows cannot pay for
 * it. Everything here is computed from daily bars, which is also why the signal
 * carries a date rather than a clock time.
 *
 * The four numbers below are read off that chart label in the order it prints
 * them and are the one thing worth checking against the real script.
 */
export const UT_BOT = {
  /** ATR lookback, Wilder-smoothed. */
  atrPeriod: 6,
  /** UT Bot's "key value" — the ATR multiple the trailing stop sits away by. */
  keyValue: 1,
  /** Hull moving average length, used as the source instead of `close`. */
  hmaLength: 31,
};

/** Daily bars are enough for a 31-period HMA several times over. */
const RANGE = '1y';
const INTERVAL = '1d';

export interface Signal {
  side: 'BUY' | 'SELL';
  /** Close of the bar that flipped the trailing stop. */
  price: number;
  /** ISO date of that bar. */
  date: string;
  /** Bars since the flip — 0 means it fired on the latest bar. */
  age: number;
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
 * `wma(2 * wma(src, n/2) - wma(src, n), sqrt(n))`, Hull's definition.
 *
 * Both derived lengths are floored, which is what Pine's `int()` does — rounding
 * instead moves a 9-period HMA by a third of a bar's worth of lag, and the point
 * of this file is to agree with a chart.
 */
export function hma(values: (number | null)[], len: number): (number | null)[] {
  const half = wma(values, Math.max(1, Math.floor(len / 2)));
  const full = wma(values, len);
  const raw = values.map((_, i) =>
    half[i] === null || full[i] === null ? null : 2 * (half[i] as number) - (full[i] as number),
  );
  return wma(raw, Math.max(1, Math.floor(Math.sqrt(len))));
}

/** Wilder's ATR. Bars must carry high/low/close — see `latestSignal`. */
export function atr(bars: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  const trueRange = (i: number) => {
    const { high, low } = bars[i] as { high: number; low: number };
    if (i === 0) return high - low;
    const prev = bars[i - 1].close as number;
    return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  };

  let sum = 0;
  for (let i = 0; i <= period; i++) sum += trueRange(i);
  let value = sum / (period + 1);
  out[period] = value;

  for (let i = period + 1; i < bars.length; i++) {
    value = (value * (period - 1) + trueRange(i)) / period;
    out[i] = value;
  }

  return out;
}

/**
 * The most recent flip of UT Bot's trailing stop, or null if the history is too
 * short for one.
 *
 * The stop update is Pine's `xATRTrailingStop` verbatim: it ratchets towards the
 * source while the source stays on the same side of it, and jumps to the other
 * side of the source when it doesn't. A flip is a bar where the source ends up
 * across the stop it was on the far side of.
 */
export function latestSignal(rawBars: Candle[], cfg = UT_BOT): Signal | null {
  const bars = rawBars.filter(
    (b) => typeof b.high === 'number' && typeof b.low === 'number' && typeof b.close === 'number',
  );
  if (bars.length < cfg.hmaLength + cfg.atrPeriod + 2) return null;

  const src = hma(bars.map((b) => b.close), cfg.hmaLength);
  const ranges = atr(bars, cfg.atrPeriod);

  let stop = 0;
  let started = false;
  let pos = 0;
  let signal: Signal | null = null;

  for (let i = 1; i < bars.length; i++) {
    const now = src[i];
    const before = src[i - 1];
    const range = ranges[i];
    if (now === null || before === null || range === null) continue;

    const nLoss = cfg.keyValue * range;
    // Pine's `nz(xATRTrailingStop[1], 0)` — zero on the first bar that has both
    // an HMA and an ATR, which puts the source above it and seeds a long stop.
    const prev = started ? stop : 0;
    started = true;

    if (now > prev && before > prev) stop = Math.max(prev, now - nLoss);
    else if (now < prev && before < prev) stop = Math.min(prev, now + nLoss);
    else stop = now > prev ? now - nLoss : now + nLoss;

    const flip = before < prev && now > stop ? 1 : before > prev && now < stop ? -1 : 0;
    if (flip !== 0 && flip !== pos) {
      pos = flip;
      signal = {
        side: flip === 1 ? 'BUY' : 'SELL',
        price: bars[i].close as number,
        date: bars[i].date,
        age: bars.length - 1 - i,
      };
    }
  }

  return signal;
}

/**
 * One chart request per symbol, kept for the trading day.
 *
 * Requested per visible cell rather than per row in the table, so a page of 50
 * costs 50 requests and scrolling back costs none. The gate is what stops a
 * fast scroll opening a hundred sockets at Yahoo at once.
 */
const store = dayCache<Signal | null>('utbot', {
  encode: (s) => (s === null ? 0 : [s.side === 'BUY' ? 1 : -1, s.price, s.date, s.age]),
  decode: (raw) => {
    if (raw === 0) return null;
    if (!Array.isArray(raw) || raw.length !== 4) return undefined;
    const [side, price, date, age] = raw as [number, number, string, number];
    return { side: side === 1 ? 'BUY' : 'SELL', price, date, age };
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
      store.set(ticker, signal);
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
