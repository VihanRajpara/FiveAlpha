import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { lastUsername, login, type User } from '../lib/auth';
// Not `activeSource` from dataSource: that would pull the whole data layer into
// the sign-in screen's bundle for one word. It is chosen on exactly this flag.
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { DUR, EASE_OUT, reducedMotion } from '../lib/motion';

/**
 * The whole of the signed-out app: a username, four digits, and one button.
 *
 * Validation is inline, under each field: the browser's own bubbles looked
 * different in every browser, vanished after a few seconds, and on iOS said
 * nothing at all. A field is judged once it has been left or the form has been
 * submitted — never while it is still being typed into. The rules are the same
 * ones the markup states (`required`, four digits); whether the PIN is *right*
 * is only known to the database (see src/lib/auth.ts).
 */
export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  // Whoever signed in last on this device, so the common case is four digits
  // and Enter. Read once: it must not change under the field as it is typed in.
  const [remembered] = useState(lastUsername);
  const [username, setUsername] = useState(remembered ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState({ username: false, pin: false });
  const [submitted, setSubmitted] = useState(false);
  const cardRef = useRef<HTMLFormElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  const userProblem = username.trim() === '' ? 'Enter the username you were given.' : null;
  const missing = 4 - pin.length;
  const pinProblem =
    missing === 4
      ? 'Enter your four-digit PIN.'
      : missing > 0
        ? `${missing} more digit${missing === 1 ? '' : 's'} — the PIN is four.`
        : null;
  const showUser = (left.username || submitted) && userProblem;
  const showPin = (left.pin || submitted) && pinProblem;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setSubmitted(true);
    if (userProblem || pinProblem) {
      (userProblem ? userRef : pinRef).current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    const result = await login(username.trim(), pin);

    if (typeof result === 'string') {
      setError(result);
      // The username stands, the PIN does not: retyping four digits is the
      // whole retry, and leaving a wrong one in the box invites a second
      // submit of the same thing.
      setPin('');
      setLeft((l) => ({ ...l, pin: false }));
      setSubmitted(false);
      setBusy(false);
      pinRef.current?.focus();
      // The shake that every lock screen uses for "no" — read before the
      // message is, and it replays on every wrong attempt, which a message that
      // reads the same twice does not. Travel, so not under reduced motion.
      if (!reducedMotion()) {
        cardRef.current?.animate(
          [0, -8, 7, -5, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
          { duration: DUR.slow, easing: EASE_OUT },
        );
      }
      return;
    }

    // No `setBusy(false)`: signing in unmounts this form.
    onSignedIn(result);
  }

  return (
    <div className="login-page">
      <form ref={cardRef} className="login-card" onSubmit={submit} noValidate>
        <div className="brand-splash login-mark" aria-hidden />

        <h1 className="login-title">{remembered ? 'Welcome back' : 'Sign in'}</h1>
        <p className="login-sub">
          {remembered ? 'Enter your PIN to continue.' : 'Your username and four-digit PIN.'}
        </p>

        <label className="login-field">
          <span>Username</span>
          <input
            ref={userRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => setLeft((l) => ({ ...l, username: true }))}
            aria-invalid={showUser ? true : undefined}
            aria-describedby={showUser ? 'login-user-error' : undefined}
            enterKeyHint="next"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            // The empty box gets the caret. With a name already in it the PIN
            // is the only thing left to type, so it gets it instead.
            autoFocus={!remembered}
          />
          {showUser && (
            <span className="login-field-error" id="login-user-error">
              {userProblem}
            </span>
          )}
        </label>

        <label className="login-field login-field-pin">
          <span>PIN</span>
          <input
            ref={pinRef}
            value={pin}
            onBlur={() => setLeft((l) => ({ ...l, pin: true }))}
            aria-invalid={showPin ? true : undefined}
            aria-describedby={showPin ? 'login-pin-error' : undefined}
            enterKeyHint="go"
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
          {showPin && (
            <span className="login-field-error" id="login-pin-error">
              {pinProblem}
            </span>
          )}
        </label>

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        {error && (
          <p className="login-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </p>
        )}

        {/* Same claim as the footer inside the app, and it has to stay in step:
            a sign-in screen promising a 15-minute delay over live Upstox prices
            is the kind of stale copy nobody re-reads. */}
        <p className="login-foot">
          NSE + BSE equities ·{' '}
          {isSupabaseConfigured ? 'live prices' : 'prices ~15 min delayed'}
        </p>
      </form>
    </div>
  );
}
