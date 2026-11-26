import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, close, createProject, eventually, launch, openFolder, resourceSnapshot, stubDialogs, withScratch } from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

process.env.ION_SHOW_TEST_WINDOWS = '0'
const target = await artifact('dist')
const snapshot = async session => {
  if (process.platform !== 'win32') return resourceSnapshot(session, { details: true })
  const value = await windowsProcessTree(session)
  return { ...value, childRssMiB: value.members.filter(({ kind }) => kind === 'child')
    .reduce((total, item) => total + item.workingSet / 1024 ** 2, 0), rssMiB: value.workingSetMiB }
}

async function openTasks(page) {
  await page.getByTestId('command-palette').click()
  const input = page.getByTestId('command-palette-input')
  await input.fill('Run Task')
  await page.getByRole('option', { name: /Run Task/i }).click()
  await page.getByRole('heading', { name: 'Run Task' }).waitFor()
}

await withScratch('tasks-desktop', async scratch => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const completed = join(project.directory, 'task-output.txt')
  const started = join(project.directory, 'task-started.txt')
  await writeFile(join(project.directory, 'package.json'), JSON.stringify({ private: true, scripts: {
    'ion:acceptance': `node -e "require('node:fs').writeFileSync('task-output.txt','ION-TASK-OK')"`,
    'ion:wait': `node -e "require('node:fs').writeFileSync('task-started.txt','started');setInterval(()=>{},1000)"`,
  } }, null, 2))
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  const session = await launch(target, profile)
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowTask: true })
    await openFolder(page, project)
    const before = await snapshot(session)
    assert.ok(before.childRssMiB <= 1,
      `Task support started a child process before the user opened or ran a task (${before.childRssMiB} MiB).`)

    await openTasks(page)
    const pickerOpen = await snapshot(session)
    const runStart = performance.now()
    await page.getByText('npm: ion:acceptance', { exact: true }).click()
    await page.locator('[data-testid="output"][data-status="success"]').waitFor({ timeout: 25_000 })
    const taskMs = performance.now() - runStart
    assert.equal(await readFile(completed, 'utf8'), 'ION-TASK-OK')
    await eventually(async () => (await snapshot(session)).childRssMiB <= before.childRssMiB + 1,
      'Completed task left a child process behind.', 10_000)
    const afterSuccess = await snapshot(session)

    await openTasks(page)
    await page.getByText('npm: ion:wait', { exact: true }).click()
    await eventually(async () => await readFile(started, 'utf8').catch(() => '') === 'started',
      'Long-running task never started.', 10_000)
    await page.getByTestId('run-console-stop').click()
    await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor({ timeout: 15_000 })
    await eventually(async () => (await snapshot(session)).childRssMiB <= before.childRssMiB + 1,
      'Stopped task left a child process behind.', 10_000)
    const afterStop = await snapshot(session)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, taskMs: Math.round(taskMs),
      rssMiB: { before: before.rssMiB, pickerOpen: pickerOpen.rssMiB, afterSuccess: afterSuccess.rssMiB, afterStop: afterStop.rssMiB },
      childRssMiB: { before: before.childRssMiB, pickerOpen: pickerOpen.childRssMiB,
        afterSuccess: afterSuccess.childRssMiB, afterStop: afterStop.childRssMiB } }))
    console.log('PASS production Electron task discovery, reviewed execution, Stop and owned cleanup')
  } finally {
    await close(session)
  }
})
