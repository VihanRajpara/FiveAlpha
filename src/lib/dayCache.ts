/**
 * A Map that survives a reload, scoped to one trading day.
 *
 * The screen's caches used to live for the life of a tab, which made a re-run
 * free and a refresh full price — reload the page and a whole-market run pays
 * again for ~5,200 spark reads, ~200 chart reads and a couple of minutes of
 * paced screener.in requests it already has the answers to. Everything those
 * passes compute is stable within a session by construction (see the caching
 * note in src/lib/technicals.ts), so the thing to widen was the session.
 *
 * A **day** is the right unit, and specifically the IST calendar day:
 *
 *   · Monthly bars change once a session, and the one figure that moves
 *     intraday — the latest close — is taken from the live quote by the caller
 *     rather than from here.
 *   · Market cap moves with the price, but the leg it feeds is a band two
 *     orders of magnitude wide.
 *   · ROCE changes once a quarter.
 *
 * So an entry written today is good until tomorrow, and the whole store is
 * dropped on the first read of a new day rather than expired per entry — one
 * timestamp for the file, no per-row bookkeeping.
 *
 * Writes are debounced and the store is rewritten whole: these are read-mostly
 * caches filled in bursts during a run, and 5,000 individual `setItem` calls
 * would cost more than the requests they save.
 */

const PREFIX = 'fivealpha:';

/** Bump to discard every stored value — a shape change, not a data change. */
const VERSION = 2;

/** Long enough that a run's burst of writes settles into one rewrite. */
const FLUSH_DELAY_MS = 3000;

/** Today in IST, `yyyy-mm-dd` — the unit these caches are valid for. */
const today = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export interface Codec<T> {
  encode: (value: T) => unknown;
  /** `undefined` rejects the stored entry — a shape this version cannot read. */
  decode: (raw: unknown) => T | undefined;
}

export interface DayCache<T> {
  has: (key: string) => boolean;
  get: (key: string) => T | undefined;
  set: (key: string, value: T) => void;
  /** Writes now rather than on the debounce — the run just finished. */
  flush: () => void;
}

interface Stored {
  day: string;
  entries: Record<string, unknown>;
}

export function dayCache<T>(name: string, codec: Codec<T>): DayCache<T> {
  const storageKey = `${PREFIX}${name}:v${VERSION}`;

  let entries: Map<string, T> | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Private mode, a full quota, a browser with storage disabled: all of them
  // leave the cache working perfectly well in memory, so none of them is an
  // error worth surfacing. They just stop it being written.
  let writable = true;

  /**
   * Read on first use rather than at import: parsing a few hundred kilobytes of
   * JSON belongs to the first screen run, not to the app's first paint.
   */
  function load(): Map<string, T> {
    if (entries) return entries;
    entries = new Map();

    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return entries;

      const stored = JSON.parse(raw) as Stored;
      if (stored?.day !== today() || !stored.entries) {
        localStorage.removeItem(storageKey);
        return entries;
      }

      for (const [key, value] of Object.entries(stored.entries)) {
        const decoded = codec.decode(value);
        if (decoded !== undefined) entries.set(key, decoded);
      }
    } catch {
      // Corrupt, or storage unavailable. Start empty; the run refills it.
      entries = entries ?? new Map();
    }

    return entries;
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !writable || !entries) return;
    dirty = false;

    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) out[key] = codec.encode(value);

    try {
      localStorage.setItem(storageKey, JSON.stringify({ day: today(), entries: out } as Stored));
    } catch {
      // Almost always the 5 MB quota. Give the space back rather than leaving a
      // half-written store behind, and stop trying for the rest of the session.
      writable = false;
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* nothing left to do about it */
      }
    }
  }

  function schedule() {
    dirty = true;
    if (!writable) return;
    // Debounced, not throttled: during a run the writes are continuous, and
    // rewriting the whole store every few seconds while it is still filling is
    // work nobody reads.
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  // A run that is still going when the tab is closed or backgrounded should not
  // take its answers with it. `pagehide` rather than `unload` — the latter is
  // ignored on mobile Safari and blocks the back/forward cache everywhere else.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  return {
    has: (key) => load().has(key),
    get: (key) => load().get(key),
    set: (key, value) => {
      load().set(key, value);
      schedule();
    },
    flush,
  };
}
