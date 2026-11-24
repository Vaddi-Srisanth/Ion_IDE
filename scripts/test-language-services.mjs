import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)

await withScratch('language-services', async scratch => {
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const packagePath = join(project.directory, 'study')
  const helper = join(packagePath, 'helper.py')
  const source = join(project.directory, 'main.py')
  await mkdir(packagePath)
  await writeFile(join(packagePath, '__init__.py'), '')
  await writeFile(helper, 'def greet(name: str) -> str:\n    return f"Hello {name}"\n')
  const text = 'from study.helper import greet\n\nprint(greet("Ion"))\n'
  await writeFile(source, text)
  const jsHelper = join(project.directory, 'helper.js')
  const jsSource = join(project.directory, 'main.js')
  await writeFile(jsHelper, 'export function total(a, b) { return a + b }\n')
  const jsText = 'import { total } from "./helper.js"\nconsole.log(total(2, 3))\n'
  await writeFile(jsSource, jsText)
  const session = await launch(target, join(scratch, 'profile'))
  const { page, app } = session
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    await openFromExplorer(page, source, 'greet')
    assert.deepEqual(await page.evaluate(() => window.ion.languageTools.status()), [], 'Opening Python started a service before opt-in.')

    await page.getByTestId('settings').click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Smart Python/ }).check()
    await page.waitForFunction(async () => (await window.ion.getPreferences()).settings.smartLanguages.includes('python'))
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.ion.languageTools.status()), [], 'Opt-in started Python before a semantic request.')

    await sleep(750)
    const beforePython = await resourceSnapshot(session, { details: true })
    const pythonStart = performance.now()
    const result = await page.evaluate(({ path, text }) => window.ion.languageTools.query({
      language: 'python', path, text, version: 1, operation: 'definition', offset: text.lastIndexOf('greet') + 2,
    }), { path: source, text })
    const pythonStartMs = performance.now() - pythonStart
    assert.ok(result?.rows.some(([path]) => path === helper), 'Python LSP did not resolve the workspace definition.')
    assert.ok((await page.evaluate(() => window.ion.languageTools.status())).some(status => status.language === 'python' && status.state === 'ready'))

    await sleep(750)
    const withPython = await resourceSnapshot(session, { details: true })
    const pythonStop = performance.now()
    await atPath(page, 'close-tab', source).click()
    await eventually(async () => (await page.evaluate(() => window.ion.languageTools.status()))
      .some(status => status.language === 'python' && status.state === 'stopped'), 'Python service did not stop after its last source closed.')
    await sleep(750)
    const afterPython = await resourceSnapshot(session, { details: true })

    await openFromExplorer(page, jsSource, 'total')
    await page.getByTestId('settings').click()
    const jsSettings = page.getByRole('dialog', { name: 'Preferences' })
    await jsSettings.getByRole('checkbox', { name: /^Smart JS\/TypeScript/ }).check()
    await jsSettings.getByRole('button', { name: 'Done', exact: true }).click()
    const jsResult = await page.evaluate(async ({ path, text }) => {
      try {
        return { result: await window.ion.languageTools.query({
          language: 'javascript', path, text, version: 1, operation: 'definition', offset: text.lastIndexOf('total') + 2,
        }) }
      } catch (error) { return { error: String(error) } }
    }, { path: jsSource, text: jsText })
    if (jsResult.error) assert.match(jsResult.error, /Install typescript-language-server/)
    else assert.ok(jsResult.result?.rows.some(([path]) => path === jsHelper), 'TypeScript LSP did not resolve the JavaScript definition.')
    const jsStatus = (await page.evaluate(() => window.ion.languageTools.status())).filter(status => status.language === 'javascript').at(-1)
    assert.ok(jsStatus && (jsStatus.state === 'ready' || jsStatus.state === 'error'))
    await atPath(page, 'close-tab', jsSource).click()
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log(JSON.stringify({
      pythonStartMs: Number(pythonStartMs.toFixed(2)), pythonStopMs: Number((performance.now() - pythonStop).toFixed(2)),
      beforeRssMiB: beforePython.rssMiB, activeRssMiB: withPython.rssMiB, afterRssMiB: afterPython.rssMiB,
      activeDeltaMiB: Number((withPython.rssMiB - beforePython.rssMiB).toFixed(2)),
      retainedDeltaMiB: Number((afterPython.rssMiB - beforePython.rssMiB).toFixed(2)),
    }))
    console.log('PASS Python LSP lazy start, workspace definition, offline operation and cleanup; JS/TS installed service or setup guidance')
  } finally {
    await close(session)
  }
})

