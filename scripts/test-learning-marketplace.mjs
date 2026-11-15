import assert from 'node:assert/strict'
// Historical filename/npm alias retained; this now exercises direct Learn and Content settings.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, eventually, launch, openFromExplorer, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
const screenshots = values.screenshots ? resolve(values.screenshots) : null
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

await withScratch('learning-marketplace', async (scratch) => {
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
  const first = await launch(target, profile)
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
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

    await page.locator('.titlebar').getByTestId('open-folder').click()
    await openFromExplorer(page, project.broken, 'return 0')
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-status="compile-error"]').waitFor()
    assert.equal(await learn.getByTestId('learning-diagnostic').count(), 0)
    assert.deepEqual((await page.evaluate(() => window.ion.learning.getHistory())).categories, [])

    await openFromExplorer(page, pythonError, 'undefined_study_value')
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-status="runtime-error"]').waitFor()
    await learn.getByTestId('learning-result').click()
    await learn.locator('[data-category="python-undefined-name"]').waitFor()
    await learn.getByTestId('learning-show-explanation').click()
    await lesson.getByText('Values, names, and output', { exact: true }).waitFor()
    await lesson.getByRole('heading', { name: 'Expected behavior' }).waitFor()
    await learn.getByRole('button', { name: 'Back to topics' }).click()
    await learn.locator('[data-testid="learning-topic"][data-topic="flow"]').click()
    await learn.getByTestId('learning-start-exercise').click()
    const practice = page.getByTestId('practice-pane')
    await practice.getByTestId('practice-sample-definitions').waitFor()
    await practice.getByRole('heading', { name: 'Conditions, loops, and ranges' }).waitFor()
    await editorShows(page, 'Write your solution here')
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
    const updated = { ...authored, version: 2, summary: 'Reviewed update with stable lesson IDs.' }
    await writeFile(custom, JSON.stringify(updated))
    await content.getByTestId('content-import').click()
    await content.getByTestId('content-import-preview').getByText('Version 2', { exact: false }).waitFor()
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
  } finally {
    await close(first)
  }

  const second = await launch(target, profile)
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
  } finally {
    await close(second)
  }
})
