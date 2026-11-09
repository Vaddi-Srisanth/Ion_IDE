import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, launch, openFolder, openFromExplorer, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values: options } = parseArgs({ options: { target: { type: 'string', default: 'dist' }, help: { type: 'boolean' } } })
if (options.help) {
  console.log('npm run test:themes -- [--target dist]')
  process.exit(0)
}
const target = await artifact(options.target)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for native dialog stubbing.')

async function theme(page, id) {
  await page.locator(`.app-shell[data-theme-id="${id}"]`).waitFor()
}

const rgb = (hex) => `rgb(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`
const background = (locator) => locator.evaluate((element) => getComputedStyle(element).backgroundColor)

async function verifySurfaces(page, definition) {
  assert.equal(await page.locator('.app-shell').getAttribute('data-theme'), definition.appearance)
  assert.equal(await background(page.locator('.app-shell')), rgb(definition.colors.background))
  assert.equal(await background(page.locator('.titlebar')), rgb(definition.colors.surface))
  assert.equal(await background(page.locator('.explorer-frame')), rgb(definition.colors.panel))
  assert.equal(await background(page.locator('.output-frame')), rgb(definition.colors.panel))
  assert.equal(await background(page.locator('.monaco-editor .monaco-editor-background').first()), rgb(definition.colors.background))
  const keyword = page.locator('.monaco-editor .view-lines').getByText('return', { exact: true })
  assert.equal(await keyword.evaluate((element) => getComputedStyle(element).color), rgb(definition.syntax.keyword))
}

await withScratch('theme-flow', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  const exportPath = join(scratch, 'export.json')
  const input = join(scratch, 'import.json')
  const blocked = join(scratch, 'bad.json')
  const originalProgram = await readFile(project.program, 'utf8')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({
    version: 1, settings: { theme: 'dark', autoSave: false, showOutput: true },
  }))
  const first = await launch(target, profile)
  let custom
  let imported
  try {
    const { app, page } = first
    await app.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, file: input, save: exportPath })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    const originalEditor = page.locator('.monaco-editor')
    await originalEditor.evaluate((node) => { node.dataset.themeTestEditor = 'original' })
    await originalEditor.locator('.view-line').first().click()
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.insertText(' // theme-flow-undo')
    await editorShows(page, 'theme-flow-undo')
    await page.getByTestId('settings').click()
    const picker = page.getByTestId('theme-picker')
    const list = () => page.evaluate(() => window.ion.themes.list())
    const settings = () => page.evaluate(async () => (await window.ion.getPreferences()).settings)
    const palette = (id) => page.evaluate((value) => window.ion.themes.load(value), id)
    const builtins = await list()
    assert.equal(builtins.length, 5)
    assert.equal(builtins.filter(({ appearance }) => appearance === 'dark').length, 3)
    assert.equal(builtins.filter(({ appearance }) => appearance === 'light').length, 2)
    for (const definition of builtins.filter(({ id }) => id !== 'dark')) {
      if (definition.id === 'light') await page.getByTestId('theme-light').click()
      else await picker.selectOption(definition.id)
      await theme(page, definition.id)
      await verifySurfaces(page, await palette(definition.id))
    }
    console.log('PASS built-in schemes apply to workbench, explorer, Console and Monaco offline')

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByTestId('theme-system').click()
    await theme(page, 'dark')
    assert.equal((await settings()).theme, 'system')
    await page.emulateMedia({ colorScheme: 'light' })
    await theme(page, 'light')
    await verifySurfaces(page, await palette('light'))
    assert.equal((await settings()).theme, 'system')
    await page.getByTestId('theme-dark').click()
    await theme(page, 'dark')
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.emulateMedia({ colorScheme: 'light' })
    await theme(page, 'dark')
    assert.equal((await settings()).theme, 'dark')
    console.log('PASS automatic selection follows live appearance changes while fixed selections stay fixed')

    await page.getByTestId('theme-create').click()
    await page.getByTestId('theme-name').fill('Custom theme flow')
    await page.getByText('Editor colors', { exact: true }).click()
    await page.getByTestId('theme-color-editor-indent').fill('#5a555a')
    await page.getByText('Syntax highlighting', { exact: true }).click()
    await page.getByTestId('theme-syntax-keyword').fill('#9dbece')
    await page.getByTestId('theme-create-submit').click()
    await page.waitForFunction(() => document.querySelector('.app-shell').dataset.themeId?.startsWith('custom-'))
    custom = (await list()).find(({ name }) => name === 'Custom theme flow')
    assert.ok(custom, 'Theme creation installed a local definition')
    await theme(page, custom.id)
    assert.equal(await picker.inputValue(), custom.id)
    const createdTheme = await palette(custom.id)
    assert.equal(createdTheme.colors['editor-indent'], '#5a555a')
    assert.equal(createdTheme.syntax.keyword, '#9dbece')
    await verifySurfaces(page, createdTheme)

    await page.getByTestId('theme-export').click()
    await page.getByText('Theme exported.').waitFor()
    const exported = JSON.parse(await readFile(exportPath, 'utf8'))
    assert.deepEqual(Object.keys(exported).sort(), ['appearance', 'colors', 'name', 'syntax', 'version'])
    assert.equal(exported.name, custom.name)
    await writeFile(input, JSON.stringify({ ...exported, name: 'Imported theme flow', colors: { ...exported.colors, panel: '#161b25' } }))
    await page.getByTestId('theme-import').click()
    const option = picker.locator('option').filter({ hasText: 'Imported theme flow' })
    await option.waitFor({ state: 'attached' })
    imported = (await list()).find(({ name }) => name === 'Imported theme flow')
    assert.ok(imported && imported.id !== custom.id)
    await theme(page, imported.id)
    const importedTheme = await palette(imported.id)
    await verifySurfaces(page, importedTheme)
    assert.equal((await settings()).theme, imported.id)

    await writeFile(blocked, JSON.stringify({
      ...exported, name: 'Rejected', colors: { ...exported.colors, background: 'url(https://example.invalid/never)' },
    }))
    await stubDialogs(app, { file: blocked })
    await page.getByTestId('theme-import').click()
    await page.getByRole('alert').filter({ hasText: /six-digit hex color/i }).waitFor()
    assert.equal((await list()).length, 7)
    assert.equal((await settings()).theme, imported.id)
    await theme(page, imported.id)
    console.log('PASS custom palette creation, validated import and portable JSON export')

    await page.getByRole('button', { name: 'Done', exact: true }).click()
    assert.equal(await originalEditor.count(), 1)
    assert.equal(await originalEditor.getAttribute('data-theme-test-editor'), 'original')
    await editorShows(page, 'theme-flow-undo')
    await originalEditor.locator('.view-line').first().click()
    await page.keyboard.press('Meta+z')
    await page.waitForFunction(() => !document.querySelector('.monaco-editor .view-lines').textContent.includes('theme-flow-undo'))
    assert.equal(await readFile(project.program, 'utf8'), originalProgram)
    await page.getByTestId('close-tab').click()
    const discard = page.getByRole('button', { name: 'Discard', exact: true })
    const tab = page.getByTestId('tab')
    await Promise.race([discard.waitFor(), tab.waitFor({ state: 'detached' })])
    if (await discard.isVisible()) await discard.click()
    await tab.waitFor({ state: 'detached' })
    console.log('PASS theme changes preserve the existing editor, dirty text and undo history')

    for (const [mode, pane] of [['learn', 'learning-pane'], ['projects', 'projects-panel'], ['practice', 'practice-pane']]) {
      await page.getByRole('button', { name: 'Welcome', exact: true }).click()
      await page.getByTestId(`workspace-${mode}`).click()
      const panel = page.getByTestId(pane)
      await panel.waitFor()
      assert.equal(await background(panel), rgb(importedTheme.colors.panel))
      await page.getByTestId('settings').click()
      await page.getByTestId('theme-light').click()
      await theme(page, 'light')
      assert.equal(await background(panel), rgb((await palette('light')).colors.panel))
      await picker.selectOption(imported.id)
      await theme(page, imported.id)
      await page.getByRole('button', { name: 'Done', exact: true }).click()
    }
    assert.deepEqual(first.requests, [], 'Theme use attempted no network requests')
    assert.deepEqual(first.errors, [], 'Theme use raised no uncaught renderer errors')
    console.log('PASS theme changes reach Learn, Projects and Practice without network requests')
  } finally {
    await close(first)
  }

  const second = await launch(target, profile)
  try {
    await theme(second.page, imported.id)
    assert.equal(await second.page.evaluate(async () => (await window.ion.getPreferences()).settings.theme), imported.id)
    await second.page.getByTestId('settings').click()
    await second.page.getByTestId('theme-picker').locator(`option[value="${custom.id}"]`).waitFor({ state: 'attached' })
    assert.equal(await second.page.getByTestId('theme-picker').inputValue(), imported.id)
    await second.page.getByRole('button', { name: 'Done', exact: true }).click()
    console.log('PASS installed themes and active custom selection survive a full relaunch')
  } finally {
    await close(second)
  }
})
