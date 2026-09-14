// Pushes a notification when a UT Bot signal fires on something somebody cares
// about. Two rules, one pass over the bars:
//
//   · **BUY** on a symbol in `public.screen_matches` → every registered device.
//     The screen is the app's shared shortlist, so a breakout in it is news for
//     everyone rather than for whoever happened to add it.
//   · **SELL** on a symbol in a `public.watchlists` row → that row's owner only.
//     A sell is a statement about a position, and positions are private.
//
// The signal is `latestSignal` from _shared/utbot.ts — the same function, not a
// transcription of it, that draws the Signal column in the browser. That is the
// whole reason the extraction in that file happened: an alert that disagrees
// with the table the user opens to check it is worse than no alert.
//
// ## Every five minutes, and what that costs
//
// This runs on the quote cron's beat (migration 0016), so a flip is announced
// within five minutes of the bar crossing the stop rather than at the close.
// The price is that the last daily bar is still trading: a flip dated today can
// un-flip before 15:30, and one that does was still sent. `signal_alerts`
// bounds the damage to one notification per symbol per side per day; nothing
// retracts it, and the body says `live · may repaint` while the session is on.
import {
  adminClient,
  assertAuthorized,
  chunk,
  CORS_HEADERS,
  json,
  mapPool,
  toNseTicker,
} from '../_shared/upstream.ts';
import { fetchDailyBars } from '../_shared/yahoo.ts';
import { fcmSession, sendPush, type FcmSession } from '../_shared/fcm.ts';
import { latestSignal, UT_BOT } from '../_shared/utbot.ts';

/**
 * Yahoo starts refusing connections past roughly this many in parallel, and an
 * Edge Function has a wall-clock budget with nobody watching a progress bar —
 * the same eight, for the same reason, as sync-technicals.
 */
const CONCURRENCY = 8;

/** The broadcast pseudo-owner in `signal_alerts`. See the table's comment. */
const EVERYONE = '*';

/** NSE and BSE are both IST and India has no daylight saving, so this is exact. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today's session date in IST — what a flip's `date` is compared against. */
const istToday = (): string =>
  new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Is the market open right now? Decides `provisional`, and the wording.
 *
 * Transcribed from `isMarketOpen` in src/lib/format.ts rather than imported —
 * that file is browser-side and importing it would drag Vite's module graph
 * into Deno. Ten lines and a fixed exchange timetable, unlike the six hundred
 * lines of signal arithmetic that earned a shared file.
 *
 * Holidays are not modelled, here or there. On one the bars simply do not
 * advance, so nothing flips and nothing is sent.
 */
function isMarketOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutesOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return minutesOfDay >= 9 * 60 + 15 && minutesOfDay <= 15 * 60 + 30;
}

/** ₹3,180 — the price as the app prints it. */
const rupees = (value: number): string =>
  `₹${Math.round(value).toLocaleString('en-IN')}`;

/** One alert that wants sending, before the ledger has been asked about it. */
interface Candidate {
  owner: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  signal_date: string;
  /**
   * The notification's two lines. Neither is stored: `signal_alerts` keeps only
   * what identifies an alert — owner, symbol, side, date — which is enough for
   * the ledger to do its job and enough for the app's bell panel to list it.
   * The numbers are live in the detail drawer rather than frozen in a column.
   */
  title: string;
  body: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const denied = assertAuthorized(req);
  if (denied) return denied;

  const url = new URL(req.url);
  /** Compute and report, send nothing and write nothing. */
  const dry = url.searchParams.get('dry') === '1';
  /** Restrict the whole pass to one symbol, for testing. */
  const only = url.searchParams.get('symbol')?.trim().toUpperCase() || null;

  try {
    const supabase = adminClient();
    const today = istToday();
    const marketOpen = isMarketOpen();

    // --- who cares about what --------------------------------------------
    const { data: screenRows, error: screenErr } = await supabase
      .from('screen_matches')
      .select('symbol');
    if (screenErr) return json({ error: screenErr.message, stage: 'read-screen' }, 500);
    const screen = new Set((screenRows ?? []).map((r) => r.symbol as string));

    const { data: listRows, error: listErr } = await supabase
      .from('watchlists')
      .select('owner, symbols');
    if (listErr) return json({ error: listErr.message, stage: 'read-watchlists' }, 500);

    // One symbol can sit on several people's lists, and one person can have it
    // on two of their own — a Set per symbol collapses both.
    const watchers = new Map<string, Set<string>>();
    for (const row of (listRows ?? []) as { owner: string; symbols: string[] | null }[]) {
      for (const symbol of row.symbols ?? []) {
        if (!watchers.has(symbol)) watchers.set(symbol, new Set());
        watchers.get(symbol)!.add(row.owner);
      }
    }

    let symbols = [...new Set([...screen, ...watchers.keys()])];
    if (only) symbols = symbols.filter((s) => s === only);
    if (symbols.length === 0) {
      return json({ ok: true, symbols: 0, note: 'nothing on the screen or any watchlist' });
    }

    // --- which Yahoo symbol is that ---------------------------------------
    // `yahoo_ticker` falling back to `toNseTicker`, matching `toSecurity` in
    // src/lib/supabaseSource.ts, so the alert and the table agree about which
    // series a row means.
    const tickers = new Map<string, string>();
    for (const batch of chunk(symbols, 500)) {
      const { data, error } = await supabase
        .from('securities')
        .select('symbol, yahoo_ticker')
        .in('symbol', batch);
      if (error) return json({ error: error.message, stage: 'read-securities' }, 500);
      for (const r of (data ?? []) as { symbol: string; yahoo_ticker?: string | null }[]) {
        tickers.set(r.symbol, r.yahoo_ticker || toNseTicker(r.symbol));
      }
    }

    // --- the signal --------------------------------------------------------
    const candidates: Candidate[] = [];
    let unreachable = 0;

    await mapPool(symbols, CONCURRENCY, async (symbol) => {
      const ticker = tickers.get(symbol) ?? toNseTicker(symbol);

      let bars;
      try {
        bars = await fetchDailyBars(ticker);
      } catch {
        // A 429 or a stalled request. Nothing is stored either way, so the next
        // run in five minutes asks again — retrying inside one invocation would
        // spend the wall-clock budget on the symbols least likely to answer.
        unreachable++;
        return;
      }
      if (bars.length === 0) return;

      const signal = latestSignal(bars, UT_BOT, marketOpen);
      if (!signal || signal.date !== today) return;

      const live = signal.provisional ? ' · live, may repaint' : '';
      const body = `${rupees(signal.price)} · UT Bot flipped today · score ${signal.score}${live}`;
      const title = `${signal.side} · ${symbol}`;

      if (signal.side === 'BUY' && screen.has(symbol)) {
        candidates.push({ owner: EVERYONE, symbol, side: 'BUY', signal_date: today, title, body });
      }

      if (signal.side === 'SELL') {
        for (const owner of watchers.get(symbol) ?? []) {
          candidates.push({ owner, symbol, side: 'SELL', signal_date: today, title, body });
        }
      }
    });

    if (dry) {
      return json({
        ok: true,
        dry: true,
        symbols: symbols.length,
        unreachable,
        marketOpen,
        today,
        candidates: candidates.map(({ owner, symbol, side, body }) => ({ owner, symbol, side, body })),
      });
    }

    if (candidates.length === 0) {
      return json({ ok: true, symbols: symbols.length, unreachable, flips: 0, sent: 0 });
    }

    // --- who has not been told yet ----------------------------------------
    // The insert *is* the test. `ignoreDuplicates` makes the primary key drop
    // anything already announced, and the rows that come back are exactly the
    // new ones — so a crash between here and the send loses a notification, but
    // a retry never doubles one. That is the right way round: a missed alert is
    // a missed alert, a duplicate one at 09:20 and again at 09:25 and again at
    // 09:30 is the feature being uninstalled.
    const { data: fresh, error: ledgerErr } = await supabase
      .from('signal_alerts')
      .upsert(
        candidates.map(({ owner, symbol, side, signal_date }) => ({ owner, symbol, side, signal_date })),
        { onConflict: 'owner,symbol,side,signal_date', ignoreDuplicates: true },
      )
      .select('owner, symbol, side');
    if (ledgerErr) return json({ error: ledgerErr.message, stage: 'ledger' }, 500);

    const announce = (fresh ?? []) as { owner: string; symbol: string; side: string }[];
    if (announce.length === 0) {
      return json({
        ok: true,
        symbols: symbols.length,
        unreachable,
        flips: candidates.length,
        sent: 0,
        note: 'all of today\'s flips were already announced',
      });
    }

    // --- devices ------------------------------------------------------------
    const { data: tokenRows, error: tokenErr } = await supabase
      .from('fcm_tokens')
      .select('fcm_token, username');
    if (tokenErr) return json({ error: tokenErr.message, stage: 'read-tokens' }, 500);

    const devices = (tokenRows ?? []) as { fcm_token: string; username: string }[];
    if (devices.length === 0) {
      // The ledger rows stay written. Nobody has a device registered, and
      // re-announcing today's flip to the first person who signs in tomorrow
      // would be announcing yesterday's news.
      return json({
        ok: true,
        symbols: symbols.length,
        flips: candidates.length,
        announced: announce.length,
        sent: 0,
        note: 'no devices registered',
      });
    }

    const link = Deno.env.get('APP_URL') || undefined;
    let session: FcmSession;
    try {
      session = await fcmSession();
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err), stage: 'fcm-auth' }, 500);
    }

    const byKey = new Map(candidates.map((c) => [`${c.owner}|${c.symbol}|${c.side}`, c]));
    const dead = new Set<string>();
    /**
     * Announcements that reached nobody because the sends errored.
     *
     * Their ledger rows are removed below so the next run tries again. Without
     * that, one 429 from FCM means the row says "told them" and the alert is
     * never sent and never retried — the worst of both, and invisible.
     *
     * A row whose only devices came back `dead` is *not* in here: nothing went
     * wrong, those devices are simply gone, and retrying in five minutes would
     * be retrying forever.
     */
    const retry: { owner: string; symbol: string; side: string }[] = [];
    let sent = 0;
    let failed = 0;

    for (const row of announce) {
      const copy = byKey.get(`${row.owner}|${row.symbol}|${row.side}`);
      if (!copy) continue;

      // '*' is everybody; anything else is one person's devices, however many.
      const targets =
        row.owner === EVERYONE ? devices : devices.filter((d) => d.username === row.owner);

      const results = await mapPool(targets, CONCURRENCY, (device) =>
        sendPush(session, device.fcm_token, { title: copy.title, body: copy.body, link }),
      );

      let delivered = 0;
      let errored = 0;
      results.forEach((result, i) => {
        if (result === 'ok') {
          sent++;
          delivered++;
        } else if (result === 'dead') {
          dead.add(targets[i].fcm_token);
        } else {
          failed++;
          errored++;
        }
      });

      if (delivered === 0 && errored > 0) retry.push(row);
    }

    if (retry.length > 0) {
      for (const row of retry) {
        await supabase
          .from('signal_alerts')
          .delete()
          .eq('owner', row.owner)
          .eq('symbol', row.symbol)
          .eq('side', row.side)
          .eq('signal_date', today);
      }
    }

    // A token FCM has disowned will never work again — drop it now rather than
    // pushing at it for the next 90 days until the sweep gets to it.
    if (dead.size > 0) {
      await supabase.from('fcm_tokens').delete().in('fcm_token', [...dead]);
    }

    // And the other half of "expired tokens delete themselves": a device that
    // simply stopped coming back is never sent to, so it never fails, so the
    // rule above never sees it. Cheap enough to run every pass.
    const { data: swept } = await supabase.rpc('fcm_tokens_sweep');

    return json({
      ok: true,
      symbols: symbols.length,
      unreachable,
      flips: candidates.length,
      announced: announce.length,
      devices: devices.length,
      sent,
      failed,
      dropped: dead.size,
      retrying: retry.length,
      swept: swept ?? 0,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
