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

export type PushResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unconfigured' | 'failed'; detail?: string };

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
 * Record the device under the signed-in username.
 *
 * Called after a successful sign-in and deliberately not awaited by it: the
 * permission prompt is answered by a human, and a form that sits disabled until
 * they do is a form that looks broken.
 *
 * Upsert rather than insert — the same browser signing in again returns the
 * same token, and `updated_at` is what the 90-day stale sweep reads, so an
 * unchanged token still needs the write.
 */
export async function registerDevice(username: string): Promise<PushResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  if (!supabase) return { ok: false, reason: 'unconfigured', detail: 'no Supabase project' };
  if (!VAPID_KEY || !firebaseConfig.appId) {
    return { ok: false, reason: 'unconfigured', detail: 'VITE_FIREBASE_* are not set' };
  }

  try {
    // Asking again once denied does nothing — the browser answers from the
    // stored decision without showing anything — so this is a real exit, not a
    // retry point. Re-allowing is done in site settings.
    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    // Registered by hand rather than left to the SDK's default lookup, so that
    // the scope is the site root and the registration is settled before
    // getToken asks for it.
    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
    });
    await navigator.serviceWorker.ready;

    const [{ initializeApp, getApps }, { getMessaging, getToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    // Signing out and back in would otherwise throw on a duplicate default app.
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

    const token = await getToken(getMessaging(app), {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return { ok: false, reason: 'failed', detail: 'FCM returned no token' };

    const { error } = await supabase
      .from('fcm_tokens')
      .upsert({ fcm_token: token, username, updated_at: new Date().toISOString() });
    if (error) return { ok: false, reason: 'failed', detail: error.message };

    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Private mode. The row is written, which is the part that matters; only
      // the tidy sign-out below depends on this.
    }

    return { ok: true, token };
  } catch (err) {
    // Service worker blocked by a policy, a browser extension eating the
    // request, an offline first run. None of it is worth failing sign-in over.
    return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
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
