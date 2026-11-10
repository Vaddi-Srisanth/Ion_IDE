import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const supported = (bin, args = ['--version']) => {
  try { execFileSync(bin, args, { stdio: 'ignore', timeout: 3000 }); return true } catch { return false }
}
const prettierAvailable = supported('prettier')
const ruffAvailable = supported('ruff')
const blackAvailable = supported('black')
const clangAvailable = supported('clang-format') || process.platform === 'darwin' && supported('/usr/bin/xcrun', ['--find', 'clang-format'])
const buffer = async (page, needle) => (await editorShows(page, needle)).dispose()
const format = (page) => page.getByTestId('format-document')
const message = (page, text) => page.getByTestId('status').getByText(text)
const viewLine = (page) => page.getByTestId('editor').locator('.view-line').first()
const exists = (path) => access(path).then(() => true, () => false)

async function replace(page, text) {
  await viewLine(page).click({ position: { x: 6, y: 8 } })
  await page.keyboard.press(mod + '+a')
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

async function quit(session) {
  const closing = close(session)
  const discard = session.page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: /discard/i })
  await Promise.race([closing, discard.click({ timeout: 3000 }).catch(() => closing)])
  await closing
}

async function preferences(page, act) {
  await page.getByTestId('settings').click()
  const dialog = page.getByRole('dialog', { name: 'Preferences' })
  await act(dialog)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function shortcut(app, keyCode, modifiers) {
  await app.evaluate(({ BrowserWindow }, input) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', ...input })
    contents.sendInputEvent({ type: 'keyUp', ...input })
  }, { keyCode, modifiers })
}

await withScratch('format-code', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 1 })
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  const original = '\uFEFFint main(void){\r\nint answer=1;\r\nreturn answer;\r\n}\r\n'
  const native = [
    ['sample.cpp', 'int sample(){return 2;}\n', 'sample() {'],
    ['Sample.java', 'class Sample{void test(){int value=1;}}\n', 'class Sample {'],
  ]
  const web = [
    ['web.js', 'const data={name:"Ion"}\n', "{ name: 'Ion' }"],
    ['web.ts', 'const total:number=1\n', 'total: number = 1'],
    ['web.html', '<main><div>Hello</div><div>Ion</div></main>\n', '<div>Hello</div>'],
    ['web.css', '.box{color:red;margin:0}\n', 'color: red;'],
    ['web.json', '{"x":1,"y":2}\n', '"x": 1'],
    ['web.md', '# Title\n\n*   One\n*  Two\n', '- One'],
  ]
  const paths = new Map([...native, ...web].map(([name]) => [name, join(project.directory, name)]))
  const python = join(project.directory, 'sample.py')
  const csv = join(project.directory, 'read-only.csv')
  const sibling = join(project.directory, 'untouched.c')
  const slow = join(project.directory, 'Slow.js')
  const large = join(project.directory, 'large.c')
  const repeated = join(project.directory, 'repeated.c')
  const auto = join(project.directory, 'autosave.c')
  const repeatedText = '\uFEFF' + Array.from({ length: 5000 }, (_, i) =>
    'int item' + i + '(void){return ' + i + ';} // café 😀\r\n').join('')
  const repeatedExpected = '\uFEFF' + Array.from({ length: 5000 }, (_, i) =>
    'int item' + i + '(void) {\r\n   return ' + i + ';\r\n} // café 😀\r\n').join('')
  const startMarker = join(scratch, 'formatter-started')
  const finishMarker = join(scratch, 'formatter-finish')
  const tools = join(scratch, 'tools')
  await mkdir(tools)
  await Promise.all([
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { autoSave: false, resourceProfile: 'minimal', openFullScreen: false } })),
    writeFile(project.program, original), writeFile(sibling, 'int other(){return 0;}\n'),
    writeFile(python, 'value={ "label" : "Ion" }\n'), writeFile(csv, 'kind,count\na,1\n'),
    writeFile(slow, 'const slow={value:1}\n'),
    writeFile(large, 'x'.repeat(2 * 1024 * 1024 + 1)),
    writeFile(repeated, repeatedText),
    writeFile(auto, 'int autosaved(void){return 0;}\n'),
    writeFile(join(project.directory, '.clang-format'), 'BasedOnStyle: LLVM\nIndentWidth: 3\nAllowShortFunctionsOnASingleLine: None\n'),
    writeFile(join(project.directory, '.prettierrc.json'), JSON.stringify({ singleQuote: true, trailingComma: 'none',
      overrides: [{ files: 'web.ts', options: { semi: false } }] })),
    writeFile(join(project.directory, '.editorconfig'), 'root=true\n[*.css]\nindent_style=tab\n'),
    writeFile(join(project.directory, 'ruff.toml'), '[format]\nquote-style = "single"\n'),
    writeFile(join(project.directory, 'pyproject.toml'), '[tool.black]\nline-length = 95\n'),
    ...[...native, ...web].map(([name, text]) => writeFile(paths.get(name), text)),
  ])
  const session = await launch(target, profile)
  const { app, page } = session
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    assert.equal(await format(page).isDisabled(), true)
    await openFromExplorer(page, project.program, 'int main(void){')
    assert.equal(await format(page).evaluate((node) => node.previousElementSibling?.classList.contains('status-autosave')), true)
    if (clangAvailable) {
      await format(page).click()
      await message(page, 'Formatted with clang-format.').waitFor()
      await buffer(page, '   int answer = 1;')
      assert.equal(await readFile(project.program, 'utf8'), original)
      await viewLine(page).click()
      await page.keyboard.press(mod + '+z')
      await buffer(page, 'int main(void){')
      await viewLine(page).click()
      await shortcut(app, 'F', ['alt', 'shift'])
      await buffer(page, '   int answer = 1;')
      await shortcut(app, 'S', [process.platform === 'darwin' ? 'meta' : 'control'])
      await eventually(async () => (await readFile(project.program, 'utf8')).includes('\r\n   int answer = 1;'), 'Saved text did not preserve CRLF.')
      const disk = await readFile(project.program, 'utf8')
      assert.ok(disk.startsWith('\uFEFF') && !/(?<!\r)\n/.test(disk), 'Saved UTF-8 BOM and CRLF preserved')
      await openFromExplorer(page, auto, 'autosaved(void){')
      await preferences(page, (dialog) => dialog.getByRole('checkbox', { name: /^Autosave/ }).check())
      await format(page).click()
      await eventually(async () => (await readFile(auto, 'utf8')).includes('autosaved(void) {'),
        'Formatting did not resume the existing Autosave policy.')
      await preferences(page, (dialog) => dialog.getByRole('checkbox', { name: /^Autosave/ }).uncheck())
      for (const [name, , expected] of native) {
        await openFromExplorer(page, paths.get(name), name.endsWith('.java') ? 'class Sample{' : 'int sample(){')
        await format(page).click()
        await buffer(page, expected)
      }
      await preferences(page, async (dialog) => {
        await dialog.getByText('Keyboard Shortcuts', { exact: true }).click()
        await dialog.getByTestId('shortcut-command').selectOption('format-document')
        await dialog.getByTestId('shortcut-binding').fill('Mod+Shift+G')
        await dialog.getByTestId('shortcut-apply').click()
        await dialog.getByText('Shortcut saved.', { exact: true }).waitFor()
      })
      await replace(page, 'class Sample{int count=3;}\n')
      await shortcut(app, 'G', [process.platform === 'darwin' ? 'meta' : 'control', 'shift'])
      await buffer(page, 'count = 3;')
      const prefs = await page.evaluate(() => window.ion.getPreferences())
      assert.equal(prefs.settings.shortcuts['format-document'], 'Mod+Shift+G')
      console.log('PASS C, C++, Java, config indentation, single Undo, CRLF/BOM save, Autosave policy, default shortcut and persisted remap')

      await openFromExplorer(page, repeated, 'int item0(void){')
      const host = page.getByTestId('editor').locator('.monaco-host')
      await host.evaluate((node) => { node.dataset.formatTest = 'same-editor' })
      for (let i = 0; i < 9; i++) {
        await format(page).click()
        await buffer(page, 'int item0(void) {')
        await viewLine(page).click()
        await page.keyboard.press(mod + '+z')
        await buffer(page, 'int item0(void){')
      }
      assert.equal(await host.getAttribute('data-format-test'), 'same-editor')
      await shortcut(app, 'S', [process.platform === 'darwin' ? 'meta' : 'control'])
      await message(page, 'Saved repeated.c').waitFor()
      assert.equal(await readFile(repeated, 'utf8'), repeatedText)
      await page.keyboard.press(mod + '+Shift+z')
      await buffer(page, 'int item0(void) {')
      await shortcut(app, 'S', [process.platform === 'darwin' ? 'meta' : 'control'])
      await eventually(async () => (await readFile(repeated, 'utf8')) === repeatedExpected,
        'Redo did not restore the exact 5,000-line formatted source.')
      console.log('PASS repeated large edits preserve the editor and exact full-file UTF-8 content through Undo and Redo')
    } else console.log('SKIP clang-format is unavailable')

    await openFromExplorer(page, project.files[0], 'Ion fixture')
    await format(page).click()
    await message(page, 'No formatter configured for this language.').waitFor()
    await atPath(page, 'explorer-entry', csv).click()
    await atPath(page, 'tab', csv).waitFor()
    assert.equal(await format(page).isDisabled(), true)
    assert.equal(await readFile(csv, 'utf8'), 'kind,count\na,1\n')
    await atPath(page, 'explorer-entry', large).click()
    await page.getByText('UTF-8 · Read only', { exact: true }).waitFor()
    assert.equal(await format(page).isDisabled(), true)
    assert.equal(await readFile(sibling, 'utf8'), 'int other(){return 0;}\n')
    console.log('PASS unsupported language feedback, disabled read-only viewer and untouched sibling')

    if (ruffAvailable || blackAvailable) {
      await openFromExplorer(page, python, '"label"')
      await format(page).click()
      await message(page, ruffAvailable ? 'Formatted with Ruff.' : 'Formatted with Black.').waitFor()
      await buffer(page, ruffAvailable ? "{'label': 'Ion'}" : '{"label": "Ion"}')
      if (blackAvailable && ruffAvailable) {
        await preferences(page, async (dialog) => {
          await dialog.getByLabel('Python formatter').selectOption('black')
        })
        await format(page).click()
        await buffer(page, '{"label": "Ion"}')
        assert.equal((await page.evaluate(() => window.ion.getPreferences())).settings.pythonFormatter, 'black')
      }
      console.log('PASS local Python formatting with project settings and persisted formatter choice')
    } else console.log('SKIP Ruff and Black are unavailable')

    await openFromExplorer(page, paths.get('web.js'), 'const data=')
    if (prettierAvailable) {
      for (const [name, text, expected] of web) {
        await openFromExplorer(page, paths.get(name), text.split('\n')[0])
        await format(page).click()
        await message(page, 'Formatted with Prettier.').waitFor()
        await buffer(page, expected)
        if (name === 'web.ts') assert.ok(!(await viewLine(page).textContent()).trimEnd().endsWith(';'))
        if (name === 'web.css') {
          await shortcut(app, 'S', [process.platform === 'darwin' ? 'meta' : 'control'])
          await eventually(async () => (await readFile(paths.get(name), 'utf8')).includes('\n\tcolor: red;'),
            'Prettier did not use the project EditorConfig indentation.')
        }
      }
      await atPath(page, 'tab', paths.get('web.js')).locator('.tab-name').click()
      await replace(page, 'const broken={\n')
      await format(page).click()
      await message(page, /Prettier could not format this file/).waitFor()
      await buffer(page, 'const broken={')
      await writeFile(join(project.directory, '.prettierrc.json'), '{"plugins":["./untrusted-plugin.cjs"]}')
      await replace(page, 'const data={value:1}\n')
      await format(page).click()
      await message(page, /built-in parsers only/).waitFor()
      await buffer(page, 'const data={value:1}')
      console.log('PASS JavaScript, TypeScript, HTML, CSS, JSON and Markdown, malformed source recovery and blocked plugins')
    } else {
      await format(page).click()
      await message(page, /Install Prettier and Node.js/).waitFor()
      console.log('SKIP Prettier language fixtures, verified missing-tool setup message')
    }

    await page.getByTestId('command-palette').click()
    await page.getByTestId('command-palette-input').fill('New File from Starter')
    await page.getByRole('option', { name: /^New File from Starter/ }).click()
    const starter = page.getByRole('dialog')
    await starter.getByRole('button', { name: /^C / }).first().click()
    await buffer(page, '#include')
    if (clangAvailable) {
      await replace(page, 'int main(void){return 0;}\n')
      await format(page).click()
      await buffer(page, 'int main(void) { return 0; }')
      assert.ok((await page.getByTestId('tab').last().getAttribute('data-path')) === null)
    }
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
  } catch (error) {
    console.error(await page.getByTestId('status').innerText().catch(() => ''))
    console.error(await page.locator('.monaco-editor .view-lines').allTextContents().catch(() => []))
    console.error(JSON.stringify(await readFile(project.program, 'utf8')))
    throw error
  } finally { await quit(session) }

  if (process.platform === 'win32') return
  // A slow disposable tool tests cancellation and races deterministically.
  // Language-format output above comes from the actual installed tools.
  await rm(join(project.directory, '.prettierrc.json'))
  const wrapper = join(tools, 'prettier')
  await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs')
process.stdin.resume()
fs.appendFileSync(${JSON.stringify(startMarker)}, process.pid + '\\n')
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(finishMarker)})) return
  clearInterval(wait)
  process.stdout.write('const slow = { value: 1 };\\n')
}, 15)
`, { mode: 0o700 })
  const oldPath = process.env.PATH
  process.env.PATH = [tools, oldPath].join(delimiter)
  const raceProfile = join(scratch, 'race-profile')
  await mkdir(raceProfile)
  await writeFile(join(raceProfile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false, openFullScreen: false } }))
  const race = await launch(target, raceProfile)
  process.env.PATH = oldPath
  const childPid = async () => Number((await readFile(startMarker, 'utf8')).trim().split('\n').at(-1))
  const reaped = async (pid) => eventually(async () => !(await resourceSnapshot(race, { details: true })).members.some((item) => item.pid === pid),
    'Formatter process was not reaped.')
  async function begin() {
    await rm(startMarker, { force: true })
    await rm(finishMarker, { force: true })
    await format(race.page).click()
    await eventually(() => exists(startMarker), 'Formatter fixture did not start.')
    return childPid()
  }
  try {
    await race.page.context().setOffline(true)
    await stubDialogs(race.app, { folder: project.directory })
    await openFolder(race.page, project)
    await openFromExplorer(race.page, project.files[0], 'Ion fixture')
    await openFromExplorer(race.page, slow, 'const slow={')
    const pid = await begin()
    await format(race.page).evaluate((node) => { for (let i = 0; i < 20; i++) node.click() })
    assert.equal((await readFile(startMarker, 'utf8')).trim().split('\n').length, 1)
    await viewLine(race.page).click()
    await race.page.keyboard.press('End')
    await race.page.keyboard.insertText(' // newer')
    await message(race.page, 'Document changed. Formatting skipped.').waitFor()
    await buffer(race.page, '// newer')
    await reaped(pid)
    const switched = await begin()
    await atPath(race.page, 'tab', project.files[0]).locator('.tab-name').click()
    await message(race.page, 'Formatting cancelled.').waitFor()
    await reaped(switched)
    await atPath(race.page, 'tab', slow).locator('.tab-name').click()
    await buffer(race.page, '// newer')
    const escaped = await begin()
    await race.page.keyboard.press('Escape')
    await message(race.page, 'Formatting cancelled.').waitFor()
    await reaped(escaped)
    const timedOut = await begin()
    await message(race.page, 'Prettier timed out.').waitFor({ timeout: 13_000 })
    await buffer(race.page, '// newer')
    await reaped(timedOut)
    const external = await begin()
    await writeFile(slow, 'const fromDisk=2\n')
    await writeFile(finishMarker, 'ready')
    await message(race.page, 'File changed on disk. Review the conflict before formatting.').waitFor()
    await buffer(race.page, '// newer')
    assert.equal(await readFile(slow, 'utf8'), 'const fromDisk=2\n')
    assert.equal(await format(race.page).isDisabled(), true)
    await reaped(external)
    assert.deepEqual(race.requests, [])
    console.log('PASS one worker for rapid clicks, edit/tab/Escape cancellation, disk conflict, unchanged drafts and process reaping')
  } finally { await quit(race) }
})
