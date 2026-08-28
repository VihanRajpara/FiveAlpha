/**
 * Who is signed in on this device, and nothing else — no network, no imports.
 *
 * Split out of `auth.ts` so that `supabaseClient` can read it. The owner sent
 * with every watchlist request is the signed-in username, and `auth.ts` imports
 * the client to run the sign-in itself; keeping the storage in a third module is
 * what stops those two importing each other.
 */

const KEY = 'fivealpha:user';

/**
 * The last username to sign in *successfully*, kept across sign-out so the form
 * comes back with the name already in it.
 *
 * A separate key from the session on purpose: signing out has to end the
 * session and must not forget who you are, and those are two different
 * lifetimes in one localStorage. Never the PIN — remembering that would be
 * remembering the whole credential.
 */
const LAST_KEY = 'fivealpha:last-username';

export interface User {
  username: string;
}

/** Whoever this browser is signed in as, or null. */
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

/** Who signed in here last, for the form to open on. */
export function lastUsername(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function saveSession(user: User): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
    localStorage.setItem(LAST_KEY, user.username);
  } catch {
    // No storage: signed in for this tab only, which still works.
  }
}

export function clearSession(): void {
  try {
    // `LAST_KEY` deliberately survives — see above.
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
