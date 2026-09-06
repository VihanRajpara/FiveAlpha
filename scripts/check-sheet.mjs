// Self-check for the bottom sheet's drag maths — `node scripts/check-sheet.mjs`.
//
// The feel of a drag cannot be asserted; it is checked with a thumb on a real
// phone. What *can* go wrong silently is the arithmetic under it, and these are
// the two pieces that would:
//
//   1. `shouldDismiss` is two conditions ORed together, and the velocity term is
//      the one that is easy to get backwards — divide the wrong way round and a
//      slow, deliberate drag dismisses while a fast flick does not, which reads
//      as the sheet ignoring you.
//   2. `rubberBand` has to *resist* — more travel must always yield more
//      distance, but each additional pixel of pull must yield less than the one
//      before it. A plain divisor passes the first test and fails the second,
//      and the difference is the whole reason the over-drag feels attached to
//      something rather than sliding freely.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript. React stays external and is never called: the two
// functions under test are pure and sit beside the hook that uses them.
//
// The bundle goes to a real file inside the project rather than a `data:` URL,
// which is the only part of this that is not obvious: a data URL has no package
// scope, so Node cannot resolve the bare `react` specifier left in the output
// and dies before the first assertion runs.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMP = 'scripts/.check-sheet.bundle.mjs';

await build({
  entryPoints: ['src/hooks/useSheetDrag.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  outfile: TMP,
});

let mod;
try {
  mod = await import(pathToFileURL(TMP).href);
} finally {
  await rm(TMP, { force: true });
}
const { rubberBand, shouldDismiss } = mod;

const H = 800;

// --- rubberBand ------------------------------------------------------------
assert.equal(rubberBand(0, H), 0, 'no pull, no travel');

// Monotonic: pulling further always moves further.
let previous = 0;
for (let d = 10; d <= 600; d += 10) {
  const y = rubberBand(d, H);
  assert.ok(y > previous, `rubberBand must increase with distance (broke at ${d})`);
  previous = y;
}

// ...and resisting: every extra 50px of pull yields less than the 50px before.
let lastGain = Infinity;
for (let d = 50; d <= 500; d += 50) {
  const gain = rubberBand(d, H) - rubberBand(d - 50, H);
  assert.ok(gain < lastGain, `resistance must rise with distance (broke at ${d})`);
  lastGain = gain;
}

// The band is a fraction of the pull, never the whole of it.
assert.ok(rubberBand(200, H) < 200, '200px of pull must move the sheet less than 200px');
assert.ok(rubberBand(200, H) > 0);

// --- shouldDismiss ---------------------------------------------------------
// Upward and stationary drags never dismiss, however fast.
assert.equal(shouldDismiss(0, 1), false, 'a tap is not a dismissal');
assert.equal(shouldDismiss(-300, 50), false, 'dragging up must never dismiss');

// Distance alone, taken slowly.
assert.equal(shouldDismiss(150, 4000), true, 'a long slow drag dismisses on distance');
assert.equal(shouldDismiss(40, 4000), false, 'a short slow drag holds');

// Speed alone, over a short distance — the case the distance rule would miss.
assert.equal(shouldDismiss(40, 50), true, 'a quick flick dismisses on velocity');

// The boundary is the right way round: same distance, slower, must not dismiss.
assert.equal(shouldDismiss(40, 4000), false, 'same flick drawn out must not dismiss');

console.log('sheet drag maths OK — rubber band resists, dismissal reads distance or speed');
