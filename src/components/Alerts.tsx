import { useCallback, useEffect, useRef, useState } from 'react';
import { PopMenu } from './PopMenu';
import { supabase } from '../lib/supabaseClient';
import { formatGap, peekSignal, signalGapPct } from '../lib/signals';
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
 * When this device last opened the panel.
 *
 * localStorage rather than a column: "have I seen this" is a property of the
 * person sitting in front of *this* browser, and a phone and a laptop having
 * their own answer is correct rather than a limitation.
 */
const SEEN_KEY = 'fivealpha:alerts-seen';

const readSeen = (): string => {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
};

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
}

export function Alerts({ signedIn, lookup, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(readSeen);
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

  const unread = alerts.filter((a) => a.sentAt > seen).length;

  const openPanel = () => {
    setOpen(true);
    void load();
  };

  const close = (refocus?: boolean) => {
    setOpen(false);
    // Marked read on *close*, not on open: opening and immediately dismissing
    // still counts as having looked, and marking on open makes the badge
    // vanish under the finger before the list has painted.
    const newest = alerts[0]?.sentAt;
    if (newest && newest > seen) {
      setSeen(newest);
      try {
        localStorage.setItem(SEEN_KEY, newest);
      } catch {
        // Private mode: the badge comes back next load. Harmless.
      }
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
        title={unread > 0 ? `${unread} new alert${unread === 1 ? '' : 's'}` : 'Alerts'}
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
        {/* Capped at 9+: the count is "is there anything new", not a total. */}
        {unread > 0 && <span className="alerts-dot num">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <PopMenu
          trigger={trigger}
          rows={Math.max(alerts.length, 1)}
          /* Header, and the taller-than-a-menu-row shape of an alert. */
          chrome={70}
          width={panelWidth()}
          ariaLabel="Alerts"
          className="alerts-menu"
          onClose={close}
        >
          <div className="alerts-head">
            <span>Alerts</span>
            <span className="muted">{alerts.length > 0 ? `last ${alerts.length}` : ''}</span>
          </div>

          {error && <p className="alerts-empty">Could not read alerts — {error}</p>}

          {!error && alerts.length === 0 && (
            <p className="alerts-empty">
              {loading
                ? 'Reading…'
                : 'No alerts yet. A BUY on a screen symbol, or a SELL on one of your watchlisted symbols, appears here and on your phone.'}
            </p>
          )}

          {alerts.map((a) => {
            const row = lookup?.(a.symbol);
            // Read, never fetched: opening the bell must not start thirty chart
            // requests. A symbol the table has already judged has its answer
            // here for free; one it has not shows the title alone.
            const signal = row ? peekSignal(row.ticker) : undefined;
            const gap = signal ? signalGapPct(signal, row?.quote?.price) : null;

            return (
              <button
                key={`${a.owner}|${a.symbol}|${a.side}|${a.signalDate}`}
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
                    <span className="num">₹{Math.round(signal.price).toLocaleString('en-IN')}</span>
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
            );
          })}
        </PopMenu>
      )}
    </>
  );
}
