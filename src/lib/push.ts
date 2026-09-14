/**
 * Registering this device for push notifications, and forgetting it again.
 *
 * There is no bell and no settings screen. An account is a person, a person has
 * a phone and a laptop, and the moment the app knows which account is in front
 * of it is the moment to record the device — so this hangs off sign-in and
 * sign-out (see `login` / `logout` in auth.ts) and has no UI of its own.
 * Signing out is the off switch.
 *
 * **Nothing in here may throw.** Every path returns a reason instead. A browser
 * with no push support, a refused permission prompt, a blocked service worker,
 * a Supabase that is not configured — none of those are a failed sign-in, and a
 * rejected promise on that path would make one.
 *
 * **But a reason nobody reads is the same as no reason.** The first version of
 * this file returned these results into a `void` at the call site, and the first
 * thing that went wrong — a dev server started before `VITE_FIREBASE_*` existed
 * in `.env`, so every value here was `undefined` — presented as "signing in
 * produces no token", with nothing anywhere saying why. So every failure is now
 * logged under one prefix, and the last one is readable by the UI.
 *
 * Firebase is pulled in with a dynamic `import()` so that its ~50 KB stays out
 * of the main chunk until somebody actually signs in.
 */
import { supabase } from './supabaseClient';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * The public half of the Web Push key pair, from Firebase → Cloud Messaging →
 * Web Push certificates. Without it `getToken` mints a token the FCM v1 send
 * silently never reaches.
 */
const VAPID_KEY = env.VITE_FIREBASE_VAPID_KEY;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

/**
 * The last token this browser registered.
 *
 * Kept only so sign-out can delete the right row when `deleteToken` cannot mint
 * the token again — a revoked permission, a service worker already gone.
 */
const TOKEN_KEY = 'fivealpha:fcm-token';

export type PushReason = 'unsupported' | 'insecure' | 'denied' | 'unconfigured' | 'failed';

export type PushResult =
  | { ok: true; token: string }
  | { ok: false; reason: PushReason; detail?: string };

/** What to tell a person, per reason. The detail goes to the console, not here. */
const SAID: Record<PushReason, string> = {
  unsupported: 'This browser cannot do push notifications. On iPhone, add the app to the home screen first.',
  insecure: 'Push needs https. Open the app over https or on localhost — a plain http LAN address cannot register.',
  denied: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then sign in again.',
  unconfigured: 'Push is not configured in this build — the VITE_FIREBASE_* values are missing. If you just added them to .env, restart the dev server.',
  failed: 'Could not register this device for alerts.',
};

export const describePush = (r: PushResult): string =>
  r.ok ? 'Alerts on for this device.' : SAID[r.reason];

/**
 * The last thing that happened, so the UI can say it without re-running any of
 * this. Module-level rather than React state because registration is triggered
 * from two unrelated places (sign-in, and app start) and neither owns the other.
 */
let last: PushResult | null = null;
export const lastPushResult = (): PushResult | null => last;

function settle(result: PushResult): PushResult {
  last = result;
  if (result.ok) console.info('[push] registered', result.token.slice(0, 12) + '…');
  else console.warn(`[push] not registered — ${result.reason}`, result.detail ?? SAID[result.reason]);
  return result;
}

/**
 * Wait until **this** registration has an active worker.
 *
 * `navigator.serviceWorker.ready` is the wrong wait and using it here was a
 * bug: it resolves for whatever registration controls the *page*, which after
 * `resetPushState()` has unregistered everything is nothing at all — and even
 * when it resolves, it says nothing about the registration object in hand. Ask
 * that registration to `pushManager.subscribe()` a moment too early and the
 * browser answers `Subscription failed - no active Service Worker`.
 *
 * A freshly registered worker goes installing → installed/waiting → activated,
 * or → redundant if its script threw. Both ends are watched, because redundant
 * is the interesting one: it is what happens when `importScripts` cannot fetch
 * the Firebase compat bundles, and it otherwise presents as the same generic
 * "no active Service Worker" with nothing pointing at the script.
 */
async function waitForActive(
  registration: ServiceWorkerRegistration,
  timeoutMs = 10_000,
): Promise<void> {
  if (registration.active) return;

  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('service worker registered but produced no worker to activate');

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', onState);
      reject(new Error(`service worker stuck in "${worker.state}" after ${timeoutMs}ms`));
    }, timeoutMs);

    function onState() {
      if (worker!.state === 'activated') {
        clearTimeout(timer);
        worker!.removeEventListener('statechange', onState);
        resolve();
      } else if (worker!.state === 'redundant') {
        clearTimeout(timer);
        worker!.removeEventListener('statechange', onState);
        // Almost always the script itself: a syntax error, or importScripts
        // failing to reach gstatic.
        reject(new Error('service worker became redundant — /firebase-messaging-sw.js failed to install'));
      }
    }

    worker.addEventListener('statechange', onState);
    // It may already have moved on between the check above and the listener.
    onState();
  });
}

/**
 * The VAPID key as raw bytes, for comparing against a subscription that already
 * exists in this browser.
 *
 * `PushSubscription.options.applicationServerKey` is an ArrayBuffer, and the
 * stored key is base64url text, so one of them has to be converted to compare
 * them at all.
 */
function vapidBytes(): ArrayBuffer | null {
  if (!VAPID_KEY) return null;
  try {
    const padded = VAPID_KEY + '='.repeat((4 - (VAPID_KEY.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    // Built into a plain ArrayBuffer rather than `Uint8Array.from`, whose
    // result is typed over `ArrayBufferLike` — that includes SharedArrayBuffer,
    // which `applicationServerKey` does not accept.
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Throw away a push subscription this browser is holding under a *different*
 * key, and say so.
 *
 * This is the state behind `Registration failed - push service error`. A
 * subscription is per (service worker, application server key); once one exists,
 * asking the push service for another under a different key is refused, and the
 * refusal surfaces as that generic message rather than as anything naming the
 * key. It is easy to get into — regenerating the Web Push certificate, pointing
 * the app at another Firebase project, or an earlier broken service worker that
 * subscribed before the config was right — and impossible to get out of from
 * inside the app without doing exactly this.
 *
 * Only when the key differs. Unsubscribing a *matching* subscription on every
 * load would throw away a working registration and mint a new token each time,
 * which is a new row in `fcm_tokens` per page view.
 */
async function dropMismatchedSubscription(
  registration: ServiceWorkerRegistration,
): Promise<string | null> {
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return null;

  const want = vapidBytes();
  const have = existing.options?.applicationServerKey;
  if (want && have) {
    const mine = new Uint8Array(want);
    const theirs = new Uint8Array(have);
    if (theirs.length === mine.length && theirs.every((b, i) => b === mine[i])) return null;
  }

  await existing.unsubscribe();
  return 'dropped a push subscription held under a different VAPID key';
}

/**
 * Which layer failed — measured, not guessed.
 *
 * When `getToken` fails there are two very different things it could mean, and
 * the error text does not distinguish them. So ask the browser to make a plain
 * Web Push subscription with the same key, with no Firebase involved:
 *
 *   · **It fails too** → the problem is between the browser and the push
 *     service. Nothing in this app is involved and nothing in this app can fix
 *     it: a network that blocks the push channel, or a browser profile whose
 *     push registration is broken.
 *   · **It succeeds** → the browser and the push service are fine, and the
 *     failure is in Firebase's own token request — the project's configuration
 *     rather than the plumbing.
 *
 * This replaced a sentence that simply asserted the first of those. It was a
 * guess presented as a diagnosis, which is worse than saying nothing: it sends
 * someone to go and change their network over a cause nobody had established.
 *
 * The probe subscription is torn down immediately. Leaving it would hold the
 * slot the next real `getToken` needs.
 */
async function probeRawSubscribe(registration: ServiceWorkerRegistration): Promise<string> {
  const key = vapidBytes();
  if (!key) return 'could not even decode the VAPID key to test with';

  try {
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await sub.unsubscribe();
    return 'the browser subscribed to the push service fine on its own, so the push channel works — the failure is in Firebase’s token request';
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `the browser cannot subscribe to the push service at all (${why}) — that is between the browser and Google, not this app`;
  }
}

/**
 * The last resort: forget every trace of push in this browser profile and start
 * over.
 *
 * Unregisters *all* service workers rather than only ours, because the one that
 * holds a bad subscription may be an older copy of this file under a scope this
 * build no longer uses — `getSubscription()` on the fresh registration cannot
 * see it, so there is nothing more surgical to aim at.
 *
 * Run once, after a failure, before one retry. Never on the happy path.
 */
async function resetPushState(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const reg of registrations) {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch {
      // A registration that is already going away. Nothing to unsubscribe.
    }
    await reg.unregister();
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * Can this browser do web push at all?
 *
 * On iOS the answer is no until the PWA has been installed to the home screen
 * (16.4+), and there is no separate flag for that — Safari in a normal tab
 * simply has no `PushManager`, which this already covers.
 */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/**
 * Show notifications that arrive while the app is on screen.
 *
 * FCM splits delivery in two and only documents one of them clearly: with the
 * page **backgrounded** the message goes to the service worker, whose SDK draws
 * the `notification` block itself. With the page **in the foreground** it does
 * not — it hands the payload to `onMessage` and draws nothing, on the theory
 * that an app you are looking at should decide for itself.
 *
 * This app had only the background half. The result was a push that FCM
 * reported as delivered, that never appeared on screen and never reached the
 * Windows notification centre, because nobody had drawn it — which looks
 * exactly like a push that was never sent.
 *
 * Drawn through the **service worker's** `showNotification` rather than
 * `new Notification(...)`: the constructor is deprecated on desktop Chrome and
 * refuses outright on Android, and a notification from the registration is the
 * same object the background path produces — same click handling, same place in
 * the OS notification centre.
 *
 * Registered once per page. `onMessage` returns its own unsubscribe, which is
 * not used: this lives as long as the tab does.
 */
let foregroundBound = false;

async function showInForeground(
  messaging: import('firebase/messaging').Messaging,
  registration: ServiceWorkerRegistration,
): Promise<void> {
  if (foregroundBound) return;
  foregroundBound = true;

  const { onMessage } = await import('firebase/messaging');

  onMessage(messaging, (payload) => {
    const title = payload.notification?.title ?? 'FiveAlpha';
    const body = payload.notification?.body ?? '';
    void registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Same collapse key the server sends, so a foreground alert and a later
      // background one for the same symbol replace rather than stack.
      tag: title,
      // Stays until it is acted on, which on Windows is also what puts it in
      // the notification centre instead of vanishing with the toast.
      requireInteraction: true,
      data: payload.fcmOptions?.link ? { link: payload.fcmOptions.link } : undefined,
    });
  });
}

/**
 * Record the device under the signed-in username.
 *
 * **Safe to call on every app start, not only at sign-in.** That is the whole
 * shape of this function and it was the second thing wrong with the first
 * version: registration happened at the sign-in instant and nowhere else, so
 * any failure — a browser that had not been granted permission yet, an offline
 * first load, a build missing its config — was permanent until the next full
 * sign-out/sign-in cycle. Now the app retries it on mount, and the only thing
 * that differs between the two callers is whether it may raise a prompt.
 *
 * Upsert rather than insert — the same browser returns the same token, and
 * `updated_at` is what the 90-day stale sweep reads, so an unchanged token
 * still needs the write. Calling this on every load is therefore not waste: it
 * is what keeps a device that is still in use from being swept.
 *
 * Never awaited by sign-in: the permission prompt is answered by a human, and a
 * form that sits disabled until they do is a form that looks broken.
 */
export async function registerDevice(
  username: string,
  /**
   * May this raise the browser's permission prompt?
   *
   * True from sign-in, where a person just acted and a prompt is expected.
   * False from app start, which would otherwise pop a permission dialog at
   * every page load for anyone who has not decided yet.
   */
  { prompt = false }: { prompt?: boolean } = {},
): Promise<PushResult> {
  if (!pushSupported()) return settle({ ok: false, reason: 'unsupported' });

  // Checked separately from `pushSupported`, because it fails in a way that
  // looks identical and is fixed completely differently: on a plain http LAN
  // address — which is how a phone reaches a dev server — `navigator` has no
  // `serviceWorker` at all, and "this browser cannot do push" is the wrong
  // thing to tell someone using Chrome.
  if (!window.isSecureContext) {
    return settle({ ok: false, reason: 'insecure', detail: location.origin });
  }

  if (!supabase) return settle({ ok: false, reason: 'unconfigured', detail: 'no Supabase project' });
  if (!VAPID_KEY || !firebaseConfig.appId) {
    return settle({
      ok: false,
      reason: 'unconfigured',
      // Named individually: "some of them are missing" sends people to check
      // all five, and in dev the answer is usually that none arrived because
      // Vite read .env before they were in it.
      detail: `missing ${[
        !VAPID_KEY && 'VITE_FIREBASE_VAPID_KEY',
        !firebaseConfig.appId && 'VITE_FIREBASE_APP_ID',
        !firebaseConfig.apiKey && 'VITE_FIREBASE_API_KEY',
        !firebaseConfig.projectId && 'VITE_FIREBASE_PROJECT_ID',
        !firebaseConfig.messagingSenderId && 'VITE_FIREBASE_MESSAGING_SENDER_ID',
      ]
        .filter(Boolean)
        .join(', ')} — if they are in .env, restart the dev server (Vite reads it once, at startup)`,
    });
  }

  try {
    // Asking again once denied does nothing — the browser answers from the
    // stored decision without showing anything — so this is a real exit, not a
    // retry point. Re-allowing is done in site settings.
    if (Notification.permission === 'default' && !prompt) {
      return settle({ ok: false, reason: 'denied', detail: 'not asked yet on this device' });
    }
    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== 'granted') return settle({ ok: false, reason: 'denied' });

    const [{ initializeApp, getApps }, { getMessaging, getToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    // Signing out and back in would otherwise throw on a duplicate default app.
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

    /**
     * One attempt: settle the service worker, clear a subscription held under
     * the wrong key, ask for a token.
     *
     * Registered by hand rather than left to the SDK's default lookup, so the
     * scope is the site root and the registration has settled before getToken
     * asks for it.
     */
    const attempt = async () => {
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
        scope: '/',
      });
      // This registration, not whatever controls the page. See waitForActive.
      await waitForActive(registration);
      const dropped = await dropMismatchedSubscription(registration);
      if (dropped) console.warn('[push]', dropped);
      return getToken(getMessaging(app), {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration,
      });
    };

    let token: string;
    try {
      token = await attempt();
    } catch (first) {
      // A subscription held under an old key, or a service worker from a build
      // whose config was wrong, is not reachable from the fresh registration
      // above — so wipe the lot and try once more. Exactly once: a loop would
      // only hide a real failure behind a spinner.
      console.warn('[push] first attempt failed, resetting local push state —', first);
      await resetPushState();

      try {
        token = await attempt();
      } catch (second) {
        // Both attempts failed, so stop asserting why and go and find out.
        // `probeRawSubscribe` says which side of Firebase the failure is on,
        // and that answer goes in the message instead of a plausible story.
        const why = second instanceof Error ? second.message : String(second);
        let verdict = 'could not test further';
        try {
          const registration = await navigator.serviceWorker.register(
            '/firebase-messaging-sw.js',
            { scope: '/' },
          );
          await waitForActive(registration);
          verdict = await probeRawSubscribe(registration);
        } catch (probeErr) {
          verdict = `the service worker would not activate for a test either (${
            probeErr instanceof Error ? probeErr.message : String(probeErr)
          })`;
        }
        return settle({ ok: false, reason: 'failed', detail: `${why} — ${verdict}` });
      }
    }

    if (!token) return settle({ ok: false, reason: 'failed', detail: 'FCM returned no token' });

    // Both halves of delivery are now wired: the service worker draws messages
    // that arrive with the tab in the background, this draws the ones that
    // arrive while it is on screen.
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (registration) await showInForeground(getMessaging(app), registration);
    } catch (err) {
      // A notification that cannot be drawn in the foreground is not a failed
      // registration — background delivery is unaffected.
      console.warn('[push] foreground handler not attached —', err);
    }

    const { error } = await supabase
      .from('fcm_tokens')
      .upsert({ fcm_token: token, username, updated_at: new Date().toISOString() });
    if (error) return settle({ ok: false, reason: 'failed', detail: `fcm_tokens upsert: ${error.message}` });

    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Private mode. The row is written, which is the part that matters; only
      // the tidy sign-out below depends on this.
    }

    return settle({ ok: true, token });
  } catch (err) {
    // Service worker blocked by a policy, a browser extension eating the
    // request, an offline first run. None of it is worth failing sign-in over.
    return settle({
      ok: false,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Drop this device's row. The off switch.
 *
 * Must run **before** the session is cleared: the RLS policy on `fcm_tokens`
 * compares the row's username to the `x-owner` header, and that header is read
 * from the session on every request (see supabaseClient.ts). Clear the session
 * first and the delete matches nothing, silently.
 *
 * The row is deleted even when `deleteToken` fails. A token this browser can no
 * longer mint is one FCM will answer UNREGISTERED for anyway — but that only
 * gets noticed the next time something is sent to it, and leaving the row is
 * leaving a signed-out device on the recipient list until then.
 */
export async function forgetDevice(): Promise<void> {
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }

  if (!token || !supabase) return;

  try {
    const { getApps } = await import('firebase/app');
    if (getApps().length) {
      const { getMessaging, deleteToken } = await import('firebase/messaging');
      await deleteToken(getMessaging(getApps()[0]));
    }
  } catch {
    // Already revoked, or the service worker is gone. The row still goes.
  }

  await supabase.from('fcm_tokens').delete().eq('fcm_token', token);

  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
