import { useState } from 'react';
import { lastUsername, login, type User } from '../lib/auth';
import { activeSource } from '../lib/dataSource';

/**
 * The whole of the signed-out app: a username, four digits, and one button.
 *
 * Validation is the browser's — `required`, `pattern` and `minLength` say what
 * a valid entry is and the form will not submit without one, which is a message
 * in the user's own language for free. The PIN is checked in the database (see
 * src/lib/auth.ts); nothing here can tell whether it is right.
 */
export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  // Whoever signed in last on this device, so the common case is four digits
  // and Enter. Read once: it must not change under the field as it is typed in.
  const [remembered] = useState(lastUsername);
  const [username, setUsername] = useState(remembered ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    const result = await login(username.trim(), pin);

    if (typeof result === 'string') {
      setError(result);
      // The username stands, the PIN does not: retyping four digits is the
      // whole retry, and leaving a wrong one in the box invites a second
      // submit of the same thing.
      setPin('');
      setBusy(false);
      return;
    }

    // No `setBusy(false)`: signing in unmounts this form.
    onSignedIn(result);
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-splash login-mark" aria-hidden />

        <h1 className="login-title">{remembered ? 'Welcome back' : 'Sign in'}</h1>
        <p className="login-sub">
          {remembered ? 'Enter your PIN to continue.' : 'Your username and four-digit PIN.'}
        </p>

        <label className="login-field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            // The empty box gets the caret. With a name already in it the PIN
            // is the only thing left to type, so it gets it instead.
            autoFocus={!remembered}
          />
        </label>

        <label className="login-field login-field-pin">
          <span>PIN</span>
          <input
            value={pin}
            // Digits only, as they are typed: `inputMode` raises a keypad on a
            // phone and does nothing at all on a laptop.
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            pattern="\d{4}"
            minLength={4}
            maxLength={4}
            placeholder="••••"
            required
            autoFocus={Boolean(remembered)}
          />
        </label>

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        {/* Same claim as the footer inside the app, and it has to stay in step:
            a sign-in screen promising a 15-minute delay over live Upstox prices
            is the kind of stale copy nobody re-reads. */}
        <p className="login-foot">
          NSE + BSE equities ·{' '}
          {activeSource.kind === 'supabase' ? 'live prices' : 'prices ~15 min delayed'}
        </p>
      </form>
    </div>
  );
}
