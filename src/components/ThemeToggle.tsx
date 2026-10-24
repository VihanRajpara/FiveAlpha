import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { Icon, type IconName } from './Icon';

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

const ICON: Record<ThemeMode, IconName> = {
  light: 'sun',
  dark: 'moon',
  system: 'monitor',
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
      {/* Keyed so each mode mounts a fresh icon, which is what lets
          `@starting-style` turn it in — see `.theme-toggle svg`. */}
      <Icon key={mode} name={ICON[mode]} size={19} />
    </button>
  );
}
