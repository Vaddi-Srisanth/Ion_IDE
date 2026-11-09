import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFromExplorer,
  stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, 'prepare-target': { type: 'string' }, screenshots: { type: 'string' },
} })
const screenshots = values.screenshots ? resolve(values.screenshots) : null
if (screenshots) await mkdir(screenshots, { recursive: true })
const capture = (page, name) => screenshots
  ? page.screenshot({ path: join(screenshots, name + '.png') })
  : Promise.resolve()
const target = await artifact(values.target)
const prepareTarget = values['prepare-target'] ? await artifact(values['prepare-target']) : target
const output = (page, status) => page.locator(`[data-testid="output"][data-status="${status}"]`).waitFor()

async function replaceCode(page, code, needle) {
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 8, y: 8 } })
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText(code)
  await editorShows(page, needle)
}

async function workspace(page, mode) {
  if (await page.getByTestId('workspace').count()) await page.getByRole('button', { name: 'Welcome', exact: true }).click()
  await page.getByTestId(`workspace-${mode}`).click()
  await page.locator(`[data-testid="workspace"][data-mode="${mode}"]`).waitFor()
}

async function selectCPack(page) {
  if (!await page.evaluate(() => Boolean(window.ion.learningPacks))) return
  const current = await page.evaluate(() => window.ion.learningPacks.getLibrary())
  if (current.selected === 'c') return
  await page.getByTestId('toggle-marketplace').click()
  if (!current.installed.some(({ id }) => id === 'c')) {
    await page.locator('[data-testid="marketplace-install"][data-pack="c"]').click()
  }
  await page.locator('[data-testid="marketplace-use"][data-pack="c"]').click()
  await page.getByTestId('marketplace-pane').waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.querySelector('[data-testid="learning-language"]')?.value === 'c')
}

await withScratch('workspaces', async (scratch) => {
  const project = await createProject(join(scratch, 'project'))
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  const choices = { folder: project.directory, file: project.broken, allowRun: true, allowProjectTests: true }
  const first = await launch(prepareTarget, profile)
  try {
    const { app, page } = first
    const duplicate = spawn(prepareTarget.executablePath, [`--user-data-dir=${profile}`, ...prepareTarget.args], { stdio: 'ignore' })
    try {
      const code = await Promise.race([once(duplicate, 'exit').then(([status]) => status), delay(5000, -1, { ref: false })])
      assert.equal(code, 0, 'a duplicate launch using the same profile exits')
    } finally {
      if (duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill('SIGKILL')
    }
    await page.context().setOffline(true)
    await page.reload()
    await page.getByTestId('welcome').waitFor()
    await stubDialogs(app, choices)
    await page.getByTestId('settings').click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await preferences.locator('#font-size').selectOption('18')
    await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    await eventually(() => page.evaluate(async () => (await window.ion.getPreferences()).settings.fontSize === 18),
      'The preparation build did not persist the chosen setting.')

    await workspace(page, 'learn')
    await page.getByTestId('learning-pane').waitFor()
    await selectCPack(page)
    await page.getByTestId('open-folder').first().click()
    await atPath(page, 'explorer-entry', project.broken).waitFor()
    await openFromExplorer(page, project.broken, 'return 0')
    await page.getByTestId('run').click()
    await output(page, 'compile-error')
    await page.locator('[data-testid="learning-diagnostic"][data-category="missing-semicolon"]').first().waitFor()
    await page.getByTestId('learning-show-explanation').first().click()
    await page.locator('[data-testid="learning-concept"][data-concept="statements"]').waitFor()
    await capture(page, 'learn')
    await page.getByTestId('run').click()
    await output(page, 'compile-error')
    assert.equal(await page.getByTestId('learning-encouragement').count(), 0, 'unchanged rerun is not a new learning attempt')
    await replaceCode(page, 'int main(void) { return 1 }', 'return 1')
    await page.getByTestId('run').click()
    await output(page, 'compile-error')
    await page.getByTestId('learning-encouragement').first().waitFor()
    await replaceCode(page, 'int main(void) { return 0; }', 'return 0;')
    await page.getByTestId('run').click()
    await output(page, 'success')
    await page.getByTestId('learning-resolved').waitFor()
    await waitForFile(readFile, project.broken, 'return 0;')
    const history = await page.evaluate(() => window.ion.learning.getHistory())
    const tracked = history.categories.find((entry) => entry.category === 'missing-semicolon')
    assert.equal(tracked.encountered, 2)
    assert.equal(tracked.repeated, 1)
    assert.equal(tracked.resolved, 1)
    console.log('PASS offline launch, C diagnosis, explanation, unchanged rerun, recurrence, and resolution')

    await workspace(page, 'projects')
    await page.getByTestId('projects-panel').waitFor()
    await page.getByTestId('project-title').fill('Offline project')
    await page.getByTestId('project-description').fill('Verify the console greeting.')
    await page.getByTestId('project-create').click()
    await page.getByTestId('project-edit').click()
    const spec = {
      version: 1,
      title: 'Offline project',
      description: 'Verify the console greeting.',
      goal: 'Print a greeting.',
      technologies: ['C17'],
      files: [{ path: 'program.c', purpose: 'Print the greeting.', required: true }],
      milestones: [{ id: 'greeting', title: 'Print greeting', description: 'Write the greeting to standard output.',
        dependsOn: [], acceptance: ['Print ION-DESKTOP-RUN-OK.'], status: 'in-progress' }],
      environment: ['GCC or Clang'],
      tests: [{ id: 'run-greeting', milestoneId: 'greeting', title: 'Greeting on stdout', source: 'program.c',
        stdin: '', expectedOutput: 'ION-DESKTOP-RUN-OK\n', match: 'exact', exitCode: 0 }],
    }
    await page.getByTestId('project-spec-json').fill(JSON.stringify(spec, null, 2))
    await page.getByTestId('project-save').click()
    await page.locator('.project-test > summary').getByText('Greeting on stdout', { exact: false }).click()
    await page.getByTestId('project-approve-test').click()
    await page.getByTestId('project-run-test').click()
    await page.getByTestId('project-evidence').waitFor()
    const verified = await page.evaluate((path) => window.ion.projects.open(path), project.directory)
    assert.equal(verified.evidence[0].outcome, 'test-verified')
    assert.equal(verified.evidence[0].stale, false)
    await capture(page, 'projects')
    const original = await readFile(project.program, 'utf8')
    await writeFile(project.program, original + '// external edit\n')
    await page.getByTestId('project-refresh').click()
    await page.locator('[data-testid="project-evidence"][data-status="unable-to-verify"]').waitFor()
    await writeFile(project.program, original)
    await page.getByTestId('project-run-test').click()
    await page.locator('[data-testid="project-evidence"][data-status="test-verified"]').waitFor()
    console.log('PASS manual offline plan, roadmap edit, explicit test review, and native C verification')

    await workspace(page, 'practice')
    await page.getByTestId('practice-new').click()
    await page.getByTestId('practice-title').fill('Echo sample')
    await page.getByTestId('practice-statement').fill('Print the word hi on standard output.')
    await page.getByTestId('practice-notes').fill('Keep independent attempts.')
    await page.getByTestId('practice-add-sample').click()
    await page.getByTestId('practice-expected').fill('hi\n')
    await page.getByTestId('practice-save').click()
    await page.getByTestId('practice-saved-notes').waitFor()
    await page.getByTestId('practice-new-attempt').click()
    await page.getByTestId('entry-submit').click()
    await page.getByTestId('entry-submit').waitFor({ state: 'detached' })
    await page.getByTestId('editor').locator('.monaco-editor').waitFor()
    await replaceCode(page, '#include <stdio.h>\nint main(void) { puts("hi"); }', 'puts("hi")')
    await page.getByTestId('practice-run-samples').click()
    await page.getByTestId('practice-results').getByText('1 of 1 passed', { exact: true }).waitFor()
    await capture(page, 'practice')
    await page.getByTestId('practice-new-attempt').click()
    await page.getByTestId('entry-submit').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="practice-attempt"]')?.options.length === 2)
    console.log('PASS local problem, notes, sample behavior, and independent practice attempts')

    assert.deepEqual(first.requests, [], 'No outbound renderer requests in offline workspaces')
    assert.deepEqual(first.errors, [], 'No uncaught renderer errors')
  } finally {
    await close(first)
  }

  const second = await launch(target, profile)
  try {
    const { app, page } = second
    await stubDialogs(app, choices)
    await page.context().setOffline(true)
    await page.locator('.recent-entry').filter({ hasText: project.directory }).click()
    await page.locator('[data-testid="workspace"][data-mode="free"]').waitFor()
    assert.equal(await page.getByTestId('learning-pane').count(), 0)
    assert.equal(await page.getByTestId('practice-pane').count(), 0)
    const saved = await page.evaluate(async (root) => {
      const { settings } = await window.ion.getPreferences()
      const problems = await window.ion.practice.list()
      const roadmap = await window.ion.projects.open(root)
      const history = await window.ion.learning.getHistory()
      return { settings, problems, roadmap, history }
    }, project.directory)
    assert.ok(saved.problems.problems.some((problem) => problem.title === 'Echo sample'))
    assert.equal(saved.settings.fontSize, 18)
    assert.equal(saved.roadmap.spec.title, 'Offline project')
    assert.equal(saved.roadmap.evidence[0].outcome, 'test-verified')
    assert.ok(saved.history.categories.some((category) => category.resolved === 1))
    assert.equal(await readFile(project.broken, 'utf8'), 'int main(void) { return 0; }')
    await workspace(page, 'learn')
    await selectCPack(page)
    await page.getByTestId('learning-history').click()
    await page.getByTestId('learning-clear-history').click()
    await page.getByTestId('learning-confirm-clear').click()
    await eventually(() => page.evaluate(async () => {
      const data = await window.ion.learning.getHistory()
      return !data.categories.length && !data.topics.length
    }), 'Learning history was not cleared.')
    assert.deepEqual(second.requests, [])
    console.log(values['prepare-target']
      ? 'PASS upgrade preserved settings, recent workspace, files, roadmap, practice, and learning history'
      : 'PASS offline relaunch, retained settings, files and local progress, and clean Free Coding')
  } finally {
    await close(second)
  }
})
