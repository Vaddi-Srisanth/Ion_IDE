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
    await page.getByRole('button', { name: 'Rerun Failed', exact: true }).click()
    await eventually(async () => {
      record = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
      return record.history.length === 2
    }, 'Rerun failed did not finish', 65_000)
    const newest = [...record.history].sort((a, b) => b.checkedAt - a.checkedAt)[0]
    assert.equal(newest.cases.length, 1)
    assert.equal(newest.cases[0].outcome, 'failed')
    await page.locator('.test-explorer-tree button').filter({ hasText: 'test_wrong' }).click()
    await page.getByRole('button', { name: /Open source/ }).click()
    await page.getByRole('heading', { name: 'Test Explorer', exact: true }).waitFor({ state: 'hidden' })
    await page.getByTestId('tab').filter({ hasText: 'test_numbers.py' }).waitFor()
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    await close(session)
    session = await launch(target, profile)
    ;({ app, page } = session)
    await stubDialogs(app, { folder: project.directory, allowFrameworkTests: true })
    await openFolder(page, project)
    await openExplorer(page)
    const restored = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
    assert.equal(restored.history.length, 2)
    await writeFile(join(project.directory, 'test_wait.py'), [
      'from pathlib import Path', 'import time', 'def test_wait():',
      '    Path("started.txt").write_text("started", encoding="utf-8")', '    time.sleep(60)',
    ].join('\n'))
    await page.getByRole('button', { name: 'Refresh Discovery…', exact: true }).click()
    await page.locator('.test-explorer-tree button').filter({ hasText: /^test_wait$/ }).waitFor({ timeout: 65_000 })
    await page.locator('.test-explorer-tree button').filter({ hasText: /^test_wait$/ }).click()
    await page.getByRole('button', { name: 'Run Selected', exact: true }).click()
    await eventually(async () => await readFile(join(project.directory, 'started.txt'), 'utf8').catch(() => '') === 'started', 'Selected test did not start', 20_000)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await eventually(async () => {
      const snapshot = await page.evaluate(root => window.ion.testExplorer.list(root), project.directory)
      return snapshot.history.some(run => run.status === 'cancelled')
    }, 'Stop did not preserve cancelled evidence', 15_000)
    assert.deepEqual(session.errors, [])
    console.log('PASS production Test Explorer: declined discovery, real pytest collection, parameterized cases, outcomes, rerun failed, navigation, relaunch history, cancellation and owned shutdown')
  } finally { await close(session) }
})
