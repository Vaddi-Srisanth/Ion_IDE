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
  'save-all': { label: 'Save All' },
  'save-as': { label: 'Save As…', key: 'Mod+Shift+S' },
  'close-tab': { label: 'Close Tab', key: 'Mod+W' },
  'close-other-tabs': { label: 'Close Other Tabs' },
  'close-tabs-to-right': { label: 'Close Tabs to the Right' },
  'close-saved-tabs': { label: 'Close Saved Tabs' },
  'close-all-tabs': { label: 'Close All Tabs' },
  'reopen-closed-tab': { label: 'Reopen Closed Tab', key: 'Mod+Shift+T' },
  'next-tab': { label: 'Next Tab', key: 'Mod+Shift+]' },
  'previous-tab': { label: 'Previous Tab', key: 'Mod+Shift+[' },
  'cycle-next-tab': { label: 'Cycle Open Editors', key: 'Ctrl+TAB', other: 'Mod+TAB' },
  'cycle-previous-tab': { label: 'Cycle Open Editors Backward', key: 'Ctrl+Shift+TAB', other: 'Mod+Shift+TAB' },
  'move-tab-left': { label: 'Move Tab Left', key: 'Mod+Alt+Shift+ARROWLEFT' },
  'move-tab-right': { label: 'Move Tab Right', key: 'Mod+Alt+Shift+ARROWRIGHT' },
  find: { label: 'Find', key: 'Mod+F' },
  replace: { label: 'Replace', key: 'Mod+Alt+F', other: 'Mod+H' },
  'add-cursor-above': { label: 'Add Cursor Above', key: 'Mod+Alt+ARROWUP' },
  'add-cursor-below': { label: 'Add Cursor Below', key: 'Mod+Alt+ARROWDOWN' },
  'select-next-occurrence': { label: 'Select Next Occurrence', key: 'Mod+D' },
  'select-all-occurrences': { label: 'Select All Occurrences', key: 'Mod+Shift+L' },
  'format-document': { label: 'Format Document', key: 'Alt+Shift+F' },
  'go-to-definition': { label: 'Go to Definition' },
  'find-references': { label: 'Find References', key: 'Shift+F12' },
  'rename-symbol': { label: 'Rename Symbol…', key: 'F2' },
  'navigate-back': { label: 'Go Back', key: 'Mod+Alt+[' },
  'navigate-forward': { label: 'Go Forward', key: 'Mod+Alt+]' },
  'language-support': { label: 'Language Support…' },
  'choose-theme': { label: 'Color Theme…' },
  'go-to-line': { label: 'Go to Line…', key: 'Ctrl+G', other: 'Mod+G' },
  'focus-editor': { label: 'Focus Code Editor', key: 'Mod+1' },
  'toggle-editor-split': { label: 'Split Code Editor', key: 'Mod+BACKSLASH' },
  'focus-editor-split': { label: 'Focus Second Editor', key: 'Mod+2' },
  'split-editor-left': { label: 'Split Editor Left' },
  'split-editor-right': { label: 'Split Editor Right' },
  'split-editor-up': { label: 'Split Editor Up' },
  'split-editor-down': { label: 'Split Editor Down' },
  'focus-editor-group-left': { label: 'Focus Editor Group Left' },
  'focus-editor-group-right': { label: 'Focus Editor Group Right' },
  'focus-editor-group-up': { label: 'Focus Editor Group Up' },
  'focus-editor-group-down': { label: 'Focus Editor Group Down' },
  'focus-next-editor-group': { label: 'Focus Next Editor Group', key: 'Mod+Alt+ARROWRIGHT' },
  'focus-previous-editor-group': { label: 'Focus Previous Editor Group', key: 'Mod+Alt+ARROWLEFT' },
  'move-editor-left': { label: 'Move Editor into Left Group' },
  'move-editor-right': { label: 'Move Editor into Right Group' },
  'move-editor-up': { label: 'Move Editor into Group Above' },
  'move-editor-down': { label: 'Move Editor into Group Below' },
  'close-editor-group': { label: 'Close Editor Group' },
  'markdown-preview': { label: 'Toggle Markdown Preview', key: 'Mod+Shift+M' },
  'markdown-split': { label: 'Toggle Markdown Split View', key: 'Mod+Alt+Shift+M' },
  'toggle-document-split': { label: 'Toggle Document Split' },
  'focus-document-split': { label: 'Focus Document Split Divider' },
  welcome: { label: 'Welcome', key: 'Mod+Shift+1' },
  'focus-explorer': { label: 'Focus Explorer', key: 'Mod+Shift+E' },
  'toggle-explorer': { label: 'Toggle Explorer', key: 'Mod+B' },
  'toggle-source-control': { label: 'Toggle Source Control' },
  'toggle-debug': { label: 'Toggle Run and Debug', key: 'Mod+Shift+D' },
  'toggle-marketplace': { label: 'Manage Learning Content' },
  'toggle-output': { label: 'Toggle Bottom Panel', key: 'Mod+J' },
  'toggle-terminal': { label: 'Toggle Terminal', key: 'Mod+Shift+J' },
  'focus-terminal': { label: 'Focus Terminal', key: 'Mod+Alt+J' },
  'toggle-auxiliary': { label: 'Toggle Workspace Panel' },
  run: { label: 'Run Active File', key: 'F5' },
  'run-task': { label: 'Run Task…', key: 'Mod+Shift+B' },
  'start-debugging': { label: 'Start Debugging', key: 'F6' },
  'debug-continue': { label: 'Debug: Continue', key: 'F8' },
  'debug-pause': { label: 'Debug: Pause' },
  'debug-step-over': { label: 'Debug: Step Over', key: 'F10' },
  'debug-step-into': { label: 'Debug: Step Into', key: 'F11' },
  'debug-step-out': { label: 'Debug: Step Out', key: 'Shift+F11' },
  'debug-restart': { label: 'Debug: Restart' },
  'debug-stop': { label: 'Debug: Stop', key: 'Shift+F6' },
  'toggle-breakpoint': { label: 'Debug: Toggle Breakpoint', key: 'F9' },
  'focus-debug-console': { label: 'Focus Debug Console' },
  'run-tests': { label: 'Run Tests' },
  'test-explorer': { label: 'Test Explorer…' },
  'ask-ion': { label: 'Ask Ion…' },
  'explain-selection': { label: 'Explain Selected Code…' },
  'edit-selection': { label: 'Edit Selected Code with Ion…' },
  'enable-copilot': { label: 'Enable GitHub Copilot…' },
  'sign-in-copilot': { label: 'Sign in to GitHub Copilot…' },
  'sign-out-copilot': { label: 'Sign out of GitHub Copilot' },
  'disable-copilot': { label: 'Disable GitHub Copilot' },
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
const keyPattern = /^(?:[A-Z0-9.,/\[\]-]|F[1-9]|F1[0-2]|ENTER|TAB|BACKSLASH|ARROW(?:UP|DOWN|LEFT|RIGHT))$/
const roleKeys = new Set(['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z'])
const macRoleKeys = new Set([
  'Mod+Q', 'Mod+H', 'Mod+Alt+H', 'Mod+M', 'Mod+Ctrl+F', 'Ctrl+Mod+F', 'Mod+TAB', 'Mod+Shift+TAB',
])

export function normalizeShortcut(value: string, platform: ShortcutPlatform): string | null {
  if (value.length > 64) return null
  if (!value.trim()) return ''
  const parts = value.split('+').map((part) => part.trim().toUpperCase())
  const rawKey = parts.pop()
  const key = rawKey === '\\' ? 'BACKSLASH' : rawKey
  if (!key || !keyPattern.test(key)) return null
  const seen = new Set<string>()
  for (const part of parts) {
    const modifier = part === 'MOD' || part === 'CMD' || part === 'COMMAND' || (part === 'CTRL' && platform !== 'darwin') ? 'Mod'
      : part === 'CTRL' ? 'Ctrl' : part === 'ALT' || part === 'OPTION' ? 'Alt' : part === 'SHIFT' ? 'Shift' : null
    if (!modifier || seen.has(modifier)) return null
    seen.add(modifier)
  }
  if (!key.startsWith('F') || key === 'F') {
    if (!seen.has('Mod') && !seen.has('Ctrl') && !(key === 'F' && seen.has('Alt') && seen.has('Shift'))) return null
  }
  return [...modifiers.filter((modifier) => seen.has(modifier)), key === 'ENTER' ? 'Enter' : key].join('+')
}

export function effectiveShortcut(command: MenuCommand, overrides: ShortcutOverrides, platform: ShortcutPlatform): string {
  const entry = definitions[command]
  if (overrides[command] !== undefined) return overrides[command]
  const fallback = platform !== 'darwin' && entry.other ? entry.other : entry.key ?? ''
  if ((command === 'markdown-preview' || command === 'markdown-split' || command === 'workspace-search' || command === 'format-document'
    || command === 'toggle-terminal' || command === 'focus-terminal'
    || command === 'toggle-editor-split' || command === 'focus-editor-split'
    || command === 'focus-next-editor-group' || command === 'focus-previous-editor-group'
    || command === 'navigate-back' || command === 'navigate-forward' || command === 'find-references' || command === 'rename-symbol'
    || command === 'focus-explorer' || command === 'toggle-debug' || command === 'focus-debug-console'
    || command === 'start-debugging' || command === 'debug-continue' || command === 'debug-step-over'
    || command === 'debug-step-into' || command === 'debug-step-out' || command === 'debug-stop'
    || command === 'toggle-breakpoint' || command === 'run-task')
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
    .replace(/\bTAB\b/g, 'Tab')
    .replace(/BACKSLASH/g, '\\')
    .replace(/ARROWUP/g, '↑').replace(/ARROWDOWN/g, '↓')
    .replace(/ARROWLEFT/g, '←').replace(/ARROWRIGHT/g, '→')
  return binding.split('+').map((part) => ({
    Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Enter: '↩',
    TAB: 'Tab',
    ARROWUP: '↑', ARROWDOWN: '↓', ARROWLEFT: '←', ARROWRIGHT: '→',
    BACKSLASH: '\\',
  })[part] ?? part).join('')
}

export function menuAccelerator(binding: string): string | undefined {
  return binding ? binding.replace(/\bMod\b/g, 'CmdOrCtrl')
    .replace(/\bTAB\b/g, 'Tab')
    .replace(/BACKSLASH/g, 'Backslash')
    .replace(/ARROWUP/g, 'Up').replace(/ARROWDOWN/g, 'Down')
    .replace(/ARROWLEFT/g, 'Left').replace(/ARROWRIGHT/g, 'Right') : undefined
}

interface ShortcutInput {
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

const punctuation: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Backslash: 'BACKSLASH', BracketLeft: '[', BracketRight: ']', Minus: '-' }

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
