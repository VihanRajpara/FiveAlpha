/**
 * Motion helpers that live in script rather than in index.css — the shared
 * timing constants, the segmented controls' sliding thumb, and scroll reveals.
 *
 * The stylesheet's reduced-motion block only reaches CSS animations and
 * transitions. Anything driven from here — `element.animate()`, a counted-up
 * figure — has to ask for itself, so every caller goes through `reducedMotion`.
 */
export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Out-quint, the stylesheet's `--ease-out`, for `element.animate()`. */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** `--ease-spring`: kept for the two "this just changed" pops. */
export const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
/** `--dur-fast`, `--dur`, `--dur-slow` — the only three durations in the app. */
export const DUR = { fast: 120, base: 200, slow: 280 } as const;

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

/**
 * Scroll reveals: blocks that sit below the fold rise into place as they come
 * into view, instead of the whole page arriving in one frame.
 *
 * Only for content that stands on its own — the watchlist report's cards and
 * panels, the drawer's fact groups and financial tables. Never the table rows:
 * a list you scan must not move under the eye.
 *
 * One IntersectionObserver for the document, no scroll listener. Elements in
 * the same batch stagger by 40ms each (capped), so a screenful arriving
 * together cascades rather than popping. Under reduced motion, or without the
 * API, nothing is marked and everything is simply visible — the hidden state is
 * only ever applied by this code, so it cannot strand content.
 */
const REVEAL = '.lcard, .mis-panel, .mis-tiles, .factset, .company-body > *';

const reveal =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          let i = 0;
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const el = e.target as HTMLElement;
            el.style.setProperty('--reveal-i', String(Math.min(i++, 6)));
            el.dataset.reveal = 'in';
            reveal!.unobserve(el);
          }
        },
        { rootMargin: '0px 0px -6% 0px' },
      );

function adoptReveals() {
  if (!reveal || reducedMotion()) return;
  document.querySelectorAll<HTMLElement>(`:is(${REVEAL}):not([data-reveal])`).forEach((el) => {
    el.dataset.reveal = 'wait';
    reveal.observe(el);
  });
}

export function installMotion() {
  document.querySelectorAll<HTMLElement>('.segmented').forEach(adopt);
  adoptReveals();

  // New nodes are scanned once per frame, however many mutation batches land in
  // it — the virtualised table mounts rows constantly while scrolling.
  let queued = false;
  const scan = () => {
    queued = false;
    // Only unseen tracks: re-measuring every control on each would force a
    // layout per scroll.
    document.querySelectorAll<HTMLElement>('.segmented:not([data-pill])').forEach(adopt);
    adoptReveals();
  };

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const track = (r.target as Element).closest<HTMLElement>('.segmented');
        if (track) seen.has(track) ? place(track) : adopt(track);
      } else if (r.addedNodes.length > 0 && !queued) {
        queued = true;
        requestAnimationFrame(scan);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-active'] });
}
