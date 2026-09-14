// Send one real notification, by hand — `npm run push:test`.
//
// The delivery half of this feature and the registration half fail for entirely
// unrelated reasons, and until now there was no way to exercise one without the
// other: the only thing that ever sent a push was the cron job, which only
// sends when a symbol actually flips, which happens on a trading day if you are
// lucky. So a whole evening could go by without ever learning whether the send
// path works at all.
//
// This is that path and nothing else: mint a Google access token from the
// service account, POST one message to FCM v1, print what came back per device.
// Same shape as supabase/functions/_shared/fcm.ts, so a success here means that
// file will work too — and a failure here is about the project or the token,
// never about the Edge Function.
//
//   npm run push:test                       → every token in public.fcm_tokens
//   npm run push:test -- <token> [<token>]  → those tokens, no database needed
//
// The service account is found in this order: FCM_SERVICE_ACCOUNT (the whole
// JSON, as the Edge Function has it), then FCM_SERVICE_ACCOUNT_FILE, then any
// *-firebase-adminsdk-*.json sitting in ~/Downloads, which is where the console
// puts it.
import { createSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function env() {
  try {
    return Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}

function serviceAccount() {
  if (process.env.FCM_SERVICE_ACCOUNT) return JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
  if (process.env.FCM_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
  }

  const downloads = join(homedir(), 'Downloads');
  const match = readdirSync(downloads).find(
    (f) => f.includes('firebase-adminsdk') && f.endsWith('.json'),
  );
  if (!match) {
    console.error(
      'No service account. Set FCM_SERVICE_ACCOUNT, or FCM_SERVICE_ACCOUNT_FILE, or leave the\n' +
        'downloaded *-firebase-adminsdk-*.json in ~/Downloads.',
    );
    process.exit(1);
  }
  console.log(`service account : ${match}`);
  return JSON.parse(readFileSync(join(downloads, match), 'utf8'));
}

/** Sign an RS256 JWT for the account and trade it for an access token. */
async function accessToken(sa) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: TOKEN_URL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      iat: now,
      exp: now + 3600,
    }),
  ].join('.');

  const signature = createSign('RSA-SHA256')
    .update(input)
    .sign(sa.private_key.replace(/\\n/g, '\n'), 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${signature}`,
    }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(`google token ${res.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

/** Every registered device, read with the secret key so RLS is not in the way. */
async function tokensFromDatabase(vars) {
  const url = vars.VITE_SUPABASE_URL;
  const key = vars.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error('VITE_SUPABASE_URL / SUPABASE_SECRET_KEY are not in .env — pass tokens as arguments instead.');
    process.exit(1);
  }

  const res = await fetch(`${url}/rest/v1/fcm_tokens?select=fcm_token,username`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`fcm_tokens read ${res.status}: ${await res.text()}`);
  return res.json();
}

const sa = serviceAccount();
const vars = env();

const fromArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const devices = fromArgs.length
  ? fromArgs.map((t) => ({ fcm_token: t, username: '(from the command line)' }))
  : await tokensFromDatabase(vars);

console.log(`project         : ${sa.project_id}`);
console.log(`devices         : ${devices.length}`);

if (devices.length === 0) {
  console.log(
    '\nNothing to send to — public.fcm_tokens is empty.\n' +
      'Sign in to the app first; the row is written at sign-in (src/lib/push.ts).\n' +
      'Or paste a token straight from the browser console:\n' +
      "  npm run push:test -- <token>",
  );
  process.exit(0);
}

const token = await accessToken(sa);
console.log('access token    : minted\n');

// Deliberately the same shape notify-signals sends — title, body, webpush
// block, optional link — so this rehearses the real thing rather than a
// simplified version of it that could succeed where the real one fails.
const message = {
  title: 'BUY · TESTSYMBOL',
  body: `₹1,234 · UT Bot flipped today · score 72 · test push ${new Date().toLocaleTimeString('en-IN')}`,
};
const link = process.env.APP_URL || vars.APP_URL;

let ok = 0;
for (const device of devices) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: device.fcm_token,
          notification: message,
          webpush: {
            notification: {
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              // Unique per run, unlike production where the tag is the title so
              // repeats collapse. Two test pushes an hour apart are two things
              // worth seeing; silently replacing the first looks like the
              // second never arrived.
              tag: `test-${Date.now()}`,
              requireInteraction: true,
            },
            ...(link ? { fcm_options: { link } } : {}),
          },
        },
      }),
    },
  );

  const text = await res.text();
  const short = `${device.fcm_token.slice(0, 16)}… (${device.username})`;

  if (res.ok) {
    ok++;
    console.log(`  ✓ ${short}`);
  } else {
    // The same classification _shared/fcm.ts makes, so what this prints is what
    // the Edge Function would have decided.
    const dead =
      res.status === 404 ||
      text.includes('UNREGISTERED') ||
      text.includes('registration token is not a valid');
    console.log(`  ✗ ${short}`);
    console.log(`     ${res.status} ${dead ? '[dead — the function would delete this row]' : '[failed — transient]'}`);
    console.log(`     ${text.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
}

console.log(`\n${ok}/${devices.length} delivered.`);
if (ok > 0) console.log('Check the device — the notification should be on screen.');
