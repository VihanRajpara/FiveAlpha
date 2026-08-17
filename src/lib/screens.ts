/**
 * Screens — Chartink scan clauses, restated as something this app can evaluate.
 *
 * A screen is a list of *legs*. Each leg carries the Chartink fragment it comes
 * from alongside the predicate implementing it, so the UI can show the clause
 * being run and a row can say which leg it failed on rather than just
 * disappearing. Keeping the fragment next to the code is also the only honest
 * way to review a translation like `yearly max( 10 , yearly high )`.
 *
 * Legs are split by `phase`, and that split is a cost decision rather than a
 * taxonomy — it is the order the runner in src/hooks/useScreen.ts can afford to
 * ask the questions in, cheapest first:
 *
 *   · `batch`       — answerable for hundreds of symbols in one request. Market
 *                     cap, from Yahoo's quote endpoint. Costs ~10 requests for
 *                     a whole market, so it runs first and everything it
 *                     excludes is never priced or scraped at all.
 *   · `technical`   — ten years of monthly bars: twenty symbols a request for
 *                     the scan, one a request to confirm what the scan cannot
 *                     settle.
 *   · `fundamental` — one screener.in page each, paced 1.2s apart. Only rows
 *                     still standing after both stages above, which on a
 *                     typical universe is a few dozen of a few thousand.
 *
 * Moving market cap out of the last group and into the first is what turned a
 * whole-market screen from three minutes into about one: it was previously
 * being scraped a company at a time from a page whose only other use is ROCE.
 *
 * A leg returns `null` for "cannot tell": a share listed three years ago has no
 * ten-year high, and screener.in does not carry every SME scrip. Those rows are
 * reported as unjudged, never silently failed.
 */

export type Phase = 'batch' | 'technical' | 'fundamental';

export interface ScreenMetrics {
  /** Latest close — the live quote where there is one, else the last monthly bar. */
  close: number;
  /** Chartink's `yearly max( 10 , yearly high )`. */
  high10y: number;
  /** `close / high10y`, as a percentage. 100 = sitting on the ten-year high. */
  pctOfHigh: number;
  monthlyRsi14: number | null;
  marketCapCr: number | null;
  rocePct: number | null;
  /** Monthly bars behind the technicals — a short history explains a null RSI. */
  bars: number;
}

export interface ScreenLeg {
  id: string;
  phase: Phase;
  /** The Chartink fragment, verbatim. */
  clause: string;
  /** How it reads in the UI. */
  label: string;
  /** True = passes, false = fails, null = not enough data to say. */
  test: (m: Partial<ScreenMetrics>) => boolean | null;
  /**
   * Optional, and purely an optimisation: the fraction of `high10y` at or below
   * which this leg cannot pass, i.e. `close <= high10y * coarseFloor` is always
   * a fail.
   *
   * It exists so the scan pass in src/hooks/useScreen.ts can reject a row
   * against a *lower bound* on the high instead of paying for its bars — sound
   * only in that one direction, and only for a leg that says so. Omitting it
   * costs speed, never correctness: the row is simply confirmed exactly.
   */
  coarseFloor?: number;
}

export interface ScreenDef {
  id: string;
  name: string;
  /** The Chartink screen this was taken from. */
  source: string;
  /** The full `scan_clause`, verbatim, for the "what is this running?" panel. */
  clause: string;
  summary: string;
  legs: ScreenLeg[];
}

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface ScreenResult {
  symbol: string;
  verdict: Verdict;
  metrics: Partial<ScreenMetrics>;
  /** The leg that decided a fail, or the first unanswerable one. */
  decidedBy: ScreenLeg | null;
  /** Whether a fundamentals page was reached, and which. */
  fundamentalsUrl?: string;
  /**
   * `high10y` and `pctOfHigh` are bounds from the scan pass rather than measured
   * highs — the row was decided without paying for its bars. The verdict is not
   * approximate; the two numbers are, and the table marks them.
   */
  approx?: boolean;
}

// ---------------------------------------------------------------------------
// Near all-time-high breakout
// https://chartink.com/screener/all-time-high-breakout-9032071
// ---------------------------------------------------------------------------

/** Bottom of the band: within 25% of the ten-year high. */
const NEAR_HIGH = 0.75;
const RSI_MIN = 65;
const MCAP_MIN_CR = 500;
const MCAP_MAX_CR = 50_000;
const ROCE_MIN_PCT = 10;

const num = (v: number | null | undefined): v is number => typeof v === 'number';

export const ALL_TIME_HIGH_BREAKOUT: ScreenDef = {
  id: 'ath-breakout',
  name: 'Near all-time-high breakout',
  source: 'https://chartink.com/screener/all-time-high-breakout-9032071',
  clause:
    '( {cash} ( daily close > yearly max( 10 , yearly high ) * 0.75 and ' +
    'daily close <= yearly max( 10 , yearly high ) * 1 and ' +
    'yearly return on capital employed percentage > 10 and ' +
    'market cap >= 500 and market cap <= 50000 and monthly rsi( 14 ) >= 65 ) )',
  summary:
    'Quality mid- and small-caps pressed up against a decade high with monthly momentum behind them.',
  legs: [
    {
      id: 'near-high',
      phase: 'technical',
      clause: 'daily close > yearly max( 10 , yearly high ) * 0.75',
      label: 'Within 25% of the 10-year high',
      test: (m) => (num(m.close) && num(m.high10y) ? m.close > m.high10y * NEAR_HIGH : null),
      // The leg the scan pass rejects on: a price already below 75% of the
      // *lowest possible* ten-year high is below 75% of the real one too.
      coarseFloor: NEAR_HIGH,
    },
    {
      id: 'below-high',
      phase: 'technical',
      clause: 'daily close <= yearly max( 10 , yearly high ) * 1',
      // Rarely the deciding leg, and deliberately kept anyway: the ten-year
      // window includes the current bar, whose high already contains today's
      // price, so a close can equal that high but never exceed it. It is in the
      // Chartink clause and it is what makes this a run *up to* the high rather
      // than a breakout above one.
      label: 'Not above the 10-year high',
      test: (m) => (num(m.close) && num(m.high10y) ? m.close <= m.high10y : null),
    },
    {
      id: 'rsi',
      phase: 'technical',
      clause: 'monthly rsi( 14 ) >= 65',
      label: `Monthly RSI(14) ≥ ${RSI_MIN}`,
      test: (m) => (num(m.monthlyRsi14) ? m.monthlyRsi14 >= RSI_MIN : null),
    },
    {
      id: 'mcap',
      // Batch, not fundamental: Yahoo carries this figure for hundreds of
      // symbols per request and agrees with screener.in on it, so the band is
      // applied to the whole universe up front. The scrape still supplies it
      // for anything Yahoo has no answer for.
      phase: 'batch',
      clause: 'market cap >= 500 and market cap <= 50000',
      label: 'Market cap ₹500–50,000 Cr',
      test: (m) =>
        num(m.marketCapCr) ? m.marketCapCr >= MCAP_MIN_CR && m.marketCapCr <= MCAP_MAX_CR : null,
    },
    {
      id: 'roce',
      phase: 'fundamental',
      clause: 'yearly return on capital employed percentage > 10',
      label: `ROCE > ${ROCE_MIN_PCT}%`,
      test: (m) => (num(m.rocePct) ? m.rocePct > ROCE_MIN_PCT : null),
    },
  ],
};

export const SCREENS: ScreenDef[] = [ALL_TIME_HIGH_BREAKOUT];

/**
 * Verdict over the legs of one phase or all of them.
 *
 * A definite failure beats an unknown, which is why this cannot short-circuit
 * on the first non-true result: a share with two years of history and a price
 * 60% off its high is a *fail*, not an "unjudged" row cluttering the report,
 * even though its RSI leg is unanswerable.
 */
export function judge(
  legs: ScreenLeg[],
  metrics: Partial<ScreenMetrics>,
): { verdict: Verdict; decidedBy: ScreenLeg | null } {
  let unknown: ScreenLeg | null = null;

  for (const leg of legs) {
    const result = leg.test(metrics);
    if (result === false) return { verdict: 'fail', decidedBy: leg };
    if (result === null && unknown === null) unknown = leg;
  }

  return unknown ? { verdict: 'unknown', decidedBy: unknown } : { verdict: 'pass', decidedBy: null };
}

export const legsFor = (screen: ScreenDef, phase: Phase) =>
  screen.legs.filter((leg) => leg.phase === phase);

/**
 * What the scan pass alone can conclude about a row: either a final verdict, or
 * "this one has to be paid for".
 */
export type ScanOutcome =
  | {
      kind: 'decided';
      verdict: Verdict;
      decidedBy: ScreenLeg | null;
      metrics: Partial<ScreenMetrics>;
      /** `metrics.high10y` is the bound rather than the measured high. */
      approx: boolean;
    }
  | { kind: 'confirm' };

/**
 * Decide a row from monthly closes alone, or send it to the exact pass.
 *
 * This is the rule the whole optimisation rests on, so it is stated here as one
 * pure function rather than spread through the runner. Everything it concludes
 * follows from two facts about a close-only series:
 *
 *   · RSI and the length of the history are **exact**. Wilder's RSI reads
 *     closes and nothing else, and the calendar years are the bars' own dates.
 *   · `closeHigh <= high10y`, always, because a month's close cannot exceed its
 *     own high.
 *
 * The second is a one-directional licence and is treated as one. It can prove a
 * price is *far* from its high — below the floor of a lower bound is below the
 * floor of the real thing — and it can prove nothing at all about a price near
 * one. So `high10y` is kept out of every judgement made here; it is attached to
 * the returned metrics for display, flagged `approx`, and the rows it cannot
 * settle are confirmed against real intra-month highs.
 *
 * Getting that backwards is not a rounding error. Feeding the bound to
 * `below-high` (`close <= high10y`) would fail precisely the shares sitting on a
 * decade high, which is the entire population the screen exists to find.
 */
export function judgeScan(
  screen: ScreenDef,
  scanned: {
    close: number;
    monthlyRsi14: number | null;
    bars: number;
    closeHigh: number;
    decade: boolean;
    density: number;
  },
  livePrice?: number | null,
): ScanOutcome {
  // The live quote is fresher than the current monthly bar's close during a
  // session, and using it keeps the screen consistent with the table's price.
  const close = livePrice ?? scanned.close;

  // Whether the series is whole — see `CoarseTechnicals.density`. A gappy one
  // gives a *different* RSI, not an imprecise one, and it can under-count the
  // calendar years too. Both of those are withheld below rather than corrected:
  // the row goes to the exact pass instead of being rejected on a number
  // computed over the wrong series.
  const dense = scanned.density >= 1;

  // Only what the scan measured exactly. Every `judge` call below sees this.
  const metrics: Partial<ScreenMetrics> = {
    close,
    monthlyRsi14: dense ? scanned.monthlyRsi14 : null,
    bars: scanned.bars,
  };

  const bounded = scanned.decade && scanned.closeHigh > 0;
  const shown: Partial<ScreenMetrics> = bounded
    ? { ...metrics, high10y: scanned.closeHigh, pctOfHigh: (close / scanned.closeHigh) * 100 }
    : metrics;

  const technicalLegs = legsFor(screen, 'technical');

  // 1. A definite fail on a leg the scan answers exactly — RSI, and anything
  //    else not written in terms of the ten-year high.
  const technical = judge(technicalLegs, metrics);
  if (technical.verdict === 'fail') {
    return { kind: 'decided', ...judge(screen.legs, metrics), metrics: shown, approx: bounded };
  }

  // 2. Too short a history for a ten-year high at all: `high10y` is genuinely
  //    null, the price legs are unanswerable, and the row is unjudged — the
  //    same answer the exact pass would spend a request arriving at.
  //
  //    Only on a whole series. `decade` is one-directional in exactly the way
  //    `closeHigh` is: bars the scan never saw cannot invent a year, so *true*
  //    is trustworthy anywhere, while *false* on a gappy series may only mean
  //    the missing months took a year with them.
  if (dense && !scanned.decade) {
    return { kind: 'decided', ...judge(screen.legs, metrics), metrics, approx: false };
  }

  // 3. Below the floor even against the lowest the high could possibly be.
  const floorLeg = technicalLegs.find((leg) => leg.coarseFloor !== undefined);
  if (bounded && floorLeg && close <= scanned.closeHigh * floorLeg.coarseFloor!) {
    return { kind: 'decided', verdict: 'fail', decidedBy: floorLeg, metrics: shown, approx: true };
  }

  // 4. The bound cannot settle it. Pay for the bars.
  return { kind: 'confirm' };
}
