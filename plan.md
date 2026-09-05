# Watchlist SELL alerts — push notifications over FCM

Written 2026-09-02. Replaces the Upstox migration note that lived here; that document is still in git (`820a8a2`).

## What this is for

A UT Bot SELL only exists today inside a logged-in browser tab that has scrolled the row into view. [src/lib/signals.ts](src/lib/signals.ts) computes it from Yahoo daily bars and memoises it in a per-browser localStorage day-cache. Nothing is stored, nothing runs server-side, and there is no notification code anywhere in the repo.

**Goal:** when a stock on a watchlist flips to SELL today, push a notification to that list's owner — app open or not — using Firebase Cloud Messaging on the free Spark plan, where FCM is unmetered.

Three things are genuinely greenfield, and they are why this is not a small feature:

1. The signal math has to run server-side. It currently cannot — it is browser-only TypeScript reaching Yahoo through a same-origin proxy.
2. Something has to remember that a flip was already announced. The day-cache is per browser, so it cannot.
3. There is no service worker, no push-token storage, and no `Notification` call anywhere.

Two decisions taken up front:

- **Post-close only.** A flip on a still-open bar can repaint — that is what `provisional` in `latestSignal` means. One run after the close, no false alarms, one push per symbol per day.
- **One copy of the math.** Not a transcription. [_shared/yahoo.ts](supabase/functions/_shared/yahoo.ts) deliberately transcribes `technicals.ts` and says so; that was the right call for thirty lines of RSI. Six hundred lines of UT Bot drifting apart would mean the browser showing one signal and the alert sending another, which is the specific failure worth spending a file to prevent.

---

## Shape

```
pg_cron  10:30 UTC, Mon–Fri            (16:00 IST — the close is 15:30)
  └─ private.invoke_sync('notify-signals')        ← existing helper, 0002_cron.sql
       └─ Edge Function notify-signals
            1. public.watchlists      → Map<symbol, owner[]>
            2. public.securities      → yahoo_ticker per symbol
            3. Yahoo chart 1y/1d, 8-way pool
            4. latestSignal(bars)     → keep side === 'SELL' && date === today
            5. upsert signal_alerts (owner, symbol, signal_date), ignoreDuplicates
                 → the rows that come back are the ones nobody has been told about
            6. FCM v1 send to every push_tokens row for those owners
            7. 404 / UNREGISTERED  → delete that token row
```

Step 5 is the whole idempotency story. Re-running the cron, or running the function by hand, notifies nobody twice — the primary key does it, not a flag anyone has to remember to set.

---

## Changes

### 1. Extract the pure math — `supabase/functions/_shared/utbot.ts` (new)

Move out of [src/lib/signals.ts](src/lib/signals.ts), verbatim: `UT_BOT`, `SCORE` and its constants, `wma`, `hma`, `atr`, `cleanBars`, `runUtBot`, `mean`, `median`, `summarise`, `latestSignal`, and the `Signal` / `Flip` types.

Two constraints make one file work in both runtimes:

- **Zero imports.** Declare a local `Candle` interface rather than importing `../types` — it is structurally identical, so TypeScript accepts values in both directions and Deno needs to resolve nothing.
- `latestSignal(bars, cfg, isOpen = false)`. The only browser dependency inside the function body is `isMarketOpen()`, used for `provisional`. Pass it in; the browser passes the real thing, Deno takes the default.

The file lives under `supabase/functions/` and **the browser reaches out to it**, not the reverse. That direction matters: the Supabase CLI bundler is the fussy one about imports outside its own tree, Vite is not. `allowImportingTsExtensions` is already on in [tsconfig.json](tsconfig.json), so `import { latestSignal } from '../../supabase/functions/_shared/utbot.ts'` resolves as written. The `"exclude": ["supabase"]` line does not block it — exclude limits globbing, not files pulled in by an import — and `utbot.ts` has no Deno globals to trip `tsc`.

`src/lib/signals.ts` keeps everything else — the day-cache, the gate, `fetchSignal`, `matchesSignalFilter`, `signalGapPct`, the formatters — and re-exports the core, so no consumer's import changes.

### 2. `supabase/migrations/0011_push.sql` (new)

```sql
create table if not exists public.push_tokens (
  token      text primary key,
  owner      text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_tokens_owner_idx on public.push_tokens (owner);

create table if not exists public.signal_alerts (
  owner       text not null,
  symbol      text not null,
  signal_date date not null,
  sent_at     timestamptz not null default now(),
  primary key (owner, symbol, signal_date)
);
```

RLS on `push_tokens` mirrors [0006_watchlists.sql](supabase/migrations/0006_watchlists.sql) exactly — reuse the existing `public.request_owner()`, four policies keyed on `owner = public.request_owner()`. Same trust model as watchlists, and the file's comment should say so in the same words: the header is self-asserted, so this is separation, not security.

`signal_alerts` gets RLS **on with no policies**, like `app_users` in [0007_users.sql](supabase/migrations/0007_users.sql) — only the service role touches it.

Then the schedule, reusing `private.invoke_sync` unchanged:

```sql
select cron.unschedule(jobname) from cron.job where jobname = 'nse-notify-signals';
-- NSE closes 15:30 IST = 10:00 UTC. Half an hour later the daily bar has settled.
select cron.schedule('nse-notify-signals', '30 10 * * 1-5',
  $$ select private.invoke_sync('notify-signals'); $$);
```

### 3. `supabase/functions/_shared/yahoo.ts` — add `fetchDailyBars`

One `chart` request, parsed to `Candle[]`. Mirrors the parse in [src/lib/yahooCandles.ts](src/lib/yahooCandles.ts) but hits Yahoo directly with `BROWSER_UA` through the existing `fetchWithTimeout`, and reuses the `IST_OFFSET_MS` session-date rule already in this file — dating an Indian bar in UTC puts it a day early, which would make "flipped today" wrong for exactly one bar. ~25 lines.

### 4. `supabase/functions/_shared/fcm.ts` (new)

- `accessToken()` — sign an RS256 JWT from the service account (`importPKCS8` + `SignJWT` from `https://esm.sh/jose@5`, in pattern with the `esm.sh` import already in [_shared/upstream.ts](supabase/functions/_shared/upstream.ts)), scope `https://www.googleapis.com/auth/firebase.messaging`, exchange it at `https://oauth2.googleapis.com/token`. Fetched once per invocation.
- `sendPush(token, title, body, link)` — POST to `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`. Returns `'ok' | 'dead'`, where `dead` is a 404, `UNREGISTERED` or `INVALID_ARGUMENT`, so the caller knows to drop the row.

The legacy server-key API was switched off in 2024, so v1 with a service account is the only door. Config is one secret, `FCM_SERVICE_ACCOUNT`, holding the whole service-account JSON; `project_id` is read out of it rather than stored separately.

### 5. `supabase/functions/notify-signals/index.ts` (new)

Same shell as [sync-technicals](supabase/functions/sync-technicals/index.ts): `assertAuthorized` → work → `json({ … })`. Uses `adminClient`, `mapPool` at 8, `chunk`, `toNseTicker`. The ticker comes from `securities.yahoo_ticker` falling back to `toNseTicker(symbol)`, matching [src/lib/supabaseSource.ts:74](src/lib/supabaseSource.ts#L74) so the alert and the table agree on which Yahoo symbol a row is.

Two query params, both cheap and both earn their keep:

- `?dry=1` — compute and return the SELL list, send nothing, write nothing.
- `?symbol=TCS` — restrict to one symbol, for testing.

Notification copy: title `SELL · TCS`, body `₹3,180 · UT Bot flipped today · score 72`, link `/?symbol=TCS`.

### 6. `public/firebase-messaging-sw.js` (new)

`importScripts` the `firebase-app-compat` and `firebase-messaging-compat` bundles from gstatic, `initializeApp(config)`, `firebase.messaging()`. With a `notification` payload the SDK displays it, so there is no `onBackgroundMessage` handler to write — only a `notificationclick` listener that focuses an already-open tab or opens the link. ~20 lines.

The config literal is **hardcoded here.** A static file in `public/` cannot read Vite env vars, and this is public data that ships in the bundle anyway. Leave a comment saying it has to stay in step with the `VITE_FIREBASE_*` values.

### 7. `src/lib/push.ts` (new)

- `pushSupported()` — `'Notification' in window && 'serviceWorker' in navigator && supabase !== null`.
- `enablePush()` — `requestPermission()` → register the service worker → **dynamic** `import('firebase/app')` and `import('firebase/messaging')` → `getToken(messaging, { vapidKey, serviceWorkerRegistration })` → upsert into `push_tokens`. Dynamic so that ~50 KB of Firebase stays out of the main chunk for everyone who never turns alerts on.
- `disablePush()` — `deleteToken()` and delete the row.
- Cache the token in localStorage and re-upsert on app start only when it has changed. FCM rotates tokens, and a stale row is a notification that silently goes nowhere.

One new dependency: `firebase`. Nothing else.

### 8. `src/components/WatchlistBar.tsx` — a bell toggle

Beside the list tabs, in the shell the actions menu already uses. Three states: unsupported (hidden), off, on. `Notification.permission === 'denied'` renders a disabled bell whose title says it has to be re-allowed in site settings, because at that point the app cannot ask again. Existing button styling from [src/index.css](src/index.css) — no new component, no toast library.

### 9. `.env.example`

Add, in the file's existing commented style: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_VAPID_KEY`, and a server-only note for `FCM_SERVICE_ACCOUNT`. The `VITE_*` ones must also be set as **build** variables in the Cloudflare dashboard — the same note [wrangler.toml](wrangler.toml) already carries for the Supabase keys.

---

## One-time Firebase setup

All of it is free on Spark — no billing account, no quota to watch.

1. Create a project → add a **Web app** → copy the config object.
2. Cloud Messaging → **Web Push certificates** → Generate key pair. That public key is `VITE_FIREBASE_VAPID_KEY`.
3. Project settings → Service accounts → **Generate new private key** → JSON file.
4. `supabase secrets set FCM_SERVICE_ACCOUNT="$(cat service-account.json)"`.
5. `supabase functions deploy notify-signals`, then apply `0011_push.sql`.

---

## Verification

1. `npm run check:signals` — must pass unchanged after the extraction. This is the regression check that proves step 1 moved code and not a number.
2. `npm run typecheck` — confirms the cross-tree `.ts` import resolves.
3. `curl -H "x-sync-secret: $SYNC_SECRET" "$FUNCTIONS_URL/notify-signals?dry=1"` — returns today's watchlist SELLs, sends nothing, writes nothing. Spot-check one against what the browser shows for the same symbol; identical or the extraction is wrong.
4. In the app, enable alerts → `select * from push_tokens` has a row under your username.
5. End to end: `?symbol=<something whose SELL is dated today>` with `dry` off. If nothing flipped today, delete the `signal_alerts` row for a recent flip and widen the date test to reproduce a send.
6. `select * from cron.job` shows `nse-notify-signals`; the next weekday, `signal_alerts` has rows.

---

## Deliberate cuts

- **SELL only.** BUY is one constant away in the filter. Add it when both are wanted.
- **One Yahoo chart request per distinct watchlist symbol per day**, 8-way pool. Fine to a few hundred symbols; mark it `ponytail:` and paginate behind an `?offset=` param if the union of all watchlists ever gets large.
- **One FCM request per token.** The batch endpoint is deprecated, so there is no cheaper shape available.
- **No in-app notification centre, no history screen, no per-list or per-symbol mute.** `signal_alerts` is already the log if one is ever wanted.
- **Push identity is the client-asserted `x-owner` username**, exactly like watchlists. Anyone who edits localStorage can register a token under another username. That is the app's existing threat model rather than a regression, and the fix — if it ever matters — is the one [0006_watchlists.sql](supabase/migrations/0006_watchlists.sql) already spells out.
- **iOS needs the PWA installed to the home screen** (16.4+) before web push works at all. [public/site.webmanifest](public/site.webmanifest) already exists; this is worth one line in the toggle's help text and nothing more.
