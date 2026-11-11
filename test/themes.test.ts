import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ThemeStore } from '../src/main/themes'
import { builtinThemes, validateTheme, type ThemeData, type ThemeDefinition } from '../src/shared/themes'

const palettes = resolve('src/main/themes/palettes')

async function setup(t: TestContext) {
  const profile = await mkdtemp(join(tmpdir(), 'ion-theme-tests-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  return { profile, store: new ThemeStore(profile, palettes) }
}

function portable({ version, name, appearance, colors, syntax }: ThemeData): ThemeDefinition {
  return { version, name, appearance, colors, syntax }
}

test('lists a metadata-only catalog of contrast-validated built-ins and two high contrast palettes', async (t) => {
  const { profile, store } = await setup(t)
  const metadata = await store.list()
  assert.equal(metadata.length, 16)
  assert.deepEqual(metadata.filter((entry) => entry.contrast === 'high').map(({ appearance }) => appearance), ['dark', 'light'])
  assert.deepEqual(await new ThemeStore(profile, join(profile, 'missing-palettes')).list(), metadata)
  for (const entry of metadata) {
    const theme = await store.load(entry.id)
    const { id, name, appearance, source, swatches, contrast } = theme
    assert.deepEqual({ id, name, appearance, source, swatches, ...(contrast && { contrast }) }, entry)
    assert.deepEqual(swatches, [theme.colors.background, theme.colors.accent, theme.syntax.keyword])
    assert.deepEqual(validateTheme(portable(theme)), portable(theme))
  }
})

test('persists parallel custom installs and round-trips a portable local export', async (t) => {
  const { profile, store } = await setup(t)
  const dark = portable(await store.load('dark'))
  const light = portable(await store.load('light'))
  const night = { ...dark, name: 'My Night' }
  const day = { ...light, name: 'My Day' }
  const [first, second] = await Promise.all([store.create(night), store.create(day)])
  assert.notEqual(first.id, second.id)
  const restarted = new ThemeStore(profile, palettes)
  assert.deepEqual((await restarted.list()).slice(builtinThemes.length), [first, second])
  assert.deepEqual(portable(await restarted.load(first.id)), night)
  const path = join(profile, 'shared-theme.json')
  await restarted.exportFile(second.id, path)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), day)
  const reimported = await restarted.importFile(path)
  assert.notEqual(reimported.id, second.id)
  assert.deepEqual(portable(await restarted.load(reimported.id)), day)

  // Missing inactive palette contents do not affect listing or another theme's load.
  await rm(join(profile, 'themes', first.id + '.json'))
  assert.equal((await restarted.list()).length, builtinThemes.length + 3)
  assert.deepEqual(portable(await restarted.load(second.id)), day)
  await assert.rejects(restarted.load(first.id), /could not be found/)
})

test('rejects injection, unknown fields, invalid encodings and inaccessible palettes', async (t) => {
  const { profile, store } = await setup(t)
  const theme = portable(await store.load('dark'))
  const path = join(profile, 'invalid.json')
  await assert.rejects(store.load('../preferences'), /Invalid theme ID/)
  await assert.rejects(store.load('custom-../../escape'), /Invalid theme ID/)
  await assert.rejects(store.create({ ...theme, name: '\u202ETheme' }), /control characters/)
  await assert.rejects(store.create({ ...theme, version: 2 }), /version 1/)
  await assert.rejects(store.create({ ...theme, colors: { ...theme.colors, accent: 'url(https://example.com)' } }), /six-digit hex/)
  await assert.rejects(store.create({ ...theme, colors: { ...theme.colors, dim: theme.colors['surface-3'] } }), /contrast for dim/)
  await assert.rejects(store.create({ ...theme, syntax: { ...theme.syntax, comment: theme.colors['editor-selection'] } }), /contrast for syntax comment/)
  await writeFile(path, '{"__proto__":{"injected":true},' + JSON.stringify(theme).slice(1))
  await assert.rejects(store.importFile(path), /Ion theme JSON/)
  assert.equal(Object.hasOwn(Object.prototype, 'injected'), false)
  await writeFile(path, Buffer.from([0xff, 0x7b, 0x7d]))
  await assert.rejects(store.importFile(path), /valid UTF-8 JSON/)
  await writeFile(path, Buffer.alloc(8 * 1024 + 1, 32))
  await assert.rejects(store.importFile(path), /exceeds 8 KiB/)
  if (process.platform !== 'win32') {
    const link = join(profile, 'linked-theme.json')
    await symlink(path, link)
    await assert.rejects(store.importFile(link), /regular file/)
  }
  assert.equal((await store.list()).length, builtinThemes.length)
})
