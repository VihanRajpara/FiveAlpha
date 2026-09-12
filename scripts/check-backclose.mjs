// Self-check for the back-button bookkeeping — `node scripts/check-backclose.mjs`.
//
// Installed as a PWA, a back press that is not caught quits the app. The
// bookkeeping in `useBackClose` decides how many history entries exist, and
// every way of getting it wrong is invisible on a desktop browser and looks
// like a broken app on a phone:
//
//   1. An entry pushed and never given back = a back press that does nothing,
//      and one more dead press for every time the drawer was opened.
//   2. An entry given back after back already consumed it = two entries popped
//      for one press, which is the original bug (the app closes).
//   3. An entry pushed per mount without claiming the one a just-closed overlay
//      left = two presses to undo one open. StrictMode does this in dev; so
//      does closing one overlay to open another in the same tick.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript — same as scripts/check-chart.mjs.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMP = 'scripts/.check-backclose.bundle.mjs';
await build({
  entryPoints: ['src/hooks/useBackClose.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: TMP,
  external: ['react'],
});

const log = [];
globalThis.history = {
  pushState: () => log.push('push'),
  back: () => log.push('back'),
};

const { enter, leave } = await import(pathToFileURL(TMP).href);
await rm(TMP);

/** Runs the deferred half of `leave` — the real one is a task, not a microtask. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// 1. Opened, then closed from the UI: one entry taken, one given back.
log.length = 0;
enter();
leave(false);
await settle();
assert.deepEqual(log, ['push', 'back'], 'UI close must pop exactly the entry it pushed');

// 2. Opened, then closed by the back press itself: the entry is already gone.
log.length = 0;
enter();
leave(true);
await settle();
assert.deepEqual(log, ['push'], 'back must not be called again for an entry back already popped');

// 3. Unmount and remount in the same tick (StrictMode, or one overlay
//    replacing another): one entry between them, and no stray back.
log.length = 0;
enter();
leave(false);
enter();
await settle();
assert.deepEqual(log, ['push'], 'a remount in the same tick must claim the leaving entry');
leave(false);
await settle();
assert.deepEqual(log, ['push', 'back'], 'the claimed entry is still given back on a real close');

// 4. Nested overlays — a menu over the drawer — get one entry each, so back
//    walks out of them one at a time.
log.length = 0;
enter();
enter();
await settle();
assert.deepEqual(log, ['push', 'push']);
leave(true); // back closed the inner one
leave(false); // the outer one then closed from the UI
await settle();
assert.deepEqual(log, ['push', 'push', 'back'], 'each overlay owns exactly one entry');

console.log('back-close bookkeeping ok');
