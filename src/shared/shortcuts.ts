const commands = {
  'command-palette': { label: 'Command Palette', key: 'Mod+Shift+P' },
  'quick-open': { label: 'Quick Open File', key: 'Mod+P' },
  'workspace-search': { label: 'Search in Files', key: 'Mod+Shift+F' },
  'new-file': { label: 'New File', key: 'Mod+N' },
  'new-starter': { label: 'New File from Starter…' },
  'insert-starter': { label: 'Insert Starter Code' },
  'open-file': { label: 'Open File…', key: 'Mod+O' },
  'open-folder': { label: 'Open Folder…', key: 'Mod+Shift+O' },
  save: { label: 'Save', key: 'Mod+S' },
  'save-as': { label: 'Save As…', key: 'Mod+Shift+S' },
  'close-tab': { label: 'Close Tab', key: 'Mod+W' },
  'next-tab': { label: 'Next Tab', key: 'Mod+Shift+]' },
  'previous-tab': { label: 'Previous Tab', key: 'Mod+Shift+[' },
  find: { label: 'Find', key: 'Mod+F' },
  replace: { label: 'Replace', key: 'Mod+Alt+F', other: 'Mod+H' },
  'go-to-line': { label: 'Go to Line…', key: 'Ctrl+G', other: 'Mod+G' },
  'focus-editor': { label: 'Focus Code Editor', key: 'Mod+1' },
  'markdown-preview': { label: 'Toggle Markdown Preview', key: 'Mod+Shift+M' },
  'markdown-split': { label: 'Toggle Markdown Split View', key: 'Mod+Alt+Shift+M' },
  'toggle-document-split': { label: 'Toggle Document Split' },
  'focus-document-split': { label: 'Focus Document Split Divider' },
  welcome: { label: 'Welcome', key: 'Mod+Shift+1' },
  'toggle-explorer': { label: 'Toggle Explorer', key: 'Mod+B' },
  'toggle-marketplace': { label: 'Toggle Learning Marketplace' },
  'toggle-output': { label: 'Toggle Run Console', key: 'Mod+J' },
  'toggle-auxiliary': { label: 'Toggle Workspace Panel' },
  run: { label: 'Run Active File', key: 'F5' },
  stop: { label: 'Stop', key: 'Shift+F5' },
  'preview-web': { label: 'Preview Web Project', key: 'Mod+Alt+P' },
  settings: { label: 'Preferences…', key: 'Mod+,' },
} satisfies Record<string, { label: string; key?: string; other?: string }>

export type MenuCommand = keyof typeof commands
export type ShortcutOverrides = Partial<Record<MenuCommand, string>>
export type ShortcutPlatform = 'darwin' | 'win32' | 'linux'
export const shortcutPlatform = (value: string): ShortcutPlatform =>
  value === 'darwin' || value === 'win32' ? value : 'linux'
export const commandEntries = Object.entries(commands) as [MenuCommand, { label: string; key?: string; other?: string }][]
const definitions: Record<MenuCommand, { label: string; key?: string; other?: string }> = commands

export function commandLabel(command: MenuCommand): string {
  return definitions[command].label
}

const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
const keyPattern = /^(?:[A-Z0-9.,/\[\]-]|F[1-9]|F1[0-2]|ENTER)$/
const roleKeys = new Set(['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z'])
const macRoleKeys = new Set(['Mod+Q', 'Mod+H', 'Mod+Alt+H', 'Mod+M', 'Mod+Ctrl+F', 'Ctrl+Mod+F'])

export function normalizeShortcut(value: string, platform: ShortcutPlatform): string | null {
  if (value.length > 64) return null
  if (!value.trim()) return ''
  const parts = value.split('+').map((part) => part.trim().toUpperCase())
  const key = parts.pop()
  if (!key || !keyPattern.test(key)) return null
  const seen = new Set<string>()
  for (const part of parts) {
    const modifier = part === 'MOD' || part === 'CMD' || part === 'COMMAND' || (part === 'CTRL' && platform !== 'darwin') ? 'Mod'
      : part === 'CTRL' ? 'Ctrl' : part === 'ALT' || part === 'OPTION' ? 'Alt' : part === 'SHIFT' ? 'Shift' : null
    if (!modifier || seen.has(modifier)) return null
    seen.add(modifier)
  }
  if (!key.startsWith('F') || key === 'F') {
    if (!seen.has('Mod') && !seen.has('Ctrl')) return null
  }
  return [...modifiers.filter((modifier) => seen.has(modifier)), key === 'ENTER' ? 'Enter' : key].join('+')
}

export function effectiveShortcut(command: MenuCommand, overrides: ShortcutOverrides, platform: ShortcutPlatform): string {
  const entry = definitions[command]
  if (overrides[command] !== undefined) return overrides[command]
  const fallback = platform !== 'darwin' && entry.other ? entry.other : entry.key ?? ''
  if ((command === 'markdown-preview' || command === 'markdown-split' || command === 'workspace-search')
    && Object.values(overrides).includes(fallback)) return ''
  return fallback
}

export function resolveShortcuts(overrides: ShortcutOverrides, platform: ShortcutPlatform): Map<string, MenuCommand> {
  const bindings = new Map<string, MenuCommand>()
  for (const [id] of commandEntries) {
    const key = effectiveShortcut(id, overrides, platform)
    if (key) bindings.set(key, id)
  }
  if (overrides.run === undefined) bindings.set('Mod+Enter', 'run')
  return bindings
}

export function shortcutIssue(overrides: ShortcutOverrides, platform: ShortcutPlatform): string | null {
  const seen = new Map<string, MenuCommand>()
  if (overrides.run === undefined) seen.set('Mod+Enter', 'run')
  for (const [id] of commandEntries) {
    const binding = effectiveShortcut(id, overrides, platform)
    if (!binding) continue
    if (roleKeys.has(binding) || platform === 'darwin' && macRoleKeys.has(binding) || binding === 'Alt+F4') {
      return binding + ' is reserved by the application or system.'
    }
    const conflicting = seen.get(binding)
    if (conflicting && conflicting !== id) return binding + ' is already assigned to ' + commandLabel(conflicting) + '.'
    seen.set(binding, id)
  }
  return null
}

export function parseShortcutOverrides(value: unknown, platform: ShortcutPlatform): ShortcutOverrides | null {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return null
  const result: ShortcutOverrides = {}
  for (const [id, binding] of Object.entries(value)) {
    if (!Object.hasOwn(commands, id) || typeof binding !== 'string') return null
    const key = normalizeShortcut(binding, platform)
    if (key === null) return null
    result[id as MenuCommand] = key
  }
  return shortcutIssue(result, platform) ? null : result
}

export function displayShortcut(command: MenuCommand, overrides: ShortcutOverrides, platform: ShortcutPlatform): string {
  const binding = effectiveShortcut(command, overrides, platform)
  if (!binding) return ''
  if (platform !== 'darwin') return binding.replace('Mod', 'Ctrl')
  return binding.split('+').map((part) => ({
    Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Enter: '↩',
  })[part] ?? part).join('')
}

export function menuAccelerator(binding: string): string | undefined {
  return binding ? binding.replace(/\bMod\b/g, 'CmdOrCtrl') : undefined
}

interface ShortcutInput {
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

const punctuation: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Minus: '-' }

export function inputShortcut(input: ShortcutInput, platform: ShortcutPlatform): string {
  if (platform !== 'darwin' && input.meta) return ''
  if (!input.meta && !input.control && !input.alt && !/^F\d/.test(input.key)) return ''
  const key = input.key.toUpperCase()
  const physical = /^(?:Key|Digit)([A-Z0-9])$/.exec(input.code)?.[1] ?? punctuation[input.code]
  const logical = keyPattern.test(key) ? key : physical
  if (!logical) return ''
  const mod = platform === 'darwin' ? input.meta : input.control
  const ctrl = platform === 'darwin' && input.control
  return [mod && 'Mod', ctrl && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', logical === 'ENTER' ? 'Enter' : logical]
    .filter(Boolean).join('+')
}
