import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifact, close, createProject, editorShows, launch, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'

async function selectProfile(page, profile) {
  await page.getByTestId('settings').click()
  await page.getByTestId('resource-profile').selectOption(profile)
  await page.locator(`.app-shell[data-resource-profile="${profile}"]`).waitFor()
  await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Done' }).click()
}

async function replaceCode(page, source, marker) {
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 8, y: 7 } })
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText(source)
  await editorShows(page, marker)
}

const spec = {
  version: 1, title: 'Save check', description: 'Local verification.', goal: 'Print a greeting.',
  technologies: ['C17'], files: [], environment: ['Clang or GCC'],
  milestones: [{ id: 'greeting', title: 'Greeting', description: '',
    dependsOn: [], acceptance: ['Print the expected greeting.'], status: 'in-progress' }],
  tests: [{ id: 'run-greeting', milestoneId: 'greeting', title: 'Greeting on stdout',
    source: 'program.c', stdin: '', expectedOutput: 'ION-DESKTOP-RUN-OK\n', match: 'exact', exitCode: 0 }],
}
const code = (marker) => '#include <stdio.h>\nint main(void) { puts("ION-DESKTOP-RUN-OK"); }\n/* ' + marker + ' */'
const testArtifact = await artifact('dist')

await withScratch('resource-lifecycle', async (scratch) => {
  const project = await createProject(join(scratch, 'project'))
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  const session = await launch(testArtifact, profile)
  const proc = session.app.process()
  try {
    const { app, page } = session
    await stubDialogs(app, { folder: project.directory, allowRun: true, allowProjectTests: true, allowAutomatic: true })
    await page.locator('.app-shell[data-resource-profile="minimal"]').waitFor()
    assert.equal(await page.evaluate(async () => (await window.ion.getPreferences()).settings.resourceProfile), 'minimal')
    const optionalAssets = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(({ name }) => /LearningPane|MarketplacePane|ProjectsPanel|PracticePane|MonacoSurface/.test(name)).length)
    assert.equal(optionalAssets, 0)

    await openFolder(page, project)
    await page.getByTestId('new-file').first().click()
    await replaceCode(page, '/* unsaved profile draft */', 'unsaved profile draft')
    const inactiveAssets = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(({ name }) => /LearningPane|MarketplacePane|ProjectsPanel|PracticePane|PagedViewer|WordViewer|TableViewer|pdf\.worker|TerminalSurface/.test(name))
      .map(({ name }) => name))
    assert.deepEqual(inactiveAssets, [], 'Normal editing leaves optional panels, viewer engines and the terminal unloaded')
    await selectProfile(page, 'full')
    await editorShows(page, 'unsaved profile draft')
    await selectProfile(page, 'minimal')
    await editorShows(page, 'unsaved profile draft')
    await page.getByTestId('close-tab').click()
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.locator('.monaco-editor').waitFor({ state: 'detached' })
    await sleep(250)
    assert.equal(page.workers().length, 0, 'no editor worker remains with zero open models')
    assert.equal(await page.evaluate(() => window.ion.projects.provider().then(() => true, () => false)), false)
    console.log('PASS cold Minimal modules, draft preservation across profile switches, and parked-editor cleanup')

    await selectProfile(page, 'full')
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-projects').click()
    await page.getByTestId('projects-panel').waitFor()
    await page.evaluate(({ path, data }) => window.ion.projects.save(path, data, null), { path: project.directory, data: spec })
    await page.getByTestId('project-refresh').click()
    await page.locator('.project-test > summary').click()
    await page.getByTestId('project-approve-test').click()
    await page.getByTestId('project-auto-test').click()
    await page.locator('[data-testid="project-auto-test"][aria-pressed="true"]').waitFor()

    await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
    await replaceCode(page, code('approved save'), 'approved save')
    await page.getByTestId('save-file').click()
    await page.locator('[data-testid="project-evidence"][data-status="test-verified"]').waitFor()
    const record = () => page.evaluate((path) => window.ion.projects.open(path), project.directory)
    const prior = (await record()).evidence[0]
    assert.equal(prior.outcome, 'test-verified')
    assert.equal(prior.stale, false)

    await page.getByRole('button', { name: 'Toggle Projects panel' }).click()
    await page.getByTestId('projects-panel').waitFor({ state: 'detached' })
    await replaceCode(page, code('hidden save'), 'hidden save')
    await page.getByTestId('save-file').click()
    await sleep(1400)
    const hidden = await record()
    assert.equal(hidden.evidence[0].checkedAt, prior.checkedAt)
    assert.equal(hidden.evidence[0].stale, true)
    assert.deepEqual(hidden.automatic ?? [], [])

    await page.getByRole('button', { name: 'Toggle Projects panel' }).click()
    await page.getByTestId('projects-panel').waitFor()
    await page.locator('.project-test > summary').click()
    await page.locator('[data-testid="project-auto-test"][aria-pressed="false"]').waitFor()
    await page.getByTestId('project-auto-test').click()
    await page.locator('[data-testid="project-auto-test"][aria-pressed="true"]').waitFor()
    await selectProfile(page, 'minimal')
    await page.getByTestId('project-auto-test').waitFor({ state: 'detached' })
    await replaceCode(page, code('minimal save'), 'minimal save')
    await page.getByTestId('save-file').click()
    await sleep(1400)
    const minimal = await record()
    assert.deepEqual(minimal.automatic ?? [], [])
    assert.equal(minimal.evidence[0].checkedAt, prior.checkedAt)
    assert.deepEqual(session.requests, [])
    console.log('PASS automatic approval, execution, panel deactivation, profile downgrade, and offline operation')

    const nativeWindow = await app.browserWindow(page)
    const exited = once(proc, 'exit')
    await nativeWindow.evaluate((window) => window.close()).catch(() => {})
    const state = await Promise.race([exited, sleep(8000, null, { ref: false })])
    assert.ok(state, 'closing the final Minimal window quits the app')
    await sleep(350)
    const after = await resourceSnapshot(session)
    assert.deepEqual(after.processes, [], 'no owned process remains after close')
    console.log('PASS last-window cleanup drains the Minimal process tree')
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) await close(session)
  }
})
