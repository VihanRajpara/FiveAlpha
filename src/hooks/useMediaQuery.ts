import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query from React.
 *
 * The initial state is read synchronously rather than defaulting to `false`,
 * so the first paint already matches the viewport — a table that renders its
 * desktop layout and then snaps to mobile one frame later looks broken.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Re-read on subscribe: the viewport can change between the initial render
    // and this effect running.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
