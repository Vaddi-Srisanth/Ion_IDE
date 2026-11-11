import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { processTree, testSpec } from './development-workflow-fixtures.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, cycles: { type: 'string', default: '24' },
  out: { type: 'string', default: 'performance-results/shutdown-stability.json' },
} })
const cycles = Number(values.cycles)
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 200)
const target = await artifact(values.target)
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const report = { complete: false, platform: process.platform, arch: process.arch,
  mainSha256: createHash('sha256').update(await readFile(join(target.path, 'main/index.cjs'))).digest('hex'),
  cycles: [], cases: [] }
const output = resolve(values.out)
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function gone(pids) {
  await eventually(() => pids.every(pid => !alive(pid)), 'Owned processes survived shutdown: ' + pids.join(', '))
}
async function exitAfter(session, action) {
  const proc = session.appProcess
  const exited = once(proc, 'exit')
  await action()
  await Promise.race([exited, sleep(8000, undefined, { ref: false }).then(() => { throw new Error('Approved shutdown did not exit.') })])
  assert.equal(proc.signalCode, null, 'Shutdown required a terminating signal.')
  assert.equal(proc.exitCode, 0)
}
async function seed(profile) {
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
    settings: { autoSave: false, openFullScreen: false, resourceProfile: 'minimal' }, recents: [] }))
}

function noteFailure(error) {
  report.primaryFailure ??= error.stack ?? String(error)
  console.error('Shutdown fixture failed before teardown:', error)
  throw error
}

try {
  await withScratch('shutdown-stability', async scratch => {
    const project = await createProject(join(scratch, 'workspace café'), { fileCount: 1 })
    const shellConfig = join(scratch, 'shell-config')
    await mkdir(shellConfig)
    await writeFile(join(shellConfig, '.zshrc'), 'PROMPT="ION-SHUTDOWN> "\nunsetopt BEEP BANG_HIST\n')
    process.env.ZDOTDIR = shellConfig
    for (let index = 0; index < cycles; index++) {
      const profile = join(scratch, `cycle-${index}`)
      await seed(profile)
      const session = await launch(target, profile)
      try {
        await session.page.context().setOffline(true)
        if (index % 2) {
          await stubDialogs(session.app, { folder: project.directory })
          await openFolder(session.page, project)
          await openFromExplorer(session.page, project.files[0], 'Ion fixture')
        }
        const childPids = (await processTree(session)).members.map(({ pid }) => pid)
        const began = performance.now()
        await close(session)
        assert.equal(session.appProcess.exitCode, 0)
        await gone(childPids)
        report.cycles.push({ startupMs: session.startupMs, quitMs: performance.now() - began })
        assert.deepEqual(session.requests, [])
        assert.deepEqual(session.errors, [])
      } catch (error) { noteFailure(error) } finally { await close(session) }
    }
    console.log(`PASS ${cycles} startup/shutdown cycles exited and their process trees drained`)

    const profile = join(scratch, 'draft-profile')
    await seed(profile)
    const session = await launch(target, profile)
    const marker = 'ION-SHUTDOWN-UNSAVED-λ'
    try {
      const { app, page } = session
      await page.context().setOffline(true)
      await page.getByTestId('new-file').first().click()
      await page.getByTestId('editor').locator('.view-line').first().click()
      await page.keyboard.press(modifier + '+a')
      await page.keyboard.insertText(marker)
      await (await editorShows(page, marker)).dispose()
      void app.evaluate(({ app }) => app.quit()).catch(() => {})
      const confirmation = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await confirmation.waitFor()
      assert.equal(session.appProcess.exitCode, null)
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await confirmation.waitFor({ state: 'detached' })
      await (await editorShows(page, marker)).dispose()
      await exitAfter(session, async () => {
        void app.evaluate(({ app }) => app.quit()).catch(() => {})
        await confirmation.getByRole('button', { name: 'Keep Drafts and Quit', exact: true }).click()
      })
      const names = await readdir(join(profile, 'recovery'))
      const contents = await Promise.all(names.filter(name => /\.(?:json|draft)$/.test(name))
        .map(name => readFile(join(profile, 'recovery', name), 'utf8')))
      assert.ok(contents.some(text => text.includes(marker)))
      report.cases.push('Canceled close preserves dirty edits and Keep Drafts writes recovery before exit')
    } catch (error) { noteFailure(error) } finally { await close(session) }
    const restored = await launch(target, profile)
    try {
      await restored.page.getByTestId('recover-edits').click()
      const dialog = restored.page.getByRole('dialog', { name: 'Recover unsaved edits', exact: true })
      await dialog.getByRole('button', { name: 'Restore Drafts', exact: true }).click()
      await (await editorShows(restored.page, marker)).dispose()
      await exitAfter(restored, async () => {
        void restored.app.evaluate(({ app }) => app.quit()).catch(() => {})
        await restored.page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
          .getByRole('button', { name: 'Discard', exact: true }).click()
      })
      report.cases.push('Kept edits restore after relaunch and explicit discard exits')
    } catch (error) { noteFailure(error) } finally { await close(restored) }
    console.log('PASS canceled close, recovery-preserving quit, restore and explicit discard')

    const runningProfile = join(scratch, 'running-profile')
    await seed(runningProfile)
    const running = await launch(target, runningProfile)
    const program = join(project.directory, 'waiting.js')
    const childMarker = join(project.directory, 'run-child.pid')
    await writeFile(program, [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'fs.writeFileSync("run.pid", String(process.pid));',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
      'fs.writeFileSync("run-child.pid", String(child.pid));',
      'process.stdin.resume();', '',
    ].join('\n'))
    try {
      const { app, page } = running
      await stubDialogs(app, { folder: project.directory, allowRun: true })
      await openFolder(page, project)
      await openFromExplorer(page, program, 'process.stdin.resume')
      await page.evaluate(path => {
        window.ionShutdownRun = window.ion.runConsole.start(crypto.randomUUID(), path, false).catch(() => {})
      }, program)
      let child
      await eventually(async () => {
        child = Number(await readFile(childMarker, 'utf8').catch(() => ''))
        return child > 0 && alive(child)
      }, 'The Run Console descendant did not start.')
      await page.evaluate(async () => {
        const api = window.ion.terminal
        window.ionShutdownTerminalUnsubscribe = api.onEvent(event => {
          if (event.kind === 'data') void api.ack(event.id, event.sequence)
        })
        const terminal = await api.create(80, 24)
        await api.attach(terminal.id)
      })
      const pids = (await processTree(running)).members.map(({ pid }) => pid)
      assert.ok(pids.includes(child))
      const began = performance.now()
      await close(running)
      await gone(pids)
      report.cases.push({ name: 'Run Console descendant and explicit terminal drained on quit', quitMs: performance.now() - began })
    } catch (error) { noteFailure(error) } finally { await close(running) }
    console.log('PASS live Run Console descendant and terminal exited on application quit')

    const suiteProfile = join(scratch, 'suite-profile')
    await seed(suiteProfile)
    const suiteSession = await launch(target, suiteProfile)
    try {
      const { app, page } = suiteSession
      await stubDialogs(app, { folder: project.directory, allowProjectTests: true })
      await openFolder(page, project)
      await page.getByTestId('run-tests').click()
      const testsDialog = page.getByRole('dialog', { name: 'Run Tests', exact: true })
      await testsDialog.waitFor()
      await app.evaluate(({ app }) => app.quit())
      await sleep(150)
      assert.equal(suiteSession.appProcess.exitCode, null, 'An open modal should allow the renderer to decline a close.')
      assert.equal(await testsDialog.isVisible(), true)
      await testsDialog.getByRole('button', { name: 'Done', exact: true }).click()
      await testsDialog.waitFor({ state: 'detached' })
      report.cases.push('Run Tests modal deliberately declines quit, then dismissing it allows a later quit')
      const spec = testSpec()
      await page.evaluate(async ({ root, spec }) => {
        let record = await window.ion.projects.save(root, spec, null)
        record = await window.ion.projects.approve(root, 'waiting', record.revision)
        window.ionShutdownSuite = window.ion.projects.runSuite(root, ['waiting'], record.revision).catch(() => {})
      }, { root: project.directory, spec })
      let pids
      await eventually(async () => {
        const tree = await processTree(suiteSession)
        pids = tree.members.map(({ pid }) => pid)
        return tree.members.some(({ kind, name }) => kind === 'child' && /^program(?:\.exe)?$/.test(name))
      }, 'The suite program did not start.')
      await close(suiteSession)
      await gone(pids)
      report.cases.push('Running approved suite canceled and all captured descendants exited on quit')
    } catch (error) { noteFailure(error) } finally { await close(suiteSession) }
    console.log('PASS live approved suite canceled and drained on quit')
  })
  report.complete = true
} catch (error) {
  report.error = error.stack ?? String(error)
  throw error
} finally {
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(output)
