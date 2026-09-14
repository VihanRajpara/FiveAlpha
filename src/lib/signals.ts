import type { Candle } from '../types';
import { dayCache } from './dayCache';
import { createGate, isMarketOpen } from './format';
import { fetchYahooBars } from './yahooCandles';
import {
  cleanBars,
  latestSignal,
  runUtBot,
  UT_BOT,
  type Flip,
  type Signal,
} from '../../supabase/functions/_shared/utbot.ts';

/**
 * The signal arithmetic itself lives under `supabase/functions/`, so that the
 * Edge Function that sends the alerts and the column that draws them are the
 * same code rather than two transcriptions of it. Re-exported here so that no
 * consumer's import had to change: everything still comes from `lib/signals`.
 *
 * `allowImportingTsExtensions` is already on in tsconfig.json, and the
 * `"exclude": ["supabase"]` line does not block this — exclude limits globbing,
 * not files pulled in by an import.
 */
export * from '../../supabase/functions/_shared/utbot.ts';

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
 * This used to be 400, which disabled the signal columns on every view wider
 * than a screen's shortlist — including "All", where sorting by Gap is the
 * obvious thing to want and the control was simply grey.
 *
 * Three things make the whole list affordable, and none of them were true when
 * the number was set:
 *   · Nothing runs until the user sorts or filters on a signal column. The
 *     default order is by symbol and costs no request at all.
 *   · Answers are kept for the trading day (`store` below) and the proxy caches
 *     upstream on top of that, so a full pass is paid once a day, not per sort.
 *   · `createGate(8)` holds it to eight in flight however long the list is, and
 *     the table re-sorts as answers land rather than waiting for the last one.
 *
 * So the cap is now the whole universe rather than a shortlist: it exists to
 * stop an unbounded list, not to stop a large one. It is still a real fetch —
 * a full pass over both exchanges is thousands of requests and some of them
 * will fail — which is why `useSignals` counts what it could not read and the
 * bar says so.
 */
export const SIGNAL_FILTER_MAX = 6000;

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
  /** A key of `MAPO_BANDS`, or `'ALL'`. Absent counts as `'ALL'`. */
  mapo?: string;
}

/** True when nothing in the filter would reject anything. */
export const signalFilterIsEmpty = (f: SignalFilter) =>
  f.side === 'ALL' &&
  f.age === 'ALL' &&
  f.gap === 'ALL' &&
  (f.score ?? 'ALL') === 'ALL' &&
  (f.mapo ?? 'ALL') === 'ALL';

/**
 * Does one row pass the side, age, gap, score and MAPO filters?
 *
 * A row with no reading — never fetched, or a history too short for one — fails
 * any active filter rather than passing it. Filtering is asking for rows that
 * say something, and a row with nothing to say is not an answer.
 *
 * The MAPO band is tested **before** the flip is required, because the two are
 * independent: a name that has not crossed its trailing stop in two years still
 * has an oscillator reading, and filtering on breadth alone must not silently
 * drop it for lacking a signal it was never asked about.
 */
export function matchesSignalFilter(
  signal: Signal | null | undefined,
  price: number | null | undefined,
  filter: SignalFilter,
  mapoReading?: Mapo | null,
): boolean {
  if (signalFilterIsEmpty(filter)) return true;

  const mapoBand = filter.mapo ? MAPO_BANDS[filter.mapo] : undefined;
  if (mapoBand && (!mapoReading || mapoReading.above < mapoBand[0] || mapoReading.above >= mapoBand[1])) {
    return false;
  }

  // Everything below is a property of the flip, so past here one is required.
  const wantsSignal =
    filter.side !== 'ALL' ||
    filter.age !== 'ALL' ||
    filter.gap !== 'ALL' ||
    (filter.score ?? 'ALL') !== 'ALL';
  if (!wantsSignal) return true;
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

/**
 * Moving Averages Proximity Oscillator [LuxAlgo] — `MAPO [LuxAlgo] 5 100 3 close`,
 * transcribed from its Pine v5 source.
 *
 * A fan of simple moving averages from `minLength` to `maxLength`, and two
 * readings taken against it every bar:
 *
 *   · `above` — Pine's `per`, "Price Above MA's". How many of the 96 averages
 *     the close is currently above, as a percentage. The **histogram**, drawn
 *     teal over 50 and red under it. A trend-breadth reading: 100 means the
 *     close is above every average from the 5-day to the 100-day.
 *   · `proximity` — Pine's `len`, "Proximity Index". *Which* average sits
 *     nearest the close, rescaled onto the same 0–100 axis. The **blue line**.
 *     It says nothing about direction — a price hugging its 100-day reads high
 *     whether it is above or below — so it is context, not a signal.
 *
 * Both are smoothed by `ta.sma(·, smooth)` and then normalised, in that order.
 *
 * Free to compute: `latestSignal` has already fetched these bars, so this costs
 * no request. The cumulative-sum trick is Pine's own and is what makes a
 * 96-deep fan affordable — each average is O(1) rather than O(period).
 *
 * Checked against the chart: CGPOWER on 2026-09-04 reads `proximity` **54.86**
 * here and 54.86 on TradingView. `above` comes out 42.01 against 41.67, which
 * is one count of ninety-six on one of the three smoothed bars — a single close
 * where Yahoo and TradingView disagree, not a difference in the arithmetic.
 */
export const MAPO = {
  /** `min`. The script's own default is 10; the chart this follows uses 5. */
  minLength: 5,
  /** `max`. */
  maxLength: 100,
  /** `smooth` — an SMA over both outputs. The script defaults to 9. */
  smooth: 3,
};

/** The script's `hline`s, and the `histbase` between them. */
export const MAPO_HIGH = 80;
export const MAPO_MID = 50;
export const MAPO_LOW = 20;

export interface Mapo {
  /** `per` normalised: percent of the fan the close is above. 0–100. */
  above: number;
  /** `len` normalised: where the nearest average sits in the fan. 0–100. */
  proximity: number;
}

/**
 * The latest MAPO reading, or null if there are not enough bars for the fan.
 *
 * Only the last `smooth` bars are evaluated. Pine computes every bar because a
 * chart plots every bar; a table needs one number, and 3 bars × 96 averages is
 * three hundred operations against the forty thousand a full history would be.
 */
/**
 * The cumulative-sum SMA the oscillator is built on.
 *
 * `csum[n + 1]` is the sum through bar `n`, so any period's average is one
 * subtraction — which is what makes evaluating ninety-six of them per bar
 * affordable at all.
 */
function smaOver(closes: number[]) {
  const csum = [0];
  for (let i = 0; i < closes.length; i++) csum.push(csum[i] + closes[i]);
  /** Pine's `(csum - csum[i]) / i` — the `i`-period average ending at bar `n`. */
  return (n: number, i: number) => (csum[n + 1] - csum[n + 1 - i]) / i;
}

/**
 * One bar's raw `per` and `len`, before smoothing or normalisation.
 *
 * Split out so the table's single reading and the chart's whole series run the
 * *same* arithmetic. They have genuinely different cost profiles — one is
 * called for thousands of tickers and evaluates three bars, the other for one
 * ticker and evaluates a thousand — but if they were two transcriptions of the
 * Pine they would eventually disagree, and the chart would draw a line that
 * contradicted the column beside it.
 */
function mapoBar(closes: number[], sma: (n: number, i: number) => number, n: number, cfg: typeof MAPO) {
  const { minLength: min, maxLength: max } = cfg;
  const src = closes[n];
  // `max_min` is seeded from the i = min average *before* the loop, so the
  // first iteration always ties and `len` starts at `min` rather than at 0.
  let maxMin = Math.abs(src - sma(n, min));
  let nearest = min;
  let above = 0;

  for (let i = min; i <= max; i++) {
    const ma = sma(n, i);
    if (src > ma) above++;

    // Pine assigns `max_min := min(ae, max_min)` and then takes `i` whenever
    // `ae == max_min`, so an exact tie moves to the *later* period. A strict
    // `<` would keep the earlier one and quietly disagree with the chart.
    const ae = Math.abs(src - ma);
    if (ae <= maxMin) {
      maxMin = ae;
      nearest = i;
    }
  }

  return { per: above, len: nearest };
}

const meanOf = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export function mapo(closes: number[], cfg = MAPO): Mapo | null {
  const { minLength: min, maxLength: max, smooth } = cfg;
  const span = max - min + 1;
  // `sma(n, max)` needs `max` closes behind it, and the smoothing needs
  // `smooth` such bars.
  if (closes.length < max + smooth - 1) return null;

  const sma = smaOver(closes);
  const per: number[] = [];
  const len: number[] = [];

  for (let n = closes.length - smooth; n < closes.length; n++) {
    const bar = mapoBar(closes, sma, n, cfg);
    per.push(bar.per);
    len.push(bar.len);
  }

  // Smoothed first, normalised second — the order the script uses.
  return {
    above: (meanOf(per) / span) * 100,
    proximity: ((meanOf(len) - min) / span) * 100,
  };
}

/**
 * `above` at every bar, for the chart's oscillator pane.
 *
 * Aligned to `closes` by index and `null` until the fan has enough history —
 * `max + smooth - 1` bars, which on a daily series is about five months. That
 * warm-up is the reason the chart computes its studies over a long history and
 * then *windows* the result: asked to compute over a one-month view there would
 * be nothing to draw at all.
 *
 * ~96 averages a bar, each a single subtraction. Over five years of dailies
 * that is roughly 120k operations — a few milliseconds, once, for a chart that
 * is drawn on demand for one symbol. The single-reading `mapo` above stays
 * separate precisely because it runs for thousands of them.
 */
export function mapoSeries(closes: number[], cfg = MAPO): (Mapo | null)[] {
  const { minLength: min, maxLength: max, smooth } = cfg;
  const span = max - min + 1;
  const out: (Mapo | null)[] = new Array(closes.length).fill(null);
  if (closes.length < max + smooth - 1) return out;

  const sma = smaOver(closes);
  const per: number[] = [];
  const len: number[] = [];

  for (let n = max - 1; n < closes.length; n++) {
    const bar = mapoBar(closes, sma, n, cfg);
    per.push(bar.per);
    len.push(bar.len);
    if (per.length > smooth) {
      per.shift();
      len.shift();
    }
    // Both outputs, because the script plots both: `per` is the histogram and
    // `len` is the line drawn over it. A pane with only the histogram is half
    // the indicator, and the table's single reading already carries the pair.
    if (per.length === smooth) {
      out[n] = {
        above: (meanOf(per) / span) * 100,
        proximity: ((meanOf(len) - min) / span) * 100,
      };
    }
  }

  return out;
}

/** Filter presets on `above`, `[min, max)`, cut at the script's own levels. */
export const MAPO_BANDS: Record<string, [number, number]> = {
  HIGH: [MAPO_HIGH, Infinity],
  UPPER: [MAPO_MID, MAPO_HIGH],
  LOWER: [MAPO_LOW, MAPO_MID],
  LOW: [-Infinity, MAPO_LOW],
};

/**
 * Everything computed from one symbol's bars, cached as a unit.
 *
 * MAPO does not depend on the UT Bot having flipped, so it cannot live inside
 * `Signal`: a name with no crossing in two years still has a breadth reading,
 * and burying it in a nullable signal would hide it. They share a record
 * because they share the request, and because caching them apart would let the
 * two halves of one answer expire at different moments.
 */
export interface Reading {
  signal: Signal | null;
  mapo: Mapo | null;
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

const store = dayCache<Reading>('utbot-v2', {
  // A pair, so the outer length is also the version check: every entry written
  // before MAPO existed is a bare tuple or a 0 and is rejected below rather
  // than read back as a reading with no oscillator in it.
  encode: ({ signal: s, mapo: m }) => [
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
    m === null ? 0 : [m.above, m.proximity],
  ],
  decode: (stored) => {
    if (!Array.isArray(stored) || stored.length !== 2) return undefined;
    const [raw, rawMapo] = stored;

    const mapoPart: Mapo | null =
      rawMapo === 0
        ? null
        : Array.isArray(rawMapo) && rawMapo.length === 2
          ? { above: rawMapo[0] as number, proximity: rawMapo[1] as number }
          : (undefined as unknown as Mapo);
    if (mapoPart === undefined) return undefined;

    if (raw === 0) return { signal: null, mapo: mapoPart };
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
      signal: {
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
        // Never stored — see `fetchReading`, which does not cache one.
        provisional: false,
        score,
      },
      mapo: mapoPart,
    };
  },
});

const gate = createGate(8);
const inflight = new Map<string, Promise<Reading>>();

/** A cached answer if there is one, without starting a fetch. */
export const peekReading = (ticker: string): Reading | undefined => store.get(ticker);

/** The flip alone, for the callers that only want that. */
export const peekSignal = (ticker: string): Signal | null | undefined =>
  store.get(ticker)?.signal;

/** The oscillator alone. Present even where there is no flip to show. */
export const peekMapo = (ticker: string): Mapo | null | undefined => store.get(ticker)?.mapo;

export function fetchReading(ticker: string): Promise<Reading> {
  const cached = store.get(ticker);
  if (cached !== undefined) return Promise.resolve(cached);

  const hit = inflight.get(ticker);
  if (hit) return hit;

  const pending = gate(() => fetchYahooBars(ticker, RANGE, INTERVAL))
    .then((bars) => {
      const signal = latestSignal(bars, UT_BOT, isMarketOpen());
      const reading: Reading = { signal, mapo: mapo(cleanBars(bars).map((b) => b.close as number)) };
      // A flip on a bar that is still trading is the one answer here that is
      // not settled for the day: it can be gone by the close. Caching it would
      // freeze a maybe into a verdict until midnight — and MAPO reads the same
      // unfinished close, so the pair is withheld together or not at all.
      if (!signal?.provisional) store.set(ticker, reading);
      inflight.delete(ticker);
      return reading;
    })
    // A failed request is not an answer — drop it so the next look retries.
    .catch((err) => {
      inflight.delete(ticker);
      throw err;
    });

  inflight.set(ticker, pending);
  return pending;
}

/* ---------- the chart's series ---------------------------------------- */

/**
 * How much history the chart computes over, regardless of what it displays.
 *
 * Both studies need a run-up before they produce anything — the ATR needs its
 * period, and the fan needs `maxLength + smooth - 1` bars, about five months of
 * dailies. Computing over the visible window instead would leave the 1M view
 * with no oscillator at all and a trailing stop seeded from nothing.
 *
 * Daily, and never weekly, because that is the interval the table's own signal
 * is calibrated on (see RANGE/INTERVAL above). A chart drawing weekly-derived
 * studies beside a column showing daily-derived ones would be two different
 * answers to the same question.
 */
const CHART_RANGE = '5y';

export interface ChartData {
  bars: Candle[];
  /** UT Bot trailing stop at every bar, aligned by index. */
  stop: (number | null)[];
  /** Both MAPO outputs at every bar, aligned by index. */
  mapo: (Mapo | null)[];
  /**
   * Every crossing in the full history.
   *
   * Carried rather than recomputed by the chart, because the trailing stop is
   * path-dependent: run the rule over a one-month slice and it starts from a
   * stop seeded at zero, so the flips it reports near the left edge are ones
   * that never happened. These are the flips of the whole series, filtered to
   * the window by date.
   */
  flips: Flip[];
}

/** Trading days per display window. `null` means the whole history. */
export const CHART_WINDOW: Record<string, number | null> = {
  '1mo': 22,
  '6mo': 126,
  '1y': 252,
  '5y': null,
};

const chartStore = new Map<string, ChartData>();
const chartInflight = new Map<string, Promise<ChartData>>();

/**
 * Five years of dailies with both studies computed over all of it, once.
 *
 * Cached per ticker and keyed on nothing else, which is what lets the range
 * buttons re-window instantly instead of firing a request each: the old chart
 * refetched on every press, and three of the four presses were asking for a
 * subset of what it already had.
 *
 * Only drawers that have been opened land in here, so the map stays small — this
 * is deliberately not the `store` above, which holds a reading for every ticker
 * in the table and would grow by a thousand bars each if it held these.
 */
export function fetchChartSeries(ticker: string): Promise<ChartData> {
  const cached = chartStore.get(ticker);
  if (cached) return Promise.resolve(cached);

  const hit = chartInflight.get(ticker);
  if (hit) return hit;

  const pending = gate(() => fetchYahooBars(ticker, CHART_RANGE, INTERVAL))
    .then((raw) => {
      const bars = cleanBars(raw);
      const run = runUtBot(bars);
      const data: ChartData = {
        bars,
        stop: run.stops,
        flips: run.flips,
        mapo: mapoSeries(bars.map((b) => b.close as number)),
      };
      chartStore.set(ticker, data);
      chartInflight.delete(ticker);
      return data;
    })
    .catch((err) => {
      chartInflight.delete(ticker);
      throw err;
    });

  chartInflight.set(ticker, pending);
  return pending;
}

/** The tail of a computed series — the display window, studies already warm. */
export function windowChart(data: ChartData, range: string): ChartData {
  const take = CHART_WINDOW[range] ?? null;
  if (take === null || take >= data.bars.length) return data;
  const from = data.bars.length - take;
  // By index for the aligned series, by date for the flips — their `index`
  // points into the full history and would be meaningless after a slice.
  const firstDate = data.bars[from].date;
  return {
    bars: data.bars.slice(from),
    stop: data.stop.slice(from),
    mapo: data.mapo.slice(from),
    flips: data.flips.filter((f) => f.date >= firstDate),
  };
}

/** Back-compat for callers that only care about the flip. */
export const fetchSignal = (ticker: string): Promise<Signal | null> =>
  fetchReading(ticker).then((r) => r.signal);

