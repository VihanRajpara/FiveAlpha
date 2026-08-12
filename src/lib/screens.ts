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
 * taxonomy. Technical legs are answered by one Yahoo request per symbol;
 * fundamental legs need a screener.in page scrape each. The runner in
 * src/hooks/useScreen.ts evaluates every technical leg first and only fetches
 * fundamentals for the rows still standing, which on a typical universe is
 * under a tenth of them — the difference between a polite pass over
 * screener.in and a punishing one.
 *
 * A leg returns `null` for "cannot tell": a share listed three years ago has no
 * ten-year high, and screener.in does not carry every SME scrip. Those rows are
 * reported as unjudged, never silently failed.
 */

export type Phase = 'technical' | 'fundamental';

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
      phase: 'fundamental',
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
