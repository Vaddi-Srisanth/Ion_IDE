import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFromExplorer, stubDialogs, waitForFile,
  withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for native dialog stubs.')

async function snapshots(profile) {
  const directory = join(profile, 'recovery')
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const published = names.filter((name) => /^[a-f\d-]{36}\.(?:json|draft)$/i.test(name))
  const contents = await Promise.all(published.map((name) => readFile(join(directory, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })))
  return contents.filter(Boolean)
}

function waitForSnapshots(profile, ...markers) {
  return eventually(async () => {
    const contents = await snapshots(profile)
    return contents.length === markers.length && markers.every((marker) => contents.some((text) => text.includes(marker)))
  }, markers.length ? `Expected journal snapshots for ${markers.join(', ')}.` : 'Resolved drafts stayed in the journal.')
}

async function replaceText(page, text) {
  await page.locator('.monaco-editor .view-line').first().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(text)
  await editorShows(page, text)
}

async function newDraft(page, text) {
  await page.getByTestId('new-file').first().click()
  await replaceText(page, text)
  const label = page.getByTestId('tab').locator('.tab-name[aria-current="true"]')
  const name = await label.textContent()
  assert.match(name, /^Untitled-/)
  return name
}

async function recoveryDialog(page) {
  await page.getByTestId('recover-edits').click()
  const dialog = page.getByRole('dialog', { name: 'Recover unsaved edits' })
  await dialog.waitFor()
  return dialog
}

async function assertDetachedDraft(page, name, marker) {
  const tab = page.getByTestId('tab').filter({ has: page.getByRole('button', { name, exact: true }) })
  await tab.waitFor()
  assert.equal(await tab.getAttribute('data-path'), null, 'Recovered content must be detached from the original path.')
  assert.match(await tab.getByTestId('close-tab').getAttribute('class'), /\btab-dirty\b/)
  await tab.getByRole('button', { name, exact: true }).click()
  await editorShows(page, marker)
  return tab
}

async function assertProcessExited(pid) {
  await eventually(() => {
    try { process.kill(pid, 0); return false } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
  }, `Run Console program ${pid} survived the renderer crash.`)
}

await withScratch('recovery', async (scratch) => {
  const folder = join(scratch, 'workspace café with spaces')
  const profile = join(scratch, 'profile')
  const original = join(folder, 'original notes.txt')
  const saved = join(folder, 'recovered copy.txt')
  const program = join(folder, 'wait for input.c')
  const originalText = 'Original saved file.\n'
  const externalText = 'External revision after the crash.\n'
  const namedDraft = 'ION-NAMED-RECOVERY-DRAFT-λ'
  const untitledDraft = 'ION-UNTITLED-RECOVERY-DRAFT'
  const processDraft = 'ION-PROCESS-RECOVERY-DRAFT'
  const choices = { folder, save: saved, allowRun: true }
  await Promise.all([mkdir(folder), mkdir(profile)])
  await Promise.all([
    writeFile(original, originalText),
    writeFile(program, '#include <stdio.h>\n#ifdef _WIN32\n#include <process.h>\n#define getpid _getpid\n#else\n#include <unistd.h>\n#endif\nint main(void) { printf("ION-RECOVERY-PID:%d\\n", (int)getpid()); fflush(stdout); return getchar() == EOF; }\n'),
  ])

  const first = await launch(target, profile)
  let resolved = false
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, choices)
    await page.getByTestId('settings').first().click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await preferences.getByRole('checkbox', { name: /^Autosave/ }).uncheck()
    await preferences.getByRole('button', { name: 'Done' }).click()
    await eventually(() => page.evaluate(async () => !(await window.ion.getPreferences()).settings.autoSave),
      'Autosave preference was not written.')
    await page.getByTestId('welcome').getByTestId('open-folder').click()
    await openFromExplorer(page, original, originalText.trim())
    await replaceText(page, namedDraft)
    const untitledName = await newDraft(page, untitledDraft)
    await waitForSnapshots(profile, namedDraft, untitledDraft)
    assert.equal(await readFile(original, 'utf8'), originalText)

    await openFromExplorer(page, program, '#include')
    await page.getByTestId('run').click()
    const pid = await page.waitForFunction(() => {
      const rows = document.querySelector('[data-testid="run-console-terminal"] .xterm-rows')
      return Number(rows?.textContent?.match(/ION-RECOVERY-PID:(\d+)/)?.[1]) || false
    }).then((handle) => handle.jsonValue())
    assert.equal(process.kill(pid, 0), true, 'The Run Console program is alive before crashing the renderer.')
    const [restarted] = await Promise.all([
      app.waitForEvent('window', { timeout: 15_000 }),
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()),
    ])
    restarted.setDefaultTimeout(8_000)
    restarted.on('pageerror', (error) => first.errors.push(error.message))
    await restarted.getByTestId('welcome').waitFor()
    assert.equal(restarted.url(), 'app://workbench/index.html')
    await assertProcessExited(pid)
    assert.equal(await readFile(original, 'utf8'), originalText)
    await writeFile(original, externalText)
    console.log('PASS workbench recycles after renderer crash and terminates its Run Console program')

    const cancelled = await recoveryDialog(restarted)
    await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click()
    await cancelled.waitFor({ state: 'hidden' })
    await waitForSnapshots(profile, namedDraft, untitledDraft)
    const restore = await recoveryDialog(restarted)
    await restore.getByRole('button', { name: 'Restore Drafts', exact: true }).click()
    const untitled = await assertDetachedDraft(restarted, untitledName, untitledDraft)
    await assertDetachedDraft(restarted, basename(original), namedDraft)
    await restarted.getByTestId('save-file').click()
    await waitForFile(readFile, saved, namedDraft)
    await atPath(restarted, 'tab', saved).waitFor()
    assert.equal(await readFile(saved, 'utf8'), namedDraft)
    assert.equal(await readFile(original, 'utf8'), externalText)
    await untitled.getByTestId('close-tab').click()
    const discard = restarted.getByRole('dialog', { name: 'Unsaved changes' })
    await discard.getByRole('button', { name: 'Discard', exact: true }).click()
    await untitled.waitFor({ state: 'detached' })
    await waitForSnapshots(profile)
    assert.deepEqual(first.requests, [], 'No remote renderer requests during crash recovery.')
    assert.deepEqual(first.errors, [], 'No uncaught renderer errors.')
    console.log('PASS named and untitled drafts restore dirty and detached, then clear after Save As or discard')
    resolved = true
  } finally {
    await close(first).catch((error) => { if (resolved) throw error })
  }

  const interrupted = await launch(target, profile)
  try {
    await interrupted.page.context().setOffline(true)
    assert.equal(await interrupted.page.getByTestId('recover-edits').isVisible(), false, 'Resolved drafts do not reappear.')
    await newDraft(interrupted.page, processDraft)
    await waitForSnapshots(profile, processDraft)
  } finally {
    const proc = interrupted.app.process()
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit')
      assert.equal(proc.kill('SIGKILL'), true, 'The operating system accepted the forced termination.')
      await exited
    }
  }
  if (process.platform === 'win32') assert.notEqual(interrupted.app.process().exitCode, 0)
  else assert.equal(interrupted.app.process().signalCode, 'SIGKILL')

  const relaunched = await launch(target, profile)
  const relaunchedProcess = relaunched.app.process()
  try {
    await relaunched.page.context().setOffline(true)
    const discard = await recoveryDialog(relaunched.page)
    await discard.getByRole('button', { name: 'Discard Drafts', exact: true }).click()
    await discard.waitFor({ state: 'hidden' })
    await relaunched.page.getByTestId('recover-edits').waitFor({ state: 'hidden' })
    assert.equal(await relaunched.page.getByTestId('tab').count(), 0)
    await waitForSnapshots(profile)
    assert.deepEqual(relaunched.requests, [])
    assert.deepEqual(relaunched.errors, [])
    console.log('PASS persisted journal survives a forced application exit and supports explicit discard after relaunch')

    await newDraft(relaunched.page, 'ION-DISCARD-ON-QUIT')
    await waitForSnapshots(profile, 'ION-DISCARD-ON-QUIT')
    const exited = once(relaunchedProcess, 'exit')
    void relaunched.app.evaluate(({ app }) => app.quit()).catch(() => {})
    const confirmation = relaunched.page.getByRole('dialog', { name: 'Unsaved changes' })
    await confirmation.getByRole('button', { name: 'Discard', exact: true }).click()
    await exited
    await waitForSnapshots(profile)
    console.log('PASS explicitly discarding on normal quit removes the checkpoint')
  } finally {
    if (relaunchedProcess.exitCode === null && relaunchedProcess.signalCode === null) await close(relaunched)
  }
})
