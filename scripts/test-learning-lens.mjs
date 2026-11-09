import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFromExplorer,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
const screenshots = values.screenshots && resolve(values.screenshots)
if (screenshots) await mkdir(screenshots, { recursive: true })
const capture = (page, name) => screenshots && page.screenshot({ path: join(screenshots, name + '.png') })
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const source = (statement) => '// Learning Lens fixture\n\nint main(void) {\n    ' + statement + '\n}\n'
const initial = source('return 0')
const category = 'missing-semicolon'
const unknownMarker = 'ION_LENS_UNKNOWN_COMPILER_DIAGNOSTIC'
const diagnostic = (page, kind) => page.locator(`[data-testid="learning-diagnostic"][data-category="${kind}"]`).first()
const problem = (page, kind) => page.locator(`[data-testid="problem-row"][data-category="${kind}"]`).first()
const lensMarker = (page) => page.locator('[data-testid="editor"] .ion-lens-line').first()
const editor = (page) => page.locator('[data-testid="editor"] .monaco-editor')
const editorHost = (page) => page.locator('[data-testid="editor"] .monaco-host')

async function replaceCode(page, code, expected) {
  await editor(page).locator('.view-line').first().click({ position: { x: 8, y: 8 } })
  await page.keyboard.press(modifier + '+a')
  await page.keyboard.insertText(code)
  await (await editorShows(page, expected)).dispose()
}

async function run(page, status) {
  // Detect the new run before checking its result, including when two runs fail
  // with the same status. Ion displays the output tab automatically on Run.
  const observation = await page.evaluateHandle(() => {
    let started = false
    const observer = new MutationObserver(() => {
      const phase = document.querySelector('[data-testid="output"]')?.getAttribute('data-phase')
      if (phase === 'preparing' || phase === 'compiling' || phase === 'running') started = true
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    return { started: () => started, dispose: () => observer.disconnect() }
  })
  try {
    await page.getByTestId('run').click()
    await (await page.waitForFunction(({ observation, status }) =>
      observation.started() && document.querySelector('[data-testid="output"]')?.getAttribute('data-status') === status,
    { observation, status }, { timeout: 15_000 })).dispose()
  } finally {
    await observation.evaluate((value) => value.dispose()).catch(() => {})
    await observation.dispose()
  }
}

async function showProblems(page) {
  await page.getByTestId('bottom-problems-tab').click()
  const panel = page.getByTestId('problems-panel')
  await panel.waitFor()
  return panel
}

async function history(page) {
  return page.evaluate(async (category) =>
    (await window.ion.learning.getHistory()).categories.find((entry) => entry.category === category), category)
}

async function selectCPack(page) {
  await page.getByTestId('toggle-marketplace').click()
  await page.locator('[data-testid="marketplace-install"][data-pack="c"]').click()
  await page.locator('[data-testid="marketplace-use"][data-pack="c"]').click()
  await page.getByTestId('marketplace-pane').waitFor({ state: 'detached' })
  await (await page.waitForFunction(() => document.querySelector('[data-testid="learning-language"]')?.value === 'c')).dispose()
}

async function theme(page, id) {
  await page.getByTestId('settings').click()
  const preferences = page.getByRole('dialog', { name: 'Preferences' })
  await preferences.getByTestId('theme-' + id).click()
  await page.locator(`.app-shell[data-theme-id="${id}"]`).waitFor()
  await preferences.getByRole('button', { name: 'Done', exact: true }).click()
}

await withScratch('learning-lens', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  await Promise.all([
    writeFile(project.broken, initial),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: { autoSave: false, openFullScreen: false },
    })),
  ])
  const session = await launch(target, profile)
  const { app, page } = session
  let step = 'prepare the offline Learn workspace'
  let completed = false
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await page.getByTestId('workspace-learn').click()
    const learningPane = page.getByTestId('learning-pane')
    await learningPane.waitFor()
    await selectCPack(page)
    await page.getByTestId('open-folder').first().click()
    await openFromExplorer(page, project.broken, 'return 0')
    await editorHost(page).evaluate((node) => { node.dataset.lensTestEditor = 'original' })

    step = 'connect the real compiler location, Problems, and the offline lesson'
    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const size = window.getContentSize()
      window.setContentSize(930, 640)
      return size
    })
    await run(page, 'compile-error')
    await lensMarker(page).waitFor()
    const outputFrame = await page.locator('.output-frame').boundingBox()
    assert.ok(outputFrame && outputFrame.width > 260 && outputFrame.width <= 420,
      'Exercise the Problems tab with a compact Run Console and both sidebars open.')
    const problems = await showProblems(page)
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0].setContentSize(width, height)
    }, originalSize)
    const recognized = problem(page, category)
    await recognized.waitFor()
    const location = /:(\d+)(?::(\d+))?$/.exec((await recognized.locator('.problem-location').innerText()).trim())
    assert.ok(location && [4, 5].includes(Number(location[1])), 'The compiler located the missing statement boundary.')
    await recognized.getByTestId('problem-reveal').click()
    await eventually(async () => (await page.locator('.document-status').innerText())
      .includes(`Ln ${location[1]}, Col ${location[2] ?? '1'}`),
      'The Problem did not reveal the compiler location in the source.')
    await recognized.getByTestId('problem-explain').click()
    const concept = page.locator('[data-testid="learning-concept"][data-concept="statements"]')
    await concept.waitFor()
    assert.match(await concept.innerText(), /example/i)
    await capture(page, 'recognized')
    if (screenshots) {
      await theme(page, 'light')
      await capture(page, 'recognized-light')
      await theme(page, 'dark')
    }
    await learningPane.getByTestId('learning-lens-lesson').click()
    await learningPane.getByTestId('learning-pack-lesson').waitFor()
    assert.equal(await readFile(project.broken, 'utf8'), initial, 'Learning Lens never changes source.')
    console.log('PASS actual C diagnostics link the source, Problems, an example, and an installed offline lesson')

    step = 'keep the model and editor history stable'
    await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
    await lensMarker(page).waitFor({ state: 'detached' })
    await atPath(page, 'tab', project.broken).getByRole('button', { name: basename(project.broken), exact: true }).click()
    await (await editorShows(page, 'return 0')).dispose()
    await lensMarker(page).waitFor()
    assert.equal(await editorHost(page).getAttribute('data-lens-test-editor'), 'original')

    step = 'distinguish an unchanged run from a repeated mistake after editing'
    await run(page, 'compile-error')
    await learningPane.getByTestId('learning-result').click()
    await diagnostic(page, category).waitFor()
    assert.equal(await learningPane.getByRole('button', { name: 'Explain Again', exact: true }).count(), 0)
    assert.deepEqual(await history(page), { category, encountered: 1, repeated: 0, resolved: 0 })
    await showProblems(page)
    await recognized.getByTestId('problem-reveal').waitFor()
    const returnLine = editor(page).locator('.view-line').filter({ hasText: 'return 0' })
    await returnLine.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.type('1')
    await (await editorShows(page, 'return 1')).dispose()
    await lensMarker(page).waitFor({ state: 'detached' })
    await recognized.getByTestId('problem-reveal').waitFor({ state: 'detached' })
    await editor(page).locator('.view-line').first().click()
    await page.keyboard.press(modifier + '+z')
    await (await editorShows(page, 'return 0')).dispose()
    assert.equal(await editorHost(page).getAttribute('data-lens-test-editor'), 'original')

    await replaceCode(page, source('return 0 /* formatting only */'), 'formatting only')
    await run(page, 'compile-error')
    await learningPane.getByTestId('learning-result').click()
    await diagnostic(page, category).waitFor()
    assert.equal(await learningPane.getByRole('button', { name: 'Explain Again', exact: true }).count(), 0)
    assert.deepEqual(await history(page), { category, encountered: 1, repeated: 0, resolved: 0 })

    await replaceCode(page, source('return 1'), 'return 1')
    await run(page, 'compile-error')
    await learningPane.getByTestId('learning-result').click()
    const explainAgain = diagnostic(page, category).getByRole('button', { name: 'Explain Again', exact: true })
    await explainAgain.click()
    await concept.waitFor()
    assert.deepEqual(await history(page), { category, encountered: 2, repeated: 1, resolved: 0 })
    console.log('PASS exact and cosmetic retries are deduplicated, a meaningful edit offers Explain Again, and the editor can undo')

    step = 'preserve the original message for an unknown diagnostic'
    await replaceCode(page, '#error ' + unknownMarker + '\n' + source('return 0;'), unknownMarker)
    await run(page, 'compile-error')
    await learningPane.getByTestId('learning-result').click()
    const unknown = diagnostic(page, 'unclassified-compiler')
    await unknown.waitFor()
    await unknown.getByText(new RegExp(unknownMarker)).first().waitFor()
    await unknown.getByText(/no reliable explanation is available/i).waitFor()
    assert.equal(await unknown.getByTestId('learning-show-explanation').count(), 0)
    assert.equal(await learningPane.getByTestId('learning-resolved').count(), 0)
    assert.deepEqual(await history(page), { category, encountered: 2, repeated: 1, resolved: 0 })
    await showProblems(page)
    await problems.getByText(new RegExp(unknownMarker)).first().waitFor()
    await capture(page, 'unknown')

    step = 'close and reopen the optional panel'
    await learningPane.getByRole('button', { name: 'Hide learning panel' }).click()
    await learningPane.waitFor({ state: 'detached' })
    await problems.waitFor()
    await page.getByRole('button', { name: 'Toggle Learn panel' }).click()
    await learningPane.waitFor()
    await run(page, 'compile-error')
    await learningPane.getByTestId('learning-result').click()
    await unknown.waitFor()

    step = 'record a verified resolution and clear obsolete problems'
    await replaceCode(page, source('return 0;'), 'return 0;')
    await run(page, 'success')
    await learningPane.getByTestId('learning-result').click()
    const resolved = learningPane.getByTestId('learning-resolved')
    await resolved.waitFor()
    assert.match(await resolved.innerText(), /resolved/i)
    assert.doesNotMatch(await resolved.innerText(), /\b(?:mastered|mastery earned|concept learned)\b/i)
    await lensMarker(page).waitFor({ state: 'detached' })
    await showProblems(page)
    assert.equal(await problems.getByTestId('problem-row').count(), 0)
    await learningPane.getByTestId('learning-history').click()
    const historyView = learningPane.getByTestId('learning-history-content')
    await historyView.waitFor()
    await historyView.getByText('Statement boundary', { exact: true }).waitFor()
    assert.match(await historyView.innerText(), /resolved/i)
    const tracked = { category, encountered: 2, repeated: 1, resolved: 1 }
    assert.deepEqual(await history(page), tracked)
    console.log('PASS failed recompilation preserves the open history event, and a verified build resolves it')

    step = 'disable Learning Lens without disabling regular Problems'
    await page.getByTestId('settings').click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    const setting = preferences.getByRole('checkbox', { name: /learning lens/i })
    assert.equal(await setting.isChecked(), true, 'Learning Lens is enabled by default in Learn.')
    await setting.uncheck()
    await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    await eventually(() => page.evaluate(async () => (await window.ion.getPreferences()).settings.learningLens === false),
      'The Learning Lens preference did not persist.')
    await replaceCode(page, initial, 'return 0')
    await run(page, 'compile-error')
    await showProblems(page)
    await problems.getByTestId('problem-row').first().waitFor()
    await lensMarker(page).waitFor({ state: 'detached' })
    assert.equal(await problems.getByTestId('problem-explain').count(), 0)
    assert.deepEqual(await history(page), tracked, 'Turning off Lens stops collecting history.')
    assert.match(await readFile(project.broken, 'utf8'), /return 0\s*}\s*$/, 'The saved file still has the compiler error.')
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    completed = true
    console.log('PASS unknown compiler text stays visible, the optional panel reopens, and disabling Lens preserves regular Problems')
  } catch (error) {
    console.error('Learning Lens smoke failed while trying to ' + step + '.')
    throw error
  } finally {
    await close(session).catch((error) => { if (completed) throw error })
  }

  const reopened = await launch(target, profile)
  try {
    await reopened.page.context().setOffline(true)
    assert.equal(await reopened.page.evaluate(async () => (await window.ion.getPreferences()).settings.learningLens), false)
    assert.deepEqual(await history(reopened.page), { category, encountered: 2, repeated: 1, resolved: 1 })
    assert.deepEqual(reopened.requests, [])
    assert.deepEqual(reopened.errors, [])
    console.log('PASS verified history and the disable preference survive an offline relaunch')
  } finally {
    await close(reopened)
  }
})
