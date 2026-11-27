import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

process.env.ION_SHOW_TEST_WINDOWS = '0'
const target = await artifact('dist')
async function openExplorer(page) {
  await page.getByTestId('command-palette').click()
  await page.getByTestId('command-palette-input').fill('Test Explorer')
  await page.getByRole('option', { name: /Test Explorer/ }).click()
  await page.getByRole('heading', { name: 'Test Explorer', exact: true }).waitFor()
}

function caseButton(page, label) {
  // Case buttons also contain their outcome. Match the label independently of
  // "Not run", "Failed" and historical-result text.
  return page.locator('.test-explorer-tree button').filter({
    has: page.getByText(label, { exact: true }),
  })
}

async function waitForStatus(page, expected, timeout = 65_000) {
  console.log('DESKTOP waiting for status:', expected)
  const status = page.locator('.test-explorer-status').filter({ hasText: expected })
  const error = page.locator('.test-explorer-error')
  await status.or(error).waitFor({ timeout })
  if (await error.isVisible()) assert.fail(await error.innerText())
}

async function waitForRenderedHistory(page, history) {
  const latest = [...history].sort((a, b) => b.checkedAt - a.checkedAt)[0]
  const picker = page.getByRole('combobox', { name: 'Test run history', exact: true })
  await eventually(async () => await picker.locator('option').count() === history.length
    && await picker.inputValue() === latest.id
    && await page.getByRole('button', { name: 'Run All', exact: true }).isEnabled()
    && await page.getByRole('button', { name: 'Stop', exact: true }).isDisabled(),
  'Persisted test history did not finish rendering in the idle explorer.')
  assert.equal(await page.locator('.test-explorer-error').count(), 0)
}

function exited(pid) {
  try { process.kill(pid, 0); return false }
  catch (error) { if (error.code === 'ESRCH') return true; throw error }
}

async function checkBackup(page, archive) {
  const review = await page.evaluate(() => window.ion.backup.review({ categories: ['tests'], folders: [] }))
  assert.equal(review.entries.length, 1)
  assert.match(review.entries[0].path, /^profile\/test-explorer-v1\/[a-f0-9]{64}\.json$/)
  assert.equal(await page.evaluate(token => window.ion.backup.create(token), review.token), archive)
  const restore = await page.evaluate(() => window.ion.backup.openRestore())
  assert.deepEqual(restore.entries, review.entries)
  assert.deepEqual(restore.folders, [])
  assert.ok(restore.warnings.some(warning => /historical and stale/.test(warning)))
  await page.evaluate(() => window.ion.backup.cancel())
}

await withScratch('test-explorer-native', async scratch => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const numbers = join(project.directory, 'test_numbers.py')
  const collected = join(project.directory, 'collected.txt')
  const source = [
    'import pytest',
    'from pathlib import Path',
    'with Path("collected.txt").open("a", encoding="utf-8") as marker: marker.write("C")',
    '@pytest.mark.parametrize("n", [1, 2])',
    'def test_positive(n):',
    '    assert n > 0',
    'def test_wrong():',
    '    assert 2 == 3',
    '@pytest.mark.skip(reason="intentional fixture skip")',
    'def test_skipped():',
    '    pass',
  ].join('\n')
  await writeFile(numbers, source)
  const savedProgram = await readFile(project.program)
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false }, recents: [] }))
  let session = await launch(target, profile)
  try {
    let { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openExplorer(page)
    assert.equal(await page.evaluate(root => window.ion.testExplorer.list(root), project.directory), null)
    await assert.rejects(readFile(collected), { code: 'ENOENT' })
    await page.getByRole('button', { name: 'Discover Tests…', exact: true }).click()
    await waitForStatus(page, 'cancelled before execution', 10_000)
    assert.equal(await page.evaluate(root => window.ion.testExplorer.list(root), project.directory), null)
    await assert.rejects(readFile(collected), { code: 'ENOENT' },
      'Declined discovery must not import the test module.')
    await stubDialogs(app, { folder: project.directory, allowFrameworkTests: true })
    await page.getByRole('button', { name: 'Discover Tests…', exact: true }).click()
    await waitForStatus(page, '4 pytest cases discovered')
    let record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(record.nodes.filter(node => node.kind === 'test').length, 4)
    await page.getByRole('button', { name: 'Run All', exact: true }).click()
    await waitForStatus(page, '2 passed, 1 failed, 1 skipped')
    record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(record.history.length, 1)
    assert.deepEqual(record.history[0].cases.map(item => item.outcome).sort(), ['failed', 'passed', 'passed', 'skipped'])
    const failedIds = record.history[0].cases.filter(item => item.outcome === 'failed').map(item => item.id)
    await waitForRenderedHistory(page, record.history)
    await page.getByRole('button', { name: 'Rerun Failed', exact: true }).click()
    await waitForStatus(page, '0 passed, 1 failed, 0 skipped')
    record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(record.history.length, 2)
    const newest = [...record.history].sort((a, b) => b.checkedAt - a.checkedAt)[0]
    assert.equal(newest.cases.length, 1)
    assert.equal(newest.cases[0].outcome, 'failed')
    assert.deepEqual(newest.selectedIds, failedIds)
    assert.equal(newest.cases[0].id, failedIds[0])
    await waitForRenderedHistory(page, record.history)
    const failedCase = caseButton(page, 'test_wrong')
    await failedCase.click()
    await page.getByRole('heading', { name: 'test_wrong', exact: true }).waitFor()
    assert.equal(await failedCase.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(newest.cases[0].location, { path: 'test_numbers.py', line: 7 })
    await page.getByRole('button', { name: 'Open source · line 7', exact: true }).click()
    await page.getByRole('heading', { name: 'Test Explorer', exact: true }).waitFor({ state: 'hidden' })
    const sourceTab = atPath(page, 'tab', numbers)
    await sourceTab.waitFor()
    await editorShows(page, 'def test_wrong():')
    await page.getByText('Ln 7, Col 1', { exact: true }).waitFor()
    const beforeEdit = await readFile(collected, 'utf8')
    await page.getByTestId('editor').locator('.view-line').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.insertText(' # unsaved test edit')
    await sourceTab.locator('.tab-dirty').waitFor()
    await openExplorer(page)
    await page.getByRole('button', { name: 'Run All', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Save or resolve unsaved workspace files' }).waitFor()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await editorShows(page, 'unsaved test edit')
    assert.equal(await readFile(numbers, 'utf8'), source)
    assert.equal(await readFile(collected, 'utf8'), beforeEdit)
    await sourceTab.getByTestId('close-tab').click()
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await sourceTab.waitFor({ state: 'detached' })
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    await close(session)
    session = await launch(target, profile)
    ;({ app, page } = session)
    await page.context().setOffline(true)
    const archive = join(scratch, 'history.ionbackup')
    await stubDialogs(app, { folder: project.directory, file: archive, save: archive })
    await openFolder(page, project)
    await openExplorer(page)
    const restored = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(restored.history.length, 2)
    await waitForRenderedHistory(page, restored.history)
    await checkBackup(page, archive)
    await page.getByRole('button', { name: 'Run All', exact: true }).click()
    await waitForStatus(page, 'cancelled before execution', 10_000)
    assert.equal(await readFile(collected, 'utf8'), beforeEdit, 'Reopening history and declining Run must not import tests.')
    assert.deepEqual(await page.evaluate(root => window.ion.testExplorer.list(root), project.directory), restored)
    await stubDialogs(app, { folder: project.directory, allowFrameworkTests: true })
    const slowSource = [
      'import json, os, subprocess, sys', 'from pathlib import Path', 'def test_wait():',
      '    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])',
      '    Path("started.txt").write_text(json.dumps([os.getpid(), child.pid]), encoding="utf-8")',
      '    child.wait()',
    ].join('\n')
    const slow = join(project.directory, 'test_wait.py')
    await writeFile(slow, slowSource)
    await page.getByRole('button', { name: 'Refresh Discovery…', exact: true }).click()
    await waitForStatus(page, '5 pytest cases discovered')
    const waitingCase = caseButton(page, 'test_wait')
    await waitingCase.click()
    record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    const waitingId = record.nodes.find(node => node.kind === 'test' && node.label === 'test_wait')?.id
    assert.ok(waitingId)
    await page.getByRole('button', { name: 'Run Selected', exact: true }).click()
    const started = join(project.directory, 'started.txt')
    await eventually(async () => Boolean(await readFile(started, 'utf8').catch(() => '')), 'Selected test did not start', 20_000)
    const pids = JSON.parse(await readFile(started, 'utf8'))
    assert.ok(pids.length === 2 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && !exited(pid)))
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await waitForStatus(page, 'Testing stopped.', 15_000)
    record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(record.history.length, 3)
    const stopped = [...record.history].sort((a, b) => b.checkedAt - a.checkedAt)[0]
    assert.equal(stopped.status, 'cancelled')
    assert.deepEqual(stopped.selectedIds, [waitingId])
    assert.deepEqual(stopped.cases.map(item => ({ id: item.id, outcome: item.outcome })), [{ id: waitingId, outcome: 'cancelled' }])
    await waitForRenderedHistory(page, record.history)
    await eventually(() => pids.every(exited), 'Stop left a pytest fixture process alive.', 8_000)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('dialog', { name: 'Test Explorer' }).waitFor({ state: 'hidden' })
    await close(session)
    assert.equal(await readFile(numbers, 'utf8'), source)
    assert.equal(await readFile(slow, 'utf8'), slowSource)
    assert.deepEqual(await readFile(project.program), savedProgram)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    console.log('PASS production Test Explorer: real pytest discovery and runs, source navigation, preserved edits, history backup, fresh approval after restart, Stop and child cleanup')
  } catch (failure) {
    // Preserve the failed product assertion even if a still-open dialog also
    // refuses the later quit. The disposable fixture contains no user files.
    console.error('Desktop journey failed before cleanup:', failure)
    try {
      const modal = session.page.getByRole('dialog', { name: 'Test Explorer' })
      if (await modal.isVisible()) {
        console.error('Test Explorer status at failure:', (await modal.locator('[role=status], [role=alert]').allTextContents()).map(text => text.slice(0, 400)))
        await modal.getByRole('button', { name: 'Close dialog' }).click()
      }
    } catch (detail) { console.error('Dialog cleanup:', detail.message) }
    try { await close(session) }
    catch (cleanup) { throw new AggregateError([failure, cleanup], 'Test Explorer journey and cleanup both failed.') }
    throw failure
  }
})
