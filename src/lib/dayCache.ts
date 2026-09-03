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

/**
 * Bump to discard every stored value.
 *
 * A shape change, normally — but also a *correctness* change in whatever
 * produced the values, and for the same reason: what is in the store was
 * written by the old code and will be believed until it expires. Version 4 is
 * one of those. Fundamentals are kept for **thirty days**, and the parse that
 * wrote them read screener.in's empty ratio spans as a figure of zero, so
 * without this bump every affected company would carry `ROCE 0` — a definite
 * fail on that leg — for a month after the fix.
 */
const VERSION = 4;

/** Long enough that a run's burst of writes settles into one rewrite. */
const FLUSH_DELAY_MS = 3000;

const MS_PER_DAY = 86_400_000;

/**
 * Built once. `new Intl.DateTimeFormat` is among the more expensive things you
 * can construct in a loop, and `today()` is now called on every read as well as
 * every write — some tens of thousands of times during a whole-market run.
 */
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Today in IST as a day number. An integer rather than `yyyy-mm-dd` because it
 * is stored against every entry and subtracted from on every read.
 */
function today(): number {
  return Math.floor(Date.parse(`${IST_DAY.format(new Date())}T00:00:00Z`) / MS_PER_DAY);
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
   * Expiry is applied here *and* on every read — see `live`. Dropping it here
   * too is not redundant: it keeps a day's worth of dead entries from being
   * parsed and decoded into a Map nobody will read from.
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

  /**
   * Whether an entry is still inside its window, measured **now**.
   *
   * Checked per read rather than only at load, because the screen is left open
   * for days at a time: without this, a tab that was loaded yesterday goes on
   * serving yesterday's signals through IST midnight until someone reloads it,
   * which is the one moment of the day the answers are guaranteed to have
   * changed. A stale entry is dropped rather than merely hidden, so the store
   * a long-lived tab flushes does not carry a week of dead weight into the 5 MB
   * quota.
   *
   * No timer: the stamps are absolute IST day numbers, so this stays correct
   * across a laptop that was asleep at midnight, which a scheduled clear is
   * exactly the wrong shape for.
   */
  function live(key: string): Entry<T> | undefined {
    const map = load();
    const entry = map.get(key);
    if (!entry) return undefined;
    if (today() - entry.stamp < maxAgeDays) return entry;

    map.delete(key);
    // Not `schedule()`: expiry is not new information worth a rewrite of its
    // own. The deletion rides along with the next real write, or is re-applied
    // at the next load if there never is one.
    dirty = true;
    return undefined;
  }

  return {
    has: (key) => live(key) !== undefined,
    get: (key) => live(key)?.value,
    set: (key, value) => {
      load().set(key, { stamp: today(), value });
      schedule();
    },
    flush,
  };
}
