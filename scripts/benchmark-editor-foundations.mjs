import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFolder, resourceSnapshot, sleep,
  stubDialogs, withScratch } from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const execute = promisify(execFile)
const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, label: { type: 'string', default: 'candidate' },
  settle: { type: 'string', default: '1200' }, cycles: { type: 'string', default: '5' },
} })
assert.ok(process.platform === 'darwin' || process.platform === 'win32', 'Run on native macOS or Windows.')
assert.match(values.label, /^[\w-]+$/)
const settleMs = Number(values.settle), cycles = Number(values.cycles)
assert.ok(Number.isInteger(settleMs) && settleMs >= 500 && settleMs <= 10_000)
assert.ok(Number.isInteger(cycles) && cycles >= 3 && cycles <= 20)
const windows = process.platform === 'win32'
const target = await artifact(values.target)
const probeSource = fileURLToPath(new URL('./benchmark-resources-probe.c', import.meta.url))
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

async function sample(session, probe, label, wait = settleMs) {
  await sleep(wait)
  if (windows) {
    const tree = await windowsProcessTree(session)
    return { label, time: tree.timeMs, rssMiB: tree.workingSetMiB, privateMiB: tree.privateMiB,
      footprintMiB: null, cpu: Object.fromEntries(tree.members.map(item => [item.pid + ':' + item.started, item.cpuSeconds])),
      processCount: tree.members.length, processes: tree.members.map(({ kind }) => kind) }
  }
  const tree = await resourceSnapshot(session, { details: true })
  const { stdout } = await execute(probe, tree.members.map(({ pid }) => String(pid)))
  const native = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, footprint, cpu] = line.split(/\s+/).map(Number)
    return [pid, { footprint, cpu }]
  }))
  const measured = tree.members.map((member) => ({ ...member, ...native.get(member.pid) }))
  assert.ok(measured.length && measured.every(({ footprint, cpu }) => Number.isFinite(footprint) && Number.isFinite(cpu)))
  return { label, time: performance.now(), rssMiB: tree.rssMiB,
    footprintMiB: measured.reduce((sum, item) => sum + item.footprint, 0) / 1024 ** 2,
    privateMiB: null, cpu: Object.fromEntries(measured.map(({ pid, started, cpu }) => [pid + ':' + started, cpu])),
    processCount: measured.length, processes: measured.map(({ kind }) => kind) }
}

function cpuPercent(before, after) {
  if (after.time <= before.time || Object.keys(before.cpu).length !== Object.keys(after.cpu).length) return null
  let delta = 0
  for (const [identity, value] of Object.entries(after.cpu)) {
    const previous = before.cpu[identity]
    if (!Number.isFinite(previous) || value < previous) return null
    delta += value - previous
  }
  return windows ? delta / ((after.time - before.time) / 1000) * 100 : delta / 1e6 / (after.time - before.time) * 100
}

async function launchOffline(profile) {
  const session = await launch(target, profile)
  await session.page.context().setOffline(true)
  return session
}

async function resume(session, expectedRoots) {
  const began = performance.now()
  await session.page.getByTestId('resume-session').click()
  await eventually(async () => await session.page.getByTestId('workspace-root').count() === expectedRoots,
    `Expected ${expectedRoots} restored workspace roots.`)
  await session.page.locator('.monaco-editor').first().waitFor()
  return performance.now() - began
}

async function splitToCount(page, count) {
  while (await page.getByTestId('editor-group').count() < count) {
    const existing = await page.getByTestId('editor-group').count()
    if (!existing) await page.getByTestId('editor-group-split-right').click()
    else await page.getByTestId('editor-group').last().getByRole('button', { name: 'Split editor down' }).click()
    await eventually(async () => await page.getByTestId('editor-group').count() >= Math.min(2, count), 'Editor group did not open.')
  }
}

async function closeGroups(page) {
  while (await page.getByTestId('editor-group').count()) {
    await page.getByTestId('editor-group').last().getByRole('button', { name: 'Close editor group' }).click()
    await sleep(20)
  }
}

const report = await withScratch('editor-foundations-benchmark', async (scratch) => {
  const probe = windows ? null : join(scratch, 'rusage')
  if (probe) await execute('/usr/bin/clang', ['-O2', '-std=c11', probeSource, '-o', probe])
  const profile = join(scratch, 'profile')
  const roots = Array.from({ length: 5 }, (_, index) => join(scratch, `workspace-${index + 1}`))
  await Promise.all([mkdir(profile), ...roots.map((root) => mkdir(root))])
  const files = Array.from({ length: 50 }, (_, index) => join(roots[0], `file-${String(index + 1).padStart(2, '0')}.c`))
  await Promise.all([
    ...files.map((path, index) => writeFile(path, `int value_${index + 1}(void) { return ${index + 1}; }\n`)),
    ...roots.map((root, index) => writeFile(join(root, `root-${index + 1}.txt`), 'ION-MULTI-ROOT-MARKER\n')),
  ])
  const project = { directory: roots[0], program: files[0] }
  const samples = [], timings = {}

  const seed = await launchOffline(profile)
  try {
    await stubDialogs(seed.app, { folder: roots[0] })
    await openFolder(seed.page, project)
    const began = performance.now()
    await atPath(seed.page, 'explorer-entry', files[0]).click()
    await editorShows(seed.page, 'value_1')
    timings.firstFileMs = performance.now() - began
  } finally { await close(seed) }

  const one = await launchOffline(profile)
  timings.oneRootStartupMs = one.startupMs
  try {
    timings.oneRootResumeMs = await resume(one, 1)
    samples.push(await sample(one, probe, 'one-root'))
    for (const root of roots.slice(1)) {
      await stubDialogs(one.app, { folder: root })
      await one.page.getByRole('button', { name: 'Add folder to workspace' }).click()
    }
    await eventually(async () => await one.page.getByTestId('workspace-root').count() === 5, 'Five roots were not added.')
  } finally { await close(one) }

  const session = await launchOffline(profile)
  timings.fiveRootStartupMs = session.startupMs
  try {
    timings.fiveRootResumeMs = await resume(session, 5)
    const fiveRootsA = await sample(session, probe, 'five-roots-a')
    const fiveRootsB = await sample(session, probe, 'five-roots-b')
    samples.push(fiveRootsA, fiveRootsB)

    let began = performance.now()
    for (const path of files.slice(1, 10)) await atPath(session.page, 'explorer-entry', path).click()
    await eventually(async () => await session.page.getByTestId('tab').count() === 10, 'Ten tabs did not open.')
    timings.tenTabsMs = performance.now() - began
    samples.push(await sample(session, probe, 'ten-tabs'))

    began = performance.now()
    for (const path of files.slice(10)) await atPath(session.page, 'explorer-entry', path).click()
    await eventually(async () => await session.page.getByTestId('tab').count() === 50, 'Fifty tabs did not open.')
    timings.fiftyTabsMs = performance.now() - began
    samples.push(await sample(session, probe, 'fifty-tabs'))

    began = performance.now()
    await splitToCount(session.page, 4)
    timings.sameFileFourGroupsMs = performance.now() - began
    samples.push(await sample(session, probe, 'same-file-four-groups'))
    await closeGroups(session.page)
    samples.push(await sample(session, probe, 'same-file-groups-closed'))

    began = performance.now()
    for (const path of files.slice(0, 4)) {
      const count = await session.page.getByTestId('editor-group').count()
      if (count < 4) {
        if (!count) await session.page.getByTestId('editor-group-split-right').click()
        else await session.page.getByTestId('editor-group').last().getByRole('button', { name: 'Split editor down' }).click()
      }
      await atPath(session.page, 'explorer-entry', path).click()
    }
    await eventually(async () => await session.page.getByTestId('editor-group').count() === 4, 'Four different-file groups did not open.')
    timings.differentFileFourGroupsMs = performance.now() - began
    samples.push(await sample(session, probe, 'different-file-four-groups'))

    const search = await session.page.evaluate(async (id) => {
      const began = performance.now(), result = await window.ion.workspaceSearch.search(id, 'ION-MULTI-ROOT-MARKER')
      return { durationMs: performance.now() - began, files: result.files.length, matches: result.files.reduce((sum, file) => sum + file.matches.length, 0) }
    }, randomUUID())
    assert.deepEqual({ files: search.files, matches: search.matches }, { files: 5, matches: 5 })
    timings.search = search
    const replacement = await session.page.evaluate(async () => {
      const began = performance.now()
      const review = await window.ion.workspaceSearch.review('ION-MULTI-ROOT-MARKER', 'ION-MULTI-ROOT-UPDATED')
      const reviewedMs = performance.now() - began
      const applied = await window.ion.workspaceSearch.apply(review.token, review.files.map((file) => file.path))
      return { reviewMs: reviewedMs, totalMs: performance.now() - began, files: review.files.length,
        applied: applied.applied.length, failed: applied.failed.length }
    })
    assert.deepEqual({ files: replacement.files, applied: replacement.applied, failed: replacement.failed }, { files: 5, applied: 5, failed: 0 })
    timings.replacement = replacement

    await closeGroups(session.page)
    began = performance.now()
    for (let index = 0; index < cycles; index++) {
      await splitToCount(session.page, 4)
      await closeGroups(session.page)
    }
    timings.groupCyclesMs = performance.now() - began
    const recovered = await sample(session, probe, 'cycles-recovered', 5000)
    samples.push(recovered)
    timings.idleCpuPercent = cpuPercent(fiveRootsA, fiveRootsB)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
  } finally { await close(session) }

  const restored = await launchOffline(profile)
  timings.groupRestoreStartupMs = restored.startupMs
  try {
    const began = performance.now()
    await restored.page.getByTestId('resume-session').click()
    await restored.page.getByTestId('workspace-root').first().waitFor()
    await restored.page.locator('.monaco-editor').first().waitFor()
    timings.groupRestoreMs = performance.now() - began
    samples.push(await sample(restored, probe, 'restored-session'))
    assert.deepEqual(restored.errors, [])
  } finally { await close(restored) }

  return { timestamp: new Date().toISOString(), label: values.label, sourceCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    target: basename(target.path), artifact: { main: await hash(target.args[0]) }, host: { platform: process.platform, arch: process.arch },
    settleMs, cycles, timings, samples, summary: {
      oneRoot: samples.find(({ label }) => label === 'one-root'),
      fiveRoots: samples.find(({ label }) => label === 'five-roots-b'),
      tenTabs: samples.find(({ label }) => label === 'ten-tabs'), fiftyTabs: samples.find(({ label }) => label === 'fifty-tabs'),
      sameFileFourGroups: samples.find(({ label }) => label === 'same-file-four-groups'),
      differentFileFourGroups: samples.find(({ label }) => label === 'different-file-four-groups'),
      recovered: samples.find(({ label }) => label === 'cycles-recovered'),
      restored: samples.find(({ label }) => label === 'restored-session'),
      ownedProcessCounts: samples.map(({ processCount }) => processCount),
    }, notes: [
      'Fresh disposable offline profiles and workspaces; the installed app and live profile were untouched.',
      'All memory samples cover Ion’s owned Electron process family. macOS footprint is summed phys_footprint; Windows uses private bytes.',
      'No service, terminal, language server, debugger, test runner, compiler or Git process is started by configuring multiple roots.',
    ] }
})

await mkdir('performance-results', { recursive: true })
const output = `performance-results/editor-foundations-${values.label}-${report.timestamp.replaceAll(':', '-')}.json`
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(output)
console.log(JSON.stringify({ timings: report.timings, summary: report.summary }, null, 2))
