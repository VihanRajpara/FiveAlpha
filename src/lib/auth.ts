import { supabase } from './supabaseClient';

/**
 * Sign-in against `app_users` — see supabase/migrations/0007_users.sql, which
 * is where the PIN is actually checked.
 *
 * Nothing here compares anything: the match happens in the `login` function in
 * the database, because a check that runs in the browser is a check the caller
 * can skip — and because the table it reads is invisible to this key. This file
 * is the session: who is signed in on this device, and how to stop being them.
 *
 * **The gate is the screen, not the data.** A signed-out visitor sees the sign
 * in form instead of the app, and that is all it does: the market tables are
 * public and the watchlists are still keyed on the browser's owner id. Someone
 * editing localStorage by hand is past it. That is the right size of lock for a
 * personal screener, and it is worth being plain about rather than implying
 * more.
 */

const KEY = 'fivealpha:user';

export interface User {
  username: string;
}

/**
 * Without a Supabase project there is nothing to sign in against — the app runs
 * off the direct NSE/BSE source and the gate would lock everyone out of it.
 */
export const authEnabled = supabase !== null;

/** Whoever this browser last signed in as, or null. */
export function currentUser(): User | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<User>;
    return parsed?.username ? { username: parsed.username } : null;
  } catch {
    // Unparseable, or no storage at all (private mode): not signed in.
    return null;
  }
}

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
  // rather than from the box, so the header shows the account's own casing.
  const matched = data as string | null;
  if (!matched) return 'Wrong username or PIN.';

  const user = { username: matched };
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // No storage: signed in for this tab only, which still works.
  }
  return user;
}

export function logout(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
