/* eslint-disable no-undef */
// The service worker Firebase Cloud Messaging needs in order to show a
// notification when no tab of this app is open.
//
// It lives in `public/` and is served from the site root, which is not a style
// choice: a service worker can only control pages at or below its own path, and
// FCM looks for `/firebase-messaging-sw.js` by default.
//
// There is no `onBackgroundMessage` handler here on purpose. notify-signals
// sends a message carrying a `notification` block, and the SDK displays those
// itself — a handler would only be needed for a data-only payload, and writing
// one that also calls `showNotification` is how an alert ends up displayed
// twice.
//
// **The config below is hardcoded and must stay in step with the
// `VITE_FIREBASE_*` values in `.env`.** A static file in `public/` is copied to
// the build verbatim, so Vite never substitutes anything into it. Nothing here
// is secret: every one of these values is already inlined into the browser
// bundle, which is what the VITE_ prefix means.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCJ91QTP1qHT8ZG-J0Gdr8TBbStYtjNPF4',
  authDomain: 'fivealpha-3fdd1.firebaseapp.com',
  projectId: 'fivealpha-3fdd1',
  storageBucket: 'fivealpha-3fdd1.firebasestorage.app',
  messagingSenderId: '668982034543',
  appId: '1:668982034543:web:cbe8ec463edecdbdd90d9a',
});

firebase.messaging();

// Clicking the notification should land in the app, and in the tab that is
// already open if there is one — opening a second copy of a single-page app
// loses whatever the first one had on screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const link = event.notification?.data?.FCM_MSG?.notification?.click_action
    || event.notification?.data?.click_action
    || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        // Same origin is the only test that matters — the app is one page, so
        // any open tab of it is the right tab.
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
