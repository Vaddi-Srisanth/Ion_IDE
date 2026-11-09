import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, editorShows, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  measure: { type: 'boolean', default: false },
} })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for native dialog stubbing.')

const projectApproval = 'Run C/C++ Build'
const terminalRows = '[data-testid="run-console-terminal"] .xterm-rows > div'
const timeout = 20_000

async function observeApprovals(app, directory, allowRun) {
  await stubDialogs(app, { folder: directory, allowRun })
  await app.evaluate(({ dialog }) => {
    const showMessageBox = dialog.showMessageBox
    globalThis.ionNativeBuildApprovals = []
    dialog.showMessageBox = async (window, options) => {
      globalThis.ionNativeBuildApprovals.push(options.buttons ?? [])
      return showMessageBox(window, options)
    }
  })
}

const approvals = (app) => app.evaluate(() => globalThis.ionNativeBuildApprovals)

function waitForTerminal(page, marker) {
  return page.waitForFunction(({ rows, marker }) => {
    const lines = [...document.querySelectorAll(rows)].map((row) => row.textContent?.replaceAll('\u00a0', ' '))
    return lines.join('\n').includes(marker) || lines.join('').includes(marker)
  }, { rows: terminalRows, marker }, { timeout })
}

async function run(page, status, marker, afterClick) {
  await page.evaluate(() => { globalThis.ionNativeBuildEvents.length = 0 })
  const started = performance.now()
  await page.getByTestId('run').click()
  if (afterClick) await afterClick()
  const completed = await page.waitForFunction((expected) => {
    const output = document.querySelector('[data-testid="output"]')
    const events = globalThis.ionNativeBuildEvents
    if (output?.dataset.status === expected && events.some(({ update }) => update.kind === 'complete')) return events
    return false
  }, status, { timeout })
  const events = await completed.jsonValue()
  await completed.dispose()
  if (status === 'success') assert.match(await page.getByTestId('run-console-duration').textContent(), /Exit 0 · \d+ ms/)
  if (marker) await (await waitForTerminal(page, marker)).dispose()
  const updates = events.map(({ update }) => update)
  return {
    elapsedMs: performance.now() - started,
    phases: updates.filter(({ kind }) => kind === 'phase').map(({ phase }) => phase),
    programOutput: updates.filter(({ kind, stream }) => kind === 'data' && stream === 'terminal')
      .map(({ text }) => text).join(''),
  }
}

async function replaceSource(page, source, marker) {
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 6, y: 7 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(source)
  await (await editorShows(page, marker)).dispose()
}

async function makeProject(directory, cpp) {
  const suffix = cpp ? 'cpp' : 'c'
  const mainName = `main.${suffix}`
  const helperName = `src code/total.${suffix}`
  const headerName = 'include files/total.h'
  const manifest = join(directory, '.ion', 'build.json')
  const specification = { version: 1, sources: [mainName, helperName],
    includeDirectories: ['include files'], headers: [headerName] }
  const helper = cpp
    ? '#include "total.h"\nnamespace ion { int total() { return 47; } }\n'
    : '#include "total.h"\nint ion_total(void) { return 19; }\n'
  const main = cpp
    ? '#include <iostream>\n#include "total.h"\nint main() { std::cout << "ION-NATIVE-CPP:" << ion::total() << std::endl; }\n'
    : '#include <stdio.h>\n#include "total.h"\nint main(void) { printf("ION-NATIVE-C:%d\\n", ion_total()); return 0; }\n'
  const header = cpp ? 'namespace ion { int total(); }\n' : 'int ion_total(void);\n'
  await Promise.all(['.ion', 'src code', 'include files'].map((part) => mkdir(join(directory, part), { recursive: true })))
  await Promise.all([
    writeFile(manifest, JSON.stringify(specification)), writeFile(join(directory, mainName), main),
    writeFile(join(directory, helperName), helper), writeFile(join(directory, headerName), header),
    writeFile(join(directory, 'single.c'), '#include <stdio.h>\nint main(void) { puts("ION-NATIVE-SINGLE"); return 0; }\n'),
  ])
  return { directory, program: join(directory, mainName), helper: join(directory, helperName), helperName,
    solo: join(directory, 'single.c'), manifest, specification }
}

await withScratch('native-projects', async (scratch) => {
  const c = await makeProject(join(scratch, 'C project λ with spaces'), false)
  const cpp = await makeProject(join(scratch, 'C++ project λ with spaces'), true)
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  await Promise.all([
    writeFile(join(scratch, 'outside.c'), 'int ion_total(void) { return 89; }\n'),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { autoSave: false, saveBeforeRun: true, keepRunOutput: false }, recents: [] })),
  ])
  const session = await launch(target, profile)
  const { app, page } = session
  let step = 'configured build approval'
  let passed = false
  try {
    await page.context().setOffline(true)
    await page.evaluate(() => {
      const events = globalThis.ionNativeBuildEvents = []
      window.ion.runConsole.onUpdate((event) => events.push(event))
    })
    await observeApprovals(app, c.directory, false)
    await openFolder(page, c)
    await openFromExplorer(page, c.program, 'int main(void)')
    assert.deepEqual(await approvals(app), [], 'Opening a project never requests build execution')
    const declined = await run(page, 'rejected', 'not approved')
    assert.ok(!declined.phases.includes('compiling') && !declined.phases.includes('running'))
    assert.deepEqual(await approvals(app), [['Cancel', projectApproval]])

    await observeApprovals(app, c.directory, true)
    const firstC = await run(page, 'success', 'ION-NATIVE-C:19')
    assert.ok(firstC.phases.includes('compiling') && firstC.phases.includes('running'))
    assert.deepEqual(await approvals(app), [['Cancel', projectApproval]])
    await observeApprovals(app, c.directory, false)
    const declinedAgain = await run(page, 'rejected', 'not approved')
    assert.ok(!declinedAgain.phases.includes('compiling') && !declinedAgain.phases.includes('running'))
    assert.deepEqual(await approvals(app), [['Cancel', projectApproval]], 'A previous approval does not authorize another build')
    console.log('PASS a two-source C build uses the declared include path and requires explicit approval on each Run')

    step = 'single-file fallback and saving a dirty companion'
    await observeApprovals(app, c.directory, true)
    await openFromExplorer(page, c.solo, 'ION-NATIVE-SINGLE')
    const standalone = await run(page, 'success', 'ION-NATIVE-SINGLE')
    assert.deepEqual(await approvals(app), [['Cancel', 'Run Program']])
    await atPath(page, 'explorer-entry', join(c.directory, 'src code')).click()
    await openFromExplorer(page, c.helper, 'return 19')
    const updated = '#include "total.h"\nint ion_total(void) { return 23; }\n'
    await replaceSource(page, updated, 'return 23')
    assert.match(await readFile(c.helper, 'utf8'), /return 19/, 'Autosave is off, so the edit stays in the editor')
    await atPath(page, 'tab', c.program).click()
    await (await editorShows(page, 'int main(void)')).dispose()
    await run(page, 'success', 'ION-NATIVE-C:23')
    assert.equal(await readFile(c.helper, 'utf8'), updated, 'Save Before Run includes the open dirty companion')
    console.log('PASS an unlisted source runs by itself, and Save Before Run persists a dirty configured companion')

    const timings = { configuredC: [], singleFileC: [], configuredCpp: [] }
    if (values.measure) {
      for (let index = 0; index < 3; index++) {
        await atPath(page, 'tab', c.solo).click()
        timings.singleFileC.push((await run(page, 'success', 'ION-NATIVE-SINGLE')).elapsedMs)
        await atPath(page, 'tab', c.program).click()
        timings.configuredC.push((await run(page, 'success', 'ION-NATIVE-C:23')).elapsedMs)
      }
    }

    step = 'failed build and invalid manifest'
    await atPath(page, 'tab', c.helper).click()
    await replaceSource(page, '#error ION-NATIVE-BROKEN\nint ion_total(void) { return 23; }\n', 'ION-NATIVE-BROKEN')
    await atPath(page, 'tab', c.program).click()
    await (await editorShows(page, 'int main(void)')).dispose()
    const failed = await run(page, 'compile-error', 'ION-NATIVE-BROKEN')
    assert.ok(failed.phases.includes('compiling') && !failed.phases.includes('running'))
    assert.equal(failed.programOutput, '', 'A bad build cannot run the last successful executable')
    await writeFile(c.manifest, '{"version":1,"sources":')
    const malformed = await run(page, 'rejected', '.ion/build.json must contain valid UTF-8 JSON.')
    assert.ok(!malformed.phases.includes('compiling') && !malformed.phases.includes('running'))
    await writeFile(c.manifest, JSON.stringify({ version: 1, sources: ['main.c', '../outside.c'] }))
    const escaping = await run(page, 'rejected', 'requires regular workspace-relative paths')
    assert.ok(!escaping.phases.includes('compiling') && !escaping.phases.includes('running'))
    console.log('PASS a failed compile never starts an older binary, and malformed or escaping manifests never compile')

    step = 'companion changed during approval'
    await writeFile(c.manifest, JSON.stringify(c.specification))
    await writeFile(c.helper, updated)
    await app.evaluate(({ dialog }, label) => {
      const showMessageBox = dialog.showMessageBox
      let requested
      globalThis.ionNativeApprovalRequested = new Promise((resolve) => { requested = resolve })
      dialog.showMessageBox = (window, options) => {
        const response = (options.buttons ?? []).indexOf(label)
        if (response < 0) return showMessageBox(window, options)
        return new Promise((resolve) => {
          globalThis.ionCompleteNativeApproval = () => resolve({ response, checkboxChecked: false })
          requested()
        })
      }
    }, projectApproval)
    const changed = await run(page, 'rejected', 'changed', async () => {
      try {
        await app.evaluate(async () => {
          let timer
          try {
            await Promise.race([globalThis.ionNativeApprovalRequested, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Expected pending C/C++ Build approval.')), 5000)
            })])
          } finally { clearTimeout(timer) }
        })
        await writeFile(c.helper, updated.replace('return 23', 'return 29'))
      } finally {
        await app.evaluate(() => {
          globalThis.ionCompleteNativeApproval?.()
          delete globalThis.ionCompleteNativeApproval
          delete globalThis.ionNativeApprovalRequested
        })
      }
    })
    assert.ok(!changed.phases.includes('compiling') && !changed.phases.includes('running'))
    console.log('PASS an externally changed companion invalidates the approved build before the compiler starts')

    step = 'configured C++ build'
    await observeApprovals(app, cpp.directory, true)
    await page.locator('.titlebar').getByTestId('open-folder').click()
    await atPath(page, 'explorer-entry', cpp.program).waitFor()
    await openFromExplorer(page, cpp.program, 'int main()')
    const firstCpp = await run(page, 'success', 'ION-NATIVE-CPP:47')
    assert.ok(firstCpp.phases.includes('compiling') && firstCpp.phases.includes('running'))
    assert.deepEqual(await approvals(app), [['Cancel', projectApproval]])
    console.log('PASS a two-source C++ build links namespaced code and executes it through the normal Run action')
    if (values.measure) {
      for (let index = 0; index < 3; index++) {
        timings.configuredCpp.push((await run(page, 'success', 'ION-NATIVE-CPP:47')).elapsedMs)
      }
      const summary = Object.fromEntries(Object.entries(timings).map(([name, samples]) => [name, {
        samples, median: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
      }]))
      console.log(JSON.stringify({ timing: 'Run click to terminal output and successful exit, milliseconds',
        coldSamples: { configuredC: firstC.elapsedMs, singleFileC: standalone.elapsedMs, configuredCpp: firstCpp.elapsedMs },
        warmSamples: summary }))
    }
    assert.deepEqual((await resourceSnapshot(session)).processes.filter((kind) => kind === 'child'), [],
      'No compiler, program, or PTY process remains after the project runs')
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    passed = true
  } catch (error) {
    console.error('Native project test failed during ' + step)
    if (!page.isClosed()) console.error(await page.getByTestId('output').innerText({ timeout: 500 }).catch(() => ''))
    throw error
  } finally {
    await close(session).catch((error) => {
      if (passed) throw error
      console.error('Closing the test session:', error)
    })
  }
})
