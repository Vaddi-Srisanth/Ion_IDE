import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inputShortcut, normalizeShortcut, parseShortcutOverrides, resolveShortcuts, shortcutIssue,
} from '../src/shared/shortcuts'

test('workbench shortcuts preserve defaults and allow validated portable overrides', () => {
  assert.equal(shortcutIssue({}, 'darwin'), null)
  assert.equal(shortcutIssue({}, 'win32'), null)
  assert.equal(resolveShortcuts({}, 'darwin').get('Mod+Enter'), 'run')
  assert.equal(resolveShortcuts({}, 'darwin').get('F5'), 'run')
  assert.equal(resolveShortcuts({}, 'darwin').get('Mod+Shift+F'), 'workspace-search')
  assert.equal(resolveShortcuts({}, 'darwin').get('Mod+Shift+J'), 'toggle-terminal')
  assert.equal(resolveShortcuts({}, 'darwin').get('Mod+Alt+J'), 'focus-terminal')
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    assert.equal(resolveShortcuts({}, platform).get('Alt+Shift+F'), 'format-document')
    assert.deepEqual(parseShortcutOverrides({ 'format-document': 'Mod+Shift+G' }, platform), { 'format-document': 'Mod+Shift+G' })
  }
  assert.equal(resolveShortcuts({ find: 'Mod+Shift+J' }, 'darwin').get('Mod+Shift+J'), 'find')
  assert.equal(resolveShortcuts({ find: 'Mod+Shift+F' }, 'darwin').get('Mod+Shift+F'), 'find')
  assert.equal(resolveShortcuts({ run: 'F6' }, 'darwin').get('F6'), 'run')
  assert.equal(resolveShortcuts({ run: 'F6' }, 'darwin').has('Mod+Enter'), false)
  assert.equal(resolveShortcuts({ 'toggle-explorer': '' }, 'darwin').has('Mod+B'), false)
  assert.deepEqual(parseShortcutOverrides({ 'command-palette': ' shift + cmd + e ' }, 'darwin'),
    { 'command-palette': 'Mod+Shift+E' })
  assert.deepEqual(parseShortcutOverrides({ run: 'ctrl+enter' }, 'linux'), { run: 'Mod+Enter' })
})

test('shortcut validation protects native roles, normal typing, and conflicting bindings', () => {
  assert.equal(normalizeShortcut('P', 'darwin'), null)
  assert.equal(normalizeShortcut('Alt+N', 'darwin'), null)
  assert.equal(normalizeShortcut('Shift+Option+F', 'darwin'), 'Alt+Shift+F')
  assert.equal(normalizeShortcut('Mod+Command+P', 'darwin'), null)
  assert.equal(parseShortcutOverrides({ unknown: 'F6' }, 'darwin'), null)
  assert.equal(parseShortcutOverrides({ run: 'Mod+Q' }, 'darwin'), null)
  assert.equal(parseShortcutOverrides({ 'close-tab': 'Mod+C' }, 'darwin'), null)
  assert.equal(parseShortcutOverrides({ 'close-tab': 'Mod+Enter' }, 'darwin'), null)
  assert.match(shortcutIssue({ stop: 'F5' }, 'darwin') ?? '', /Run Active File/)
  assert.deepEqual(parseShortcutOverrides({ run: '', stop: 'F5' }, 'darwin'), { run: '', stop: 'F5' })
})

test('physical keys recover shifted punctuation and option-modified shortcuts', () => {
  const input = { key: 'p', code: 'KeyP', meta: false, control: false, alt: false, shift: false }
  assert.equal(inputShortcut(input, 'darwin'), '')
  assert.equal(inputShortcut({ ...input, key: 'F5', code: 'F5', shift: true }, 'darwin'), 'Shift+F5')
  assert.equal(inputShortcut({ ...input, key: '!', code: 'Digit1', meta: true, shift: true }, 'darwin'), 'Mod+Shift+1')
  assert.equal(inputShortcut({ ...input, key: 'ƒ', code: 'KeyF', meta: true, alt: true }, 'darwin'), 'Mod+Alt+F')
  assert.equal(inputShortcut({ ...input, key: 'Ï', code: 'KeyF', shift: true, alt: true }, 'darwin'), 'Alt+Shift+F')
  assert.equal(inputShortcut({ ...input, key: 'g', code: 'KeyG', control: true }, 'darwin'), 'Ctrl+G')
  assert.equal(inputShortcut({ ...input, control: true }, 'linux'), 'Mod+P')
})
