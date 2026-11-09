import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, launch, openFromExplorer, stubDialogs, withScratch,
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
  const hostileText = '<img src="https://example.invalid/learn-tracker.png" onerror="alert(1)">'
  const authored = {
    schema: 1, id: 'tiny-study', name: 'Tiny Study', summary: 'Local hand-written notes.', version: 1,
    lessons: [{ id: 'first', title: 'A local lesson', section: 'Basics', explanation: hostileText,
      example: 'print(42)', api: [{ name: 'print', description: 'Write a value.' }], practice: 'Print a second number.' }],
  }
  await Promise.all([
    writeFile(custom, JSON.stringify(authored)),
    writeFile(bad, JSON.stringify({ ...authored, id: '../outside' })),
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
    await search.fill('python')
    await packAction(page, 'install', 'python').click()
    await packAction(page, 'use', 'python').waitFor()
    assert.equal((await library(page)).selected, null)
    assert.equal(await learn.locator('option[value="python"]').count(), 1)
    assert.equal(await learn.locator('option[value="java"]').count(), 0)
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

    await page.getByTestId('toggle-marketplace').click()
    await stubDialogs(app, { file: bad })
    await market.getByTestId('marketplace-import').click()
    await market.getByRole('alert').waitFor()
    assert.equal((await library(page)).installed.length, 1)
    await stubDialogs(app, { file: custom })
    await market.getByTestId('marketplace-import').click()
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
    console.log('PASS regular C run while Python is selected, malformed import rejection, safe text rendering, remove and reselect')
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
