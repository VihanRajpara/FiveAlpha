import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCENTS, AUTO, THEMES, themeById, type Theme } from '../themes';
import { useTheme } from '../hooks/useTheme';
import { PopMenu } from './PopMenu';
import { Icon } from './Icon';

/**
 * The palette button in the header, and the panel it opens.
 *
 * Every option is previewed in its own colours: a swatch carries the theme's
 * `data-theme`, which re-scopes the tokens beneath it, so what you see is the
 * stylesheet's block and not a hand-copied picture of it. Choosing applies at
 * once — the panel stays open so themes can be compared one after another.
 */

/** Read at open time; PopMenu closes itself on resize, so it cannot go stale. */
const panelWidth = () => Math.min(452, window.innerWidth - 16);

/**
 * Arrow keys within a radio group: move and select, wrapping, as the ARIA
 * radio pattern specifies. One tab stop per group (roving tabindex).
 */
function onRadioKeys(e: React.KeyboardEvent<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const n = radios.length;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (step ?? 0) + n) % n;
  radios[next].focus();
  radios[next].click();
}

/** The app in miniature, in the theme's own colours: a header with its
 *  button, a selected row in its accent, and a gain and a loss. */
function Swatch({ id }: { id: string }) {
  return (
    <span className="theme-swatch" data-theme={id} aria-hidden>
      <span className="sw-bar">
        <i className="sw-mark" />
        <i className="sw-btn" />
      </span>
      <span className="sw-rows">
        <span className="sw-row sw-row-on">
          <i className="sw-txt" />
          <b className="sw-up">+2.4%</b>
        </span>
        <span className="sw-row">
          <i className="sw-txt sw-txt-short" />
          <b className="sw-down">−1.1%</b>
        </span>
      </span>
    </span>
  );
}

function Option({
  theme,
  checked,
  onPick,
}: {
  theme: Pick<Theme, 'id' | 'name' | 'note'>;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className="theme-opt"
      onClick={onPick}
    >
      {theme.id === 'auto' ? (
        <span className="theme-swatch sw-auto" aria-hidden>
          <Swatch id={AUTO.light} />
          <Swatch id={AUTO.dark} />
        </span>
      ) : (
        <Swatch id={theme.id} />
      )}
      <span className="theme-opt-text">
        <span className="theme-opt-name">
          {theme.name}
          {checked && <Icon name="check" size={14} weight={2.5} />}
        </span>
        <span className="theme-opt-note">{theme.note}</span>
      </span>
    </button>
  );
}

function Panel() {
  const { pref, resolved, accent, setPref, setAccent } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  // Focus lands on the current choice, so arrows start from where you are.
  // An effect, not a layout effect: PopMenu focuses its own shell in one,
  // and this has to run after it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, []);

  const preset = ACCENTS.find((a) => a.hex === accent);
  const custom = accent !== null && !preset;
  const auto = {
    id: 'auto',
    name: 'Auto',
    note: `Follows your device · now ${themeById(resolved)?.name ?? ''}`,
  };

  return (
    <div className="theme-panel" ref={ref}>
      <div className="theme-head">
        <h2 id="theme-title">Theme</h2>
        <span>Applies instantly · saved on this device</span>
      </div>

      <div className="theme-groups" role="radiogroup" aria-labelledby="theme-title" onKeyDown={onRadioKeys}>
        <div className="theme-grid theme-grid-auto">
          <Option theme={auto} checked={pref === 'auto'} onPick={() => setPref('auto')} />
        </div>
        {(['light', 'dark'] as const).map((scheme) => (
          <div key={scheme} className="theme-group">
            <p className="theme-group-label">{scheme === 'light' ? 'Light' : 'Dark'}</p>
            <div className="theme-grid">
              {THEMES.filter((t) => t.scheme === scheme).map((t) => (
                <Option key={t.id} theme={t} checked={pref === t.id} onPick={() => setPref(t.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="theme-accent">
        <div className="theme-accent-head">
          <span id="accent-title" className="theme-group-label">
            Accent
          </span>
          {accent && (
            <button type="button" className="theme-reset" onClick={() => setAccent(null)}>
              Reset
            </button>
          )}
        </div>
        <div className="accent-row">
          <div className="accent-chips" role="radiogroup" aria-labelledby="accent-title" onKeyDown={onRadioKeys}>
            <button
              type="button"
              role="radio"
              aria-checked={accent === null}
              tabIndex={accent === null || custom ? 0 : -1}
              className="accent-chip"
              aria-label="The theme's own accent"
              title="The theme's own accent"
              onClick={() => setAccent(null)}
            >
              {/* Scoped to the theme, so it shows the theme's accent even
                  while a custom one is overriding it on the page. */}
              <span className="accent-dot accent-dot-theme" data-theme={resolved} />
            </button>
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={accent === a.hex}
                tabIndex={accent === a.hex ? 0 : -1}
                className="accent-chip"
                aria-label={a.name}
                title={a.name}
                onClick={() => setAccent(a.hex)}
              >
                <span className="accent-dot" style={{ background: a.hex }} />
              </button>
            ))}
          </div>
          <label className="accent-chip accent-custom" data-on={custom} title="Pick any colour">
            <input
              type="color"
              value={accent ?? ACCENTS[0].hex}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Custom accent colour"
            />
            {custom ? (
              <span className="accent-dot" style={{ background: accent }} />
            ) : (
              <Icon name="pipette" size={16} />
            )}
          </label>
        </div>
        <p className="theme-accent-note">Any colour works — it is fitted to each theme so it always reads as text.</p>
      </div>
    </div>
  );
}

export function ThemePicker() {
  const { pref, resolved } = useTheme();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const current = pref === 'auto' ? `Auto (${themeById(resolved)?.name})` : themeById(pref)?.name;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-btn theme-btn"
        data-open={open}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Theme: ${current}. Change theme`}
        title={`Theme — ${current}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="palette" size={19} />
      </button>
      {open && (
        <PopMenu
          trigger={trigger}
          role="dialog"
          rows={0}
          chrome={760}
          maxHeight={760}
          width={panelWidth()}
          ariaLabel="Theme"
          className="theme-menu"
          onClose={close}
        >
          <Panel />
        </PopMenu>
      )}
    </>
  );
}
