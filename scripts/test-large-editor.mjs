import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for native dialog stubbing.')

const mac = process.platform === 'darwin'
const modifier = mac ? 'Meta' : 'Control'

await withScratch('large-editor', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const source = join(project.directory, 'large-source.c')
  const oversized = join(project.directory, 'oversized-source.txt')
  const profile = join(scratch, 'profile')
  const header = 'int ion_fixture(void)'
  const diskHeader = 'int ion_outside(void)'
  const foldMarker = 'ION-FOLD-MARKER'
  const startWrap = 'ION-WRAP-START'
  const endWrap = 'ION-WRAP-END'
  const deepComment = 'ion_deep_comment'
  const findNeedle = 'ion_original_value'
  const replacement = 'ion_replaced_value'
  const content = [
    `${header} {`,
    `    /* ${foldMarker} */`,
    '    return 7;',
    '}',
    `static const char long_line[] = "${startWrap}${' text'.repeat(135)} ${endWrap}";`,
    ...Array.from({ length: 28_000 }, (_, index) => `static const unsigned item_${index} = ${index}u; /* fixture */`),
    '/* A multiline comment checks syntax coloring far below the first viewport.',
    `const int ${deepComment} = 200;`,
    '*/',
    `static const int ${findNeedle} = 91;`,
    '',
  ].join('\n')
  assert.ok(Buffer.byteLength(content) >= 1.5 * 1024 ** 2 && Buffer.byteLength(content) < 2 * 1024 ** 2)
  const oversizedText = 'FIRST PAGE\n' + 'a'.repeat(64 * 1024 - 'FIRST PAGE\n'.length) + 'SECOND PAGE\n'
    + 'Line of local text for the preview.\n'.repeat(65_000)
  await mkdir(profile)
  await Promise.all([
    writeFile(source, content),
    writeFile(oversized, oversizedText),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: { autoSave: false, wordWrap: false },
    })),
  ])

  const session = await launch(target, profile)
  let passed = false
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    await openFromExplorer(page, source, header)

    const editor = page.getByTestId('editor')
    const lines = editor.locator('.view-line')
    const line = (needle) => lines.filter({ hasText: needle }).first()
    const color = (row, token) => line(row).evaluate((element, text) => {
      const tokenNode = [...element.querySelectorAll('span')]
        .find((node) => !node.childElementCount && node.textContent.includes(text))
      return tokenNode ? getComputedStyle(tokenNode).color : null
    }, token)
    await eventually(async () => {
      const keyword = await color('return 7', 'return')
      const number = await color('return 7', '7')
      return keyword && number && keyword !== number
    }, 'Visible C keyword and numeric tokens must use different syntax colors.')
    const commentColor = await color(foldMarker, foldMarker)
    assert.ok(commentColor)

    // Monaco's folding gutter has no accessible name.
    await editor.locator('.codicon-folding-expanded').first().click()
    await line(foldMarker).waitFor({ state: 'detached' })
    await editor.locator('.codicon-folding-collapsed').first().click()
    await line(foldMarker).waitFor()

    async function setWrap(enabled) {
      await page.getByTestId('settings').click()
      const preferences = page.getByRole('dialog', { name: 'Preferences' })
      await preferences.getByRole('checkbox', { name: 'Word wrap' }).setChecked(enabled)
      await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    }
    await line(startWrap).filter({ hasText: endWrap }).waitFor()
    await setWrap(true)
    await line(startWrap).waitFor()
    await line(endWrap).waitFor()
    await line(startWrap).filter({ hasText: endWrap }).waitFor({ state: 'detached' })
    await setWrap(false)
    await line(startWrap).filter({ hasText: endWrap }).waitFor()
    console.log('PASS 1.5 MiB C source loads offline with syntax colors, folding and configurable word wrap')

    await line(header).click({ position: { x: 80, y: 8 } })
    await page.keyboard.press(`${modifier}+f`)
    const find = editor.getByRole('dialog', { name: 'Find / Replace' })
    const query = find.getByPlaceholder('Find', { exact: true })
    await query.fill(deepComment)
    await query.press('Enter')
    await line(deepComment).waitFor()
    await eventually(() => color(deepComment, deepComment).then((actual) => actual === commentColor),
      'Deep multiline comment must receive the same syntax color as the first comment.')

    await query.fill(findNeedle)
    await query.press('Enter')
    await line(findNeedle).waitFor()
    await find.getByRole('button', { name: 'Toggle Replace' }).click()
    await find.getByPlaceholder('Replace', { exact: true }).fill(replacement)
    await find.getByRole('button', { name: /Replace All/ }).click()
    await page.keyboard.press('Escape')
    await line(replacement).waitFor()
    await line(replacement).click({ position: { x: 80, y: 8 } })
    await page.keyboard.press(`${modifier}+z`)
    await line(findNeedle).waitFor()
    await page.keyboard.press(mac ? 'Meta+Shift+z' : 'Control+y')
    await line(replacement).waitFor()
    assert.equal(await readFile(source, 'utf8'), content, 'Edits must stay in memory with autosave disabled.')
    await page.getByTestId('save-file').click()
    await waitForFile(readFile, source, replacement)
    const saved = content.replace(findNeedle, replacement)
    assert.equal(await readFile(source, 'utf8'), saved)
    console.log('PASS deep syntax and Find/Replace, undo and redo, and exact on-disk save')

    const closeSource = async () => {
      await atPath(page, 'close-tab', source).click()
      await atPath(page, 'tab', source).waitFor({ state: 'detached' })
      const ready = await editorShows(page, '#include')
      await ready.dispose()
    }
    await closeSource()
    await openFromExplorer(page, source, header)
    await closeSource()
    const external = join(scratch, 'external-replacement.c')
    const updated = saved.replace(header, diskHeader)
    assert.equal(Buffer.byteLength(updated), Buffer.byteLength(saved))
    await writeFile(external, updated)
    await rename(external, source)
    await openFromExplorer(page, source, diskHeader)
    await line(header).waitFor({ state: 'detached' })
    assert.equal(await readFile(source, 'utf8'), updated)
    const openStart = performance.now()
    await atPath(page, 'explorer-entry', oversized).click()
    const preview = page.getByTestId('large-text-preview')
    await preview.locator('pre').filter({ hasText: 'FIRST PAGE' }).waitFor()
    const previewMs = performance.now() - openStart
    assert.equal(await page.getByTestId('save-file').isDisabled(), true)
    await preview.getByRole('button', { name: 'Next', exact: true }).click()
    await preview.locator('pre').filter({ hasText: 'SECOND PAGE' }).waitFor()
    assert.equal(await readFile(oversized, 'utf8'), oversizedText)
    console.log(`PASS oversized source opens read only in ${previewMs.toFixed(0)} ms, with bounded paging and unchanged bytes`)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    console.log('PASS reopening reads an externally replaced revision without changing it or making network requests')
    passed = true
  } finally {
    await close(session).catch((error) => { if (passed) throw error })
  }
})
