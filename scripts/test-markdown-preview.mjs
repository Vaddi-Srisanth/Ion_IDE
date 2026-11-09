import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder,
  openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'
import { savedPlotPng } from './notebook-fixtures.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  coupling: { type: 'string' },
} })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use an unpackaged production build with the desktop harness.')

const marker = 'IONUNSAVEDMARKDOWNTEXT'
const splitMarker = 'ION live split update'
const editLine = 'ION cursor and scroll target'
const explicitLink = 'https://example.invalid/ion-explicit-link'
const commandModifier = process.platform === 'darwin' ? 'meta' : 'control'
const examples = [
  ['c', 'int main(void) { return 0; }'],
  ['cpp', 'int main() { return 0; }'],
  ['java', 'public class Preview { private final int value = 3; }'],
  ['python', 'def example():\n    return 3'],
  ['javascript', 'const example = () => 3;'],
  ['html', '<section class="example">Code only</section>'],
  ['css', '.example { color: red; }'],
]
const fixtureLines = [
  '# Ion Markdown fixture', '',
  '**Important** and *emphasized* with `inline code`.', '',
  '1. First ordered item', '2. Second ordered item', '',
  '- First unordered item', '- Second unordered item', '',
  '- [x] Completed task', '- [ ] Pending task', '',
  '> This is a quote.', '',
  '| Language | Example |', '| --- | --- |', '| Java | Coupling |', '',
  '[Jump to examples](#examples)', '',
  '[Linked Markdown](Linked%20Note.markdown)', '',
  `[Open a web link](${explicitLink})`, '',
  '![Local chart](../images/space%20chart.png)', '',
  '![Outside chart](../../outside.png)', '',
  '![Symlink chart](../images/symlink.png)', '',
  '![Remote chart](https://example.invalid/ion-tracker.png)', '',
  '[Script link](javascript:alert%281%29)', '',
  '[File link](file:///etc/passwd)', '',
  '<script>window.ionPreviewExecuted = true</script>', '',
  '<img src="https://example.invalid/ion-html-tracker.png" onerror="window.ionPreviewExecuted=true">', '',
  '<iframe src="https://example.invalid/ion-frame"></iframe>', '',
  '<a href="javascript:alert(1)" onclick="window.ionPreviewExecuted=true">HTML script link</a>', '',
  '---', '', '## Examples', '',
  ...examples.flatMap(([language, source]) => ['```' + language, source, '```', '']),
  ...Array.from({ length: 115 }, (_, index) => [`## Long section ${index + 1}`, '', 'Content to create a real scroll range.', '']).flat(),
  editLine, '',
  ...Array.from({ length: 30 }, (_, index) => [`## Tail section ${index + 1}`, '', 'More content after the cursor.', '']).flat(),
]
const fixtureText = fixtureLines.join('\n')

async function shortcut(app, keyCode, modifiers = []) {
  await app.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', ...input })
    window.webContents.sendInputEvent({ type: 'keyUp', ...input })
  }, { keyCode, modifiers })
}

async function goToLine(session, line) {
  await shortcut(session.app, 'G', ['control'])
  const input = session.page.getByTestId('goto-line-input')
  await input.fill(String(line))
  await input.press('Enter')
  await session.page.waitForFunction(() => Boolean(document.activeElement?.closest('[data-testid="editor"] .monaco-editor')))
  await session.page.getByText(`Ln ${line}, Col 1`, { exact: true }).waitFor()
}

async function editorText(page, text) {
  const handle = await editorShows(page, text)
  await handle.dispose()
}

async function selectTab(page, path) {
  await atPath(page, 'tab', path).locator('.tab-name').click()
}

async function sourceScroll(editor) {
  return editor.locator('.monaco-editor').evaluate((node) => {
    const slider = node.querySelector('.scrollbar.vertical .slider')
    return Math.round(slider?.getBoundingClientRect().top - node.getBoundingClientRect().top)
  })
}

async function watchImageUrls(page) {
  await page.evaluate(() => {
    const activeUrls = new Set()
    const originalCreate = URL.createObjectURL.bind(URL)
    const originalRevoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (value) => {
      const url = originalCreate(value)
      if (value.type?.startsWith('image/')) activeUrls.add(url)
      return url
    }
    URL.revokeObjectURL = (url) => { activeUrls.delete(url); originalRevoke(url) }
    window.ionTestMarkdownUrls = activeUrls
  })
}

async function expectClosedPreview(page, preview) {
  await preview.waitFor({ state: 'hidden' })
  assert.ok(await preview.count() <= 1, 'Source mode can retain at most one preview pane.')
  await preview.locator('img').first().waitFor({ state: 'detached' })
  await eventually(() => page.evaluate(() => window.ionTestMarkdownUrls.size === 0),
    'Hidden Markdown previews must release image object URLs.')
}

await withScratch('markdown-preview', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  const docs = join(project.directory, 'docs')
  const images = join(project.directory, 'images')
  const coupling = join(project.directory, 'Coupling.md')
  const fixture = join(docs, 'Preview.md')
  const linked = join(docs, 'Linked Note.markdown')
  const outside = join(scratch, 'outside.png')
  const originalCoupling = values.coupling ? await readFile(values.coupling)
    : Buffer.from('# Coupling\n\nA test for related Java classes.\n\n```java\npublic class Example { private int count = 3; }\n```\n')
  const verifyOriginal = async () => {
    if (values.coupling) assert.deepEqual(await readFile(values.coupling), originalCoupling)
  }
  const couplingHeading = /^#\s+(.+?)\s*$/m.exec(originalCoupling.toString('utf8'))?.[1]
  assert.ok(couplingHeading, 'The requested Coupling.md must contain its Markdown heading.')
  await Promise.all([mkdir(docs), mkdir(images)])
  await Promise.all([
    writeFile(coupling, originalCoupling), writeFile(fixture, fixtureText),
    writeFile(linked, '# Linked Markdown note\n\nThis tab uses the long Markdown extension.\n'),
    writeFile(join(images, 'space chart.png'), savedPlotPng(160, 96)), writeFile(outside, savedPlotPng(32, 24)),
    symlink(outside, join(images, 'symlink.png')),
  ])
  const session = await launch(target, profile)
  const { app, page } = session
  const preview = page.getByTestId('markdown-preview')
  const toggle = page.getByTestId('markdown-preview-toggle')
  const split = page.getByTestId('markdown-split-toggle')
  const editor = page.getByTestId('editor')
  let completed = false
  let step = 'open the real Coupling document'
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await app.evaluate(({ shell }) => {
      globalThis.ionTestMarkdownExternal = []
      shell.openExternal = async (url) => { globalThis.ionTestMarkdownExternal.push(url) }
    })
    await watchImageUrls(page)
    await page.getByTestId('settings').click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Autosave/ }).uncheck()
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await eventually(() => page.evaluate(async () => !(await window.ion.getPreferences()).settings.autoSave),
      'The disposable workspace must have autosave disabled.')
    await openFolder(page, project)

    const debuggerSession = await page.context().newCDPSession(page)
    const parsedScripts = new Set()
    debuggerSession.on('Debugger.scriptParsed', ({ url }) => parsedScripts.add(url))
    await debuggerSession.send('Debugger.enable')
    const markdownLoaded = () => [...parsedScripts].some((url) => /\/MarkdownPreview(?:-[^/?]+)?\.js(?:\?|$)/.test(url))
    try {
      await openFromExplorer(page, project.program, '#include')
      assert.equal(await toggle.count(), 0)
      assert.equal(await split.count(), 0)
      assert.equal(await preview.count(), 0)
      assert.equal(markdownLoaded(), false, 'Ordinary code editing must leave the preview bundle unloaded.')

      await openFromExplorer(page, coupling, couplingHeading)
      assert.equal(markdownLoaded(), false, 'Opening Markdown in source mode must leave the preview bundle unloaded.')
      await toggle.click()
      await preview.getByRole('heading', { level: 1, name: couplingHeading }).waitFor()
      assert.equal(markdownLoaded(), true, 'Opening preview should load its renderer bundle.')
      await preview.locator('[data-language="java"] [class^="mtk"]').first().waitFor({ state: 'attached' })
      assert.equal(await editor.isVisible(), false, 'Full preview should hide the Monaco editor.')
      assert.equal(await preview.locator('[contenteditable="true"]').count(), 0)
      await toggle.click()
      await expectClosedPreview(page, preview)
      await editorText(page, couplingHeading)
      assert.deepEqual(await readFile(coupling), originalCoupling)
      console.log('PASS Coupling.md opens as source, renders Java in preview, and returns without writing the file')
    } finally {
      await debuggerSession.detach()
    }

    step = 'render synthetic Markdown and check asset policy'
    await atPath(page, 'explorer-entry', docs).click()
    await openFromExplorer(page, fixture, '# Ion Markdown fixture')
    await toggle.click()
    await preview.getByRole('heading', { name: 'Ion Markdown fixture' }).waitFor()
    await preview.locator('strong').filter({ hasText: 'Important' }).waitFor()
    await preview.locator('em').filter({ hasText: 'emphasized' }).waitFor()
    await preview.locator('ol li').filter({ hasText: 'First ordered item' }).waitFor()
    await preview.locator('ul li').filter({ hasText: 'First unordered item' }).waitFor()
    await preview.locator('blockquote').getByText('This is a quote.', { exact: true }).waitFor()
    await preview.locator('p code').filter({ hasText: 'inline code' }).waitFor()
    assert.equal(await preview.locator('hr').count(), 1)
    await preview.getByRole('table').getByRole('cell', { name: 'Coupling' }).waitFor()
    const tasks = preview.getByRole('checkbox')
    assert.equal(await tasks.count(), 2)
    assert.equal(await tasks.first().isChecked(), true)
    assert.equal(await tasks.last().isChecked(), false)
    assert.equal(await tasks.first().isDisabled(), true)
    assert.equal(await tasks.last().isDisabled(), true)
    for (const [language] of examples) {
      const block = preview.locator(`[data-language="${language}"]`).first()
      await block.scrollIntoViewIfNeeded()
      await block.locator('[class^="mtk"]').first().waitFor({ state: 'attached' })
    }
    await eventually(() => preview.locator('[data-language="java"] [class^="mtk"]').evaluateAll((tokens) =>
      new Set(tokens.map((token) => getComputedStyle(token).color)).size > 1),
    'Java tokens should have multiple visible syntax colors.')

    const localImage = preview.getByRole('img', { name: 'Local chart' })
    const imageHolder = preview.locator('.markdown-image').filter({ hasText: 'Local chart' })
      .or(preview.locator('.markdown-image').filter({ has: page.getByRole('img', { name: 'Local chart' }) }))
    await imageHolder.scrollIntoViewIfNeeded()
    await localImage.waitFor()
    await eventually(() => localImage.evaluate((image) => image.complete && image.naturalWidth === 160 && image.naturalHeight === 96),
      'The approved relative PNG should decode at its original size.')
    assert.match(await localImage.getAttribute('src'), /^blob:/)
    for (const alt of ['Outside chart', 'Symlink chart', 'Remote chart']) {
      assert.equal(await preview.getByRole('img', { name: alt }).count(), 0)
    }
    const disallowed = ['../../outside.png', '../images/symlink.png', '%2e%2e/%2e%2e/outside.png',
      'https://example.invalid/ion-tracker.png', 'file:///etc/passwd']
    for (const href of disallowed) {
      const accepted = await page.evaluate(async ({ fixture, href }) => {
        try { await window.ion.markdown.readImage(fixture, href); return true }
        catch { return false }
      }, { fixture, href })
      assert.equal(accepted, false, `The image bridge must reject ${href}.`)
    }
    assert.equal(await preview.locator('script, iframe, [onerror], [onclick], a[href^="javascript:"], a[href^="file:"]').count(), 0)
    assert.equal(await page.evaluate(() => window.ionPreviewExecuted), undefined)
    assert.deepEqual(await app.evaluate(() => globalThis.ionTestMarkdownExternal), [])
    await preview.getByRole('link', { name: 'Open a web link' }).click()
    await eventually(async () => (await app.evaluate(() => globalThis.ionTestMarkdownExternal)).includes(explicitLink),
      'An explicit safe link click should open the URL in the system browser.')
    await preview.getByRole('link', { name: 'Jump to examples' }).click()
    await preview.getByRole('heading', { name: 'Examples' }).waitFor({ state: 'visible' })
    const articleScroll = await preview.evaluate((node) => node.scrollTop)
    assert.ok(articleScroll > 0, 'A heading link should scroll within the preview.')
    await toggle.click()
    await expectClosedPreview(page, preview)
    await toggle.click()
    await preview.getByRole('heading', { name: 'Examples' }).waitFor()
    await eventually(() => preview.evaluate((node, previous) => Math.abs(node.scrollTop - previous) <= 3, articleScroll),
      'The preview should remember its scroll position independently of the editor.')
    await preview.getByRole('link', { name: 'Linked Markdown' }).click()
    await atPath(page, 'tab', linked).waitFor()
    await editorText(page, 'Linked Markdown note')
    assert.equal(await toggle.isVisible(), true)
    await expectClosedPreview(page, preview)
    console.log('PASS offline GFM, seven highlighted languages, scoped images and safe link handling')

    step = 'place the cursor and edit unsaved Markdown'
    await selectTab(page, fixture)
    await preview.getByRole('heading', { name: 'Ion Markdown fixture' }).waitFor()
    await toggle.click()
    await expectClosedPreview(page, preview)
    const line = fixtureText.split('\n').indexOf(editLine) + 1
    await goToLine(session, line)
    await editorText(page, editLine)
    await eventually(async () => await sourceScroll(editor) > 0, 'The test must exercise a scrolled editor.')
    await page.keyboard.insertText(marker)
    await editorText(page, marker)
    await page.getByText(`Ln ${line}, Col ${marker.length + 1}`, { exact: true }).waitFor()
    const beforeToggle = await sourceScroll(editor)
    step = 'restore editor cursor and scroll after preview'
    await toggle.click()
    await preview.getByText(new RegExp(marker)).waitFor()
    assert.equal(await readFile(fixture, 'utf8'), fixtureText, 'Preview must leave the original source bytes on disk.')
    await toggle.click()
    await expectClosedPreview(page, preview)
    await page.getByText(`Ln ${line}, Col ${marker.length + 1}`, { exact: true }).waitFor()
    await eventually(async () => Math.abs(await sourceScroll(editor) - beforeToggle) <= 3,
      'Source scrolling should return to its former position.')
    step = 'undo the unsaved edit and resize Markdown split'
    await editorText(page, marker)
    const focus = await page.evaluate(() => ({
      editor: Boolean(document.activeElement?.closest('.monaco-editor')),
      tag: document.activeElement?.tagName,
      action: document.activeElement?.getAttribute('aria-label'),
    }))
    assert.equal(focus.editor, true, `Source should restore editor focus after preview (${focus.tag} ${focus.action ?? ''}).`)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await eventually(async () => {
      const text = (await editor.locator('.view-lines').textContent())?.replaceAll('\u00a0', ' ')
      return text?.includes(editLine) && !text.includes(marker)
    }, 'Undo must remove the unsaved text in Monaco.')
    await split.click()
    await preview.getByRole('heading', { name: 'Ion Markdown fixture' }).waitFor()
    assert.equal(await preview.getByText(new RegExp(marker)).count(), 0, 'Undo must still work after toggling preview.')
    assert.equal(await editor.isVisible(), true)
    assert.equal(await page.locator('.monaco-editor').count(), 1)
    const divider = page.getByRole('separator', { name: /resize.*markdown/i })
    const initialWidth = (await editor.boundingBox()).width
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await eventually(async () => (await editor.boundingBox()).width > initialWidth, 'Keyboard resizing must grow the source pane.')

    step = 'observe the live split edit and switch tabs'
    await goToLine(session, line)
    await page.keyboard.insertText(splitMarker + ' ')
    await preview.getByText(new RegExp(splitMarker)).waitFor()
    assert.equal(await readFile(fixture, 'utf8'), fixtureText)
    await selectTab(page, coupling)
    await editorText(page, couplingHeading)
    await expectClosedPreview(page, preview)
    await selectTab(page, fixture)
    await preview.getByText(new RegExp(splitMarker)).waitFor()
    assert.equal(await editor.isVisible(), true)
    console.log('PASS unsaved live content, Monaco undo and position, split resize and independent tab modes')

    step = 'check native shortcuts and remember mode after reopen'
    await selectTab(page, linked)
    await editorText(page, 'Linked Markdown note')
    await shortcut(app, 'M', [commandModifier, 'shift'])
    await preview.getByRole('heading', { name: 'Linked Markdown note' }).waitFor()
    await preview.evaluate((node) => { node.dataset.markdownQaClosing = 'true' })
    await atPath(page, 'close-tab', linked).click()
    await atPath(page, 'tab', linked).waitFor({ state: 'detached' })
    await page.locator('[data-markdown-qa-closing]').waitFor({ state: 'detached' })
    await atPath(page, 'explorer-entry', linked).click()
    await preview.getByRole('heading', { name: 'Linked Markdown note' }).waitFor()
    await shortcut(app, 'M', [commandModifier, 'alt', 'shift'])
    await page.locator('[data-markdown-mode="split"]').waitFor()
    await preview.getByRole('heading', { name: 'Linked Markdown note' }).waitFor()
    await shortcut(app, 'M', [commandModifier, 'alt', 'shift'])
    await expectClosedPreview(page, preview)
    await editorText(page, 'Linked Markdown note')
    await shortcut(app, 'M', [commandModifier, 'shift'])
    await preview.getByRole('heading', { name: 'Linked Markdown note' }).waitFor()
    console.log('PASS native preview and split shortcuts and remembered mode after closing and reopening')

    await selectTab(page, fixture)
    await atPath(page, 'close-tab', fixture).click()
    const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' })
    await unsaved.getByRole('button', { name: 'Discard', exact: true }).click()
    await atPath(page, 'tab', fixture).waitFor({ state: 'detached' })
    await selectTab(page, project.program)
    await editorText(page, '#include')
    assert.equal(await toggle.count(), 0)
    assert.equal(await split.count(), 0)
    await preview.waitFor({ state: 'detached' })
    await expectClosedPreview(page, preview)
    assert.equal(app.windows().length, 1, 'Source and preview should share the workbench window.')
    assert.equal(await readFile(fixture, 'utf8'), fixtureText)
    await verifyOriginal()
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    completed = true
  } catch (error) {
    console.error(`Markdown desktop check failed while trying to ${step}.`)
    throw error
  } finally {
    const closing = close(session)
    if (!completed) {
      await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard', exact: true })
        .click({ timeout: 1800 }).catch(() => {})
    }
    await closing.catch((error) => { if (completed) throw error })
  }

  const reopened = await launch(target, profile)
  try {
    const { app, page } = reopened
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await atPath(page, 'explorer-entry', docs).click()
    await atPath(page, 'explorer-entry', linked).click()
    await page.getByTestId('markdown-preview').getByRole('heading', { name: 'Linked Markdown note' }).waitFor()
    assert.deepEqual(reopened.errors, [])
    assert.deepEqual(reopened.requests, [])
    await verifyOriginal()
    console.log(`PASS per-file preview mode survives relaunch${values.coupling ? ' and the original Coupling.md is unchanged' : ''}`)
  } finally {
    await close(reopened)
  }
})
