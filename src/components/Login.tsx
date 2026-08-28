import { useState } from 'react';
import { login, type User } from '../lib/auth';

/**
 * The whole of the signed-out app: a username, four digits, and one button.
 *
 * Validation is the browser's — `required`, `pattern` and `minLength` say what
 * a valid entry is, and the form will not submit without one, which is a
 * message in the user's own language for free. The PIN is checked in the
 * database (see src/lib/auth.ts); nothing here can tell whether it is right.
 */
export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState('');
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
    <div className="app login-page">
      <form className="center-msg login" onSubmit={submit}>
        <div className="brand-splash" aria-hidden />
        <strong>Sign in</strong>
        <span>Your username and four-digit PIN.</span>

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
            autoFocus
          />
        </label>

        <label className="login-field">
          <span>PIN</span>
          <input
            value={pin}
            // Digits only, as they are typed: a numeric keypad is a hint on a
            // phone and nothing at all on a laptop.
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            pattern="\d{4}"
            minLength={4}
            maxLength={4}
            placeholder="••••"
            required
          />
        </label>

        <button className="btn login-submit" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        {error && (
          <span className="login-error" role="alert">
            {error}
          </span>
        )}
      </form>
    </div>
  );
}
