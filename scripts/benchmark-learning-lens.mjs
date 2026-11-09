import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, cpus, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, cpuPercent, createProject, editorShows, launch, openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { windowsProcessTree, windowsTreeCPU } from './windows/process-tree.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, compare: { type: 'string' },
  trials: { type: 'string', default: '3' }, out: { type: 'string', default: 'performance-results/learning-lens/desktop.json' },
} })
const trials = Number(values.trials)
assert.ok(Number.isInteger(trials) && trials >= 2 && trials <= 10)
const targets = await Promise.all([values.compare, values.target].filter(Boolean).map(artifact))
const windows = process.platform === 'win32'
const snapshot = windows ? windowsProcessTree : resourceSnapshot
const compareCPU = windows ? windowsTreeCPU : cpuPercent
const output = (page) => page.locator('[data-testid="output"][data-status="compile-error"]')
const known = (page) => page.locator('[data-testid="learning-diagnostic"][data-category="missing-semicolon"]').first()

async function settled(session) {
  await sleep(500)
  const first = await snapshot(session)
  await sleep(1500)
  const last = await snapshot(session)
  return { rssMiB: last.rssMiB ?? last.workingSetMiB, cpuPercent: compareCPU(first, last) }
}

async function typing(page) {
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 6, y: 7 } })
  await page.keyboard.press('Home')
  await page.evaluate(() => {
    const measurements = []
    const sample = (event) => {
      if (event.key !== 'x') return
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => measurements.push(performance.now() - start)))
    }
    document.addEventListener('keydown', sample, true)
    window.ionLensBenchmarkTyping = { measurements, sample }
  })
  try {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('x')
      await (await page.waitForFunction((count) => window.ionLensBenchmarkTyping.measurements.length === count, i + 1)).dispose()
    }
    await (await editorShows(page, 'xxxxxxxxxxxx')).dispose()
    return await page.evaluate(() => window.ionLensBenchmarkTyping.measurements)
  } finally {
    await page.evaluate(() => {
      document.removeEventListener('keydown', window.ionLensBenchmarkTyping.sample, true)
      delete window.ionLensBenchmarkTyping
    })
  }
}

async function replace(page, source) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(source)
  await (await editorShows(page, source)).dispose()
}

async function sample(target, profile, project) {
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({
    version: 1, settings: { autoSave: false, openFullScreen: false },
  }))
  const session = await launch(target, profile)
  const { page, app } = session
  try {
    await page.context().setOffline(true)
    const welcome = await settled(session)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await page.evaluate(async () => {
      await window.ion.learningPacks.install('c')
      await window.ion.learningPacks.select('c', false)
    })
    await page.getByTestId('workspace-learn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="learning-language"]')?.value === 'c')
    await page.locator('.titlebar').getByTestId('open-folder').click()
    await openFromExplorer(page, project.broken, 'return 0')
    const beforeRun = await settled(session)
    const compileMs = []
    for (let i = 0; i < 4; i++) {
      if (i) {
        await page.locator('.monaco-editor .view-line').first().click()
        await replace(page, 'int main(void) { return ' + i + ' }')
      }
      await page.evaluate(() => {
        window.ionLensRunStarted = false
        const observer = new MutationObserver(() => {
          if (['preparing', 'compiling', 'running'].includes(document.querySelector('[data-testid="output"]')?.dataset.phase)) {
            window.ionLensRunStarted = true
            observer.disconnect()
          }
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
      })
      const start = performance.now()
      await page.getByTestId('run').click()
      await (await page.waitForFunction(() => window.ionLensRunStarted)).dispose()
      await output(page).waitFor()
      await known(page).waitFor()
      compileMs.push(performance.now() - start)
    }
    await page.getByTestId('learning-show-explanation').first().click()
    await page.locator('[data-testid="learning-concept"][data-concept="statements"]').waitFor()
    const explained = await settled(session)
    const typingMs = await typing(page)
    await replace(page, 'int main(void) { return 0; }')
    await page.getByTestId('save-file').click()
    await page.waitForFunction(() => !document.querySelector('.tab-dirty'))
    await page.getByRole('button', { name: 'Toggle Learn panel', exact: true }).click()
    await page.getByTestId('learning-pane').waitFor({ state: 'detached' })
    const closed = await settled(session)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    return { startupMs: session.startupMs, welcome, beforeRun, explained, closed, typingMs, compileMs }
  } finally {
    await close(session)
  }
}

const samples = targets.map((target) => ({ target: target.path, samples: [] }))
await withScratch('learning-lens-bench', async (scratch) => {
  for (let run = 0; run < trials; run++) {
    const order = targets.map((_, index) => index)
    if (run % 2) order.reverse()
    for (const index of order) {
      const project = await createProject(join(scratch, 'project-' + index + '-' + run), { fileCount: 0 })
      samples[index].samples.push(await sample(targets[index], join(scratch, 'profile-' + index + '-' + run), project))
      console.log('Recorded', targets[index].path, run + 1)
    }
  }
})
const path = resolve(values.out)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, JSON.stringify({
  host: { platform: process.platform, arch: arch(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  trials, samples,
}, null, 2) + '\n')
console.log(path)
