import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const snapshot = process.platform === 'win32' ? windowsProcessTree : resourceSnapshot
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)

// Installed only in this fixture's disposable main entry. Observe stderr and
// lifecycle boundaries without changing commands, input, protocol or ownership.
function installClangdFailureProbe(childProcess, basename, syncExports, errorMonitor) {
  const original = childProcess.spawn, subscriptions = new Set(), events = []
  let stderr = Buffer.alloc(0), sequence = 0, spawns = 0, omitted = 0, disposed = false
  const began = performance.now()
  function record(kind, values = {}) {
    const event = { sequence: ++sequence, elapsedMs: performance.now() - began, kind, ...values }
    if (events.length === 32) events.shift()
    events.push(event)
  }
  function listen(emitter, kind, listener) {
    if (!emitter) return
    emitter.on(kind, listener)
    subscriptions.add(() => emitter.removeListener(kind, listener))
  }
  function spawn(...args) {
    if (!/^clangd(?:\.exe)?$/i.test(basename(String(args[0])))) return Reflect.apply(original, this, args)
    const id = ++spawns
    record('spawn-request', { id })
    let child
    try { child = Reflect.apply(original, this, args) }
    catch (error) { record('spawn-throw', { id, code: String(error?.code ?? '').slice(0, 80) }); throw error }
    if (id > 32) { omitted++; return child }
    listen(child, 'spawn', () => record('spawn', { id, pid: child.pid ?? null }))
    listen(child, 'exit', (code, signal) => record('exit', { id, code, signal }))
    listen(child, 'close', (code, signal) => record('close', { id, code, signal }))
    listen(child.stdout, 'end', () => record('stdout-end', { id }))
    const stdinError = error => {
      record('stdin-error', { id, code: String(error?.code ?? '').slice(0, 80) })
    }
    // Node's monitor observes without handling or reordering normal errors.
    listen(child.stdin, errorMonitor, stdinError)
    listen(child.stderr, 'data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderr = bytes.length >= 8192 ? Buffer.from(bytes.subarray(bytes.length - 8192))
        : Buffer.concat([stderr.subarray(Math.max(0, stderr.length + bytes.length - 8192)), bytes])
    })
    return child
  }
  childProcess.spawn = spawn
  syncExports()
  globalThis.__ionClangdFailureProbe = {
    snapshot: () => ({ spawns, omitted, events: events.slice(), stderr: stderr.toString('utf8'), disposed }),
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of subscriptions) remove()
      subscriptions.clear()
      if (childProcess.spawn === spawn) { childProcess.spawn = original; syncExports() }
    },
  }
}

await withScratch('project-navigation', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const headers = join(project.directory, 'include')
  const header = join(headers, 'arithmetic.h')
  const cpp = join(project.directory, 'project.cpp')
  await mkdir(headers)
  await writeFile(header, 'static inline int increment(int value) { return value + 1; }\n')
  await writeFile(project.program, '#include "include/arithmetic.h"\nint main(void) { return increment(41) + increment(0); }\n')
  await writeFile(cpp, '#include "include/arithmetic.h"\nint main() { return increment(5); }\n')
  assert.ok(target.args[0], 'The navigation fixture requires a disposable source entry.')
  const probeEntry = join(scratch, 'navigation-clangd-observer.cjs')
  await writeFile(probeEntry, `(${installClangdFailureProbe.toString()})(require('node:child_process'),require('node:path').basename,require('node:module').syncBuiltinESMExports,require('node:events').errorMonitor);require(${JSON.stringify(resolve(target.args[0]))});`)
  const session = await launch({ ...target, path: probeEntry, args: [probeEntry, ...target.args.slice(1)] }, join(scratch, 'profile'))
  const { page, app } = session
  const clangd = async () => (await snapshot(session, { details: true })).members
    .filter(({ name }) => /^clangd(?:[.-].*)?$/i.test(name ?? ''))
  let completed = false
  let primaryError
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, project.program, 'increment')
    assert.deepEqual(await clangd(), [], 'Basic Mode must not start clangd')
    await page.getByTestId('settings').click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Smart C\/C\+\+/ }).check()
    await page.waitForFunction(async () => (await window.ion.getPreferences()).settings.smartLanguages.includes('c'))
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    assert.deepEqual(await clangd(), [], 'Opening a source with Smart C/C++ enabled must not start clangd')

    const symbol = page.locator('.monaco-editor .view-lines').getByText('increment', { exact: true }).first()
    await symbol.click()
    await page.keyboard.press('F12')
    await atPath(page, 'tab', header).waitFor()
    await editorShows(page, 'static inline int increment')
    assert.match(await page.locator('.editor-breadcrumb').innerText(), /project\/include\/arithmetic\.h/)
    const goBack = page.getByRole('button', { name: 'Go Back', exact: true })
    const goForward = page.getByRole('button', { name: 'Go Forward', exact: true })
    await goBack.click()
    await editorShows(page, 'increment(41)')
    assert.match(await page.locator('.document-status').innerText(), /Ln 2, Col/)
    await goForward.click()
    await editorShows(page, 'static inline int increment')
    await goBack.click()
    await editorShows(page, 'increment(41)')
    await page.getByTestId('command-palette').click()
    await page.getByTestId('command-palette-input').fill('Find References')
    await page.keyboard.press('Enter')
    const references = page.getByTestId('source-reference')
    await references.first().waitFor()
    assert.ok((await references.allTextContents()).filter((text) => text.includes('program.c')).length >= 2)
    await references.last().click()
    await page.getByRole('dialog', { name: 'Find References' }).waitFor({ state: 'detached' })
    await eventually(async () => (await page.locator('.document-status').innerText()).includes('Ln 2, Col 41'),
      'Selecting a reference did not jump to its location.')

    const workers = await clangd()
    assert.equal(workers.length, 1)
    if (process.platform === 'darwin') {
      const probe = join(scratch, 'proc-rusage')
      execFileSync('/usr/bin/clang', ['-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
      const [, footprint] = execFileSync(probe, [String(workers[0].pid)], { encoding: 'utf8' }).trim().split(' ').map(Number)
      console.log(`clangd current-translation-unit fixture: ${(footprint / 2 ** 20).toFixed(2)} MiB attributed, ${workers[0].rssMiB.toFixed(2)} MiB RSS.`)
    }
    await openFromExplorer(page, cpp, 'increment(5)')
    await page.locator('.monaco-editor .view-lines').getByText('increment', { exact: true }).first().click()
    await page.keyboard.press('F12')
    await editorShows(page, 'static inline int increment')
    assert.equal((await clangd()).length, 1, 'C and C++ reuse the workspace clangd process')
    await atPath(page, 'close-tab', cpp).click()
    await atPath(page, 'close-tab', header).click()
    await atPath(page, 'close-tab', project.program).click()
    await eventually(async () => (await clangd()).length === 0, 'clangd remained after closing its last source.')
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    completed = true
    console.log('PASS native clangd definition, references, scoped Back/Forward, breadcrumbs and worker cleanup')
  } catch (error) {
    primaryError = error
    const probe = await app.evaluate(() => globalThis.__ionClangdFailureProbe?.snapshot()
      ?? { unavailable: 'Clangd observation was not installed.' })
      .catch(error => ({ unavailable: String(error).slice(0, 1000) }))
    console.error('Clangd process evidence:', JSON.stringify(probe))
    const text = await readFile(project.program, 'utf8')
    const location = await page.evaluate(async ({ path, text }) => window.ion.languageTools.query({
      language: 'c', path, text, version: 999, operation: 'definition', offset: text.indexOf('increment(41)') + 3,
    }), { path: project.program, text }).catch(error => ({ error: String(error) }))
    console.error({ problem: error.message, dialog: await page.getByRole('dialog').first().isVisible()
      ? await page.getByRole('dialog').first().innerText() : '', errors: session.errors, location,
      status: await page.locator('.java-tool-status, .notification, [role="status"]').allTextContents() })
    throw error
  } finally {
    let cleanupError
    try {
      await app.evaluate(() => globalThis.__ionClangdFailureProbe?.dispose())
    } catch (error) {
      cleanupError = error
    }
    try {
      if (!completed) {
        const dialog = page.getByRole('dialog').first()
        const dismiss = dialog.getByRole('button', { name: 'Close dialog', exact: true })
        if (await dismiss.isVisible()) {
          await dismiss.click()
          await dialog.waitFor({ state: 'detached' })
        }
      }
    } catch (error) { cleanupError = error }
    try { await close(session) } catch (error) { cleanupError ??= error }
    if (cleanupError) {
      if (!primaryError) throw cleanupError
      console.error('Project navigation cleanup also failed:', String(cleanupError.message).slice(0, 1000))
    }
  }
})
