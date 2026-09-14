import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Login } from './components/Login';
import { authEnabled, currentUser, logout, type User } from './lib/auth';
import './index.css';

/**
 * The gate, above `App` rather than inside it: signed out, the market data is
 * not fetched at all, and the form is the only thing mounted.
 *
 * With no Supabase project there is nothing to sign in against — see
 * `authEnabled` — and the app opens straight into the screener the way it did
 * before any of this existed.
 */
function Root() {
  const [user, setUser] = useState<User | null>(currentUser);

  if (authEnabled && !user) return <Login onSignedIn={setUser} />;

  return (
    <App
      user={user}
      onSignOut={async () => {
        // Awaited: `logout` deletes this device's push token, and that is a
        // network write authorised by the session it is about to clear. A
        // reload fired alongside it would cancel the request in flight and
        // leave a signed-out browser on the alert list.
        await logout();
        // A reload rather than `setUser(null)`: the watchlist store is module
        // state holding the signed-out account's lists, and handing those to
        // whoever signs in next is the one thing this must not do. Nothing is
        // lost by it — the form is the next thing on screen either way.
        location.reload();
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
