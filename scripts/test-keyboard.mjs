import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const modifier = process.platform === 'darwin' ? 'meta' : 'control'

// Send native workbench input through Electron's accelerator/renderer boundary.
async function shortcut(app, keyCode, modifiers = []) {
  await app.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', ...input })
    window.webContents.sendInputEvent({ type: 'keyUp', ...input })
  }, { keyCode, modifiers })
}

async function command(session, label) {
  await session.page.getByTestId('command-palette').click()
  const input = session.page.getByTestId('command-palette-input')
  await input.fill(label)
  await session.page.getByRole('option', { name: new RegExp(label, 'i') }).first().waitFor()
  await input.press('Enter')
  await input.waitFor({ state: 'detached' })
}

async function quickOpen(session, query, option) {
  await shortcut(session.app, 'P', [modifier])
  const input = session.page.getByTestId('quick-open-input')
  await input.fill(query)
  await session.page.getByRole('option', { name: option }).waitFor()
  assert.ok(await input.getAttribute('aria-activedescendant'), 'The active option is exposed to assistive technology.')
  await input.press('Enter')
}

await withScratch('keyboard', async (scratch) => {
  const project = await createProject(join(scratch, 'keyboard workspace'))
  const profile = join(scratch, 'profile')
  const nested = join(project.directory, 'nested')
  const source = join(nested, 'deep target.c')
  const table = join(nested, 'reference.csv')
  const otherSource = join(nested, 'other.c')
  const external = join(scratch, 'private.c')
  const replaceTarget = join(nested, 'replace.txt')
  await Promise.all([mkdir(profile), mkdir(nested)])
  await Promise.all([
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false } })),
    writeFile(source, '#include <stdio.h>\nint main(void) {\n    puts("ION-KEYBOARD-INPUT");\n    fflush(stdout);\n    return getchar() == EOF;\n}\n' + Array.from({ length: 180 }, (_, index) => `// scroll fixture ${index}`).join('\n') + '\n'),
    writeFile(table, 'heading,note\n1,keyboard reference\n'),
    writeFile(otherSource, 'int other(void) { return 42; }\n'),
    writeFile(external, 'private'),
    writeFile(replaceTarget, 'ION-REVIEWED-OLD twice ION-REVIEWED-OLD\n'),
    symlink(external, join(nested, 'secret alias.c')),
  ])
  const session = await launch(target, profile)
  let workflowError
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    await shortcut(app, 'P', [modifier, 'shift'])
    await page.getByTestId('command-palette-input').waitFor()
    await page.keyboard.press('Escape')
    await shortcut(app, 'P', [modifier])
    const quick = page.getByTestId('quick-open-input')
    await quick.fill('secret alias')
    await page.getByText('Type a filename or workspace path.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('listbox', { name: 'Quick Open File' }).getByRole('option').count(), 0)
    await quick.press('Escape')
    await quick.waitFor({ state: 'detached' })
    await quickOpen(session, 'deep target', /deep target\.c/)
    await atPath(page, 'tab', source).waitFor()
    await editorShows(page, 'ION-KEYBOARD-INPUT')
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
      .some(({ name }) => /\/multicursor-[^/]+\.js(?:$|\?)/.test(name))), false,
    'The multi-cursor contribution must stay unloaded during ordinary editing.')
    await command(session, 'Add Cursor Below')
    await page.waitForFunction(() => document.querySelectorAll('.monaco-editor .cursor').length >= 2)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('.monaco-editor .cursor').length === 1)
    console.log('PASS keyboard multi-cursor action adds and clears a secondary cursor without editing')

    await page.getByTestId('source-split-toggle').click()
    const sourceSplit = page.locator('[data-source-split="true"]')
    await sourceSplit.waitFor()
    assert.equal(await sourceSplit.locator('.monaco-editor').count(), 2)
    await command(session, 'Focus Second Editor')
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('.secondary-monaco-host')))
    await page.keyboard.insertText('Z')
    await page.waitForFunction(() => [...document.querySelectorAll('.monaco-editor')]
      .every((editor) => editor.textContent?.includes('Z')))
    await shortcut(app, 'Z', [modifier])
    await page.waitForFunction(() => [...document.querySelectorAll('.monaco-editor')]
      .every((editor) => !editor.textContent?.includes('Z')))
    const secondaryEditor = page.locator('.secondary-monaco-host .monaco-editor')
    await secondaryEditor.hover()
    await page.mouse.wheel(0, 10_000)
    await secondaryEditor.locator('.view-line').last().click()
    const secondaryLine = Number((await page.getByText(/^Ln \d+, Col /).textContent()).match(/Ln (\d+)/)?.[1])
    assert.ok(secondaryLine > 20, 'The second editor must scroll independently into the lower source.')
    await command(session, 'Focus Code Editor')
    await page.locator('.primary-monaco-host .view-line').first().click()
    const primaryLine = Number((await page.getByText(/^Ln \d+, Col /).textContent()).match(/Ln (\d+)/)?.[1])
    assert.ok(primaryLine < secondaryLine, 'The primary editor must retain its own cursor and scroll position.')
    await shortcut(app, 'S', [modifier])
    await eventually(async () => !/\btab-dirty\b/.test(await atPath(page, 'close-tab', source).getAttribute('class') ?? ''),
      'Saving after split-editor Undo did not clear the disposable tab.')
    const sourceDivider = page.getByRole('separator', { name: 'Resize code editor split' })
    const sourcePercent = Number(await sourceDivider.getAttribute('aria-valuenow'))
    await sourceDivider.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(Number(await sourceDivider.getAttribute('aria-valuenow')), sourcePercent + 3)
    await page.getByTestId('source-split-toggle').click()
    await sourceSplit.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.secondary-monaco-host').count(), 0)
    console.log('PASS source split shares one undoable model, resizes by keyboard, and disposes on close')

    await page.getByTestId('editor-group-split-right').click()
    const editorGroups = page.getByTestId('editor-group')
    await eventually(async () => await editorGroups.count() === 2, 'The second editor group did not open.')
    const firstGroupEditor = page.locator('[data-testid="editor-group"][data-group-id="group-1"] .monaco-editor')
    await firstGroupEditor.evaluate((element) => element.setAttribute('data-ion-identity', 'preserved'))
    await page.locator('[data-testid="editor-group"][data-group-id="group-2"] .monaco-editor').click()
    await page.keyboard.insertText('Q')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="editor-group"] .monaco-editor')]
      .every((editor) => editor.textContent?.includes('Q')))
    await shortcut(app, 'Z', [modifier])
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="editor-group"] .monaco-editor')]
      .every((editor) => !editor.textContent?.includes('Q')))
    await quickOpen(session, 'other.c', /other\.c/)
    await page.locator('[data-testid="editor-group"][data-group-id="group-2"]').getByText('int other').waitFor()
    await firstGroupEditor.click()
    assert.equal(await firstGroupEditor.getAttribute('data-ion-identity'), 'preserved', 'Focusing another group must not recreate its Monaco editor.')
    assert.equal(await page.locator('[data-testid="editor-group"][data-group-id="group-1"] [data-testid="group-tab"]').count(), 1)
    assert.equal(await page.locator('[data-testid="editor-group"][data-group-id="group-2"] [data-testid="group-tab"]').count(), 2)
    const otherGroupTab = page.locator('[data-testid="editor-group"][data-group-id="group-2"] [data-testid="group-tab"]')
      .filter({ has: page.getByText('other.c', { exact: true }) })
    await otherGroupTab.dragTo(page.locator('[data-testid="editor-group"][data-group-id="group-1"] .tab-scroll'))
    await eventually(async () => await page.locator('[data-testid="editor-group"][data-group-id="group-1"] [data-testid="group-tab"]').count() === 2,
      'Dragging a tab did not move it into the target group.')
    await page.locator('[data-testid="editor-group"][data-group-id="group-2"]').getByRole('button', { name: 'Close editor group' }).click()
    await eventually(async () => await editorGroups.count() === 0, 'Closing the editor group did not return to the single-editor layout.')
    await page.getByTestId('tab').filter({ has: page.getByText('other.c', { exact: true }) }).waitFor()
    await atPath(page, 'close-tab', otherSource).click()
    await atPath(page, 'tab', source).locator('.tab-name').click()
    console.log('PASS different-file editor groups share models, open independently, and rebalance on close')

    await shortcut(app, 'G', ['control'])
    const line = page.getByTestId('goto-line-input')
    await line.fill('999')
    assert.equal(await page.getByRole('button', { name: 'Go', exact: true }).isEnabled(), false)
    await line.fill('4')
    await line.press('Enter')
    await page.getByText('Ln 4, Col 1', { exact: true }).waitFor()
    await command(session, 'Toggle Explorer')
    await page.getByTestId('explorer').waitFor({ state: 'detached' })
    await shortcut(app, 'B', [modifier])
    await page.getByTestId('explorer').waitFor()
    console.log('PASS native keyboard dispatch, scoped Quick Open, Go to Line and command palette panel toggles')

    await page.locator('.monaco-editor .view-line').first().click()
    await page.keyboard.insertText('X')
    await eventually(async () => /\btab-dirty\b/.test(await atPath(page, 'close-tab', source).getAttribute('class') ?? ''),
      'The source tab did not report its modified buffer before workspace replacement review.')
    await command(session, 'Search in Files')
    let search = page.getByRole('dialog', { name: 'Search in Files' })
    await search.getByTestId('workspace-search-input').fill('ION-REVIEWED-OLD')
    await search.getByRole('button', { name: 'Replace in files…' }).click()
    await search.getByText(/Save or close 1 modified workspace file/).waitFor()
    assert.equal(await search.getByRole('button', { name: 'Review replacements' }).isDisabled(), true)
    await search.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await search.waitFor({ state: 'detached' })
    await command(session, 'Focus Code Editor')
    await shortcut(app, 'Z', [modifier])
    await shortcut(app, 'S', [modifier])

    await command(session, 'Search in Files')
    search = page.getByRole('dialog', { name: 'Search in Files' })
    await search.getByTestId('workspace-search-input').fill('ION-REVIEWED-OLD')
    await search.getByRole('button', { name: 'Replace in files…' }).click()
    await search.getByRole('textbox', { name: 'Replacement text' }).fill('ION-REVIEWED-NEW')
    await search.getByRole('button', { name: 'Review replacements' }).click()
    await search.getByText(/Review 2 replacements in 1 files/).waitFor()
    await search.getByRole('button', { name: 'Replace in 1 files' }).click()
    await eventually(async () => (await readFile(replaceTarget, 'utf8')).includes('ION-REVIEWED-NEW'), 'Reviewed replacement was not published.')
    await search.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await search.waitFor({ state: 'detached' })
    console.log('PASS workspace replacement reviews the exact selection and publishes through the safe save path')

    await quickOpen(session, 'reference.csv', /reference\.csv/)
    await page.getByTestId('table-grid').getByText('keyboard reference').waitFor()
    const tabPaths = () => page.getByTestId('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-path')))
    assert.deepEqual(await tabPaths(), [source, table])
    await command(session, 'Move Tab Left')
    await eventually(async () => JSON.stringify(await tabPaths()) === JSON.stringify([table, source]), 'Move Tab Left did not reorder the tabs.')
    assert.equal(await atPath(page, 'tab', table).locator('.tab-name').getAttribute('aria-current'), 'true')
    await command(session, 'Move Tab Right')
    await eventually(async () => JSON.stringify(await tabPaths()) === JSON.stringify([source, table]), 'Move Tab Right did not reorder the tabs.')
    console.log('PASS keyboard tab reordering preserves the active tab')
    await command(session, 'Toggle Document Split')
    await page.getByTestId('document-split').waitFor()
    await command(session, 'Focus Document Split Divider')
    const divider = page.getByRole('separator', { name: 'Resize document split' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Resize document split')
    const previous = Number(await divider.getAttribute('aria-valuenow'))
    await page.keyboard.press('ArrowRight')
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), previous + 3)
    await command(session, 'Toggle Document Split')
    await page.getByTestId('document-split').waitFor({ state: 'detached' })
    await command(session, 'Preferences')
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await preferences.getByText('Keyboard Shortcuts', { exact: true }).click()
    const selected = page.getByTestId('shortcut-command')
    const binding = page.getByTestId('shortcut-binding')
    const apply = page.getByTestId('shortcut-apply')
    await selected.selectOption('run')
    await binding.fill('Mod+B')
    await apply.click()
    await preferences.getByRole('alert').getByText(/already assigned/i).waitFor()
    for (const [id, key] of [['run', 'F6'], ['stop', 'F7']]) {
      await selected.selectOption(id)
      await binding.fill(key)
      await apply.click()
      await preferences.getByText('Shortcut saved.', { exact: true }).waitFor()
    }
    await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    await shortcut(app, 'F6')
    await page.getByTestId('run-console-terminal').getByText('ION-KEYBOARD-INPUT', { exact: true }).waitFor()
    await shortcut(app, 'F7')
    await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor()
    console.log('PASS keyboard document split, reserved shortcut detection, remapped Run and Stop')
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
  } catch (error) {
    workflowError = error
    throw error
  } finally {
    try { await close(session) }
    catch (closeError) {
      if (workflowError) throw new AggregateError([workflowError, closeError], 'Editor workflow and cleanup both failed.')
      throw closeError
    }
  }

  const reopened = await launch(target, profile)
  try {
    await eventually(() => reopened.page.evaluate(async () => {
      const { shortcuts } = (await window.ion.getPreferences()).settings
      return shortcuts.run === 'F6' && shortcuts.stop === 'F7'
    }), 'Keyboard overrides must survive a real relaunch.')
    await shortcut(reopened.app, 'P', [modifier, 'shift'])
    await reopened.page.getByTestId('command-palette-input').waitFor()
    await reopened.page.keyboard.press('Escape')
    console.log('PASS keyboard overrides survive a profile relaunch')
  } finally {
    await close(reopened)
  }
})
