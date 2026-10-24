import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Whether the browser believes it has a network. `false` is reliable (the radio
 * is off, the cable is out); `true` only means "not known to be offline", which
 * is why this drives a notice and never gates a request.
 */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
