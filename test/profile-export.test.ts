import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LearningService } from '../src/main/learning'
import { PreferenceStore } from '../src/main/preferences'
import { exportLocalProfile } from '../src/main/profile-export'
import { unavailableTest } from '../src/main/projects/evidence'
import { ProjectRepository } from '../src/main/projects/repository'
import { ThemeStore } from '../src/main/themes'
import { planningCases } from './fixtures/project-plans'

async function profileFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ion-profile-export-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'Local profile')
  const destination = join(directory, 'Selected backups')
  await Promise.all([mkdir(source), mkdir(destination)])
  return { directory, source, destination, preferences: new PreferenceStore(join(source, 'preferences.json')) }
}

test('profile export reopens settings, custom theme, history and project evidence without the provider or cache', async (t) => {
  const { directory, source, destination, preferences } = await profileFixture(t)
  const workspace = join(directory, 'Workspace')
  const projectData = new ProjectRepository(join(source, 'projects-v1'))
  const themeAssets = resolve('src/main/themes/palettes')
  const themes = new ThemeStore(source, themeAssets)
  const palette = await themes.create(JSON.parse(await readFile(join(themeAssets, 'dark.json'), 'utf8')))
  await preferences.remember({ path: workspace, kind: 'folder', name: 'Workspace' })
  await preferences.updateSettings({ theme: palette.id, fontSize: 19 })
  const learning = new LearningService(join(source, 'learning.json'))
  await learning.recordTopic('arrays', 'selected')
  const plan = planningCases[0].reviewed
  const created = await projectData.save(workspace, plan, null)
  const approved = await projectData.approve(workspace, plan.tests[0], created.revision)
  const evidence = await projectData.evidence(workspace, unavailableTest(plan.tests[0], 'No test runner.'), approved.revision)
  await Promise.all([
    writeFile(join(source, 'planning-provider-v1.json'), 'sensitive-provider-data'),
    writeFile(join(source, 'Login Data'), 'sensitive-chromium-data'),
    writeFile(join(source, 'projects-v1', 'not-a-project.json'), 'unrelated-file'),
    mkdir(join(source, 'recovery')),
    mkdir(join(source, 'practice')),
  ])
  const saved = await exportLocalProfile(source, destination, preferences)
  assert.deepEqual((await readdir(saved)).sort(), ['ion-profile-backup.json', 'learning.json', 'preferences.json', 'projects-v1', 'themes'])
  const manifest = JSON.parse(await readFile(join(saved, 'ion-profile-backup.json'), 'utf8'))
  assert.equal(manifest.format, 'ion-local-profile')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.projects, 1)
  assert.equal(manifest.themes, 1)
  assert.equal(manifest.learning, true)
  assert.deepEqual(await new PreferenceStore(join(saved, 'preferences.json')).get(), await preferences.get())
  assert.deepEqual(await new ThemeStore(saved, themeAssets).load(palette.id), await themes.load(palette.id))
  assert.deepEqual(await new LearningService(join(saved, 'learning.json')).getHistory(), await learning.getHistory())
  assert.deepEqual(await new ProjectRepository(join(saved, 'projects-v1')).read(workspace), evidence)
  assert.equal(await readFile(join(source, 'planning-provider-v1.json'), 'utf8'), 'sensitive-provider-data')
  if (process.platform !== 'win32') {
    assert.equal((await stat(saved)).mode & 0o777, 0o700)
    assert.equal((await stat(join(saved, 'learning.json'))).mode & 0o777, 0o600)
  }
  const next = await exportLocalProfile(source, destination, preferences)
  assert.notEqual(next, saved)
  assert.equal(await readFile(join(saved, 'ion-profile-backup.json'), 'utf8').then(JSON.parse).then(value => value.version), 1)
})

test('failed profile exports leave no completed backup or user files overwritten', async (t) => {
  const { source, destination, preferences } = await profileFixture(t)
  const kept = join(destination, 'existing.txt')
  await writeFile(kept, 'keep')
  const history = join(source, 'learning.json')
  await writeFile(history, '')
  await truncate(history, 512 * 1024 + 1)
  await assert.rejects(exportLocalProfile(source, destination, preferences), /too large/)
  await assert.rejects(exportLocalProfile(source, source, preferences), /outside the active/)
  assert.deepEqual(await readdir(destination), ['existing.txt'])
  assert.equal(await readFile(kept, 'utf8'), 'keep')
  assert.equal((await stat(history)).size, 512 * 1024 + 1)
})

test('profile export refuses symbolic links in profile stores', { skip: process.platform === 'win32' }, async (t) => {
  const { source, destination, preferences } = await profileFixture(t)
  const outside = join(destination, 'external-data.json')
  await writeFile(outside, 'outside the profile')
  const learning = join(source, 'learning.json')
  await symlink(outside, learning)
  await assert.rejects(exportLocalProfile(source, destination, preferences), /symbolic link/)
  await rm(learning)
  await symlink(destination, join(source, 'projects-v1'))
  await assert.rejects(exportLocalProfile(source, destination, preferences), /symbolic link/)
  assert.deepEqual(await readdir(destination), ['external-data.json'])
})
