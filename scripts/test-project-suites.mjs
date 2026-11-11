import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'
import { testSpec, waitForChildren } from './development-workflow-fixtures.mjs'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const programChild = ({ name }) => /^program(?:\.exe)?$|^ion-program(?:\.exe)?$/i.test(name)
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' } } })
const target = await artifact(values.target)
const screenshots = values.screenshots ? resolve(values.screenshots) : null
if (screenshots) await mkdir(screenshots, { recursive: true })

await withScratch('saved-tests', async (scratch) => {
  const project = await createProject(join(scratch, 'C suite ü with spaces'), { fileCount: 0 })
  const profile = join(scratch, 'profile')
  const sample = join(project.directory, 'résultat sample.c')
  const marker = join(project.directory, 'suite-child.pid')
  const original = [
    '#include <stdio.h>',
    'int main(void) {',
    '  FILE *fixture = fopen("relative fixture.txt", "r");',
    '  if (!fixture) return 23;',
    '  fclose(fixture);',
    '  int value = 0;',
    '  if (scanf("%d", &value) != 1) return 3;',
    '  fprintf(stderr, "case stderr\\n");',
    '  printf("doubled: %d\\n", value * 2);',
    '  return value == 2 ? 7 : 0;',
    '}', '',
  ].join('\r\n')
  await mkdir(profile)
  await Promise.all([
    writeFile(sample, original), writeFile(join(project.directory, 'relative fixture.txt'), 'working directory fixture'),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false } })),
    writeFile(project.loop, String.raw`#include <stdio.h>
#ifdef _WIN32
#include <process.h>
#define GETPID _getpid
#else
#include <unistd.h>
#define GETPID getpid
#endif
int main(void) {
    FILE *marker = fopen("suite-child.pid", "w");
    if (!marker) return 23;
    fprintf(marker, "%ld\n", (long) GETPID());
    fclose(marker);
    for (;;) {}
}
`),
  ])
  const spec = testSpec()
  const [passing, failing] = spec.tests
  Object.assign(passing, { source: basename(sample), stdin: '4\n', expectedOutput: 'doubled: 8\n' })
  Object.assign(failing, { source: basename(sample), stdin: '2\n', expectedOutput: 'doubled: 5\n' })
  async function programPid() {
    let pid
    await eventually(async () => {
      pid = Number(await readFile(marker, 'utf8').catch(() => ''))
      return Number.isSafeInteger(pid) && pid > 0
    }, 'The actual C test process did not start.')
    return pid
  }
  const gone = pid => eventually(() => {
    try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }, `Test program ${pid} survived stop or timeout.`)
  const first = await launch(target, profile)
  let failed = false
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
    const root = project.directory
    const stored = () => page.evaluate(path => window.ion.projects.open(path), root)
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => /ProjectTestsDialog/.test(name))), false)
    await page.getByTestId('run-tests').click()
    await page.getByText('Save a C behavior test in Projects to run it here.').waitFor()
    await page.getByRole('dialog', { name: 'Run Tests' }).getByRole('button', { name: 'Done', exact: true }).click()
    const saved = await page.evaluate(({ root, spec }) => window.ion.projects.save(root, spec, null), { root, spec })
    await assert.rejects(page.evaluate(({ root, revision }) => window.ion.projects.runSuite(root, ['pass'], revision),
      { root, revision: saved.revision }), /approv/i)
    await assert.rejects(page.evaluate(({ root, revision }) => window.ion.projects.runSuite(root, ['pass'], revision),
      { root: join(root, 'unrelated'), revision: saved.revision }), /workspace/i)

    await app.evaluate(({ dialog }) => {
      globalThis.ionFixtureApproval = { accepted: false, reviews: [], unexpected: [] }
      const initial = dialog.showMessageBox
      dialog.showMessageBox = async (window, options) => {
        const approve = options.buttons?.indexOf('Approve Test') ?? -1
        if (approve < 0) {
          if (options.buttons?.includes('Run Test')) globalThis.ionFixtureApproval.unexpected.push(options.detail)
          return initial(window, options)
        }
        globalThis.ionFixtureApproval.reviews.push(options.detail)
        return { response: globalThis.ionFixtureApproval.accepted ? approve : options.cancelId, checkboxChecked: false }
      }
    })
    await page.getByTestId('command-palette').click()
    await page.getByTestId('command-palette-input').fill('Run Tests')
    await page.getByRole('option', { name: /Run Tests/ }).waitFor()
    await page.keyboard.press('Enter')
    const panel = page.getByTestId('project-tests')
    const item = (id) => panel.locator(`[data-testid="project-suite-case"][data-case="${id}"]`)
    const select = panel.getByTestId('project-test-selection')
    const run = panel.getByTestId('project-run-suite')
    const summary = panel.getByTestId('project-suite-status')
    const status = (id, label) => item(id).locator('summary').getByText(label, { exact: true })
    await item('pass').locator('summary').click()
    await item('pass').getByTestId('project-suite-approve').click()
    await eventually(async () => (await app.evaluate(() => globalThis.ionFixtureApproval.reviews.length)) === 1,
      'Approval did not show the toolchain preview.')
    assert.deepEqual((await stored()).approved, [])
    assert.equal(await run.isDisabled(), true)
    await app.evaluate(() => { globalThis.ionFixtureApproval.accepted = true })
    for (const id of ['pass', 'fail', 'broken']) {
      if (await item(id).getAttribute('open') === null) await item(id).locator('summary').click()
      await item(id).getByTestId('project-suite-approve').click()
      await status(id, 'Ready').waitFor()
    }
    const reviews = await app.evaluate(() => globalThis.ionFixtureApproval.reviews)
    assert.equal(reviews.length, 4)
    assert.ok(reviews[0].includes(JSON.stringify(sample)), 'The preview displays the source as one structured argument.')
    assert.ok(reviews[0].includes(JSON.stringify(root)))
    assert.match(reviews[0], /(?:clang|gcc|cc)(?:\.exe)?\b/i)
    assert.match(reviews[0], /Compiler arguments: \["-x","c","-std=c17"/)
    assert.match(reviews[0], /Program arguments: \[\]/)

    await select.selectOption('pass')
    await run.click()
    await summary.filter({ hasText: /^1 passed · 0 failed · 0 unable to verify$/ }).waitFor()
    await status('pass', 'Passed').waitFor()
    await select.selectOption('')
    await run.click()
    await summary.filter({ hasText: /^1 passed · 1 failed · 1 unable to verify$/ }).waitFor()
    const beforeRerun = await stored()
    if (await item('fail').getAttribute('open') === null) await item('fail').locator('summary').click()
    assert.match(await item('fail').innerText(), /doubled: 5/)
    assert.match(await item('fail').innerText(), /doubled: 4/)
    assert.match(await item('fail').innerText(), /observed exit code\s+7/i)
    assert.match(await item('fail').innerText(), /case stderr/)
    assert.match(await item('fail').innerText(), /\d+ ms/)
    if (screenshots) {
      for (const id of ['pass', 'broken']) {
        if (await item(id).getAttribute('open') !== null) await item(id).locator('summary').click()
      }
      await page.screenshot({ path: join(screenshots, 'saved-tests.png') })
    }
    await panel.getByTestId('project-rerun-failed').click()
    await summary.filter({ hasText: /^0 passed · 1 failed · 1 unable to verify$/ }).waitFor()
    const afterRerun = await stored()
    assert.equal(afterRerun.evidence.find(item => item.testId === 'pass').checkedAt,
      beforeRerun.evidence.find(item => item.testId === 'pass').checkedAt)
    assert.ok(afterRerun.evidence.find(item => item.testId === 'fail').checkedAt
      > beforeRerun.evidence.find(item => item.testId === 'fail').checkedAt)
    assert.deepEqual(await app.evaluate(() => globalThis.ionFixtureApproval.unexpected), [])
    if (await item('broken').getAttribute('open') === null) await item('broken').locator('summary').click()
    await item('broken').getByTestId('project-test-location').click()
    await atPath(page, 'tab', project.broken).waitFor()
    await editorShows(page, 'return 0')
    console.log('PASS offline approval, scoped suite, Unicode and CRLF fixture, real output and exit code, failed-only rerun and compiler jump')
    await page.getByTestId('run-tests').click()
    await item('waiting').locator('summary').click()
    await item('waiting').getByTestId('project-suite-approve').click()
    await status('waiting', 'Ready').waitFor()
    await select.selectOption('waiting')
    await run.click()
    await panel.getByTestId('project-stop-suite').waitFor()
    const stopped = await programPid()
    await panel.getByTestId('project-stop-suite').click()
    await summary.filter({ hasText: /Stopped after 0 of 1/ }).waitFor()
    await gone(stopped)
    assert.equal((await stored()).evidence.some(item => item.testId === 'waiting'), false)
    await rm(marker)
    await run.click()
    const timedOut = await programPid()
    await summary.filter({ hasText: /^0 passed · 0 failed · 1 unable to verify$/ }).waitFor({ timeout: 15000 })
    await gone(timedOut)
    assert.match((await stored()).evidence.find(item => item.testId === 'waiting').message, /time limit/)
    await waitForChildren(first, children => children.every(child => !programChild(child)),
      'A C test process remained after Stop.')
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    console.log('PASS explicit Stop and timeout drained the real test process')

    await openFromExplorer(page, sample, 'doubled:')
    await page.getByTestId('editor').locator('.view-line').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.insertText(' // local unsaved edit')
    await page.getByTestId('run-tests').click()
    await select.selectOption('pass')
    await run.click()
    await panel.getByRole('alert').filter({ hasText: 'Save or resolve unsaved project files' }).waitFor()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await editorShows(page, 'local unsaved edit')
    assert.equal(await readFile(sample, 'utf8'), original)
    await page.getByTestId('editor').locator('.view-line').first().click()
    await page.keyboard.press(modifier + '+z')
    await page.waitForFunction(() => !document.querySelector('[data-testid="editor"] .view-lines').textContent.includes('local unsaved edit'))
    const sampleTab = atPath(page, 'tab', sample)
    const discard = page.getByRole('button', { name: 'Discard', exact: true })
    await atPath(page, 'close-tab', sample).click()
    await Promise.race([discard.waitFor(), sampleTab.waitFor({ state: 'detached' })])
    if (await discard.isVisible()) await discard.click()
    await sampleTab.waitFor({ state: 'detached' })
    await atPath(page, 'tab', project.program).locator('.tab-name').click()
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-status="success"]').waitFor()
    assert.deepEqual(first.requests, [])
    assert.deepEqual(first.errors, [])
  } catch (error) {
    failed = true
    console.error(error)
    throw error
  } finally {
    if (failed) await first.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    }).catch(() => undefined)
    await close(first)
  }

  const second = await launch(target, profile)
  let abandoned
  try {
    await stubDialogs(second.app, { folder: project.directory })
    await openFolder(second.page, project)
    await second.page.getByTestId('run-tests').click()
    await second.page.locator('[data-case="pass"]').locator('summary').getByText('Passed', { exact: true }).waitFor()
    await second.page.locator('[data-case="waiting"]').locator('summary').getByText('Unable to verify', { exact: true }).waitFor()
    assert.deepEqual((await second.page.evaluate(root => window.ion.projects.open(root), project.directory)).approved,
      ['pass', 'fail', 'broken', 'waiting'])
    await rm(marker)
    await second.page.getByTestId('project-test-selection').selectOption('waiting')
    await second.page.getByTestId('project-run-suite').click()
    abandoned = await programPid()
  } finally {
    await second.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    }).catch(() => undefined)
    await close(second)
  }
  await gone(abandoned)
  console.log('PASS dirty source preserved, Run Console works, evidence survives relaunch, and window teardown drains an active test')
})
