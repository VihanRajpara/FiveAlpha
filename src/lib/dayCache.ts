/**
 * A Map that survives a reload, with entries that expire in whole days.
 *
 * The screen's caches used to live for the life of a tab, which made a re-run
 * free and a refresh full price — reload the page and a whole-market run pays
 * again for ~5,200 spark reads, ~200 chart reads and a couple of minutes of
 * paced screener.in requests it already has the answers to. Everything those
 * passes compute is stable within a session by construction (see the caching
 * note in src/lib/technicals.ts), so the thing to widen was the session.
 *
 * A **day** is the unit, and specifically the IST calendar day, because that is
 * how often the inputs actually change: monthly bars move once a session, and
 * the one figure that moves intraday — the latest close — is taken from the
 * live quote by the caller rather than from here.
 *
 * How many days is per store, because the answers age at wildly different
 * rates: a ten-year high is a day old at worst, while ROCE is an *annual*
 * figure that was being re-scraped every morning at 1.2s a row. Each entry
 * carries its own stamp, so a store rewritten today does not silently renew
 * everything in it.
 *
 * Writes are debounced and the store is rewritten whole: these are read-mostly
 * caches filled in bursts during a run, and 5,000 individual `setItem` calls
 * would cost more than the requests they save.
 */

const PREFIX = 'fivealpha:';

/** Bump to discard every stored value — a shape change, not a data change. */
const VERSION = 3;

/** Long enough that a run's burst of writes settles into one rewrite. */
const FLUSH_DELAY_MS = 3000;

const MS_PER_DAY = 86_400_000;

/**
 * Today in IST as a day number. An integer rather than `yyyy-mm-dd` because it
 * is stored against every entry and subtracted from on every read.
 */
function today(): number {
  const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return Math.floor(Date.parse(`${ist}T00:00:00Z`) / MS_PER_DAY);
}

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

interface Entry<T> {
  /** The day it was written, so rewriting the store does not renew it. */
  stamp: number;
  value: T;
}

export function dayCache<T>(name: string, codec: Codec<T>, maxAgeDays = 1): DayCache<T> {
  const storageKey = `${PREFIX}${name}:v${VERSION}`;

  let entries: Map<string, Entry<T>> | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Private mode, a full quota, a browser with storage disabled: all of them
  // leave the cache working perfectly well in memory, so none of them is an
  // error worth surfacing. They just stop it being written.
  let writable = true;

  /**
   * Read on first use rather than at import: parsing a few hundred kilobytes of
   * JSON belongs to the first screen run, not to the app's first paint.
   *
   * Expiry is applied here and nowhere else. A tab left open across midnight
   * therefore keeps yesterday's answers until it is reloaded, which is the same
   * staleness any long-lived in-memory cache has and not worth a timer.
   */
  function load(): Map<string, Entry<T>> {
    if (entries) return entries;
    const fresh = new Map<string, Entry<T>>();
    entries = fresh;

    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return fresh;

      const stored = JSON.parse(raw) as { entries?: Record<string, [number, unknown]> };
      const now = today();

      for (const [key, entry] of Object.entries(stored?.entries ?? {})) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [stamp, encoded] = entry;
        if (typeof stamp !== 'number' || now - stamp >= maxAgeDays) continue;

        const value = codec.decode(encoded);
        if (value !== undefined) fresh.set(key, { stamp, value });
      }
    } catch {
      // Corrupt, or storage unavailable. Start empty; the run refills it.
    }

    return fresh;
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !writable || !entries) return;
    dirty = false;

    const out: Record<string, [number, unknown]> = {};
    for (const [key, entry] of entries) out[key] = [entry.stamp, codec.encode(entry.value)];

    try {
      localStorage.setItem(storageKey, JSON.stringify({ entries: out }));
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
    get: (key) => load().get(key)?.value,
    set: (key, value) => {
      load().set(key, { stamp: today(), value });
      schedule();
    },
    flush,
  };
}
