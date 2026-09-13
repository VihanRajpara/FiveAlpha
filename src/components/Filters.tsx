import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { SelectMenu } from './SelectMenu';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useClosing } from '../hooks/useClosing';
import { useBackClose } from '../hooks/useBackClose';
import { RuleBuilder } from './RuleBuilder';
import { describeRule, type Rule } from '../lib/rules';

export interface FilterOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FilterGroupSpec {
  key: string;
  label: string;
  /**
   * The sheet heading this group files under.
   *
   * The sheet holds every filter now, and fourteen labelled chip rows in a
   * column is a list to scroll rather than a panel to read. Sections come from
   * the caller because only it knows what the groups *mean* — this component
   * knows they are all the same shape, which is exactly why it cannot tell
   * "Exchange" from "Signal age".
   */
  section?: string;
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
  /**
   * The groups that also sit inline in the bar on a wide window, as the
   * shortcut to the ones reached for every time.
   */
  groups: FilterGroupSpec[];
  /**
   * Groups that are only ever in the sheet. There are too many of them to sit
   * in the bar — a chip row that scrolls past the window edge is a filter you
   * have to go looking for — and they are the second question you ask, once the
   * bar has settled what you are looking at.
   */
  advanced?: FilterGroupSpec[];
  /**
   * The free-form conditions — see `src/lib/rules.ts`.
   *
   * They live in this component rather than beside it because they are the same
   * control at a finer grain: the same sheet opens them, the same count counts
   * them, and "Clear all" has to mean all of it.
   */
  rules: Rule[];
  onRulesChange: (rules: Rule[]) => void;
  /** Shown live on the sheet's confirm button. */
  resultCount: number;
}

const isDefault = (g: FilterGroupSpec) => g.value === g.options[0]?.value;

/**
 * The groups under their headings, in the order the caller listed them.
 *
 * A Map rather than a sort: first appearance decides where a section sits, so
 * adding a group puts it beside its own kind without anyone having to maintain
 * an order of sections as well as an order of groups.
 */
function bySection(groups: FilterGroupSpec[]): [string, FilterGroupSpec[]][] {
  const out = new Map<string, FilterGroupSpec[]>();
  for (const g of groups) {
    const name = g.section ?? 'Filters';
    const held = out.get(name);
    if (held) held.push(g);
    else out.set(name, [g]);
  }
  return [...out.entries()];
}

/**
 * Filter controls: a shortcut row of the core groups inline on a wide window,
 * and one sheet holding *everything* at every width.
 *
 * The sheet used to hold only what the bar was not already showing, which made
 * "More" mean a different thing at each breakpoint and left a wide window with
 * no single place that listed the filters. It holds all of them now — the
 * inline row is a shortcut to the ones reached for every time, not a separate
 * set — and the groups are sectioned so a panel of fourteen reads as four
 * questions rather than one long column.
 *
 * Every layout still renders from the same group specs, so they cannot drift.
 */
export function Filters({
  groups,
  advanced = [],
  rules,
  onRulesChange,
  resultCount,
}: Props) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);

  const sheetGroups = [...groups, ...advanced];

  // Deliberately not memoised: the specs are rebuilt on every change to a
  // filter's value, so a cached grouping would render the sheet from the
  // previous render's `value`s — chips showing the selection before last.
  // Bucketing fifteen items costs nothing worth caching.
  const sections = bySection(sheetGroups);

  const activeCount = sheetGroups.filter((g) => !isDefault(g)).length + rules.length;

  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, open);

  // Stable, so the Escape listener below is not torn down every render.
  const hide = useCallback(() => setOpen(false), []);
  const { closing, close } = useClosing(open, hide);

  // On a phone the sheet is the screen, so back should shut it, not the app.
  useBackClose(open, close);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);

    // Without this the page behind the sheet scrolls under the finger on iOS.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, close]);

  const clearAll = () => {
    for (const g of sheetGroups) {
      if (g.options[0]) g.onChange(g.options[0].value);
    }
    onRulesChange([]);
  };

  return (
    <>
      {/* Wide: the groups reached for every time stay in the bar as a shortcut.
          Narrow: there is no room, and the sheet is all of it. */}
      {!compact && (
        <div className="filters-inline">
          {groups.map((g) => (
            <ChipGroup key={g.key} group={g} />
          ))}
          {/* Conditions are written in the sheet and read here: a filter you
              cannot see from the table it is cutting is one you forget you set.
              On a narrow screen the count on the button carries this instead —
              there is no room for the sentence. */}
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className="rule-chip"
              title="Remove this condition"
              onClick={() => onRulesChange(rules.filter((r) => r.id !== rule.id))}
            >
              {describeRule(rule)}
              <span aria-hidden>✕</span>
              <span className="sr-only">— remove</span>
            </button>
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
          {/* One word at both widths, because it now opens the same thing at
              both. "More" said "the rest of them", which stopped being true. */}
          Filters
          {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
        </button>
      )}

      {open &&
        createPortal(
          <>
            <div className="sheet-scrim" data-closing={closing || undefined} onClick={close} />
            <div
              ref={sheetRef}
              className="sheet"
              data-closing={closing || undefined}
              role="dialog"
              aria-modal="true"
              tabIndex={-1}
              aria-label="Filters"
            >
              <div className="sheet-head">
                <h3>
                  Filters
                  {activeCount > 0 && <span className="sheet-count">{activeCount}</span>}
                </h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={close}
                  aria-label="Close filters"
                >
                  ✕
                </button>
              </div>

              {/* Capped and centred rather than run to the window edge: at
                  1920px an uncapped auto-fit grid is seven columns of chips and
                  a reading line nobody can follow across. */}
              <div className="sheet-body">
                {sections.map(([name, inSection]) => {
                  const on = inSection.filter((g) => !isDefault(g)).length;
                  return (
                    <section className="sheet-section" key={name}>
                      <h4 className="sheet-section-title">
                        {name}
                        {on > 0 && <span className="sheet-section-count">{on}</span>}
                      </h4>
                      <div className="sheet-grid">
                        {inSection.map((g) => (
                          <div className="sheet-group" key={g.key}>
                            <ChipGroup group={g} />
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}

                <section className="sheet-section">
                  <h4 className="sheet-section-title">
                    Conditions
                    {rules.length > 0 && (
                      <span className="sheet-section-count">{rules.length}</span>
                    )}
                  </h4>
                  <RuleBuilder rules={rules} onChange={onRulesChange} />
                </section>
              </div>

              <div className="sheet-foot">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={clearAll}
                  disabled={activeCount === 0}
                >
                  Clear all
                </button>
                <button type="button" className="btn" onClick={close}>
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
