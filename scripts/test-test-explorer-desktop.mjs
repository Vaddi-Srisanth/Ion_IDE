import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, close, createProject, eventually, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

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

await withScratch('test-explorer-native', async scratch => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  await writeFile(join(project.directory, 'test_numbers.py'), [
    'import pytest',
    'from pathlib import Path',
    'Path("collected.txt").write_text("collected", encoding="utf-8")',
    '@pytest.mark.parametrize("n", [1, 2])',
    'def test_positive(n):',
    '    assert n > 0',
    'def test_wrong():',
    '    assert 2 == 3',
    '@pytest.mark.skip(reason="intentional fixture skip")',
    'def test_skipped():',
    '    pass',
  ].join('\n'))
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  let session = await launch(target, profile)
  try {
    let { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openExplorer(page)
    assert.equal(await page.evaluate(root => window.ion.testExplorer.list(root), project.directory), null)
    assert.equal(await readFile(join(project.directory, 'collected.txt'), 'utf8').catch(() => null), null)
    await page.getByRole('button', { name: 'Discover Tests…', exact: true }).click()
    await eventually(async () => /cancel/i.test(await page.locator('.test-explorer-status').innerText()), 'Declined discovery was not cancelled.', 10_000)
    assert.equal(await page.evaluate(root => window.ion.testExplorer.list(root), project.directory), null)
    assert.equal(await readFile(join(project.directory, 'collected.txt'), 'utf8').catch(() => null), null,
      'Declined discovery must not import the test module.')
    await stubDialogs(app, { folder: project.directory, allowFrameworkTests: true })
    await page.getByRole('button', { name: 'Discover Tests…', exact: true }).click()
    await eventually(async () => await page.locator('.test-explorer-tree button').count() >= 4, 'pytest discovery failed', 65_000)
    let record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(record.nodes.filter(node => node.kind === 'test').length, 4)
    await page.getByRole('button', { name: 'Run All', exact: true }).click()
    await eventually(async () => {
      record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
      return record.history.length === 1
    }, 'pytest run did not persist results', 65_000)
    assert.deepEqual(record.history[0].cases.map(item => item.outcome).sort(), ['failed', 'passed', 'passed', 'skipped'])
    const failedIds = record.history[0].cases.filter(item => item.outcome === 'failed').map(item => item.id)
    await waitForRenderedHistory(page, record.history)
    await page.getByRole('button', { name: 'Rerun Failed', exact: true }).click()
    await eventually(async () => {
      record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
      return record.history.length === 2
    }, 'Rerun failed did not finish', 65_000)
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
    await page.getByTestId('tab').filter({ hasText: 'test_numbers.py' }).waitFor()
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    await close(session)
    session = await launch(target, profile)
    ;({ app, page } = session)
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowFrameworkTests: true })
    await openFolder(page, project)
    await openExplorer(page)
    const restored = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(restored.history.length, 2)
    await waitForRenderedHistory(page, restored.history)
    await writeFile(join(project.directory, 'test_wait.py'), [
      'from pathlib import Path', 'import time', 'def test_wait():',
      '    Path("started.txt").write_text("started", encoding="utf-8")', '    time.sleep(60)',
    ].join('\n'))
    await page.getByRole('button', { name: 'Refresh Discovery…', exact: true }).click()
    const waitingCase = caseButton(page, 'test_wait')
    await waitingCase.waitFor({ timeout: 65_000 })
    await waitingCase.click()
    record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    const waitingId = record.nodes.find(node => node.kind === 'test' && node.label === 'test_wait')?.id
    assert.ok(waitingId)
    await page.getByRole('button', { name: 'Run Selected', exact: true }).click()
    await eventually(async () => await readFile(join(project.directory, 'started.txt'), 'utf8').catch(() => '') === 'started', 'Selected test did not start', 20_000)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await eventually(async () => {
      record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
      return record.history.some(run => run.status === 'cancelled')
    }, 'Stop did not preserve cancelled evidence', 15_000)
    const stopped = [...record.history].sort((a, b) => b.checkedAt - a.checkedAt)[0]
    assert.equal(stopped.status, 'cancelled')
    assert.deepEqual(stopped.selectedIds, [waitingId])
    assert.deepEqual(stopped.cases.map(item => ({ id: item.id, outcome: item.outcome })), [{ id: waitingId, outcome: 'cancelled' }])
    await waitForRenderedHistory(page, record.history)
    await eventually(async () => /^Testing stopped\./.test(await page.locator('.test-explorer-status').innerText()),
      'Stop did not finish cleanup and render its cancellation result.')
    assert.equal(await page.locator('.test-explorer-error').count(), 0)
    await close(session)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    console.log('PASS production Test Explorer: declined discovery, real pytest collection, parameterized cases, outcomes, rerun failed, navigation, relaunch history, cancellation and owned shutdown')
  } finally { await close(session) }
})
