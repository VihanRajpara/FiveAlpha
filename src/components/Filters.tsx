import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';

export interface FilterOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FilterGroupSpec {
  key: string;
  label: string;
  value: string;
  disabled?: boolean;
  /** The first option is treated as the group's "everything" default. */
  options: FilterOption[];
  onChange: (value: string) => void;
}

/**
 * Below this width the three chip groups (~1,016px of chips before gaps) cannot
 * share a line, and wrapping them reads as a broken bar rather than a designed
 * one. They move into a sheet instead.
 */
const COMPACT_QUERY = '(max-width: 1179px)';

function ChipGroup({ group }: { group: FilterGroupSpec }) {
  return (
    <div className="filter-group">
      <span className="filter-label">{group.label}</span>
      <div className="segmented">
        {group.options.map((o) => (
          <button
            key={o.value}
            type="button"
            data-active={o.value === group.value}
            disabled={group.disabled}
            onClick={() => group.onChange(o.value)}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  groups: FilterGroupSpec[];
  /** Shown live on the sheet's confirm button. */
  resultCount: number;
}

/**
 * Filter controls, rendered inline on wide screens and as a bottom sheet on
 * everything narrower. Both render from the same group specs, so the two
 * layouts cannot drift apart.
 */
export function Filters({ groups, resultCount }: Props) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);

  const activeCount = groups.filter((g) => g.value !== g.options[0]?.value).length;

  // Growing the window past the breakpoint puts the chips back on screen, so a
  // sheet left open would be a modal over controls that are already visible.
  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);

    // Without this the page behind the sheet scrolls under the finger on iOS.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!compact) {
    return (
      <div className="filters-inline">
        {groups.map((g) => (
          <ChipGroup key={g.key} group={g} />
        ))}
      </div>
    );
  }

  const clearAll = () => {
    for (const g of groups) {
      if (g.options[0]) g.onChange(g.options[0].value);
    }
  };

  return (
    <>
      <button
        type="button"
        className="filter-trigger"
        data-active={activeCount > 0}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        Filters
        {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
      </button>

      {open &&
        createPortal(
          <>
            <div className="sheet-scrim" onClick={() => setOpen(false)} />
            <div className="sheet" role="dialog" aria-modal="true" aria-label="Filters">
              <div className="sheet-head">
                <h3>Filters</h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpen(false)}
                  aria-label="Close filters"
                >
                  ✕
                </button>
              </div>

              {groups.map((g) => (
                <div className="sheet-group" key={g.key}>
                  <ChipGroup group={g} />
                </div>
              ))}

              <div className="sheet-foot">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={clearAll}
                  disabled={activeCount === 0}
                >
                  Clear all
                </button>
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Show {resultCount.toLocaleString('en-IN')}
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
