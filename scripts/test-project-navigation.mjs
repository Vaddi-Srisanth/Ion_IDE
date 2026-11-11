import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const snapshot = process.platform === 'win32' ? windowsProcessTree : resourceSnapshot
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)

await withScratch('project-navigation', async (scratch) => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const headers = join(project.directory, 'include')
  const header = join(headers, 'arithmetic.h')
  const cpp = join(project.directory, 'project.cpp')
  await mkdir(headers)
  await writeFile(header, 'static inline int increment(int value) { return value + 1; }\n')
  await writeFile(project.program, '#include "include/arithmetic.h"\nint main(void) { return increment(41) + increment(0); }\n')
  await writeFile(cpp, '#include "include/arithmetic.h"\nint main() { return increment(5); }\n')
  const session = await launch(target, join(scratch, 'profile'))
  const { page, app } = session
  const clangd = async () => (await snapshot(session, { details: true })).members
    .filter(({ name }) => /^clangd(?:[.-].*)?$/i.test(name ?? ''))
  let completed = false
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
    const text = await readFile(project.program, 'utf8')
    const location = await page.evaluate(async ({ path, text }) => window.ion.languageTools.query({
      language: 'c', path, text, version: 999, operation: 'definition', offset: text.indexOf('increment(41)') + 3,
    }), { path: project.program, text }).catch(error => ({ error: String(error) }))
    console.error({ problem: error.message, dialog: await page.getByRole('dialog').first().isVisible()
      ? await page.getByRole('dialog').first().innerText() : '', errors: session.errors, location,
      status: await page.locator('.java-tool-status, .notification, [role="status"]').allTextContents() })
    throw error
  } finally {
    if (!completed) {
      const dismiss = page.getByRole('dialog').first().getByRole('button', { name: 'Close dialog', exact: true })
      if (await dismiss.isVisible()) await dismiss.click().catch(() => {})
    }
    await close(session)
  }
})
