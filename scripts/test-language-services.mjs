import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, cpuPercent, createProject, eventually, launch, openFolder, openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { windowsProcessTree, windowsTreeCPU } from './windows/process-tree.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const snapshot = process.platform === 'win32' ? windowsProcessTree : resourceSnapshot
const cpu = process.platform === 'win32' ? windowsTreeCPU : cpuPercent
const percent = value => value === null ? null : Number(value.toFixed(2))

function memory(sample) {
  if (process.platform === 'win32') {
    const child = sample.members.filter(({ kind }) => kind === 'child')
    return { totalMiB: sample.workingSetMiB,
      ionMiB: (sample.members.reduce((sum, item) => sum + item.workingSet, 0)
        - child.reduce((sum, item) => sum + item.workingSet, 0)) / 1024 ** 2,
      serviceMiB: child.reduce((sum, item) => sum + item.workingSet, 0) / 1024 ** 2,
      processes: sample.members.length }
  }
  return { totalMiB: sample.rssMiB, ionMiB: sample.ideRssMiB, serviceMiB: sample.childRssMiB,
    processes: sample.processes.length }
}

function pyrightTimings(path, queryStartNs) {
  if (!path) return null
  return readFile(path, 'utf8').then(text => {
    const rows = text.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const firstSession = rows.find(row => row.event === 'proxy-start')?.session
    const events = rows.filter(row => row.session === firstSession)
    const first = (event, method) => events.find(row => row.event === event && (!method || row.method === method))
    const delta = (start, end) => start && end ? Number((BigInt(end.tNs) - BigInt(start.tNs)) / 10_000n) / 100 : null
    const proxy = first('proxy-start'), spawned = first('server-spawned')
    const initializeRequest = first('request', 'initialize'), initializeResponse = first('response', 'initialize')
    const initialized = first('request', 'initialized'), configured = first('request', 'workspace/didChangeConfiguration')
    const opened = first('request', 'textDocument/didOpen')
    const definitionRequest = first('request', 'textDocument/definition'), definitionResponse = first('response', 'textDocument/definition')
    const completionRequest = first('request', 'textDocument/completion'), completionResponse = first('response', 'textDocument/completion')
    const shutdownRequest = first('request', 'shutdown'), shutdownResponse = first('response', 'shutdown')
    const exitNotification = first('request', 'exit'), exited = first('server-exit')
    const required = { proxy, spawned, initializeRequest, initializeResponse, initialized, configured, opened,
      definitionRequest, definitionResponse, completionRequest, completionResponse, shutdownRequest, shutdownResponse, exitNotification }
    assert.ok(firstSession && Object.values(required).every(Boolean), `Incomplete Pyright timing trace: ${Object.entries(required).filter(([, value]) => !value).map(([name]) => name).join(', ')}`)
    return {
      executableDiscoveryUpperBoundMs: Number((BigInt(proxy.tNs) - queryStartNs) / 10_000n) / 100,
      processSpawnMs: delta(proxy, spawned), initializationMs: delta(initializeRequest, initializeResponse),
      workspaceConfigurationMs: delta(initializeResponse, configured), documentSyncDispatchMs: delta(configured, opened),
      documentSyncToColdRequestMs: delta(opened, definitionRequest),
      coldDefinitionMs: delta(definitionRequest, definitionResponse), warmCompletionMs: delta(completionRequest, completionResponse),
      shutdownResponseMs: delta(shutdownRequest, shutdownResponse), shutdownToExitDispatchMs: delta(shutdownRequest, exitNotification),
      processExitAfterShutdownMs: exited ? delta(shutdownRequest, exited) : null,
    }
  })
}

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
  const tsHelper = join(project.directory, 'typed-helper.ts')
  const tsSource = join(project.directory, 'main.ts')
  await writeFile(join(project.directory, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { checkJs: true, module: 'esnext', moduleResolution: 'node' }, include: ['*.js'],
  }))
  await writeFile(jsHelper, '/** @param {number} a @param {number} b @returns {number} */\nexport function total(a, b) { return a + b }\n')
  const jsText = 'import { total } from "./helper.js"\nconsole.log(total(2, 3))\nconsole.log(Math.max(2, 3))\n'
  await writeFile(join(project.directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'node' }, include: ['*.ts'],
  }))
  const tsHelperText = 'export function typedTotal(a: number, b: number): number { return a + b }\n'
  await writeFile(tsHelper, tsHelperText)
  const tsText = 'import { typedTotal } from "./typed-helper"\nconst answer: number = typedTotal(2, 3)\nconsole.log(answer)\n'
  await writeFile(tsSource, tsText)
  const second = await createProject(join(scratch, 'second project'), { fileCount: 0 })
  const secondSource = join(second.directory, 'other.py')
  const secondText = 'def second_value() -> int:\n    return 2\n\nprint(second_value())\n'
  const secondTsSource = join(second.directory, 'other.ts')
  const secondTsText = 'export function secondValue(): number { return 2 }\nconsole.log(secondValue())\n'
  await writeFile(secondSource, secondText)
  await writeFile(join(second.directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  await writeFile(secondTsSource, secondTsText)
  await writeFile(jsSource, jsText)
  const session = await launch(target, join(scratch, 'profile'))
  const { page, app } = session
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    const initialResources = await snapshot(session, { details: true })
    await openFromExplorer(page, source, 'greet')
    assert.deepEqual(await page.evaluate(() => window.ion.languageTools.status()), [], 'Opening Python started a service before opt-in.')
    const openResources = await snapshot(session, { details: true })
    assert.equal(openResources.members?.filter(({ kind }) => kind === 'child').length
      ?? openResources.processes.filter(kind => kind === 'child').length,
    initialResources.members?.filter(({ kind }) => kind === 'child').length
      ?? initialResources.processes.filter(kind => kind === 'child').length,
    'Ordinary editing started an owned language-server process.')

    await page.getByTestId('settings').click()
    const settings = page.getByRole('dialog', { name: 'Preferences' })
    await settings.getByRole('checkbox', { name: /^Smart Python/ }).check()
    await page.waitForFunction(async () => (await window.ion.getPreferences()).settings.smartLanguages.includes('python'))
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.ion.languageTools.status()), [], 'Opt-in started Python before a semantic request.')

    await sleep(750)
    const beforePython = await snapshot(session, { details: true })
    const pythonStart = performance.now()
    const pythonQueryStartNs = process.hrtime.bigint()
    const query = (language, path, text, operation, offset, version = 1) => page.evaluate(
      ({ language, path, text, operation, offset, version }) => window.ion.languageTools.query({
        language, path, text, version, operation, offset,
      }), { language, path, text, operation, offset, version })
    const result = await query('python', source, text, 'definition', text.lastIndexOf('greet') + 2)
    const pythonStartMs = performance.now() - pythonStart
    assert.ok(result?.rows.some(([path]) => path === helper), 'Python LSP did not resolve the workspace definition.')
    await eventually(async () => (await page.evaluate(() => window.ion.languageTools.status()))
      .some(status => status.language === 'python' && status.state === 'ready' && status.executable),
    'Python service status did not expose its selected executable.')
    const pythonStatus = (await page.evaluate(() => window.ion.languageTools.status())).find(status => status.language === 'python' && status.state === 'ready')
    assert.ok(pythonStatus)
    assert.ok(pythonStatus.executable && !pythonStatus.executable.startsWith(project.directory), 'Python selected a workspace-controlled executable.')
    assert.ok(pythonStatus.capabilities?.includes('definition'))
    const completionText = text + '\ngre'
    const completionStart = performance.now()
    const completion = await query('python', source, completionText, 'complete', completionText.length, 2)
    const pythonCompletionMs = performance.now() - completionStart
    assert.ok(completion?.rows.some(([label]) => label.startsWith('greet')), 'Python completion did not use the current unsaved buffer.')
    const hover = await query('python', source, text, 'hover', text.lastIndexOf('greet') + 2, 3)
    assert.ok(hover?.rows.length, 'Python hover was unavailable despite the server capability.')
    const signature = await query('python', source, text, 'signature', text.lastIndexOf('greet') + 6, 4)
    assert.ok(signature?.rows.length, 'Python signature help was unavailable despite the server capability.')
    const references = await query('python', source, text, 'references', text.lastIndexOf('greet') + 2, 5)
    assert.ok(references?.rows.some(([path]) => path === source || path === helper), 'Python references returned no authorized source.')
    const invalidPython = 'def broken(:\n    pass\n'
    const diagnosticStart = performance.now()
    const diagnostics = await query('python', source, invalidPython, 'diagnostics', 0, 6)
    const pythonDiagnosticsMs = performance.now() - diagnosticStart
    assert.ok(diagnostics?.rows.some(([severity]) => severity === 'error'), 'Python diagnostics did not analyze the unsaved syntax error.')

    await stubDialogs(app, { folder: second.directory })
    await page.getByRole('button', { name: 'Add folder to workspace' }).click()
    await eventually(async () => await page.getByTestId('workspace-root').count() === 2, 'The second language-service root was not added.')
    const secondResult = await query('python', secondSource, secondText, 'definition', secondText.lastIndexOf('second_value') + 2, 1)
    assert.ok(secondResult?.rows.some(([path]) => path === secondSource), 'Python did not route the second root independently.')
    assert.equal((await page.evaluate(() => window.ion.languageTools.status()))
      .filter(({ language, state }) => language === 'python' && state === 'ready').length, 2,
    'Python roots did not receive isolated language-service state.')

    await sleep(750)
    const withPythonA = await snapshot(session, { details: true })
    await sleep(750)
    const withPython = await snapshot(session, { details: true })
    const pythonRename = await page.evaluate(({ path, text }) => window.ion.languageTools.reviewRename({
      language: 'python', path, text, version: 7, operation: 'rename', offset: text.lastIndexOf('greet') + 2,
      replacement: 'welcomeName',
    }, 'welcomeName', []), { path: source, text })
    assert.ok(pythonRename.files.some(({ path }) => path === source) && pythonRename.files.some(({ path }) => path === helper),
      'Python rename review did not include every affected saved file.')
    const pythonApplied = await page.evaluate(token => window.ion.languageTools.applyEdit(token), pythonRename.token)
    assert.deepEqual(pythonApplied.failed, [], 'Python rename review could not publish through Ion safe saves.')
    assert.match(await readFile(source, 'utf8'), /welcomeName/)
    assert.match(await readFile(helper, 'utf8'), /welcomeName/)
    const pythonStop = performance.now()
    await atPath(page, 'close-tab', source).click()
    await page.evaluate(() => window.ion.languageTools.release(true, 'python'))
    await eventually(async () => (await page.evaluate(() => window.ion.languageTools.status()))
      .filter(status => status.language === 'python').every(status => status.state === 'stopped'),
    'Python services did not stop after their sources closed.')
    await sleep(750)
    const afterPython = await snapshot(session, { details: true })
    const pythonStopMs = performance.now() - pythonStop
    const pythonLifecycle = await pyrightTimings(process.env.ION_LSP_TIMING_LOG, pythonQueryStartNs)

    await openFromExplorer(page, jsSource, 'total')
    await page.getByTestId('settings').click()
    const jsSettings = page.getByRole('dialog', { name: 'Preferences' })
    await jsSettings.getByRole('checkbox', { name: /^Smart JS\/TypeScript/ }).check()
    await jsSettings.getByRole('button', { name: 'Done', exact: true }).click()
    const beforeJs = await snapshot(session, { details: true })
    const jsStart = performance.now()
    const jsResult = await page.evaluate(async ({ path, text }) => {
      try {
        return { result: await window.ion.languageTools.query({
          language: 'javascript', path, text, version: 1, operation: 'definition', offset: text.lastIndexOf('total') + 2,
        }) }
      } catch (error) { return { error: String(error) } }
    }, { path: jsSource, text: jsText })
    const jsStartMs = performance.now() - jsStart
    if (jsResult.error && process.env.ION_REQUIRE_TYPESCRIPT_LSP === '1') {
      assert.fail(`The pinned TypeScript language server was installed but Ion could not use it: ${jsResult.error}`)
    }
    if (jsResult.error) assert.match(jsResult.error, /Install typescript-language-server/)
    else {
      assert.ok(jsResult.result?.rows.some(([path, line]) => path === jsSource && line === '1'),
        'TypeScript LSP did not resolve the JavaScript import declaration.')
      assert.ok((await query('javascript', jsSource, jsText, 'hover', jsText.lastIndexOf('total') + 2, 1))?.rows.length,
        'TypeScript service returned no JavaScript hover.')
      for (let request = 0; request < 3; request++) {
        assert.ok((await query('javascript', jsSource, jsText, 'signature', jsText.lastIndexOf('Math.max') + 10, 1))?.rows.length,
          `TypeScript service returned no JavaScript signature help on unchanged request ${request + 1}.`)
      }
      assert.ok((await query('javascript', jsSource, jsText, 'references', jsText.lastIndexOf('total') + 2, 1))?.rows.length,
        'TypeScript service returned no JavaScript references.')
      const jsCompletionText = jsText + '\nMath.'
      assert.ok((await query('javascript', jsSource, jsCompletionText, 'complete', jsCompletionText.length, 2))?.rows.length,
        'TypeScript service returned no JavaScript completions.')
      const invalidJs = 'const value = ;\n'
      assert.ok((await query('javascript', jsSource, invalidJs, 'diagnostics', 0, 3))?.rows.some(([severity]) => severity === 'error'),
        'TypeScript service did not report an unsaved JavaScript syntax error.')

      const tsDefinition = await query('typescript', tsSource, tsText, 'definition', tsText.lastIndexOf('typedTotal') + 3, 1)
      assert.ok(tsDefinition?.rows.some(([path]) => path === tsHelper || path === tsSource),
        'TypeScript service did not resolve a TypeScript definition.')
      assert.ok((await query('typescript', tsSource, tsText, 'hover', tsText.lastIndexOf('typedTotal') + 3, 1))?.rows.length,
        'TypeScript service returned no TypeScript hover.')
      assert.ok((await query('typescript', tsSource, tsText, 'signature', tsText.lastIndexOf('typedTotal') + 12, 1))?.rows.length,
        'TypeScript service returned no TypeScript signature help.')
      assert.ok((await query('typescript', tsSource, tsText, 'references', tsText.lastIndexOf('typedTotal') + 3, 1))?.rows.length,
        'TypeScript service returned no TypeScript references.')
      const tsCompletionText = tsText + '\nconst label = "Ion"\nlabel.'
      assert.ok((await query('typescript', tsSource, tsCompletionText, 'complete', tsCompletionText.length, 2))?.rows.length,
        'TypeScript service returned no TypeScript completions from an unsaved buffer.')
      const invalidTs = 'const answer: number = ;\n'
      assert.ok((await query('typescript', tsSource, invalidTs, 'diagnostics', 0, 3))?.rows.some(([severity]) => severity === 'error'),
        'TypeScript service did not report an unsaved TypeScript syntax error.')
      const changedTs = 'export const changedValue: string = "updated"\nchangedValue.\n'
      assert.ok((await query('typescript', tsSource, changedTs, 'complete', changedTs.lastIndexOf('.') + 1, 4))?.rows.length,
        'TypeScript service did not synchronize a changed TypeScript document.')
      const secondTs = await query('typescript', secondTsSource, secondTsText, 'definition', secondTsText.lastIndexOf('secondValue') + 3, 1)
      assert.ok(secondTs?.rows.some(([path]) => path === secondTsSource),
        'TypeScript service did not route the second workspace root independently.')
      assert.equal((await page.evaluate(() => window.ion.languageTools.status()))
        .filter(({ language, state }) => (language === 'javascript' || language === 'typescript') && state === 'ready').length, 2,
      'TypeScript roots did not receive isolated language-service state.')
      await page.getByRole('button', { name: 'Remove second project from workspace' }).click()
      await eventually(async () => await page.getByTestId('workspace-root').count() === 1,
        'The second workspace root was not removed.')
      await assert.rejects(query('typescript', secondTsSource, secondTsText, 'definition', 1, 2),
        /Open the file|outside|workspace|authorized|grant/i, 'A removed workspace root remained authorized for TypeScript requests.')
      await query('typescript', tsSource, tsText, 'definition', tsText.lastIndexOf('typedTotal') + 3, 5)
      const tsRename = await page.evaluate(({ path, text }) => window.ion.languageTools.reviewRename({
        language: 'typescript', path, text, version: 1, operation: 'rename', offset: text.indexOf('typedTotal') + 3,
        replacement: 'sumTyped',
      }, 'sumTyped', []), { path: tsHelper, text: tsHelperText })
      assert.ok(tsRename.files.some(({ path }) => path === tsSource) && tsRename.files.some(({ path }) => path === tsHelper),
        `TypeScript rename review did not include every affected saved file: ${JSON.stringify(tsRename.files)}`)
      const tsApplied = await page.evaluate(token => window.ion.languageTools.applyEdit(token), tsRename.token)
      assert.deepEqual(tsApplied.failed, [], 'TypeScript rename review could not publish through Ion safe saves.')
      assert.match(await readFile(tsSource, 'utf8'), /sumTyped/)
      assert.match(await readFile(tsHelper, 'utf8'), /sumTyped/)
    }
    let jsStatus = (await page.evaluate(() => window.ion.languageTools.status()))
      .filter(status => status.language === 'javascript' || status.language === 'typescript').at(-1)
    assert.ok(jsStatus && (jsStatus.state === 'ready' || jsStatus.state === 'error'))
    if (!jsResult.error) {
      await eventually(async () => (await page.evaluate(() => window.ion.languageTools.status()))
        .some(status => (status.language === 'javascript' || status.language === 'typescript')
          && status.state === 'ready' && status.executable),
      'TypeScript service status did not expose its selected executable.')
      const selected = (await page.evaluate(() => window.ion.languageTools.status()))
        .filter(status => (status.language === 'javascript' || status.language === 'typescript') && status.state === 'ready').at(-1)
      assert.ok(selected?.executable && !selected.executable.startsWith(project.directory),
        'TypeScript selected a workspace-controlled executable.')
      jsStatus = selected
    }
    const withJsA = await snapshot(session, { details: true })
    await sleep(750)
    const withJs = await snapshot(session, { details: true })
    await atPath(page, 'close-tab', jsSource).click()
    if (!jsResult.error) {
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate(() => window.ion.languageTools.release(true, 'javascript'))
        const restarted = await query('javascript', jsSource, jsText, 'definition', jsText.lastIndexOf('total') + 2, 1)
        assert.ok(restarted?.rows.some(([path, line]) => path === jsSource && line === '1'),
          `TypeScript service restart ${cycle + 1} failed.`)
      }
      await page.evaluate(() => window.ion.languageTools.release(true, 'javascript'))
    }
    await sleep(750)
    const afterJs = await snapshot(session, { details: true })
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log(JSON.stringify({
      pythonStartMs: Number(pythonStartMs.toFixed(2)), pythonLifecycle, pythonCompletionMs: Number(pythonCompletionMs.toFixed(2)),
      pythonDiagnosticsMs: Number(pythonDiagnosticsMs.toFixed(2)), pythonStopMs: Number(pythonStopMs.toFixed(2)),
      before: memory(beforePython), active: memory(withPython), after: memory(afterPython),
      activeCpuPercent: percent(cpu(withPythonA, withPython)), pythonExecutable: pythonStatus.executable,
      pythonVersion: pythonStatus.version, pythonCapabilities: pythonStatus.capabilities,
      javascript: jsResult.error ? { unavailable: jsResult.error } : {
        startMs: Number(jsStartMs.toFixed(2)), before: memory(beforeJs), active: memory(withJs), after: memory(afterJs),
        activeCpuPercent: percent(cpu(withJsA, withJs)), executable: jsStatus.executable,
        version: jsStatus.version, capabilities: jsStatus.capabilities,
      },
    }))
    console.log('PASS Python/TypeScript lazy lifecycle, diagnostics, completion, hover, signatures, navigation, unsaved buffers, root isolation, restarts and cleanup')
  } finally {
    await close(session)
  }
})

