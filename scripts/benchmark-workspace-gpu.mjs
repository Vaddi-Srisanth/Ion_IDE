import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, cpus, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { artifact, close, createProject, desktopWindowsVisible, editorShows, launch, openFolder,
  openFromExplorer, resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' },
  trials: { type: 'string', default: '2' }, checkpoints: { type: 'string', default: '0,1,5,30,120' },
  fullscreen: { type: 'boolean' }, out: { type: 'string', default: 'performance-results/workspace-gpu.json' } } })
assert.equal(process.platform, 'darwin', 'This probe measures macOS per-process graphics ledger charges.')
const trials = Number(values.trials)
const checkpoints = values.checkpoints.split(',').map(Number)
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 10)
assert.ok(checkpoints[0] === 0 && checkpoints.every((item, index) => Number.isFinite(item) && item <= 300
  && (index === 0 || item > checkpoints[index - 1])))
assert.ok(!values.fullscreen || desktopWindowsVisible(), 'Fullscreen comparison requires explicitly visible desktop windows.')
const execute = promisify(execFile)
const target = await artifact(values.target)
const output = resolve(values.out)
const modes = ['standalone', 'workspace']
const visible = desktopWindowsVisible()
const marker = 'same editor source'
const report = { host: { arch: arch(), cpu: cpus()[0]?.model, darwin: release(), bytes: totalmem() },
  protocol: { trials, checkpoints, visibility: values.fullscreen ? 'native fullscreen' : visible ? 'visible' : 'hidden',
    timing: 'from source text becoming available in the editor. The first probe runs immediately.',
    memory: 'macOS process ledger charges and summed RSS. GPU helper footprint includes general process allocations.' },
  samples: [] }

await mkdir(dirname(output), { recursive: true })
await withScratch('workspace-gpu', async (scratch) => {
  const probe = join(scratch, 'resource-probe')
  await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const fixture = await createProject(join(scratch, 'same fixture'), { fileCount: 0 })
  await writeFile(fixture.program, Array.from({ length: 650 }, (_, index) =>
    `static const int value_${index} = ${index}; // ${marker}\n`).join(''))

  async function memory(session, opened) {
    const tree = await resourceSnapshot(session, { details: true })
    const { stdout } = await execute(probe, tree.members.map(({ pid }) => String(pid)))
    const footprints = new Map(stdout.trim().split('\n').map(row => {
      const [pid, bytes] = row.split(' ').map(Number)
      return [pid, bytes / 1024 ** 2]
    }))
    const members = tree.members.map(member => ({ ...member, footprintMiB: footprints.get(member.pid) }))
    assert.ok(members.every(({ footprintMiB }) => Number.isFinite(footprintMiB)))
    assert.equal(members.filter(({ kind }) => kind === 'child').length, 0)
    return { second: (tree.timeMs - opened) / 1000, rssMiB: tree.rssMiB,
      footprintMiB: members.reduce((sum, member) => sum + member.footprintMiB, 0), members }
  }
  async function layers(page) {
    const devtools = await page.context().newCDPSession(page)
    try {
      let current = []
      devtools.on('LayerTree.layerTreeDidChange', event => { current = event.layers })
      await devtools.send('LayerTree.enable')
      for (let attempt = 0; attempt < 20 && !current.length; attempt++) await sleep(50)
      return current.length ? { total: current.length, drawing: current.filter(layer => layer.drawsContent).length,
        content: current.filter(layer => layer.drawsContent).map(({ width, height }) => ({ width, height })) } : null
    } finally { await devtools.detach() }
  }

  let reference
  for (let trial = 0; trial < trials; trial++) {
    for (const mode of trial % 2 ? [...modes].reverse() : modes) {
      const profile = join(scratch, `${mode}-${trial}`)
      await mkdir(profile)
      await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
        resourceProfile: 'minimal', theme: 'dark', showExplorer: true, showOutput: false,
        autoSave: false, openFullScreen: Boolean(values.fullscreen),
      } }))
      const session = await launch(target, profile)
      try {
        const { app, page } = session
        await page.context().setOffline(true)
        await stubDialogs(app, { folder: fixture.directory, file: fixture.program })
        if (values.fullscreen) {
          await sleep(1100)
          assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()))
        }
        if (mode === 'workspace') {
          await openFolder(page, fixture)
          await openFromExplorer(page, fixture.program, marker)
        } else {
          await page.getByTestId('welcome').getByTestId('open-file').click()
          await editorShows(page, marker)
        }
        const began = performance.now()
        const samples = []
        for (const second of checkpoints) {
          await sleep(Math.max(0, began + second * 1000 - performance.now()))
          samples.push({ checkpoint: second, ...await memory(session, began) })
        }
        const dimensions = await page.evaluate(() => {
          const editor = document.querySelector('.monaco-editor').getBoundingClientRect()
          return { viewport: [innerWidth, innerHeight], editor: [editor.width, editor.height], scale: devicePixelRatio }
        })
        reference ??= dimensions
        assert.deepEqual(dimensions, reference, 'Viewport and editor size must match in both opening workflows.')
        report.samples.push({ trial: trial + 1, mode, dimensions, samples, layers: await layers(page) })
        assert.deepEqual(session.requests, [])
        assert.deepEqual(session.errors, [])
        await writeFile(output, JSON.stringify(report, null, 2) + '\n')
        console.log(`${mode} ${trial + 1}/${trials}`)
      } finally { await close(session) }
    }
  }
})
console.log(output)
