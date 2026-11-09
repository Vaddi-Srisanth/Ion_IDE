import type { CSSProperties } from 'react';
import type { Accent } from '../shared/contracts';
import type { ThemeAppearance, ThemeData } from '../shared/themes';

export const systemAppearance = '(prefers-color-scheme: dark)';

export function themeForPreference(selection: string, dark = () => window.matchMedia(systemAppearance).matches): string {
  return selection === 'system' ? (dark() ? 'dark' : 'light') : selection;
}

type AccentColors = { accent: string; 'accent-bg': string; 'accent-ink': string };
const legacyAccents: Record<ThemeAppearance, Record<Exclude<Accent, 'cyan'>, AccentColors>> = {
  dark: {
    violet: { accent: '#bba9ff', 'accent-bg': '#302944', 'accent-ink': '#201333' },
    lime: { accent: '#c2e98b', 'accent-bg': '#26382a', 'accent-ink': '#192611' },
    amber: { accent: '#f2c47c', 'accent-bg': '#382d24', 'accent-ink': '#2e1a08' },
  },
  light: {
    violet: { accent: '#604aa4', 'accent-bg': '#ece5fa', 'accent-ink': '#ffffff' },
    lime: { accent: '#3f651b', 'accent-bg': '#e6efd8', 'accent-ink': '#ffffff' },
    amber: { accent: '#875018', 'accent-bg': '#faecd8', 'accent-ink': '#ffffff' },
  },
};

export function appearanceFor(theme: ThemeData | null, accent: Accent) {
  const kind = theme?.appearance ?? 'dark';
  const classic = !theme || theme.id === 'dark' || theme.id === 'light';
  const override = classic && accent !== 'cyan' ? legacyAccents[kind][accent] : undefined;
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme?.colors ?? {})) {
    if (!key.startsWith('editor-')) style[`--${key}`] = value;
  }
  if (override) {
    for (const [key, value] of Object.entries(override)) style[`--${key}`] = value;
  }
  return { kind, style: style as CSSProperties, accentColor: override?.accent };
}
