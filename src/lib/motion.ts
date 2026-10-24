/**
 * Motion helpers that live in script rather than in index.css.
 *
 * The stylesheet's reduced-motion block only reaches CSS animations and
 * transitions. Anything driven from here — `element.animate()`, a counted-up
 * figure — has to ask for itself, so every caller goes through `reducedMotion`.
 */
export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Out-quint, the stylesheet's `--ease-out`, for `element.animate()`. */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * The sliding thumb behind every `.segmented` control.
 *
 * Each control marks its option with `button[data-active='true']` and paints
 * it tonal; that snapped from option to option, so a click read as two things
 * blinking rather than one thing moving. This measures the active button and
 * hands its box to the track as CSS variables, and `.segmented[data-pill]::before`
 * in index.css glides to it.
 *
 * One observer for the whole document rather than a hook per control: there
 * are four kinds of segmented control across three components, and a new one
 * picks this up by having the class, not by remembering to call something.
 *
 * Mount-time placement does not animate — the track is marked `set` first and
 * only becomes `live`, which is what enables the transition, a frame later.
 */

const seen = new WeakSet<Element>();
const resize = new ResizeObserver((entries) => entries.forEach((e) => place(e.target as HTMLElement)));

function place(track: HTMLElement) {
  const active = track.querySelector<HTMLElement>(':scope > button[data-active="true"]');
  if (!active) {
    track.style.setProperty('--pill-o', '0');
    return;
  }
  track.style.setProperty('--pill-o', '1');
  track.style.setProperty('--pill-x', `${active.offsetLeft}px`);
  track.style.setProperty('--pill-y', `${active.offsetTop}px`);
  track.style.setProperty('--pill-w', `${active.offsetWidth}px`);
  track.style.setProperty('--pill-h', `${active.offsetHeight}px`);
}

function adopt(track: HTMLElement) {
  if (seen.has(track)) return;
  seen.add(track);
  place(track);
  track.dataset.pill = 'set';
  requestAnimationFrame(() => (track.dataset.pill = 'live'));
  resize.observe(track);
}

export function installSegmentedPill() {
  document.querySelectorAll<HTMLElement>('.segmented').forEach(adopt);

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const track = (r.target as Element).closest<HTMLElement>('.segmented');
        if (track) seen.has(track) ? place(track) : adopt(track);
      } else if (r.addedNodes.length > 0) {
        // Only unseen tracks: rows of the virtualised table mount constantly,
        // and re-measuring every control on each would force a layout per scroll.
        document.querySelectorAll<HTMLElement>('.segmented:not([data-pill])').forEach(adopt);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-active'] });
}
