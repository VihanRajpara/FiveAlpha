import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { PopMenu } from './PopMenu';
import { supabase } from '../lib/supabaseClient';
import { formatGap, peekSignal, signalGapPct } from '../lib/signals';
import { describePush, type PushResult } from '../lib/push';
import type { SecurityWithQuote } from '../types';

/**
 * The notifications this account has been sent, and how many are new.
 *
 * A push notification appears once and is then gone — swiped away, missed while
 * the phone was face down, cleared by the OS. So the bell is not a second way
 * to subscribe (signing in does that, see `push.ts`); it is the place to look
 * one up afterwards.
 *
 * Everything shown here is read from `public.signal_alerts`, which is the same
 * ledger `notify-signals` writes to decide what has already been announced —
 * there is no second store to keep in step, and nothing is duplicated into one.
 *
 * The row carries what *identifies* an alert: side, symbol, date. That is the
 * notification's title. The numbers under it are not stored and are not
 * reconstructed from a copy either — they are read live out of the signal
 * day-cache this app already fills (`peekSignal`), so what the panel shows and
 * what the table shows cannot disagree. A row the cache has not reached yet
 * simply shows no second line rather than an em dash pretending to be data.
 */

/** How many to keep on screen. Older than this is not a notification any more. */
const LIMIT = 30;

/** What the panel wants on a laptop. Narrower screens get whatever there is. */
const WIDTH = 320;

/**
 * The panel's width, which **must** be the number PopMenu is given rather than
 * something CSS overrides afterwards.
 *
 * `placeMenu` computes `left` from the width it is told:
 * `min(trigger.left - 8, viewport.width - width - 8)`. Forcing a different
 * width in a media query leaves `left` solved for the old one, and the panel
 * runs off the right edge — measured at 16px over on a 360px screen and 70px
 * on a 414px one, because the bell sits near the right and the two errors add.
 *
 * Read at open time, not subscribed to: PopMenu dismisses itself on resize and
 * on orientation change, so the value cannot go stale while the panel is up.
 */
const panelWidth = (): number => Math.min(WIDTH, window.innerWidth - 16);

/**
 * How tall the panel wants to be, expressed in the 38px rows PopMenu sizes in.
 *
 * PopMenu asks for a row count because its own menus are uniform lists. This
 * one is not: an alert row is two lines, and a day heading is a third kind of
 * thing entirely. Passing the alert count alone under-measured the panel by
 * 60px on four alerts across three days — so it opened short and scrolled a
 * list that would have fitted, which reads as "there is more here" when there
 * is not.
 *
 * The pixel figures are measured from `.alert-row` and `.alerts-day` in
 * index.css and are the one thing to update if that padding changes. Rounding
 * up is deliberate: over-measuring costs nothing (PopMenu caps at the space
 * available), under-measuring is the bug above.
 */
const ROW_PX = 46;
const DAY_PX = 20;
const POPMENU_ROW_PX = 38;

const sizeInRows = (rows: number, days: number): number =>
  Math.max(1, Math.ceil((rows * ROW_PX + days * DAY_PX) / POPMENU_ROW_PX));

/**
 * When this device last opened the panel.
 *
 * localStorage rather than a column: "have I seen this" is a property of the
 * person sitting in front of *this* browser, and a phone and a laptop having
 * their own answer is correct rather than a limitation.
 */
const SEEN_KEY = 'fivealpha:alerts-seen';

/**
 * Everything sent at or before this is hidden — the panel's "clear".
 *
 * **A cutoff, never a delete.** `public.signal_alerts` is not a display list,
 * it is the ledger `notify-signals` consults to decide what has already been
 * announced: the insert with `ignoreDuplicates` *is* the test. Deleting a row
 * to clear it from this panel would make the next five-minute run treat that
 * alert as new and push it to every device again. Clearing is therefore a local
 * marker and nothing leaves the browser.
 *
 * Which also makes it per device, like `seen` — and that is the honest
 * behaviour to ship rather than something that looks account-wide and is not.
 * The panel says so.
 */
const CLEARED_KEY = 'fivealpha:alerts-cleared';

const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // Private mode. Everything shows, nothing is remembered, nothing breaks.
    return '';
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode again — the state lives for this tab only.
  }
};

/**
 * `Today`, `Yesterday`, or `12 Sep`.
 *
 * The panel groups by day because an uncleared list is mostly old: without it,
 * a flip from last Tuesday sits flush against this morning's with nothing but a
 * relative age in small type to tell them apart.
 */
function dayLabel(iso: string): string {
  const then = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export interface Alert {
  owner: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  signalDate: string;
  sentAt: string;
}

interface Row {
  owner: string;
  symbol: string;
  side: string;
  signal_date: string;
  sent_at: string;
}

/** `4m`, `3h`, `2d` — a notification's age is glanceable or it is noise. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface Props {
  /** Nothing to show, and no `x-owner` header to read them with, when signed out. */
  signedIn: boolean;
  /**
   * The alert's symbol as the app knows it, or undefined for one that has since
   * been delisted. One lookup rather than two props: the row it returns carries
   * both the Yahoo ticker the signal cache is keyed on and the current price,
   * and App already has the list to answer it from.
   */
  lookup?: (symbol: string) => SecurityWithQuote | undefined;
  /** Opens the detail drawer, so an alert is one tap from the chart. */
  onOpen?: (row: SecurityWithQuote) => void;
  /**
   * Whether this device is registered for push, and why not when it isn't.
   *
   * Shown here because this is where somebody looks when the alerts they
   * expected did not arrive. A registration that silently fails and says so
   * nowhere is how "no token in the database" becomes an hour of guessing.
   */
  push?: PushResult | null;
}

export function Alerts({ signedIn, lookup, onOpen, push }: Props) {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(() => read(SEEN_KEY));
  const [cleared, setCleared] = useState(() => read(CLEARED_KEY));
  const trigger = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!supabase || !signedIn) return;
    setLoading(true);

    // RLS does the filtering (migration 0017): own rows plus the '*' broadcast.
    // Asking for a specific owner here would be the client deciding what it is
    // allowed to see, which is the part that belongs in the database.
    const { data, error: err } = await supabase
      .from('signal_alerts')
      .select('owner, symbol, side, signal_date, sent_at')
      .order('sent_at', { ascending: false })
      .limit(LIMIT);

    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    setAlerts(
      (data ?? []).map((r: Row) => ({
        owner: r.owner,
        symbol: r.symbol,
        side: r.side === 'SELL' ? 'SELL' : 'BUY',
        signalDate: r.signal_date,
        sentAt: r.sent_at,
      })),
    );
    setError(null);
    setLoading(false);
  }, [signedIn]);

  // Once on mount for the badge, then whenever the tab comes back. Not polled:
  // the job that writes this runs every five minutes and the push notification
  // itself is the real-time channel — the bell is where you look afterwards.
  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  if (!signedIn || !supabase) return null;

  // Cleared alerts are hidden from the list *and* from the badge. Anything that
  // arrives afterwards is unaffected — clearing is not muting.
  const visible = alerts.filter((a) => a.sentAt > cleared);
  const unread = visible.filter((a) => a.sentAt > seen).length;

  /**
   * Hide everything currently listed.
   *
   * The cutoff is the newest alert's own timestamp, not `now()`: an alert that
   * lands in the same second as the tap has not been read, and using the clock
   * would swallow it.
   */
  const clearAll = () => {
    const newest = visible[0]?.sentAt;
    if (!newest) return;
    setCleared(newest);
    write(CLEARED_KEY, newest);
    // Seen moves with it, or the badge would keep counting rows nobody can see.
    setSeen(newest);
    write(SEEN_KEY, newest);
  };

  const openPanel = () => {
    setOpen(true);
    void load();
  };

  const close = (refocus?: boolean) => {
    setOpen(false);
    // Marked read on *close*, not on open: opening and immediately dismissing
    // still counts as having looked, and marking on open makes the badge
    // vanish under the finger before the list has painted.
    const newest = visible[0]?.sentAt;
    if (newest && newest > seen) {
      setSeen(newest);
      write(SEEN_KEY, newest);
    }
    if (refocus) trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-btn alerts-btn"
        onClick={() => (open ? close() : openPanel())}
        data-open={open}
        title={
          push && !push.ok
            ? `Alerts — this device is not registered. ${describePush(push)}`
            : unread > 0
              ? `${unread} new alert${unread === 1 ? '' : 's'}`
              : 'Alerts'
        }
        aria-label={unread > 0 ? `Alerts, ${unread} new` : 'Alerts'}
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5" />
          <path d="M10.3 19.5a2 2 0 0 0 3.4 0" />
        </svg>
        {/* Capped at 9+: the count is "is there anything new", not a total.
            The unregistered mark takes precedence — a count of unread alerts is
            beside the point on a device that will not receive the next one. */}
        {push && !push.ok ? (
          <span className="alerts-dot alerts-dot-warn" aria-hidden>
            !
          </span>
        ) : (
          unread > 0 && <span className="alerts-dot num">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <PopMenu
          trigger={trigger}
          rows={sizeInRows(visible.length, new Set(visible.map((a) => dayLabel(a.sentAt))).size)}
          /* Header, and the taller-than-a-menu-row shape of an alert. */
          chrome={70}
          width={panelWidth()}
          ariaLabel="Alerts"
          className="alerts-menu"
          onClose={close}
        >
          <div className="alerts-head">
            <span>
              Alerts
              {unread > 0 && <span className="alerts-new-count"> {unread} new</span>}
            </span>
            {visible.length > 0 && (
              <button type="button" className="alerts-clear" onClick={clearAll}>
                Clear
              </button>
            )}
          </div>

          {push && !push.ok && (
            <p className="alerts-warn">
              <strong>Not registered on this device.</strong> {describePush(push)}
              {/* The exact cause, not just the category. `failed` covers a
                  service worker that would not register, an SDK version
                  mismatch, an RLS refusal and a dead network — and "could not
                  register this device" sends someone to guess which. It is the
                  one line worth putting on screen rather than leaving in the
                  console. */}
              {push.detail && <span className="alerts-detail">{push.detail}</span>}
            </p>
          )}

          {error && <p className="alerts-empty">Could not read alerts — {error}</p>}

          {!error && visible.length === 0 && (
            <p className="alerts-empty">
              {loading
                ? 'Reading…'
                : cleared
                  ? 'Cleared. New alerts still arrive — clearing hides what you have already read on this device, it does not turn anything off.'
                  : 'No alerts yet. A BUY on a screen symbol, or a SELL on one of your watchlisted symbols, appears here and on your phone.'}
            </p>
          )}

          {visible.map((a, i) => {
            // A heading whenever the day changes. `visible` is already newest
            // first, so comparing with the previous row is the whole grouping —
            // no second pass, no map of buckets to render from.
            const day = dayLabel(a.sentAt);
            const heading = i === 0 || day !== dayLabel(visible[i - 1].sentAt) ? day : null;
            const row = lookup?.(a.symbol);
            // Read, never fetched: opening the bell must not start thirty chart
            // requests. A symbol the table has already judged has its answer
            // here for free; one it has not shows the title alone.
            const signal = row ? peekSignal(row.ticker) : undefined;
            const gap = signal ? signalGapPct(signal, row?.quote?.price) : null;

            return (
              <Fragment key={`${a.owner}|${a.symbol}|${a.side}|${a.signalDate}`}>
                {heading && <div className="alerts-day">{heading}</div>}
                <button
                  type="button"
                  className={`alert-row sig ${a.side === 'BUY' ? 'up' : 'down'}`}
                  data-new={a.sentAt > seen}
                  disabled={!row}
                  onClick={() => {
                    if (row) onOpen?.(row);
                    close();
                  }}
                >
                  <span className="alert-line">
                    <span className="sig-badge">{a.side}</span>
                    <strong className="alert-symbol">{a.symbol}</strong>
                    {/* Which rule fired, because the two have different audiences
                      and "why am I being told this" is the first question. */}
                    <span className="alert-src muted">
                      {a.owner === '*' ? 'Screen' : 'Watchlist'}
                    </span>
                    <span className="alert-ago muted num">{ago(a.sentAt)}</span>
                  </span>

                  {signal && (
                    <span className="alert-body muted">
                      <span className="num">
                        ₹{Math.round(signal.price).toLocaleString('en-IN')}
                      </span>
                      {' · score '}
                      <span className="num">{signal.score}</span>
                      {gap !== null && (
                        <>
                          {' · '}
                          <span className="num">{formatGap(gap)}</span>
                          {' since'}
                        </>
                      )}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </PopMenu>
      )}
    </>
  );
}
