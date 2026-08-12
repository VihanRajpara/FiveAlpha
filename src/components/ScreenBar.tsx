import { SelectMenu } from './SelectMenu';
import { LARGE_RUN, formatEstimate, type ScreenRun } from '../hooks/useScreen';
import type { ScreenDef } from '../lib/screens';

/**
 * The screen control: pick a screen, run it over whatever the filters currently
 * select, then read the verdict.
 *
 * It sits below the filters and above the table because that is the order the
 * work happens in — a screen is expensive per row (see useScreen) and the
 * filters are what make it affordable, so the bar reads as the second half of
 * one sentence rather than as an independent control.
 *
 * The clause itself is on show, collapsed. A screen that silently drops 95% of
 * the table has to be able to say exactly what it did, and the Chartink text is
 * the most precise statement of that available.
 */

const NONE = 'none';

const PHASE_LABEL: Record<'technical' | 'fundamental', string> = {
  technical: 'Reading 10 years of monthly bars',
  fundamental: 'Reading fundamentals',
};

interface Props {
  screens: ScreenDef[];
  /** The screen chosen in the picker — not necessarily one that has been run. */
  selected: ScreenDef | null;
  onSelect: (id: string) => void;
  run: ScreenRun;
  /** How many rows the current filters select — the run's universe. */
  universeCount: number;
  onRun: () => void;
  matchesOnly: boolean;
  onMatchesOnlyChange: (value: boolean) => void;
}

export function ScreenBar({
  screens,
  selected,
  onSelect,
  run,
  universeCount,
  onRun,
  matchesOnly,
  onMatchesOnlyChange,
}: Props) {
  const running = run.status === 'running';
  const hasResults = run.results.size > 0;
  const long = universeCount > LARGE_RUN;

  const pct =
    run.progress.total === 0 ? 0 : Math.round((run.progress.done / run.progress.total) * 100);

  return (
    <div className="screenbar">
      <div className="screenbar-row">
        <span className="filter-label">Screen</span>

        <SelectMenu
          ariaLabel="Screen"
          value={selected?.id ?? NONE}
          options={[
            { value: NONE, label: 'None', hint: 'Show every row the filters select' },
            ...screens.map((s) => ({ value: s.id, label: s.name, hint: s.summary })),
          ]}
          onChange={onSelect}
          minMenuWidth={320}
        />

        {selected && (
          <button
            type="button"
            className="btn"
            onClick={running ? run.cancel : onRun}
            // Only a genuinely empty universe disables this. A large one is
            // slow, not impossible, and it says how slow in the note below.
            disabled={!running && universeCount === 0}
            title={`Runs over the ${universeCount.toLocaleString('en-IN')} rows the filters currently select — one request each, six at a time.`}
          >
            {running ? 'Stop' : `Run on ${universeCount.toLocaleString('en-IN')}`}
          </button>
        )}

        {running && (
          <>
            <span className="progress" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="screen-phase">
              {run.progress.phase ? PHASE_LABEL[run.progress.phase] : ''} · {run.progress.done} of{' '}
              {run.progress.total}
              {/* Only on the long tail of phase 1, where the number is both
                  reliable and worth knowing. */}
              {run.progress.phase === 'technical' &&
                run.progress.total - run.progress.done > LARGE_RUN &&
                ` · ~${formatEstimate(run.progress.total - run.progress.done)} left`}
            </span>
          </>
        )}

        {!running && hasResults && (
          <>
            <span className="pill screen-count" title="Rows that pass every leg of the clause">
              <span className="dot" />
              {run.counts.pass.toLocaleString('en-IN')} match
            </span>
            <span className="pill" title="Rows that failed at least one leg">
              {run.counts.fail.toLocaleString('en-IN')} no
            </span>
            {run.counts.unknown > 0 && (
              <span
                className="pill"
                title="Not enough data to judge — too little price history, or no screener.in page for the company"
              >
                {run.counts.unknown.toLocaleString('en-IN')} unjudged
              </span>
            )}

            <button
              type="button"
              className="filter-trigger"
              data-active={matchesOnly}
              onClick={() => onMatchesOnlyChange(!matchesOnly)}
              aria-pressed={matchesOnly}
            >
              {matchesOnly ? 'Matches only' : 'Showing all'}
            </button>

            <button type="button" className="btn ghost" onClick={run.clear}>
              Clear
            </button>
          </>
        )}
      </div>

      {/* Said before the click, not after: the cost of a screen is a property
          of how many rows are selected, and that is knowable up front. */}
      {selected && !running && !hasResults && long && (
        <p className="screen-note">
          {universeCount.toLocaleString('en-IN')} rows takes about {formatEstimate(universeCount)} —
          one request per row, six at a time, which is all the browser allows. It shows progress and
          can be stopped at any point, keeping whatever it has already judged. Filtering by exchange,
          cap band or F&amp;O first gets you to a shortlist faster.
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

      {selected && (
        <details className="screen-clause">
          <summary>What this runs</summary>
          <p className="screen-note">{selected.summary}</p>
          <ul className="screen-legs">
            {selected.legs.map((leg) => (
              <li key={leg.id}>
                <span className="screen-leg-label">{leg.label}</span>
                <code>{leg.clause}</code>
              </li>
            ))}
          </ul>
          <p className="screen-note">
            Translated from{' '}
            <a href={selected.source} target="_blank" rel="noreferrer noopener">
              the Chartink screen
            </a>
            . Prices and the 10-year high come from Yahoo Finance monthly bars; ROCE and market cap
            are scraped from screener.in company pages, consolidated where they exist.
          </p>
        </details>
      )}
    </div>
  );
}
