import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  cpuPercent, resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { windowsProcessTree, windowsTreeCPU } from './windows/process-tree.mjs'

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
    if (events.length === 64) events.shift()
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
  globalThis.__ionClangdTimingProbe = stage => record(String(stage).slice(0, 80))
  globalThis.__ionClangdFailureProbe = {
    snapshot: () => ({ spawns, omitted, events: events.slice(), stderr: stderr.toString('utf8'), disposed }),
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of subscriptions) remove()
      subscriptions.clear()
      delete globalThis.__ionClangdTimingProbe
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
    await sleep(750)
    assert.deepEqual(await clangd(), [], 'Opening a source with Smart C/C++ enabled must not start clangd')

    const beforeClangd = await snapshot(session, { details: true })
    const clangdStart = performance.now()
    const symbol = page.locator('.monaco-editor .view-lines').getByText('increment', { exact: true }).first()
    await symbol.click()
    await page.keyboard.press('F12')
    // A cold Windows clangd can legitimately spend more than eight seconds
    // parsing the first translation unit under host security scanning. Keep
    // this distinct from warm requests and preserve the measured outlier.
    await atPath(page, 'tab', header).waitFor({ timeout: 20_000 })
    await editorShows(page, 'static inline int increment')
    const definitionMs = performance.now() - clangdStart
    assert.match(await page.locator('.editor-breadcrumb').innerText(), /project\/include\/arithmetic\.h/)
    const goBack = page.getByRole('button', { name: 'Go Back', exact: true })
    const goForward = page.getByRole('button', { name: 'Go Forward', exact: true })
    await goBack.click()
    await editorShows(page, 'increment(41)')
    await page.keyboard.press('F2')
    const renameDialog = page.getByRole('dialog', { name: 'Review Symbol Rename' })
    await renameDialog.waitFor()
    await renameDialog.getByTestId('entry-name').fill('previewedIncrement')
    await renameDialog.getByTestId('entry-submit').click()
    const reviewDialog = page.getByRole('dialog', { name: 'Apply reviewed rename' })
    await reviewDialog.waitFor()
    assert.match(await reviewDialog.innerText(), /Ion will recheck every file before publishing/)
    await reviewDialog.getByRole('button', { name: 'Cancel' }).click()
    await reviewDialog.waitFor({ state: 'detached' })
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

    const sourceText = await readFile(project.program, 'utf8')
    const query = (operation, text, offset, version, extra = {}) => page.evaluate(
      ({ path, operation, text, offset, version, extra }) => window.ion.languageTools.query({
        language: 'c', path, operation, text, offset, version, ...extra,
      }), { path: project.program, operation, text, offset, version, extra })
    assert.ok((await query('hover', sourceText, sourceText.indexOf('increment(41)') + 3, 2))?.rows.length,
      'clangd hover returned no source information.')
    assert.ok((await query('signature', sourceText, sourceText.indexOf('increment(41)') + 'increment('.length, 3))?.rows.length,
      'clangd signature help returned no callable signature.')
    assert.ok((await query('declaration', sourceText, sourceText.indexOf('increment(41)') + 3, 4))?.rows.some(([path]) => path === header),
      'clangd declaration did not resolve the header.')
    assert.ok((await query('documentSymbols', sourceText, 0, 5))?.rows.some(([name]) => name === 'main'),
      'clangd document symbols did not include main.')
    assert.ok((await query('workspaceSymbols', sourceText, 0, 6, { search: 'increment' }))?.rows.some(([name]) => name.includes('increment')),
      'clangd workspace symbols did not include increment.')
    const completionText = sourceText + '\nint probe(void) { return incr'
    assert.ok((await query('complete', completionText, completionText.length, 7))?.rows.some(([label]) => label.includes('increment')),
      'clangd completion did not use the unsaved buffer.')
    const invalidText = '#include "include/arithmetic.h"\nint main(void) { return ; broken_token }\n'
    assert.ok((await query('diagnostics', invalidText, invalidText.length, 8))?.rows.some(([severity]) => severity === 'error'),
      'clangd diagnostics did not report the unsaved invalid source.')
    await query('codeActions', sourceText, sourceText.indexOf('increment(41)') + 3, 9)

    const workers = await clangd()
    assert.equal(workers.length, 1)
    const activeA = await snapshot(session, { details: true })
    await sleep(750)
    const activeB = await snapshot(session, { details: true })
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
    const renameReview = await page.evaluate(({ path, text }) => window.ion.languageTools.reviewRename({
      language: 'c', path, text, version: 10, operation: 'rename', offset: text.indexOf('increment(41)') + 3,
      replacement: 'advance',
    }, 'advance', []), { path: project.program, text: sourceText })
    assert.ok(renameReview.files.some(({ path, edits }) => path === project.program && edits >= 2),
      `clangd rename review omitted current-translation-unit edits: ${JSON.stringify(renameReview.files)}`)
    const renamed = await page.evaluate(token => window.ion.languageTools.applyEdit(token), renameReview.token)
    assert.deepEqual(renamed.failed, [], 'clangd rename did not publish through Ion safe saves.')
    assert.match(await readFile(project.program, 'utf8'), /advance/)
    const stopStart = performance.now()
    await atPath(page, 'close-tab', cpp).click()
    await atPath(page, 'close-tab', header).click()
    await atPath(page, 'close-tab', project.program).click()
    await eventually(async () => (await clangd()).length === 0, 'clangd remained after closing its last source.')
    const shutdownObservedMs = performance.now() - stopStart
    const afterClangd = await snapshot(session, { details: true })
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    const lifecycle = await app.evaluate(() => globalThis.__ionClangdFailureProbe?.snapshot())
    completed = true
    console.log(JSON.stringify({ definitionMs: Number(definitionMs.toFixed(2)),
      startProcessCount: beforeClangd.members.length, activeProcessCount: activeB.members.length,
      afterProcessCount: afterClangd.members.length,
      serviceMemoryMiB: process.platform === 'win32' ? Number((workers[0].workingSet / 1024 ** 2).toFixed(2)) : workers[0].rssMiB,
      servicePrivateMiB: process.platform === 'win32' ? Number((workers[0].privateBytes / 1024 ** 2).toFixed(2)) : null,
      activeCpuPercent: Number((process.platform === 'win32' ? windowsTreeCPU(activeA, activeB) : cpuPercent(activeA, activeB)).toFixed(2)),
      shutdownObservedMs: Number(shutdownObservedMs.toFixed(2)) }))
    console.log('Clangd lifecycle timing:', JSON.stringify(lifecycle))
    console.log('PASS native clangd diagnostics, completion, hover, signatures, definition, declaration, references, symbols, reviewed rename, scoped navigation and cleanup')
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
