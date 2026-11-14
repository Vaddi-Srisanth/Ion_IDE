import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const specification = {
  version: 1, title: 'Portable project', description: 'Check the saved project.', goal: 'Keep local project metadata.',
  technologies: ['C17'], files: [{ path: 'program.c', purpose: 'Write the greeting.', required: true }], environment: [],
  milestones: [{ id: 'example', title: 'Run the greeting', description: '', dependsOn: [],
    acceptance: ['Print a greeting.'], status: 'in-progress' }], tests: [],
}

async function selectExportFolder(app, folder) {
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (options.title !== 'Export Local Profile' || !options.properties.includes('openDirectory')) {
        throw new Error('Unexpected export destination prompt.')
      }
      return { canceled: !destination, filePaths: destination ? [destination] : [] }
    }
  }, folder)
}

await withScratch('profile-export', async (scratch) => {
  const project = await createProject(join(scratch, 'Portable workspace'))
  const profile = join(scratch, 'Local profile')
  const destination = join(scratch, 'Backups λ')
  await Promise.all([mkdir(profile), mkdir(destination)])
  await writeFile(join(profile, 'planning-provider-v1.json'), 'Synthetic provider record kept out of the copy.')
  const source = await launch(target, profile)
  let exported
  try {
    const { app, page } = source
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    const original = await page.evaluate(async ({ root, spec }) => {
      await window.ion.learning.recordTopic('arrays', 'selected')
      await window.ion.learningPacks.install('python')
      await window.ion.learningPacks.select('python')
      return window.ion.projects.save(root, spec, null)
    }, { root: project.directory, spec: specification })
    assert.equal(original.spec.title, specification.title)
    await page.getByTestId('settings').first().click()
    const dialog = page.getByRole('dialog', { name: 'Preferences' })
    await dialog.getByTestId('theme-light').click()
    await page.locator('.app-shell[data-theme-id="light"]').waitFor()

    await selectExportFolder(app, null)
    await dialog.getByTestId('export-local-profile').click()
    await eventually(() => dialog.getByTestId('export-local-profile').isEnabled(), 'Export remained busy after cancel.')
    assert.deepEqual(await readdir(destination), [])
    assert.equal(await dialog.getByTestId('profile-export-status').count(), 0)

    await selectExportFolder(app, destination)
    await dialog.getByTestId('export-local-profile').click()
    const status = dialog.getByTestId('profile-export-status')
    await status.waitFor()
    assert.equal(await status.getAttribute('role'), 'status', await status.textContent())
    const [backup, ...extras] = await readdir(destination)
    assert.match(backup, /^Ion IDE Backup /)
    assert.deepEqual(extras, [])
    exported = join(destination, backup, 'Profile')
    assert.ok((await status.textContent()).includes(exported))
    assert.deepEqual((await readdir(exported)).sort(), ['ion-profile-backup.json', 'learning-library', 'learning.json', 'preferences.json', 'projects-v1'])
    const manifest = JSON.parse(await readFile(join(exported, 'ion-profile-backup.json'), 'utf8'))
    assert.equal(manifest.projects, 1)
    assert.equal(manifest.learning, true)
    assert.equal(manifest.learningPacks, 1)
    await dialog.getByRole('button', { name: 'Done' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(source.requests, [])
    assert.deepEqual(source.errors, [])
  } finally {
    await close(source)
  }

  const portable = await launch(target, exported)
  try {
    const { page } = portable
    await page.context().setOffline(true)
    await page.locator('.app-shell[data-theme-id="light"]').waitFor()
    await page.getByRole('region', { name: 'Recent locations' })
      .getByRole('button', { name: new RegExp(basename(project.directory)) }).click()
    await atPath(page, 'explorer-entry', project.program).waitFor()
    const data = await page.evaluate(async (root) => ({
      learning: await window.ion.learning.getHistory(),
      packs: await window.ion.learningPacks.getLibrary(),
      python: await window.ion.learningPacks.getTopics('python'),
      project: await window.ion.projects.open(root),
    }), project.directory)
    assert.deepEqual(data.learning.topics, [{ id: 'arrays', viewed: 1, selected: 1 }])
    assert.equal(data.packs.selected, 'python')
    assert.equal(data.packs.installed.length, 1)
    assert.ok(data.python.length >= 6)
    assert.equal(data.project.spec.title, specification.title)
    assert.equal(data.project.spec.milestones[0].status, 'in-progress')
    assert.deepEqual(portable.requests, [])
    assert.deepEqual(portable.errors, [])
    console.log('PASS canceled export, new local backup, credential exclusion, and reopening the portable profile offline')
  } finally {
    await close(portable)
  }
})
