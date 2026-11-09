import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  sleep, stubDialogs, waitForFile, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'

await withScratch('data-integrity', async (scratch) => {
  const project = await createProject(join(scratch, 'workspace'))
  const source = project.files[0]
  const moved = join(project.directory, 'moved original.txt')
  const saved = join(project.directory, 'saved as copy.txt')
  const occupied = join(project.directory, 'existing target.txt')
  const profile = join(scratch, 'future-profile')
  const preferences = join(profile, 'preferences.json')
  const futureData = '{"version":999,"settings":{"autoSave":false,"fontSize":20}}\n'
  const original = 'Original source\n'
  const replacement = 'New external file\n'
  const buffer = 'Unsaved editor draft 🧪'
  await mkdir(profile)
  await Promise.all([writeFile(preferences, futureData), writeFile(source, original), writeFile(occupied, 'Keep this file')])
  const first = await launch(target, profile)
  let completed = false
  try {
    const { app, page } = first
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await page.getByTestId('status').getByText(/preferences format is unsupported/i).waitFor()
    await openFolder(page, project)
    await openFromExplorer(page, source, 'Original source')
    await page.locator('.monaco-editor .view-line').first().click()
    await page.keyboard.press(selectAll)
    await page.keyboard.insertText(buffer)
    await editorShows(page, buffer)
    await eventually(() => page.evaluate(async (text) => {
      const [draft] = await window.ion.recovery.list()
      return Boolean(draft && await window.ion.recovery.read(draft.id) === text)
    }, buffer), 'Expected a durable recovery checkpoint.')
    await sleep(1100)
    assert.equal(await readFile(source, 'utf8'), original, 'Unreadable settings must not enable autosave.')
    assert.equal(await readFile(preferences, 'utf8'), futureData, 'Reopening must not rewrite a future profile.')
    console.log('PASS an unsupported profile remains intact and editing continues with autosave off')

    await rename(source, moved)
    await writeFile(source, replacement)
    await atPath(page, 'close-tab', source).click()
    const confirmation = page.getByRole('dialog', { name: 'Unsaved changes' })
    await confirmation.getByRole('button', { name: 'Save', exact: true }).click()
    await confirmation.getByRole('alert').getByText(/changed on disk/i).waitFor()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await atPath(page, 'tab', source).waitFor()
    await editorShows(page, buffer)

    const conflict = page.locator('.conflict-banner')
    const saveAs = conflict.getByRole('button', { name: 'Save As…' })
    await saveAs.click()
    await editorShows(page, buffer)
    await atPath(page, 'tab', source).waitFor()
    await stubDialogs(app, { folder: project.directory, save: occupied })
    await app.evaluate(({ dialog }) => {
      const answer = dialog.showMessageBox
      dialog.showMessageBox = async (window, options) => {
        if (options.buttons?.includes('Replace File')) globalThis.ionTestOverwritePrompted = true
        return answer(window, options)
      }
    })
    await saveAs.click()
    await eventually(() => app.evaluate(() => Boolean(globalThis.ionTestOverwritePrompted)),
      'An occupied Save As destination requires explicit replacement consent.')
    assert.equal(await readFile(occupied, 'utf8'), 'Keep this file')
    await editorShows(page, buffer)
    await stubDialogs(app, { folder: project.directory, save: saved })
    await saveAs.click()
    await waitForFile(readFile, saved, buffer)
    await atPath(page, 'tab', saved).waitFor()
    assert.equal(await readFile(moved, 'utf8'), original)
    assert.equal(await readFile(source, 'utf8'), replacement)
    assert.equal(await readFile(preferences, 'utf8'), futureData)
    await eventually(() => page.evaluate(async () => (await window.ion.recovery.list()).length === 0),
      'A completed Save As must clear the corresponding draft.')
    assert.deepEqual(first.errors, [])
    assert.deepEqual(first.requests, [])
    console.log('PASS failed close-and-save and canceled Save As preserve the buffer, and an explicit Save As preserves both disk versions')
    completed = true
  } finally {
    await close(first).catch((error) => { if (completed) throw error })
  }

  const privateFile = join(scratch, 'private.txt')
  const originalRecent = join(project.directory, 'old recent.txt')
  const recentProfile = join(scratch, 'recent-profile')
  await mkdir(recentProfile)
  await writeFile(privateFile, 'private')
  const linked = await symlink(privateFile, originalRecent, 'file').then(() => true, (error) => {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      console.log('SKIP recent-file symbolic link: Windows account lacks symbolic-link privileges.')
      return false
    }
    throw error
  })
  await writeFile(join(recentProfile, 'preferences.json'), JSON.stringify({
    version: 1, settings: {}, recents: [{ path: originalRecent, name: 'old recent.txt', kind: 'file', lastOpened: 1 }],
  }))
  if (linked) {
    const second = await launch(target, recentProfile)
    try {
    const { page } = second
    await page.locator('.recent-entry').filter({ hasText: 'old recent.txt' }).click()
    await page.getByTestId('status').getByText(/local source path changed/i).waitFor()
    assert.equal(await page.getByTestId('workspace').count(), 0)
    const granted = await page.evaluate(async (path) => {
      try { await window.ion.readFile(path); return true } catch { return false }
    }, privateFile)
    assert.equal(granted, false)
    console.log('PASS a recent file replaced with a symlink cannot grant access to another file')
    } finally {
      await close(second)
    }
  }

  const autosaveProfile = join(scratch, 'autosave-profile')
  const autosave = await launch(target, autosaveProfile)
  try {
    const { app, page } = autosave
    const status = page.locator('.document-status')
    await stubDialogs(app, { folder: project.directory, save: join(project.directory, 'recovered edit.txt') })
    await openFolder(page, project)
    await openFromExplorer(page, source, replacement.trim())
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/xattr', ['-w', 'org.ion.test.autosave', 'metadata only', source])
    } else {
      const info = await stat(source)
      await utimes(source, info.atime, new Date(info.mtimeMs + 2000))
    }
    const replaceText = async (text) => {
      await page.locator('.monaco-editor .view-line').first().click()
      await page.keyboard.press(selectAll)
      await page.keyboard.insertText(text)
      await editorShows(page, text)
    }
    const firstEdit = 'Autosave after metadata update'
    await replaceText(firstEdit)
    await waitForFile(readFile, source, firstEdit)
    assert.equal(await page.locator('.conflict-banner').count(), 0)
    await status.getByText('Autosave on', { exact: true }).waitFor()

    const externalEdit = 'External edit after autosave'
    const nextEdit = 'Keep this unsaved edit'
    await writeFile(source, externalEdit)
    await replaceText(nextEdit)
    await page.locator('.conflict-banner').getByText(/your edits are unsaved/i).waitFor()
    await status.getByText('Autosave paused', { exact: true }).waitFor()
    await page.locator('.conflict-banner').getByRole('button', { name: 'Save As…' }).click()
    await waitForFile(readFile, join(project.directory, 'recovered edit.txt'), nextEdit)
    assert.equal(await readFile(source, 'utf8'), externalEdit)
    await status.getByText('Autosave on', { exact: true }).waitFor()
    assert.deepEqual(autosave.errors, [])
    console.log('PASS metadata updates keep autosave working and real external edits pause it until both versions are safe')
  } finally {
    await close(autosave)
  }
})
