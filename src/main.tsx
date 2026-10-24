import { lazy, StrictMode, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Login } from './components/Login';
import { NotFound } from './components/NotFound';
import { authEnabled, currentUser, logout, type User } from './lib/auth';
import './index.css';
// After index.css: the theme blocks override its defaults at equal specificity.
import './themes/themes.css';
import { installTheme } from './lib/theme';
import { installMotion } from './lib/motion';

/**
 * The app proper is its own chunk, so the sign-in form does not download the
 * screener, the table and the data layer to show two fields. When someone is
 * already signed in (or there is no gate) the app is the next thing on screen,
 * so the fetch starts here, alongside React's own start-up, not after it.
 */
const loadApp = () => import('./App');
const App = lazy(loadApp);
if (!authEnabled || currentUser()) void loadApp();

/** The page is one screen; anything but its root is a dead link. */
const KNOWN_PATHS = new Set(['/', '/index.html']);

/** What shows for the moment the app chunk is in flight: the ruled page and the
 *  mark, fading in only if the wait is long enough to notice. */
function Boot() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading FiveAlpha">
      <div className="brand-splash boot-mark" />
      <div className="boot-bar" />
    </div>
  );
}

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

  if (!KNOWN_PATHS.has(location.pathname)) return <NotFound path={location.pathname} />;
  if (authEnabled && !user) return <Login onSignedIn={setUser} />;

  return (
    <Suspense fallback={<Boot />}>
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
    </Suspense>
  );
}

installTheme();
installMotion();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
