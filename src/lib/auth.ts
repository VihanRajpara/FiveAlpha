import { supabase } from './supabaseClient';
import { saveSession, clearSession, type User } from './session';
import { forgetDevice, registerDevice } from './push';

/**
 * Sign-in against `app_users` — see supabase/migrations/0007_users.sql, which
 * is where the PIN is actually checked.
 *
 * Nothing here compares anything: the match happens in the `login` function in
 * the database, because a check that runs in the browser is a check the caller
 * can skip — and because the table it reads is invisible to this key. The
 * session itself lives in `session.ts`.
 *
 * **The gate is the screen, not the data.** A signed-out visitor sees the sign
 * in form instead of the app. Watchlists are keyed on the username from here
 * (`supabaseClient.owner`), so they now follow the person rather than the
 * browser — but the key that reads them still ships in the bundle, so someone
 * editing localStorage by hand can name any owner they like. That is the right
 * size of lock for a personal screener, and it is worth being plain about
 * rather than implying more.
 */

export type { User } from './session';
export { currentUser, lastUsername } from './session';

/**
 * Without a Supabase project there is nothing to sign in against — the app runs
 * off the direct NSE/BSE source and the gate would lock everyone out of it.
 */
export const authEnabled = supabase !== null;

/**
 * The signed-in user, or the message to show under the form.
 *
 * A wrong username and a wrong PIN both come back as null from the database and
 * get the same sentence here — telling them apart is telling an attacker which
 * usernames are real.
 */
export async function login(username: string, pin: string): Promise<User | string> {
  if (!supabase) return 'Sign-in needs a Supabase project — set VITE_SUPABASE_URL in .env.';

  const { data, error } = await supabase.rpc('login', {
    p_username: username,
    p_pin: pin,
  });

  if (error) {
    // Not a wrong PIN — that is a null result, not an error. This is the
    // network, or a project without the migration.
    console.warn('sign-in failed', error);
    return 'Could not reach the sign-in service. Check the connection, and that 0007_users.sql has been run.';
  }

  // The stored spelling of the username, or null. Taken from the database
  // rather than from the box, so the header shows the account's own casing —
  // and so the watchlist owner matches the rows already saved under it.
  const matched = data as string | null;
  if (!matched) return 'Wrong username or PIN.';

  const user = { username: matched };
  saveSession(user);

  // Record this device for push alerts, now that there is an account to file it
  // under. Deliberately **not** awaited: the permission prompt is answered by a
  // human, and a sign-in that waits on one is a sign-in that looks hung. It also
  // cannot reject — `registerDevice` reports every failure as a value — so a
  // browser with no push support, or a refused prompt, signs in normally.
  //
  // It has to come after `saveSession`, not before: the upsert is an ordinary
  // browser write and RLS reads the owner from the `x-owner` header, which
  // `supabaseClient` fills from the session that was just stored.
  void registerDevice(user.username);

  return user;
}

/**
 * Async now, because forgetting the device is a network write and it has to
 * happen while the session still exists — the `fcm_tokens` delete is authorised
 * by the `x-owner` header, which is read from the session on every request.
 * Clearing first would leave the row behind and keep pushing to a signed-out
 * browser.
 */
export async function logout(): Promise<void> {
  await forgetDevice();
  clearSession();
}
