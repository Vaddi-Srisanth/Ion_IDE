import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { defaultSettings } from '../src/shared/contracts'
import { readWorkspaceConfiguration, validateWorkspaceConfiguration, writeWorkspaceConfiguration } from '../src/main/workspace-configuration'

test('workspace configurations persist only bounded editor preferences and explicit roots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-workspace-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'course.ion-workspace')
  const roots = [join(directory, 'one'), join(directory, 'two')]
  await writeWorkspaceConfiguration(path, roots, { ...defaultSettings, tabSize: 2, wordWrap: true })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored.roots, roots)
  assert.equal(stored.settings.tabSize, 2)
  assert.equal(stored.settings.wordWrap, true)
  assert.equal('shortcuts' in stored.settings, false)
  assert.equal('smartLanguages' in stored.settings, false)
  assert.deepEqual(await readWorkspaceConfiguration(path), stored)
})

test('workspace configurations reject duplicate, relative, oversized, and executable metadata', () => {
  const settings = { fontSize: 13, tabSize: 4, wordWrap: false, lineNumbers: true, showExplorer: true, explorerWidth: 260 }
  const duplicate = resolve(tmpdir(), 'ion-workspace-duplicate')
  assert.throws(() => validateWorkspaceConfiguration({ version: 1, roots: ['relative'], settings }), /folder path/)
  assert.throws(() => validateWorkspaceConfiguration({ version: 1, roots: [duplicate, duplicate], settings }), /Duplicate/)
  assert.throws(() => validateWorkspaceConfiguration({ version: 1,
    roots: Array.from({ length: 9 }, (_, index) => resolve(tmpdir(), `ion-workspace-root-${index}`)), settings }), /Invalid/)
  const parsed = validateWorkspaceConfiguration({ version: 1, roots: [duplicate], settings,
    trust: { run: true }, tasks: [{ command: 'danger' }], credentials: 'secret' })
  assert.deepEqual(Object.keys(parsed).sort(), ['roots', 'settings', 'version'])
})
