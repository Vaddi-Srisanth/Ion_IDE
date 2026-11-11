import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, runProgram, sleep, stubDialogs, waitForFile, withScratch,
} from './desktop-harness.mjs'
import { plotNotebook, savedPlotPng } from './notebook-fixtures.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, label: { type: 'string', default: 'candidate' },
  'soak-seconds': { type: 'string', default: '0' }, 'interval-seconds': { type: 'string', default: '30' },
  'soak-only': { type: 'boolean' }, out: { type: 'string', default: 'performance-results' },
} })
assert.equal(process.platform, 'darwin')
assert.match(values.label, /^[\w-]+$/)
const soakSeconds = Number(values['soak-seconds'])
const intervalSeconds = Number(values['interval-seconds'])
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 14_400)
assert.ok(Number.isInteger(intervalSeconds) && intervalSeconds >= 5 && intervalSeconds <= 300)
assert.ok(!values['soak-only'] || soakSeconds > 0)
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use a production dist directory.')
const execute = promisify(execFile)
const host = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const timestamp = new Date().toISOString()
const directory = resolve(values.out)
const output = join(directory, `session-${values.label}-${timestamp.replaceAll(':', '-')}.json`)
const report = {
  timestamp, artifact: target.path, version: process.versions.node,
  mainSha256: createHash('sha256').update(await readFile(join(target.path, 'main/index.cjs'))).digest('hex'),
  host: { macOS: host('/usr/bin/sw_vers'), processor: host('/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'),
    ramBytes: Number(host('/usr/sbin/sysctl', '-n', 'hw.memsize')), power: host('/usr/bin/pmset', '-g', 'batt').split('\n')[0] },
  protocol: { soakSeconds, intervalSeconds, settleMs: 1000, featureRounds: values['soak-only'] ? 0 : 3 },
  complete: false, stages: [], soak: [],
}
await mkdir(directory, { recursive: true })
async function record() {
  await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
  await rename(output + '.tmp', output)
}

await withScratch('session-benchmark', async (scratch) => {
  const probe = join(scratch, 'footprint')
  execFileSync('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'workspace'))
  const md = join(project.directory, 'notes.md')
  const ipynb = join(project.directory, 'plots.ipynb')
  const pdf = join(project.directory, 'reading.pdf')
  const mdText = '# Study fixture\n\n![Chart](chart.png)\n\n' + Array.from({ length: 80 }, (_, i) =>
    `## Topic ${i}\n\n**Local preview** and \`code\`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n`).join('')
  await Promise.all([
    writeFile(md, mdText), writeFile(join(project.directory, 'chart.png'), savedPlotPng(640, 400)),
    writeFile(ipynb, JSON.stringify(plotNotebook())), writeFile(pdf, pdfFixture(160)),
  ])
  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  const diagnostics = { mainConsole: [], stderr: [], lifecycle: [] }
  const bounded = (items, value) => { items.push(value); if (items.length > 12) items.shift() }
  const onConsole = message => bounded(diagnostics.mainConsole, message.text().slice(0, 1200))
  const onStderr = bytes => bounded(diagnostics.stderr, bytes.toString().slice(-1200))
  const onExit = (code, signal) => { diagnostics.exit = { code, signal } }
  const onPageClose = () => bounded(diagnostics.lifecycle, { event: 'page-closed', time: Date.now() })
  const onCrash = () => bounded(diagnostics.lifecycle, { event: 'page-crashed', time: Date.now() })
  app.on('console', onConsole)
  session.appProcess.stderr?.on('data', onStderr)
  session.appProcess.once('exit', onExit)
  page.on('close', onPageClose)
  page.on('crash', onCrash)
  const cdp = await page.context().newCDPSession(page)
  async function sample(label, timingMs, settleMs = 1000) {
    if (settleMs) await sleep(settleMs)
    const { timeMs, rssMiB, members } = await resourceSnapshot(session, { details: true })
    const [{ stdout }, heap, dom, visible] = await Promise.all([
      execute(probe, members.map(({ pid }) => String(pid))),
      cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters'),
      page.evaluate(() => ({
        editors: document.querySelectorAll('.monaco-editor').length,
        notebookCells: document.querySelectorAll('[data-testid="notebook-cell"]').length,
        pdfCanvases: document.querySelectorAll('[data-testid="pdf-page-canvas"]').length,
        previewImages: document.querySelectorAll('[data-testid="markdown-preview"] img').length,
      })),
    ])
    const counters = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [pid, footprintBytes, cpuNs, reapedChildCpuNs] = line.split(' ').map(Number)
      return [pid, { footprintMiB: footprintBytes / 1024 ** 2, cpuNs, reapedChildCpuNs }]
    }))
    const processes = members.map((member) => ({ ...member, ...counters.get(member.pid) }))
    return { label, timingMs, timeMs, rssMiB,
      footprintMiB: processes.every(({ footprintMiB }) => Number.isFinite(footprintMiB))
        ? processes.reduce((total, item) => total + item.footprintMiB, 0) : null,
      heapUsedMiB: heap.usedSize / 1024 ** 2, heapCommittedMiB: heap.totalSize / 1024 ** 2,
      dom, visible, pdfWorkers: page.workers().filter((worker) => worker.url().includes('pdf.worker')).length, processes,
    }
  }
  async function closeTab(path) {
    await atPath(page, 'close-tab', path).click()
    await atPath(page, 'tab', path).waitFor({ state: 'detached' })
  }
  async function showText(expected) { await (await editorShows(page, expected)).dispose() }

  try {
    report.startupMs = session.startupMs
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    report.stages.push(await sample('Welcome'))
    await openFolder(page, project)
    await openFromExplorer(page, project.program, '#include')
    report.stages.push(await sample('One C file'))

    if (!values['soak-only']) {
      for (let i = 0; i < 3; i++) {
        let began = performance.now()
        await openFromExplorer(page, md, 'Study fixture')
        if (!await page.locator('[data-markdown-mode="split"]').count()) await page.getByTestId('markdown-split-toggle').click()
        await page.getByTestId('markdown-preview').getByRole('heading', { name: 'Study fixture', exact: true }).waitFor()
        await (await page.waitForFunction(() => document.querySelector('[data-testid="markdown-preview"] img')?.naturalWidth === 640)).dispose()
        report.stages.push(await sample('Markdown split', performance.now() - began))
        await closeTab(md)
        const markdownClosed = await sample('Markdown closed')
        assert.equal(markdownClosed.visible.previewImages, 0)
        report.stages.push(markdownClosed)

        began = performance.now()
        await atPath(page, 'explorer-entry', ipynb).click()
        await (await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="notebook-view"] img')?.naturalWidth))).dispose()
        report.stages.push(await sample('Notebook plots', performance.now() - began))
        await closeTab(ipynb)
        const notebookClosed = await sample('Notebook closed')
        assert.equal(notebookClosed.visible.notebookCells, 0)
        report.stages.push(notebookClosed)

        began = performance.now()
        await atPath(page, 'explorer-entry', pdf).click()
        await page.locator('[data-rendered="true"] [data-testid="pdf-page-canvas"]').first().waitFor()
        await page.getByTestId('viewer-split').click()
        await page.getByTestId('document-split').waitFor()
        report.stages.push(await sample('PDF beside code', performance.now() - began))
        await closeTab(pdf)
        const pdfClosed = await sample('PDF closed')
        assert.equal(pdfClosed.pdfWorkers, 0)
        assert.equal(pdfClosed.visible.pdfCanvases, 0)
        report.stages.push(pdfClosed)
      }
      report.stages.push(await sample('All previews closed', undefined, 10_000))
      await record()
    }

    if (soakSeconds) {
      for (const file of project.files) await openFromExplorer(page, file, `Ion fixture ${basename(file)}`)
      const start = performance.now()
      const until = start + soakSeconds * 1000
      report.soakStart = await sample('Soak start', undefined, 0)
      for (let index = 0; performance.now() < until; index++) {
        const began = performance.now()
        const path = project.files[index % project.files.length]
        await atPath(page, 'tab', path).locator('.tab-name').click()
        await showText(`Ion fixture ${basename(path)}`)
        const switchMs = performance.now() - began
        const line = page.locator('.monaco-editor .view-line').nth(1)
        await line.click({ position: { x: 4, y: 5 } })
        const edit = `LIFECYCLE_${String(index).padStart(4, '0')}`
        const typed = performance.now()
        await page.keyboard.insertText(edit + ' ')
        await showText(edit)
        const editMs = performance.now() - typed
        await page.getByTestId('save-file').click()
        await waitForFile(readFile, path, edit)
        let runMs
        if (index % 4 === 0) {
          await atPath(page, 'tab', project.program).locator('.tab-name').click()
          await showText('#include')
          runMs = await runProgram(page)
        }
        const snapshot = await sample('Soak edit', undefined, 250)
        assert.equal(snapshot.processes.filter(({ kind }) => kind === 'child').length, 0)
        report.soak.push({ index, elapsedMs: performance.now() - start, switchMs, editMs, runMs, ...snapshot })
        await record()
        if (index % 20 === 0) console.log(`${values.label}: ${Math.round((performance.now() - start) / 1000)} seconds, ${index + 1} editing rounds`)
        const next = start + (index + 1) * intervalSeconds * 1000
        if (performance.now() < Math.min(next, until)) await sleep(Math.min(next, until) - performance.now())
      }
      report.soakElapsedMs = performance.now() - start
      report.soakEnd = await sample('Soak end', undefined, 0)
    }
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
  } catch (error) {
    report.error = String(error)
    report.diagnostics = diagnostics
    throw error
  } finally {
    await cdp.detach().catch(() => {})
    await record()
    await close(session)
    await eventually(async () => !(await resourceSnapshot(session, { details: true })).members.length, 'App process family must exit')
    report.diagnostics = diagnostics
    app.removeListener('console', onConsole)
    session.appProcess.stderr?.removeListener('data', onStderr)
    session.appProcess.removeListener('exit', onExit)
    page.removeListener('close', onPageClose)
    page.removeListener('crash', onCrash)
  }
  report.complete = true
  await record()
})
console.log(output)
