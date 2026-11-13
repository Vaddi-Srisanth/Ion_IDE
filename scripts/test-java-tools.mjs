import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, resourceSnapshot, stubDialogs, withScratch } from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const snapshot = process.platform === 'win32' ? windowsProcessTree : resourceSnapshot
const source = 'class Main {\n    void run() {\n        List<String> values;\n    }\n}\n'
const clean = 'class Main {\n    void run() {\n        java.util.List<String> values;\n    }\n}\n'
const sourceEditor = (page) => page.getByTestId('editor').locator('.monaco-editor').first()
const suggestion = (page, text) => page.locator('.suggest-widget.visible .monaco-list-row').filter({ hasText: text }).first()
const problem = (page) => page.getByTestId('problem-row').filter({ hasText: /cannot find symbol.*List/s }).first()

async function navigate(page, line, column = 1) {
  await page.getByTestId('command-palette').click()
  await page.getByTestId('command-palette-input').fill('Go to Line')
  await page.getByRole('option', { name: /^Go to Line/ }).click()
  await page.getByTestId('goto-line-input').fill(String(line))
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByText(`Ln ${line}, Col 1`, { exact: true }).waitFor()
  for (let i = 1; i < column; i++) await page.keyboard.press('ArrowRight')
}

async function preferences(page, options) {
  await page.getByTestId('settings').click()
  const dialog = page.getByRole('dialog', { name: 'Preferences' })
  for (const [name, value] of Object.entries(options)) await dialog.getByRole('checkbox', { name: new RegExp(name) }).setChecked(value)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function replace(page, text) {
  await sourceEditor(page).locator('.view-line').first().click()
  await page.keyboard.press(mod + '+a')
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

await withScratch('java-tools', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const path = join(project.directory, 'Main.java')
  const helper = join(project.directory, 'Helper.java')
  const outsideFolder = join(scratch, 'outside')
  const outside = join(outsideFolder, 'Outside.java')
  const profile = join(scratch, 'profile')
  await Promise.all([mkdir(profile), mkdir(outsideFolder)])
  await Promise.all([
    writeFile(path, source), writeFile(helper, 'class Helper { static int value() { return 4; } }\n'),
    writeFile(outside, 'class Outside {}\n'),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: { autoSave: false, openFullScreen: false, showOutput: true, automaticSuggestions: false },
    })),
  ])
  const escapedFile = process.platform === 'win32'
    ? join(project.directory, 'outside', 'Outside.java') : join(project.directory, 'Outside.java')
  if (process.platform === 'win32') await symlink(outsideFolder, join(project.directory, 'outside'), 'junction')
  else await symlink(outside, escapedFile)
  const session = await launch(target, profile)
  const { app, page } = session
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const query = (text, operation, offset = 0, version = 1, file = path) => page.evaluate(
    (payload) => window.ion.languageTools.query(payload), { language: 'java', path: file, operation, offset, text, version })
  const javaProcesses = async () => (await snapshot(session, { details: true })).members.filter(({ name }) => /^java(?:\.exe)?$/i.test(name ?? ''))
  let step = 'verify manual snippets with Smart Java disabled'
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, path, 'List<String> values')
    const basic = 'class Main {\n    void run() {\n        sout\n    }\n}\n'
    await replace(page, basic)
    await navigate(page, 3, 13)
    await page.keyboard.press('Control+Space')
    await suggestion(page, 'sout').waitFor()
    await page.keyboard.press('Tab')
    await (await editorShows(page, 'System.out.println();')).dispose()
    await page.keyboard.press(mod + '+z')
    await (await editorShows(page, 'sout')).dispose()
    await preferences(page, { 'Automatic suggestions': true })
    await replace(page, 'class Main {\n    \n}\n')
    await navigate(page, 2, 5)
    await page.keyboard.type('psvm')
    await suggestion(page, 'psvm').waitFor()
    await page.keyboard.press('Enter')
    await (await editorShows(page, 'public static void main(String[] args)')).dispose()
    await preferences(page, { 'Automatic suggestions': false })
    assert.deepEqual(await javaProcesses(), [])
    assert.equal(await query(source, 'diagnostics'), null)
    await replace(page, source)

    step = 'enable Smart Java, then locate a real diagnostic, squiggle and hover'
    await preferences(page, { 'Smart Java': true })
    await page.getByTestId('bottom-problems-tab').click()
    await problem(page).waitFor({ timeout: 18_000 })
    assert.match(await problem(page).innerText(), /Main.java:3:9/)
    await problem(page).getByTestId('problem-reveal').click()
    await page.getByText('Ln 3, Col 9', { exact: true }).waitFor()
    // Monaco retains decoration nodes for clipped/hidden ranges. Target an
    // actual visible squiggle in the revealed source viewport. Its decoration
    // sits below the rendered text, so move a real pointer to that source
    // position instead of asking the decorative overlay to receive events.
    // Read visibility and geometry atomically: Monaco can replace decorations
    // between separate waitFor() and boundingBox() protocol calls.
    const visibleMarker = await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="editor"] .monaco-editor')
      if (!editor) return null
      const viewport = editor.getBoundingClientRect()
      for (const marker of editor.querySelectorAll('.view-overlays .squiggly-error')) {
        const rect = marker.getBoundingClientRect(), style = getComputedStyle(marker)
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          && x >= viewport.left && x < viewport.right && y >= viewport.top && y < viewport.bottom
          && editor.contains(document.elementFromPoint(x, y))) {
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
      }
      return null
    }, undefined, { timeout: 8000 })
    let markerBox
    try { markerBox = await visibleMarker.jsonValue() } finally { await visibleMarker.dispose() }
    assert.ok(markerBox && markerBox.width > 0 && markerBox.height > 0, 'The diagnostic squiggle must occupy visible source pixels.')
    await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2)
    const hover = sourceEditor(page).locator('.monaco-hover').filter({ hasText: 'cannot find symbol' }).first()
    await hover.waitFor()
    assert.match(await hover.innerText(), /javac · error · 3:9/)
    assert.doesNotMatch(await hover.innerText(), /quick fix/i)
    assert.equal(await sourceEditor(page).locator('.lightbulb-glyph, .lightbulb-glyph-widget').count(), 0)
    await page.keyboard.press('Escape')
    assert.equal((await javaProcesses()).length, 1)
    console.log('PASS Basic Java snippet, undo and zero JDK processes; Smart Java diagnostic, source navigation, squiggle and hover')

    step = 'check semantic completion, signatures, navigation and file scope'
    const member = 'class Main { void run() { System.out.; } }'
    const completions = await query(member, 'complete', member.indexOf('.;') + 1, 22)
    assert.equal(completions.version, 22)
    for (const name of ['println', 'print', 'printf']) assert.ok(completions.rows.some(([label, kind]) => label === name && kind === 'method'), name)
    const hash = 'class Main { HashM value; }'
    assert.ok((await query(hash, 'complete', hash.indexOf('HashM') + 5)).rows.some(([label, kind, , text]) =>
      label === 'HashMap' && kind === 'class' && text === 'java.util.HashMap'))
    const importPackage = 'import java.u;\nclass Main {}'
    assert.ok((await query(importPackage, 'complete', importPackage.indexOf(';'))).rows.some(([label, kind]) =>
      label === 'util' && kind === 'package'))
    const importClass = 'import java.util.HashM;\nclass Main {}'
    assert.ok((await query(importClass, 'complete', importClass.indexOf(';'))).rows.some(([label, kind, , text]) =>
      label === 'HashMap' && kind === 'class' && text === 'HashMap'))
    const local = 'class Main { void run() { int localCounter = 1; System.out.println(localC); } }'
    assert.ok((await query(local, 'complete', local.indexOf('localC)') + 6)).rows.some(([label, kind]) =>
      label === 'localCounter' && kind === 'variable'))
    const signature = 'class Main { void run() { System.out.println(1); } }'
    assert.ok((await query(signature, 'signature', signature.indexOf('(1') + 1)).rows.some(([, label]) => label.includes('println(int')))
    const localNavigation = 'class Main {\n    int count = 1;\n    int total() { return count + count; }\n}\n'
    const use = localNavigation.indexOf('return count') + 9
    assert.deepEqual((await query(localNavigation, 'definition', use)).rows, [[path, '2', '9']])
    assert.equal((await query(localNavigation, 'references', use)).rows.length, 2)
    const projectNavigation = 'class Main { int total() { return Helper.value(); } }'
    assert.equal((await query(projectNavigation, 'definition', projectNavigation.indexOf('value') + 2)).rows[0]?.[0], helper)
    await assert.rejects(query('class Outside {}', 'diagnostics', 0, 1, outside))
    await assert.rejects(query('class Outside {}', 'diagnostics', 0, 1, escapedFile))
    assert.ok((await query('class Main { Outside value; }', 'diagnostics')).rows.some(([, , , message]) =>
      message.includes('cannot find symbol') && message.includes('Outside')), 'javac must not resolve sources outside the granted workspace')
    const parallel = await Promise.all([query(clean, 'diagnostics', 0, 31), query(member, 'complete', member.indexOf('.;') + 1, 32)])
    assert.equal(parallel[0]?.version, 31)
    assert.equal(parallel[1]?.version, 32)
    assert.equal(await readFile(path, 'utf8'), source)
    console.log('PASS JDK completion for local symbols and APIs, versioned results, method signatures, local and workspace definitions, reference lookup and workspace boundary')

    step = 'check the Monaco semantic suggestion widget and revision-safe diagnostics'
    const firstLine = 'class Main {'
    const brokenMember = firstLine + '\n    void run() {\n        System.out.pri;\n    }\n}\n'
    await replace(page, brokenMember)
    await navigate(page, 3, 23)
    await page.keyboard.press('Control+Space')
    await suggestion(page, 'println').waitFor()
    await page.keyboard.press('Escape')
    await replace(page, projectNavigation)
    await navigate(page, 1, projectNavigation.indexOf('value') + 2)
    await page.keyboard.press('F12')
    await atPath(page, 'tab', helper).waitFor()
    await (await editorShows(page, 'return 4')).dispose()
    await atPath(page, 'close-tab', helper).click()
    await atPath(page, 'tab', helper).waitFor({ state: 'detached' })
    await replace(page, clean)
    await eventually(async () => await page.getByTestId('problem-row').count() === 0
      && await sourceEditor(page).locator('.squiggly-error').count() === 0, 'Stale markers did not clear.')
    await query(clean, 'diagnostics')
    await replace(page, source)
    await problem(page).waitFor()
    await preferences(page, { 'Smart Java': false })
    await eventually(async () => (await javaProcesses()).length === 0, 'The JDK process survived disabling Smart Java.')
    await preferences(page, { 'Smart Java': true })
    await problem(page).waitFor({ timeout: 18_000 })
    await atPath(page, 'close-tab', path).click()
    await page.getByRole('button', { name: /discard/i }).click()
    await eventually(async () => (await javaProcesses()).length === 0, 'The JDK process survived closing the final Java file.')
    assert.equal(await readFile(path, 'utf8'), source)
    assert.deepEqual(session.requests, [])
    console.log('PASS semantic widget, current-buffer problems, offline operation, no file writes and JDK cleanup on disable and tab close')
  } catch (error) {
    console.error({ errors, status: await page.locator('.java-tool-status').allTextContents().catch(() => []),
      editor: await page.locator('.editor-loading, .view-lines, .suggest-widget .message').allTextContents().catch(() => []),
      cursor: await page.getByTestId('status').innerText().catch(() => '') })
    throw new Error('Java desktop verification failed while attempting to ' + step, { cause: error })
  } finally {
    await close(session).catch(() => {})
  }
})
