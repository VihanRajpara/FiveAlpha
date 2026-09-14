// Sending one Firebase Cloud Messaging notification, and knowing when a device
// is gone.
//
// FCM v1 is the only door: the legacy `key=AAAA…` server-key endpoint was
// switched off in 2024, and v1 authenticates with a Google OAuth access token
// minted from a service account. That is three steps — build a JWT, sign it
// RS256 with the account's private key, trade it at Google's token endpoint —
// and `jose` does the middle one. Same `esm.sh` pattern the rest of this folder
// already uses for supabase-js.
//
// Configuration is one secret, `FCM_SERVICE_ACCOUNT`, holding the whole
// service-account JSON. `project_id` is read out of it rather than stored a
// second time, because two places to look is how a stale value survives a
// rotation.
import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.9.6';
import { fetchWithTimeout } from './edge.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * A minted access token and the project it is good for.
 *
 * Made once per invocation and passed to every `sendPush`: the token is valid
 * for an hour and a function run is seconds, so signing a fresh JWT per
 * notification would be an RSA operation and a round trip per device for
 * nothing.
 */
export interface FcmSession {
  projectId: string;
  accessToken: string;
}

function serviceAccount(): ServiceAccount {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT');
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT is not set on this function');

  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The usual cause is shell quoting eating the newlines in private_key, and
    // the error a parse failure produces on its own says nothing about that.
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON — set it to the whole downloaded file');
  }

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT is missing project_id / client_email / private_key');
  }
  return parsed as ServiceAccount;
}

/** Signs a JWT for the service account and trades it for an access token. */
export async function fcmSession(): Promise<FcmSession> {
  const account = serviceAccount();

  // `supabase secrets set` round-trips the JSON, but a value pasted into the
  // dashboard can arrive with the newlines escaped. importPKCS8 rejects that
  // with a message about the PEM header rather than about the newlines.
  const pem = account.private_key.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`google token ${res.status}: ${body.slice(0, 200)}`);

  const token = (JSON.parse(body) as { access_token?: string }).access_token;
  if (!token) throw new Error('google returned no access_token');

  return { projectId: account.project_id, accessToken: token };
}

export interface PushMessage {
  title: string;
  body: string;
  /**
   * Absolute https URL to open on click. Omitted when `APP_URL` is not
   * configured — FCM rejects a relative one, and a notification that shows but
   * does not navigate is better than no notification.
   */
  link?: string;
}

/**
 * One notification to one device.
 *
 * `'dead'` means the token will never work again and its row should go: a 404,
 * an `UNREGISTERED` (uninstalled, or site data cleared), or the specific
 * complaint that the registration token is malformed.
 *
 * **Not any `INVALID_ARGUMENT`.** That was the first version of this check and
 * it is a trap: FCM answers 400 INVALID_ARGUMENT for a bad *message* too, so a
 * typo in the payload this file builds would delete every token it was sent to
 * — one deploy silently unsubscribing every device, with the rows gone and no
 * way to tell what happened. Verified against the live endpoint: a malformed
 * token comes back as `"The registration token is not a valid FCM registration
 * token"`, which is what is matched instead.
 *
 * Everything else is `'failed'`: a 429 or a 5xx is about this request, not
 * about this device, and deleting a token over one is how a working phone stops
 * receiving alerts forever.
 *
 * This is one HTTP request per device on purpose — the batch endpoint
 * (`/batch`) was deprecated alongside the legacy API, so there is no cheaper
 * shape on offer.
 */
export async function sendPush(
  session: FcmSession,
  token: string,
  message: PushMessage,
): Promise<'ok' | 'dead' | 'failed'> {
  const res = await fetchWithTimeout(
    `https://fcm.googleapis.com/v1/projects/${session.projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          // A `notification` block rather than a data-only message: with one,
          // the service worker's SDK displays it without any handler of ours
          // running, which is what makes the alert arrive when the tab is shut.
          notification: { title: message.title, body: message.body },
          webpush: {
            notification: {
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              // Collapse repeats for the same symbol rather than stacking them.
              tag: message.title,
            },
            ...(message.link ? { fcm_options: { link: message.link } } : {}),
          },
        },
      }),
    },
  );

  if (res.ok) {
    // The body is `{ name: "projects/…/messages/…" }` and carries nothing
    // actionable, but it must be read or the connection is left open.
    await res.text();
    return 'ok';
  }

  const text = await res.text();
  if (
    res.status === 404 ||
    text.includes('UNREGISTERED') ||
    text.includes('registration token is not a valid')
  ) {
    return 'dead';
  }

  console.warn(`fcm ${res.status}: ${text.slice(0, 200)}`);
  return 'failed';
}
