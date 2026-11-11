export type ThemeAppearance = 'dark' | 'light'

export const themeColorKeys = [
  'background', 'surface', 'surface-2', 'surface-3', 'panel', 'border', 'subtle-border',
  'ink', 'text', 'muted', 'dim', 'accent', 'accent-ink', 'accent-bg',
  'mint', 'lilac', 'amber', 'danger', 'warning-bg',
  'editor-foreground', 'editor-line-number', 'editor-active-line-number', 'editor-selection',
  'editor-line-highlight', 'editor-indent', 'editor-active-indent',
] as const

export const themeSyntaxKeys = [
  'comment', 'keyword', 'string', 'number', 'type', 'operator', 'delimiter', 'identifier', 'tag', 'attribute',
] as const

export type ThemeColorKey = typeof themeColorKeys[number]
export type ThemeSyntaxKey = typeof themeSyntaxKeys[number]

export interface ThemeSummary {
  id: string
  name: string
  appearance: ThemeAppearance
  source: 'builtin' | 'custom'
  contrast?: 'high'
  swatches?: readonly [string, string, string]
}

export interface ThemeDefinition {
  version: 1
  name: string
  appearance: ThemeAppearance
  colors: Record<ThemeColorKey, string>
  syntax: Record<ThemeSyntaxKey, string>
}

export type ThemeData = ThemeSummary & ThemeDefinition

export const builtinThemes: readonly ThemeSummary[] = [
  { id: 'dark', name: 'Ion Dark', appearance: 'dark', source: 'builtin', swatches: ['#10131a', '#7be7db', '#c2a5ff'] },
  { id: 'light', name: 'Ion Light', appearance: 'light', source: 'builtin', swatches: ['#ffffff', '#005e58', '#6044a7'] },
  { id: 'midnight', name: 'Ion Midnight', appearance: 'dark', source: 'builtin', swatches: ['#151021', '#cfb1ff', '#cfb1ff'] },
  { id: 'graphite', name: 'Ion Graphite', appearance: 'dark', source: 'builtin', swatches: ['#1a1817', '#ffc082', '#eab4d7'] },
  { id: 'obsidian', name: 'Ion Obsidian', appearance: 'dark', source: 'builtin', swatches: ['#101012', '#a9b9ff', '#b5acff'] },
  { id: 'ocean', name: 'Ion Ocean', appearance: 'dark', source: 'builtin', swatches: ['#071c29', '#72def2', '#98c8ff'] },
  { id: 'forest', name: 'Ion Forest', appearance: 'dark', source: 'builtin', swatches: ['#111f16', '#a6dc83', '#c2d994'] },
  { id: 'orchid', name: 'Ion Orchid', appearance: 'dark', source: 'builtin', swatches: ['#211527', '#eea8e2', '#deaafe'] },
  { id: 'ember', name: 'Ion Ember', appearance: 'dark', source: 'builtin', swatches: ['#231815', '#f5ab86', '#edb295'] },
  { id: 'aurora', name: 'Ion Aurora', appearance: 'dark', source: 'builtin', swatches: ['#111b27', '#84efd0', '#c5acff'] },
  { id: 'paper', name: 'Ion Paper', appearance: 'light', source: 'builtin', swatches: ['#fcf9f1', '#23477b', '#633f7c'] },
  { id: 'snow', name: 'Ion Snow', appearance: 'light', source: 'builtin', swatches: ['#fbfcff', '#2d508a', '#653d90'] },
  { id: 'sandstone', name: 'Ion Sandstone', appearance: 'light', source: 'builtin', swatches: ['#faf3e7', '#744223', '#653b7e'] },
  { id: 'daylight', name: 'Ion Daylight', appearance: 'light', source: 'builtin', swatches: ['#f6fbfc', '#20596a', '#553790'] },
  { id: 'contrast-dark', name: 'Ion High Contrast Dark', appearance: 'dark', source: 'builtin', contrast: 'high', swatches: ['#06070a', '#8ff8ff', '#e1c6ff'] },
  { id: 'contrast-light', name: 'Ion High Contrast Light', appearance: 'light', source: 'builtin', contrast: 'high', swatches: ['#ffffff', '#103358', '#462166'] },
]

export function isCustomThemeId(value: unknown): value is string {
  return typeof value === 'string' && /^custom-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
}

export function isThemeId(value: unknown): value is string {
  return isCustomThemeId(value) || builtinThemes.some((theme) => theme.id === value)
}

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === 'dark' || value === 'light'
}

export function isThemeName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && value === value.trim()
    && !/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function recordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function readColors<Key extends string>(value: unknown, keys: readonly Key[], label: string): Record<Key, string> {
  if (!recordWithKeys(value, keys)) throw new Error(`Theme ${label} must contain every supported key and no extra keys.`)
  return Object.fromEntries(keys.map((key) => {
    const color = value[key]
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error(`Theme ${label} ${key} must be a six-digit hex color such as #7be7db.`)
    }
    return [key, color.toLowerCase()]
  })) as Record<Key, string>
}

function channels(color: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255) as [number, number, number]
}

// WCAG relative luminance for sRGB.
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function mixedLuminance(first: string, second: string, firstShare: number): number {
  const [r, g, b] = channels(first)
  const [r2, g2, b2] = channels(second)
  const secondShare = 1 - firstShare
  return luminance([r * firstShare + r2 * secondShare, g * firstShare + g2 * secondShare, b * firstShare + b2 * secondShare])
}

function requireContrast(foreground: number, background: number, label: string): void {
  const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  if (ratio < 4.5) throw new Error(`Theme contrast for ${label} must be at least 4.5:1 (currently ${ratio.toFixed(2)}:1).`)
}

function validateContrast(colors: ThemeDefinition['colors'], syntax: ThemeDefinition['syntax']): void {
  const levels = Object.fromEntries(themeColorKeys.map((key) => [key, luminance(channels(colors[key]))])) as Record<ThemeColorKey, number>
  const text = ['ink', 'text', 'muted', 'dim', 'accent', 'mint', 'lilac', 'amber', 'danger'] as const
  for (const surface of ['background', 'surface', 'surface-2', 'surface-3', 'panel'] as const) {
    for (const color of text) requireContrast(levels[color], levels[surface], `${color} on ${surface}`)
  }
  for (const color of ['accent', 'ink', 'text', 'muted'] as const) {
    requireContrast(levels[color], levels['accent-bg'], `${color} on accent-bg`)
  }
  for (const color of ['amber', 'danger'] as const) {
    requireContrast(levels[color], levels['warning-bg'], `${color} on warning-bg`)
  }
  requireContrast(levels['accent-ink'], levels.accent, 'accent-ink on accent')
  requireContrast(levels['accent-ink'], mixedLuminance(colors.accent, colors['surface-3'], 0.83), 'accent-ink on the hovered primary button')
  requireContrast(levels.accent, mixedLuminance(colors['accent-bg'], colors.accent, 0.86), 'accent on the hovered Run button')

  const tokenLevels = themeSyntaxKeys.map((key) => [key, luminance(channels(syntax[key]))] as const)
  for (const surface of ['background', 'editor-line-highlight', 'editor-selection'] as const) {
    requireContrast(levels['editor-foreground'], levels[surface], `editor-foreground on ${surface}`)
    requireContrast(levels.accent, levels[surface], `editor cursor on ${surface}`)
    for (const [key, level] of tokenLevels) requireContrast(level, levels[surface], `syntax ${key} on ${surface}`)
  }
  for (const key of ['editor-line-number', 'editor-active-line-number'] as const) {
    requireContrast(levels[key], levels.background, `${key} on background`)
    requireContrast(levels[key], levels['editor-line-highlight'], `${key} on editor-line-highlight`)
  }
}

export function validateTheme(value: unknown): ThemeDefinition {
  if (!recordWithKeys(value, ['version', 'name', 'appearance', 'colors', 'syntax']) || value.version !== 1) {
    throw new Error('Use an Ion theme JSON file with version 1, name, appearance, colors, and syntax.')
  }
  if (!isThemeName(value.name)) throw new Error('Theme name must be between 1 and 64 characters with no surrounding whitespace or control characters.')
  if (!isThemeAppearance(value.appearance)) throw new Error('Theme appearance must be dark or light.')
  const colors = readColors(value.colors, themeColorKeys, 'colors')
  const syntax = readColors(value.syntax, themeSyntaxKeys, 'syntax')
  validateContrast(colors, syntax)
  return { version: 1, name: value.name, appearance: value.appearance, colors, syntax }
}
