import { formatAge, formatIstDateTime } from '../lib/format';
import type { ScreenMatches } from '../hooks/useScreenMatches';
import type { ScreenDef } from '../lib/screens';

/**
 * The screen control: what the shortlist is, when it was taken, and whether the
 * table is cut to it.
 *
 * It used to be a progress bar. The screen was run in the browser — thousands of
 * requests, a stage breakdown, an ETA, a cancel button — and this bar was where
 * all of that was reported. The list now arrives already decided from Chartink
 * (see useScreenMatches), so there is no run to narrate: the bar states the
 * result, says how old it is, and offers the one toggle that still means
 * anything.
 */

interface Props {
  screen: ScreenDef;
  matches: ScreenMatches;
  /** Matches that are also rows of the current table — see the note below. */
  shown: number;
  matchesOnly: boolean;
  onMatchesOnlyChange: (value: boolean) => void;
}

export function ScreenBar({ screen, matches, shown, matchesOnly, onMatchesOnlyChange }: Props) {
  const total = matches.rows.length;
  // Chartink screens the whole cash segment; this table is whatever the filters
  // select. So a match can be absent for two very different reasons — filtered
  // out here, or not in this app's security list at all — and a bare "76" over a
  // table showing 41 rows reads as a bug. The gap is stated instead.
  const hidden = total - shown;

  return (
    <div className="screenbar">
      <div className="screenbar-row">
        <a
          className="screen-source"
          href={screen.source}
          target="_blank"
          rel="noreferrer noopener"
          title={`Chartink runs: ${screen.clause}`}
        >
          {screen.name}
        </a>

        {matches.loading && total === 0 ? (
          <span className="screen-phase">Reading the screen…</span>
        ) : (
          <>
            <div className="screen-results">
              <span className="screen-count" title="Symbols the Chartink screen currently returns">
                <span className="dot" />
                <b>{total.toLocaleString('en-IN')}</b> match
              </span>
              {hidden > 0 && (
                <span title="Matches not in the current table — filtered out here, or not in this app’s NSE/BSE list">
                  <b>{hidden.toLocaleString('en-IN')}</b> not shown
                </span>
              )}
              {/* `formatAge`, the same helper the status bar states the price
                  age with — the two lines describe two halves of one cron and
                  must not word it differently. */}
              {matches.fetchedAt && (
                <span
                  title={`Scraped from Chartink ${formatIstDateTime(matches.fetchedAt)} IST · refreshed every 5 minutes through the session`}
                >
                  {formatAge(matches.fetchedAt)}
                </span>
              )}
            </div>

            {/* A two-state control rather than a button whose label flips: what
                the other state *is* should be visible without pressing it. */}
            <div className="segmented" role="group" aria-label="Rows shown">
              <button
                type="button"
                data-active={matchesOnly}
                onClick={() => onMatchesOnlyChange(true)}
                title="Show only the symbols the screen returned"
              >
                Matches
              </button>
              <button
                type="button"
                data-active={!matchesOnly}
                onClick={() => onMatchesOnlyChange(false)}
                title="Show every filtered row"
              >
                All
              </button>
            </div>

            <button
              type="button"
              className="btn ghost"
              onClick={matches.refresh}
              disabled={matches.loading}
              title="Re-read the list. It is rescraped from Chartink every five minutes during the session, so this only picks up a newer one."
            >
              {matches.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        )}
      </div>

      {matches.error && <p className="screen-error">{matches.error}</p>}

      {!matches.loading && !matches.error && total === 0 && (
        <p className="screen-note">
          The screen list is empty. It is filled by the <code>sync-screen</code> function every five
          minutes during market hours — if this is the first deploy, apply{' '}
          <code>supabase/migrations/0013_screen_matches.sql</code> and invoke the function once.
        </p>
      )}
    </div>
  );
}
