import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, launch, openFromExplorer, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
const screenshots = values.screenshots ? resolve(values.screenshots) : null
if (screenshots) await mkdir(screenshots, { recursive: true })
const capture = (page, name) => screenshots ? page.screenshot({ path: join(screenshots, name + '.png') }) : Promise.resolve()
const packAction = (page, action, id) => page.locator(`[data-testid="marketplace-${action}"][data-pack="${id}"]`)
const library = (page) => page.evaluate(() => window.ion.learningPacks.getLibrary())
const current = (page, id) => page.waitForFunction((value) =>
  document.querySelector('[data-testid="learning-language"]')?.value === value, id)

await withScratch('learning-marketplace', async (scratch) => {
  const profile = join(scratch, 'profile')
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const custom = join(scratch, 'tiny-study.json')
  const bad = join(scratch, 'bad-study.json')
  const exported = join(scratch, 'exported-python.json')
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
  const first = await launch(target, profile)
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await page.getByTestId('workspace-learn').click()
    const learn = page.getByTestId('learning-pane')
    await learn.getByTestId('learning-open-marketplace').waitFor()
    assert.equal((await learn.locator('.learning-nav-item').first().textContent()).trim(), 'Topics')
    assert.equal(await learn.getByTestId('learning-result').count(), 0)
    assert.equal(await learn.locator('option[value="c"]').count(), 0)
    const empty = await library(page)
    assert.equal(empty.selected, null)
    assert.deepEqual(empty.installed, [])
    assert.ok(empty.catalog.length >= 8)
    await capture(page, 'learn-empty')

    await learn.getByTestId('learning-open-marketplace').click()
    const market = page.getByTestId('marketplace-pane')
    const search = market.getByTestId('marketplace-search')
    await market.getByTestId('marketplace-category').selectOption('data')
    await market.getByTestId('marketplace-difficulty').selectOption('intermediate')
    await search.fill('context managers')
    await market.getByTestId('marketplace-view-cards').click()
    await packAction(page, 'details', 'python').click()
    const details = market.getByTestId('marketplace-detail')
    await details.getByText('Use context managers for deterministic cleanup').waitFor()
    await details.getByRole('heading', { name: 'Mini-project' }).waitFor()
    await details.getByRole('button', { name: 'Back to packs' }).click()
    await market.getByTestId('marketplace-category').selectOption('')
    await market.getByTestId('marketplace-difficulty').selectOption('')
    await market.getByTestId('marketplace-view-list').click()
    await search.fill('python')
    await packAction(page, 'install', 'python').click()
    await packAction(page, 'use', 'python').waitFor()
    assert.equal((await library(page)).selected, null)
    assert.equal(await learn.locator('option[value="python"]').count(), 1)
    assert.equal(await learn.locator('option[value="java"]').count(), 0)
    await market.getByTestId('marketplace-installed-only').check()
    await packAction(page, 'details', 'python').click()
    await stubDialogs(app, { folder: project.directory, allowRun: true, save: exported })
    await market.getByTestId('marketplace-export').click()
    await market.getByText('Python exported.', { exact: true }).waitFor()
    assert.equal(JSON.parse(await readFile(exported, 'utf8')).lessons.length, 15)
    await details.getByRole('button', { name: 'Back to packs' }).click()
    await capture(page, 'marketplace-install')
    await packAction(page, 'use', 'python').click()
    await market.waitFor({ state: 'detached' })
    await current(page, 'python')
    await learn.getByTestId('learning-topic').first().click()
    const lesson = learn.getByTestId('learning-pack-lesson')
    await lesson.getByText('Values, names, and output', { exact: true }).waitFor()
    await lesson.getByText('Key APIs and syntax', { exact: true }).waitFor()
    await lesson.getByText('Try it yourself', { exact: true }).waitFor()
    await capture(page, 'learn-python')
    console.log('PASS Topics first, no default language, searchable offline catalog, explicit install and selection, real lessons')

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
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-learn').click()
    await current(page, 'python')

    await page.getByTestId('toggle-marketplace').click()
    await stubDialogs(app, { file: bad })
    await market.getByTestId('marketplace-import').click()
    await market.getByRole('alert').waitFor()
    assert.equal((await library(page)).installed.length, 1)
    await stubDialogs(app, { file: custom })
    await market.getByTestId('marketplace-import').click()
    await market.getByTestId('marketplace-import-confirm').waitFor()
    assert.equal((await library(page)).installed.length, 1)
    await market.getByTestId('marketplace-import-confirm').click()
    await packAction(page, 'use', authored.id).click()
    await current(page, authored.id)
    await learn.getByTestId('learning-topic').first().click()
    await lesson.getByText(hostileText, { exact: true }).waitFor()
    assert.equal(await lesson.locator('img').count(), 0)
    await page.getByTestId('toggle-marketplace').click()
    await packAction(page, 'remove', authored.id).click()
    await packAction(page, 'use', authored.id).waitFor({ state: 'detached' })
    assert.equal((await library(page)).selected, null)
    await packAction(page, 'use', 'python').click()
    await current(page, 'python')
    assert.deepEqual(first.requests, [])
    assert.deepEqual(first.errors, [])
    console.log('PASS matching offline diagnostic guidance, Practice handoff and real sample tests, reviewed imports, safe text and removal')
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
    assert.deepEqual((await library(page)).installed.map(({ id }) => id), ['python'])
    assert.deepEqual(second.requests, [])
    assert.deepEqual(second.errors, [])
    console.log('PASS installed pack, selected language and lessons survive an offline relaunch')
  } finally {
    await close(second)
  }
})
