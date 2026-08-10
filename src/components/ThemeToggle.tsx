import { useTheme, type ThemeMode } from '../hooks/useTheme';

/** system → light → dark → system. One button, all three states reachable. */
const NEXT: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABEL: Record<ThemeMode, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

const ICON: Record<ThemeMode, JSX.Element> = {
  light: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </>
  ),
  dark: <path d="M20 13.5A8.2 8.2 0 1 1 10.5 4a6.6 6.6 0 0 0 9.5 9.5Z" />,
  system: (
    <>
      <rect x="2.8" y="4.2" width="18.4" height="12.6" rx="1.8" />
      <path d="M8.5 20.5h7" />
    </>
  ),
};

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const next = NEXT[mode];

  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={() => setMode(next)}
      title={`${LABEL[mode]} — switch to ${LABEL[next].toLowerCase()}`}
      aria-label={`${LABEL[mode]}. Switch to ${LABEL[next].toLowerCase()}`}
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {ICON[mode]}
      </svg>
    </button>
  );
}
