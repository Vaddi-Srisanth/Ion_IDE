import assert from 'node:assert/strict'
// Historical filename/npm alias retained; this now exercises direct Learn and Content settings.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, eventually, launch, openFromExplorer, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { installBenchmarkRun } from './run-completion.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
  out: { type: 'string', default: 'performance-results/direct-learning.json' },
} })
const target = await artifact(values.target)
const screenshots = values.screenshots ? resolve(values.screenshots) : null
const receiptPath = resolve(values.out)
const receipt = { schemaVersion: 1, protocol: 'direct-learning-observation-v1', complete: false,
  platform: process.platform, arch: process.arch, phase: 'fixture', runs: [], cleanups: [] }
let phase = 'fixture', primaryError
const errorRecord = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 2000),
  stack: String(error?.stack ?? '').slice(-4000) })
function watchMain(session) {
  const state = { stderr: '', console: [] }
  const stderr = chunk => { state.stderr = (state.stderr + String(chunk)).slice(-8192) }
  const consoleMessage = message => {
    state.console.push({ type: message.type(), text: message.text().slice(0, 1000) })
    if (state.console.length > 12) state.console.shift()
  }
  session.appProcess.stderr?.on('data', stderr)
  session.app.on('console', consoleMessage)
  return { state, dispose() { session.appProcess.stderr?.removeListener('data', stderr); session.app.removeListener('console', consoleMessage) } }
}
async function captureFailure(session, observation, error) {
  receipt.phase = phase
  receipt.failure = errorRecord(error)
  receipt.main = observation.state
  receipt.renderer = await session.page.evaluate(async () => {
    const bounded = async promise => {
      let timer
      try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'diagnostic capture deadline' }), 1000) })]) }
      catch (reason) { return { unavailable: String(reason?.message ?? reason).slice(0, 300) } }
      finally { clearTimeout(timer) }
    }
    const library = await bounded(window.ion.learningPacks.getLibrary())
    const history = await bounded(window.ion.learning.getHistory())
    const output = document.querySelector('[data-testid="output"]')
    return {
      selected: library?.selected ?? null,
      installed: library?.installed?.slice(0, 24).map(({ id, version, diagnostics }) => ({ id, version, diagnostics })) ?? library,
      selector: document.querySelector('[data-testid="learning-language"]')?.value ?? null,
      mode: document.querySelector('[data-testid="workspace"]')?.getAttribute('data-mode'),
      output: output ? { phase: output.getAttribute('data-phase'), status: output.getAttribute('data-status'),
        text: [...output.querySelectorAll('.xterm-rows > div')].map(row => row.textContent).join('\n').slice(-8192) } : null,
      learningText: document.querySelector('[data-testid="learning-pane"]')?.textContent?.slice(-8192),
      diagnostics: [...document.querySelectorAll('[data-testid="learning-diagnostic"]')].slice(0, 24).map(node => ({
        category: node.getAttribute('data-category'), raw: node.textContent?.slice(0, 2200) })),
      history: history?.categories ? { categories: history.categories.slice(0, 24), topics: history.topics?.slice(0, 24) } : history,
      run: window.ionLearningRunReceipt ?? null,
    }
  }).catch(reason => ({ unavailable: String(reason.message).slice(0, 500) }))
  // Only the synthetic fixture's bounded run output is logged. No environment,
  // user profile or source dump; path-bearing raw receipt is sanitized at upload.
  const safeText = value => String(value ?? '').replace(/\b[A-Z]:[\\/][^\r\n"']+/gi, '[disposable path]')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\r\n"']+/g, '[disposable path]').slice(-8192)
  console.error('Direct learning failure observation:', JSON.stringify({ phase,
    selected: receipt.renderer.selected, selector: receipt.renderer.selector, mode: receipt.renderer.mode,
    outputPhase: receipt.renderer.output?.phase, outputStatus: receipt.renderer.output?.status,
    runId: receipt.renderer.run?.id, completed: receipt.renderer.run?.completed,
    terminal: safeText(receipt.renderer.run?.terminalTail ?? receipt.renderer.output?.text),
    diagnosticCategories: receipt.renderer.diagnostics?.map(item => item.category),
    learningText: safeText(receipt.renderer.learningText) }))
}
async function closeObserved(session, observation, primary) {
  let cleanup
  try {
    await close(session)
    receipt.cleanups.push({ status: 'passed', exitCode: session.appProcess.exitCode, signal: session.appProcess.signalCode })
  } catch (error) {
    cleanup = error
    receipt.cleanups.push({ status: 'failed', error: errorRecord(error), shutdown: error.desktopShutdown ?? null })
  } finally { observation.dispose() }
  if (cleanup) throw primary ? new AggregateError([primary, cleanup], 'Direct learning workflow and cleanup both failed.') : cleanup
}
async function runObserved(page, expectedStatus) {
  await page.evaluate(() => {
    window.ionLearningRunReceiptCleanup?.()
    const record = { id: null, completed: false, events: [], terminalTail: '', compilerTail: '', ignoredRunIds: [] }
    const unsubscribe = window.ion.runConsole.onUpdate(({ id, update }) => {
      if (!record.id && (update.kind === 'phase' && update.phase === 'preparing' || update.kind === 'complete')) record.id = id
      if (record.id !== id) { if (record.ignoredRunIds.length < 8 && !record.ignoredRunIds.includes(id)) record.ignoredRunIds.push(id); return }
      if (record.events.length < 40) record.events.push({ id, kind: update.kind, phase: update.phase, stream: update.stream, ms: performance.now() })
      if (update.kind === 'complete') record.completed = true
      if (update.kind === 'data' && update.stream === 'terminal') record.terminalTail = (record.terminalTail + update.text).slice(-8192)
      if (update.kind === 'data' && update.stream === 'compiler') record.compilerTail = (record.compilerTail + update.text).slice(-4096)
    })
    window.ionLearningRunReceipt = record
    window.ionLearningRunReceiptCleanup = () => { unsubscribe(); delete window.ionLearningRunReceiptCleanup }
  })
  // Reuse the tested correlation observer instead of accepting an old rendered
  // runtime-error. Existing per-stage eight-second watchdogs are unchanged.
  await page.evaluate(installBenchmarkRun, { preparing: 8000, compiling: 8000, running: 8000 })
  try {
    await page.getByTestId('run').click()
    const completion = await page.evaluate(() => window.ionBenchmarkRunCompletion)
    const observed = await page.evaluate(() => window.ionLearningRunReceipt)
    receipt.runs.push({ phase, completion, ...observed })
    assert.ok(observed.id && observed.completed, 'The current run did not deliver its correlated completion.')
    assert.equal(completion.failure, undefined, 'The correlated run observer failed: ' + completion.failure)
    assert.equal(completion.status, expectedStatus)
  } finally {
    await page.evaluate(() => { window.ionBenchmarkRunCleanup?.(); window.ionLearningRunReceiptCleanup?.() }).catch(() => {})
  }
}
if (screenshots) await mkdir(screenshots, { recursive: true })
const capture = (page, name) => screenshots ? page.screenshot({ path: join(screenshots, name + '.png') }) : Promise.resolve()
const contentRow = (content, id) => content.locator(`[data-content-id="${id}"]`)
const library = (page) => page.evaluate(() => window.ion.learningPacks.getLibrary())
const current = (page, id) => eventually(async () => {
  const choice = page.getByTestId('learning-language')
  return await choice.isEnabled() && await choice.inputValue() === id && (await library(page)).selected === id
}, 'The explicit language selection did not settle.')
async function selectLanguage(page, id) {
  await eventually(() => page.getByTestId('learning-language').isEnabled(), 'Language selection remained busy.')
  await page.getByTestId('learning-language').selectOption(id)
  await current(page, id)
}
async function openContent(page) {
  await page.getByTestId('settings').first().click()
  await page.getByRole('dialog', { name: 'Preferences', exact: true }).getByTestId('manage-learning-content').click()
  const content = page.getByRole('dialog', { name: 'Learning Content', exact: true })
  await eventually(() => content.getByTestId('content-import').isEnabled(), 'Content metadata did not load.')
  return content
}
async function closeContent(content) {
  await content.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await content.waitFor({ state: 'detached' })
}

try { await withScratch('learning-marketplace', async (scratch) => {
  const profile = join(scratch, 'profile')
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const custom = join(scratch, 'tiny-study.json')
  const bad = join(scratch, 'bad-study.json')
  const exported = join(scratch, 'exported-python.json')
  const customExport = join(scratch, 'exported-study.json')
  const pythonError = join(project.directory, 'undefined name.py')
  const hostileText = '<img src="https://example.invalid/learn-tracker.png" onerror="alert(1)">'
  const authored = {
    schema: 1, id: 'tiny-study', name: 'Tiny Study', summary: 'Local hand-written notes.', version: 1,
    lessons: [{ id: 'first', title: 'A local lesson', section: 'Basics', explanation: hostileText,
      example: 'print(42)', api: [{ name: 'print', description: 'Write a value.' }], practice: 'Print a second number.' }],
  }
  await Promise.all([
    writeFile(custom, JSON.stringify(authored)),
    writeFile(bad, JSON.stringify({ ...authored, id: '../outside' })),
    writeFile(pythonError, 'print(undefined_study_value)\n'),
  ])
  let savedProblem, savedHistory, savedSource, savedSourcePath
  phase = 'launch-first'
  const first = await launch(target, profile)
  const firstObservation = watchMain(first)
  let firstError
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    phase = 'direct-selection-storage-export'
    await page.getByTestId('workspace-learn').click()
    const learn = page.getByTestId('learning-pane')
    await learn.getByTestId('learning-language').waitFor()
    assert.equal((await learn.locator('.learning-nav-item').first().textContent()).trim(), 'Topics')
    assert.equal(await learn.getByTestId('learning-result').count(), 0)
    for (const id of ['python', 'java', 'c']) assert.equal(await learn.locator(`option[value="${id}"]`).count(), 1)
    assert.equal(await page.getByTestId('toggle-marketplace').count(), 0)
    const empty = await library(page)
    assert.equal(empty.selected, null)
    assert.deepEqual(empty.installed, [])
    assert.ok(empty.catalog.length >= 8)
    await assert.rejects(readdir(join(profile, 'learning-library')), { code: 'ENOENT' })
    await capture(page, 'learn-empty')

    await selectLanguage(page, 'python')
    assert.deepEqual((await library(page)).installed.map(({ id }) => id), ['python'])
    const registry = JSON.parse(await readFile(join(profile, 'learning-library/library.json'), 'utf8'))
    assert.deepEqual(registry.installed.map(({ id }) => id), ['python'])
    assert.equal((await readdir(join(profile, 'learning-library'))).filter((name) => name.startsWith('pack-')).length, 1)
    for (const id of ['java', 'c', 'python']) await selectLanguage(page, id)
    let content = await openContent(page)
    await stubDialogs(app, { folder: project.directory, allowRun: true, save: exported })
    await contentRow(content, 'python').getByTestId('content-export').click()
    await content.getByRole('status').filter({ hasText: 'Python exported.' }).waitFor()
    assert.equal(JSON.parse(await readFile(exported, 'utf8')).lessons.length,
      (await library(page)).installed.find(({ id }) => id === 'python').topicCount)
    await capture(page, 'learning-content-settings')
    await closeContent(content)
    await current(page, 'python')
    await learn.getByTestId('learning-topic').first().click()
    const lesson = learn.getByTestId('learning-pack-lesson')
    await lesson.getByText('Values, names, and output', { exact: true }).waitFor()
    await lesson.getByText('Key APIs and syntax', { exact: true }).waitFor()
    await lesson.getByText('Try it yourself', { exact: true }).waitFor()
    await capture(page, 'learn-python')
    console.log('PASS Topics first, no default language, direct Python/Java/C selection, chosen-only storage, real lessons and export')

    phase = 'c-diagnostic-selected-python'
    await page.locator('.titlebar').getByTestId('open-folder').click()
    await openFromExplorer(page, project.broken, 'return 0')
    await runObserved(page, 'compile-error')
    assert.equal(await learn.getByTestId('learning-diagnostic').count(), 0)
    assert.deepEqual((await page.evaluate(() => window.ion.learning.getHistory())).categories, [])

    phase = 'python-runtime-delivery'
    await openFromExplorer(page, pythonError, 'undefined_study_value')
    await runObserved(page, 'runtime-error')
    phase = 'python-diagnostic-classification'
    await learn.getByTestId('learning-result').click()
    await learn.locator('[data-category="python-undefined-name"]').waitFor()
    await learn.getByTestId('learning-show-explanation').click()
    await lesson.getByText('Values, names, and output', { exact: true }).waitFor()
    await lesson.getByRole('heading', { name: 'Expected behavior' }).waitFor()
    phase = 'exercise-practice-evidence'
    await learn.getByRole('button', { name: 'Back to topics' }).click()
    await learn.locator('[data-testid="learning-topic"][data-topic="flow"]').click()
    await learn.getByTestId('learning-start-exercise').click()
    await eventually(() => learn.getByTestId('learning-run-samples').isEnabled(), 'The exercise did not open beside its lesson.')
    await page.locator('[data-testid="workspace"][data-mode="learn"]').waitFor()
    await (await editorShows(page, 'upper = int(input())')).dispose()
    await learn.getByTestId('learning-practice').click()
    const practice = page.getByTestId('practice-pane')
    await practice.getByTestId('practice-sample-definitions').waitFor()
    await practice.getByRole('heading', { name: 'Conditions, loops, and ranges' }).waitFor()
    await (await editorShows(page, 'upper = int(input())')).dispose()
    await page.locator('.monaco-editor .view-lines').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await page.keyboard.insertText('bound = int(input())\nfor value in range(bound, 0, -1):\n    if value % 3 == 0:\n        print(value)\n')
    await practice.getByTestId('practice-run-samples').click()
    await practice.getByTestId('practice-results').getByText('3 of 3 passed', { exact: true }).waitFor()
    await practice.getByTestId('practice-edit').click()
    await page.getByTestId('practice-notes').fill('Keep my own reasoning across content changes.')
    await page.getByTestId('practice-save').click()
    await practice.getByTestId('practice-saved-notes').waitFor()
    await practice.getByTestId('practice-new-attempt').click()
    const attemptDialog = page.getByRole('dialog', { name: 'Create attempt', exact: true })
    await attemptDialog.getByTestId('entry-name').fill('Second approach')
    await attemptDialog.getByTestId('entry-submit').click()
    await attemptDialog.waitFor({ state: 'detached' })
    const problemId = await practice.getByTestId('practice-problem').inputValue()
    const attemptId = await practice.getByTestId('practice-attempt').inputValue()
    const entry = await page.evaluate(({ problemId, attemptId }) => window.ion.practice.openAttempt(problemId, attemptId), { problemId, attemptId })
    savedSourcePath = entry.path
    savedSource = await readFile(savedSourcePath, 'utf8')
    savedProblem = await page.evaluate((id) => window.ion.practice.get(id), problemId)
    assert.equal(savedProblem.attempts.length, 2)
    assert.ok(savedProblem.attempts[0].lastRun.results.every(({ status }) => status === 'passed'))
    assert.equal(savedProblem.completion, 'Not started', 'Sample success must not silently mark manual completion or mastery.')
    savedHistory = await page.evaluate(() => window.ion.learning.getHistory())
    assert.ok(savedHistory.categories.some(({ category }) => category === 'python-undefined-name'))

    phase = 'draft-navigation-protection'
    // The new experience navigation must retain the existing unsaved-draft guard.
    await practice.getByTestId('practice-edit').click()
    await page.getByTestId('practice-notes').fill('Unsaved draft blocks switching.')
    await page.getByRole('button', { name: 'Keep draft', exact: true }).click()
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await page.locator('[data-testid="workspace"][data-mode="practice"]').waitFor()
    await page.getByText('Save or close the current draft before switching workspaces.', { exact: true }).waitFor()
    await practice.getByTestId('practice-new').click()
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await page.locator('[data-testid="workspace"][data-mode="free"]').waitFor()
    await page.getByTestId('navigate-learn').click()
    await page.locator('[data-testid="workspace"][data-mode="learn"]').waitFor()
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-learn').click()
    await current(page, 'python')

    phase = 'reviewed-import-and-update'
    content = await openContent(page)
    await stubDialogs(app, { file: bad })
    await content.getByTestId('content-import').click()
    await content.getByRole('alert').waitFor()
    assert.equal((await library(page)).installed.length, 3)
    await stubDialogs(app, { file: custom })
    await content.getByTestId('content-import').click()
    await content.getByTestId('content-import-preview').waitFor()
    assert.equal((await library(page)).installed.length, 3)
    await content.getByTestId('content-import-discard').click()
    await content.getByTestId('content-import-preview').waitFor({ state: 'detached' })
    assert.equal((await library(page)).installed.length, 3)
    await content.getByTestId('content-import').click()
    await content.getByTestId('content-import-confirm').click()
    await contentRow(content, authored.id).waitFor()
    await closeContent(content)
    await selectLanguage(page, authored.id)
    await current(page, authored.id)
    await learn.getByTestId('learning-topic').first().click()
    await lesson.getByText(hostileText, { exact: true }).waitFor()
    assert.equal(await lesson.locator('img').count(), 0)
    content = await openContent(page)
    const updated = { ...authored, version: 2, summary: 'Reviewed update with stable lesson IDs.',
      lessons: [{ ...authored.lessons[0], example: 'print(43)' },
        { ...authored.lessons[0], id: 'second', title: 'Another local lesson' }] }
    await writeFile(custom, JSON.stringify(updated))
    await content.getByTestId('content-import').click()
    const updatePreview = content.getByTestId('content-import-preview')
    await updatePreview.getByText('Version 2', { exact: false }).waitFor()
    await updatePreview.getByText('Installed version 1 · 1 added · 1 changed', { exact: true }).waitFor()
    await updatePreview.getByText('A local lesson · Changed', { exact: true }).waitFor()
    await updatePreview.getByText('Another local lesson · Added', { exact: true }).waitFor()
    await writeFile(custom, JSON.stringify({ ...updated, name: 'Changed after review' }))
    await content.getByTestId('content-import-confirm').click()
    await content.getByRole('alert').filter({ hasText: 'changed after preview' }).waitFor()
    assert.equal((await library(page)).installed.find(({ id }) => id === authored.id).version, 1)
    await writeFile(custom, JSON.stringify(updated))
    await content.getByTestId('content-import').click()
    await content.getByTestId('content-import-confirm').click()
    await contentRow(content, authored.id).getByText('Version 2', { exact: false }).waitFor()
    await stubDialogs(app, { file: custom, save: customExport })
    await contentRow(content, authored.id).getByTestId('content-export').click()
    await content.getByRole('status').filter({ hasText: 'Tiny Study exported.' }).waitFor()
    assert.deepEqual(JSON.parse(await readFile(customExport, 'utf8')), updated)
    phase = 'content-removal-preserves-evidence'
    for (const id of [authored.id, 'python']) {
      const row = contentRow(content, id)
      await row.getByTestId('content-remove').click()
      await row.getByTestId('content-remove-confirmation').getByText('Attempts, notes, and diagnostic history remain.', { exact: false }).waitFor()
      await row.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.ok((await library(page)).installed.some((pack) => pack.id === id))
      await row.getByTestId('content-remove').click()
      await row.getByTestId('content-remove-confirm').click()
      await row.waitFor({ state: 'detached' })
    }
    assert.equal((await library(page)).selected, null)
    assert.deepEqual(await page.evaluate((id) => window.ion.practice.get(id), savedProblem.id), savedProblem)
    assert.deepEqual(await page.evaluate(() => window.ion.learning.getHistory()), savedHistory)
    assert.equal(await readFile(savedSourcePath, 'utf8'), savedSource)
    await closeContent(content)
    await selectLanguage(page, 'python')
    await learn.locator('[data-testid="learning-topic"][data-topic="flow"]').click()
    await learn.getByTestId('learning-start-exercise').click()
    await eventually(() => learn.getByTestId('learning-run-samples').isEnabled(), 'The saved exercise did not reopen beside its lesson.')
    await learn.getByTestId('learning-practice').click()
    await practice.getByTestId('practice-sample-definitions').waitFor()
    assert.equal(await practice.getByTestId('practice-problem').inputValue(), savedProblem.id)
    assert.equal(await practice.getByTestId('practice-attempt').inputValue(), savedProblem.attempts[1].id)
    assert.deepEqual(await page.evaluate((id) => window.ion.practice.get(id), savedProblem.id), savedProblem)
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-learn').click()
    await current(page, 'python')
    assert.deepEqual(first.requests, [])
    assert.deepEqual(first.errors, [])
    console.log('PASS offline diagnostic guidance, Practice sample evidence and identities, navigation draft guard, reviewed imports/updates, safe text and removal')
  } catch (error) {
    firstError = error
    await captureFailure(first, firstObservation, error).catch(reason => { receipt.captureError = errorRecord(reason) })
    throw error
  } finally {
    await closeObserved(first, firstObservation, firstError)
  }

  phase = 'offline-relaunch'
  const second = await launch(target, profile)
  const secondObservation = watchMain(second)
  let secondError
  try {
    const { page } = second
    await page.context().setOffline(true)
    await page.getByTestId('workspace-learn').click()
    await current(page, 'python')
    await page.getByTestId('learning-topic').first().click()
    await page.getByTestId('learning-pack-lesson').waitFor()
    assert.deepEqual((await library(page)).installed.map(({ id }) => id), ['java', 'c', 'python'])
    assert.deepEqual(await page.evaluate((id) => window.ion.practice.get(id), savedProblem.id), savedProblem)
    assert.deepEqual(await page.evaluate(() => window.ion.learning.getHistory()), savedHistory)
    assert.equal(await readFile(savedSourcePath, 'utf8'), savedSource)
    assert.deepEqual(second.requests, [])
    assert.deepEqual(second.errors, [])
    console.log('PASS selected language, lessons, notes, attempts, sample evidence and diagnostic history survive an offline relaunch')
  } catch (error) {
    secondError = error
    await captureFailure(second, secondObservation, error).catch(reason => { receipt.captureError = errorRecord(reason) })
    throw error
  } finally {
    await closeObserved(second, secondObservation, secondError)
  }
}); receipt.complete = true }
catch (error) { primaryError = error; receipt.failure ??= errorRecord(error) }
finally {
  receipt.phase = phase
  try {
    await mkdir(dirname(receiptPath), { recursive: true })
    const text = JSON.stringify(receipt, null, 2) + '\n'
    assert.ok(Buffer.byteLength(text) < 128 * 1024, 'Direct learning receipt exceeded its bound.')
    await writeFile(receiptPath, text)
  } catch (error) {
    primaryError = primaryError ? new AggregateError([primaryError, error], 'Direct learning failed and its receipt could not be written.') : error
  }
}
if (primaryError) throw primaryError
