/**
 * The screen, as a label and a link.
 *
 * This file used to be the screen *reimplemented*: five legs, each pairing a
 * Chartink fragment with a predicate over metrics the browser fetched itself,
 * plus the two judging functions the client-side runner drove them with. All of
 * it is gone. The clause is evaluated by Chartink, scraped every five minutes
 * (supabase/functions/sync-screen) and read from `public.screen_matches` — so
 * what is left here is only what the UI needs to *say* about the screen, and
 * the clause below is quoted for display rather than executed.
 *
 * Keeping the translation was not free: `yearly max( 10 , yearly high )` rebuilt
 * from Yahoo monthly bars, and ROCE from a screener.in scrape, disagreed with
 * the original precisely at the boundary — which on a "within 25% of the decade
 * high" screen is the entire population it exists to find.
 */
export interface ScreenDef {
  id: string;
  name: string;
  /** The Chartink screen this list comes from. Shown as a link, so it stays checkable. */
  source: string;
  /** The `scan_clause` Chartink runs, verbatim. */
  clause: string;
  summary: string;
}

export const ALL_TIME_HIGH_BREAKOUT: ScreenDef = {
  id: 'ath-breakout',
  name: 'Near all-time-high breakout',
  source: 'https://chartink.com/screener/all-time-high-breakout-9032071',
  // Read from the page at scrape time as well (`atlas_query`), so if the screen's
  // author edits it on Chartink the list follows immediately and only this
  // caption lags. Keep the two in step.
  clause:
    '( {cash} ( daily close > yearly max( 10 , yearly high ) * 0.75 and ' +
    'daily close <= yearly max( 10 , yearly high ) * 1 and ' +
    'yearly return on capital employed percentage > 10 and ' +
    'market cap >= 500 and market cap <= 50000 and monthly rsi( 14 ) >= 65 ) )',
  summary:
    'Quality mid- and small-caps pressed up against a decade high with monthly momentum behind them.',
};
