import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { SelectMenu } from './SelectMenu';

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
 * Above this many options, chips stop working: they wrap onto a second line and
 * the filter bar reads as broken. The series filter crosses it as soon as BSE
 * groups are in play — NSE contributes 3 series, BSE another 14 — so that group
 * renders as a dropdown instead. The threshold is here rather than at the call
 * site because it is a fact about the chip layout, not about any one filter.
 */
const MAX_CHIPS = 6;

/**
 * The sheet is for touch widths now, not for "the groups don't all fit".
 *
 * It used to trip at 1,459px — the width the widest configuration needs — which
 * meant a 1,280px laptop, with room for three of the four groups, showed none
 * of them and a button instead. The inline row scrolls sideways instead, so the
 * only thing the breakpoint still decides is chips-vs-sheet, and 900px is where
 * a pointer stops being the likely input.
 */
const COMPACT_QUERY = '(max-width: 899px)';

function ChipGroup({ group }: { group: FilterGroupSpec }) {
  return (
    <div className="filter-group">
      <span className="filter-label">{group.label}</span>
      {group.options.length > MAX_CHIPS ? (
        // The hints carry the meaning of each code here. In the chip layout they
        // are a tooltip, which is fine for "EQ"; in a list of BSE group letters
        // it is the difference between a usable control and a row of initials.
        <SelectMenu
          ariaLabel={group.label}
          value={group.value}
          options={group.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
          onChange={group.onChange}
          minMenuWidth={280}
        />
      ) : (
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
      )}
    </div>
  );
}

interface Props {
  groups: FilterGroupSpec[];
  /**
   * Groups that live in the sheet at every width. There are too many of them
   * to sit in the bar — a chip row that scrolls past the window edge is a
   * filter you have to go looking for — and they are the second question you
   * ask, once the bar has settled what you are looking at.
   */
  advanced?: FilterGroupSpec[];
  /** Shown live on the sheet's confirm button. */
  resultCount: number;
}

/**
 * Filter controls: the core groups inline on wide screens and as a bottom sheet
 * on everything narrower, with the advanced groups always in the sheet. Every
 * layout renders from the same group specs, so they cannot drift apart.
 */
export function Filters({ groups, advanced = [], resultCount }: Props) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);

  // Which groups the sheet shows depends on whether the bar is showing the
  // core ones already.
  const sheetGroups = compact ? [...groups, ...advanced] : advanced;
  const isDefault = (g: FilterGroupSpec) => g.value === g.options[0]?.value;
  const activeCount = (compact ? [...groups, ...advanced] : advanced).filter(
    (g) => !isDefault(g),
  ).length;

  // Crossing the breakpoint changes what the sheet contains, so a sheet left
  // open would swap its own contents underneath the reader.
  useEffect(() => {
    setOpen(false);
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

  const clearAll = () => {
    for (const g of sheetGroups) {
      if (g.options[0]) g.onChange(g.options[0].value);
    }
  };

  return (
    <>
      {/* Wide: the core groups stay in the bar and the button opens the rest.
          Narrow: the button is all of it. */}
      {!compact && (
        <div className="filters-inline">
          {groups.map((g) => (
            <ChipGroup key={g.key} group={g} />
          ))}
        </div>
      )}

      {sheetGroups.length > 0 && (
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
          {compact ? 'Filters' : 'More'}
          {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
        </button>
      )}

      {open &&
        createPortal(
          <>
            <div className="sheet-scrim" onClick={() => setOpen(false)} />
            <div className="sheet" role="dialog" aria-modal="true" aria-label="Filters">
              <div className="sheet-head">
                <h3>{compact ? 'Filters' : 'More filters'}</h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpen(false)}
                  aria-label="Close filters"
                >
                  ✕
                </button>
              </div>

              {sheetGroups.map((g) => (
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
