import {
  LARGE_RUN,
  formatDuration,
  formatEstimate,
  type ScreenProgress,
  type ScreenRun,
} from '../hooks/useScreen';
import type { ScreenDef } from '../lib/screens';

/**
 * The screen control: run the one screen over whatever the filters currently
 * select, then read the verdict.
 *
 * It sits below the filters and above the table because that is the order the
 * work happens in — a screen is expensive per row (see useScreen) and the
 * filters are what make it affordable, so the bar reads as the second half of
 * one sentence rather than as an independent control.
 */

/**
 * Named after what each stage is *doing to the rows*, not after the endpoint it
 * calls: the scan reads twenty symbols a request and settles most of them, the
 * confirm stage buys the true intra-month highs for the few it could not, and
 * the last one scrapes the survivors.
 *
 * All three run at once, so all three are shown at once — with a stage's count
 * appearing only once it has work, which is what stops "0 of 0" standing in for
 * "not started" on a bar that has no sequence to it any more.
 */
const STAGE_LABEL = {
  cap: 'Market cap',
  scan: 'Scanning',
  confirm: 'Confirming highs',
  fundamental: 'ROCE',
} as const;

const STAGE_HINT =
  'Market cap for every row, two hundred symbols a request, so the band’s rejects cost nothing ' +
  'further · then ten years of monthly closes, twenty symbols a request · then the true 10-year ' +
  'high for the rows that bound could not decide · then a screener.in page per survivor, paced.';

/** "Scanning 1,204/1,450 · ROCE 3/8" — only the stages with work. */
function stageLine(progress: ScreenProgress): string {
  return (['cap', 'scan', 'confirm', 'fundamental'] as const)
    .filter((key) => progress[key].total > 0)
    .map(
      (key) =>
        `${STAGE_LABEL[key]} ${progress[key].done.toLocaleString('en-IN')}/${progress[
          key
        ].total.toLocaleString('en-IN')}`,
    )
    .join(' · ');
}

interface Props {
  /** The screen this bar runs — not necessarily one that has been run yet. */
  selected: ScreenDef | null;
  run: ScreenRun;
  /** How many rows the current filters select — the run's universe. */
  universeCount: number;
  onRun: () => void;
  matchesOnly: boolean;
  onMatchesOnlyChange: (value: boolean) => void;
}

export function ScreenBar({
  selected,
  run,
  universeCount,
  onRun,
  matchesOnly,
  onMatchesOnlyChange,
}: Props) {
  const running = run.status === 'running';
  const hasResults = run.results.size > 0;
  const long = universeCount > LARGE_RUN;

  const pct = Math.round(run.progress.fraction * 100);

  return (
    <div className="screenbar">
      <div className="screenbar-row">
        {selected && (
          <button
            type="button"
            className="btn"
            onClick={running ? run.cancel : onRun}
            // Only a genuinely empty universe disables this. A large one is
            // slow, not impossible, and it says how slow in the note below.
            disabled={!running && universeCount === 0}
            title={`Runs over the ${universeCount.toLocaleString('en-IN')} rows the filters currently select — twenty symbols a request, then a closer look at the ones that survive.`}
          >
            {running ? 'Stop' : `Run on ${universeCount.toLocaleString('en-IN')}`}
          </button>
        )}

        {running && (
          <>
            <span className="progress" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="screen-phase" title={STAGE_HINT}>
              {stageLine(run.progress)}
              {/* Withheld under half a minute: at that point the estimate is
                  mostly the granularity of its own rounding, and a countdown
                  that reads "10s left" for half a minute is worse than none. */}
              {run.progress.secondsLeft > 30 &&
                ` · ~${formatDuration(run.progress.secondsLeft)} left`}
            </span>
          </>
        )}

        {!running && hasResults && (
          <>
            {/* One verdict, read left to right, rather than three pills that
                happen to be adjacent. */}
            <div className="screen-results">
              <span className="screen-count" title="Rows that pass every leg of the clause">
                <span className="dot" />
                <b>{run.counts.pass.toLocaleString('en-IN')}</b> match
              </span>
              <span title="Rows that failed at least one leg">
                <b>{run.counts.fail.toLocaleString('en-IN')}</b> no
              </span>
              {run.counts.unknown > 0 && (
                <span title="Not enough data to judge — too little price history, or no screener.in page for the company">
                  <b>{run.counts.unknown.toLocaleString('en-IN')}</b> unjudged
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
                title="Show only the rows that pass"
              >
                Matches
              </button>
              <button
                type="button"
                data-active={!matchesOnly}
                onClick={() => onMatchesOnlyChange(false)}
                title="Show every filtered row, with its verdict"
              >
                All
              </button>
            </div>
          </>
        )}
      </div>

      {/* Said before the click, not after: the cost of a screen is a property
          of how many rows are selected, and that is knowable up front. */}
      {selected && !running && !hasResults && long && (
        <p className="screen-note">
          {universeCount.toLocaleString('en-IN')} rows takes about {formatEstimate(universeCount)} —
          prices are read twenty symbols at a time, and nearly all of that estimate is the polite
          pace of the fundamentals scrape over whatever survives, which runs alongside the price
          work rather than after it. Matches appear as they are found, and it can be stopped at any
          point, keeping whatever it has already judged. Answers are kept for the rest of the day,
          so running it again only pays for rows it has not seen — and filtering by exchange, cap
          band or F&amp;O first gets you to a shortlist faster.
        </p>
      )}

      {run.error && <p className="screen-error">{run.error}</p>}

      {run.warning && !running && <p className="screen-note">{run.warning}</p>}

      {run.status === 'cancelled' && (
        <p className="screen-note">
          Stopped early — {run.counts.screened.toLocaleString('en-IN')} of the{' '}
          {universeCount.toLocaleString('en-IN')} rows were judged.
        </p>
      )}

    </div>
  );
}
