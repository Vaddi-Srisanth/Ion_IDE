import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { backupCategories, type BackupCategory, type RestoreChoices } from '../../shared/backup'
import { validateBackupPreferences, isRecent } from '../preferences'
import { validateEditorSnapshot } from '../editor-session'
import { validateSavedProject } from '../projects/repository'
import { restoreStoredTests, maxTestRecordBytes } from '../test-explorer/model'
import { validatePracticeReport, validatePracticeSubmissions } from '../practice/store'
import { RecoveryStore } from '../recovery'
import { limits, plain, sha256, type BackupManifest } from './format'
import { profileFiles, inertPath } from './profile'
import { aborted, copyChecked, exists, names, readValue } from './safe-fs'
import { durableJson } from './transaction'
import { snapshot } from './snapshot'

export async function importLegacy(source: string, stage: string, appVersion: string, signal?: AbortSignal): Promise<BackupManifest> {
  const marker = plain(await readValue(source, 'ion-profile-backup.json', 64 * 1024))
  if (marker.format !== 'ion-local-profile' || marker.version !== 1) throw new Error('Not a supported Ion profile export.')
  const categories: BackupCategory[] = ['preferences', 'themes', 'learning', 'content', 'projects']
  const files = await profileFiles(source, categories, signal), expected = new Set(files.map(f => f.name))
  for (const file of await names(source, signal)) if (file !== 'ion-profile-backup.json' && !expected.has(file)) throw new Error('Legacy export contains unexpected files.')
  return (await snapshot(source, stage, categories, [], appVersion, () => {}, signal)).manifest
}
export function validateChoices(value: unknown, manifest: BackupManifest): RestoreChoices {
  const c = plain(value)
  if (!Array.isArray(c.replace) || !c.replace.length || c.replace.length > backupCategories.length
    || new Set(c.replace).size !== c.replace.length || c.replace.some(v => !manifest.categories.includes(v))
    || !Array.isArray(c.mappings) || c.mappings.length > 1024 || !Array.isArray(c.copyFolders) || c.copyFolders.length > limits.folders
    || new Set(c.copyFolders).size !== c.copyFolders.length || c.copyFolders.some(v => !manifest.folders.some(f => f.id === v && f.mode === 'copy'))) throw new Error('Invalid restore selection.')
  const seen = new Set<string>()
  for (const item of c.mappings) {
    const m = plain(item)
    const allowed = (c.replace.includes('projects') && manifest.projects.some(p => p.file === m.id))
      || (c.replace.includes('tests') && manifest.entries.some(e => e.category === 'tests' && e.path === 'profile/' + m.id))
    if (typeof m.id !== 'string' || !allowed || seen.has(m.id)
      || typeof m.folderId !== 'string' || !/^[a-f0-9-]{36}$/.test(m.folderId)) throw new Error('Invalid project folder mapping.')
    seen.add(m.id)
  }
  return c as unknown as RestoreChoices
}
export async function prepareProfile(profile: string, payload: string, target: string, manifest: BackupManifest, choices: RestoreChoices,
  mappings: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<BackupCategory[]> {
  const selected = [...choices.replace]
  if (selected.includes('session') && manifest.entries.some(e => e.category === 'recovery') && !selected.includes('recovery')) {
    throw new Error('Select detached drafts together with a restored editor session.')
  }
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const entry of manifest.entries.filter(e => e.category && e.category !== 'tests' && selected.includes(e.category))) {
    const name = entry.path.slice(8)
    await copyChecked(join(payload, 'profile'), name, join(target, name), limits.fileBytes, signal)
  }
  if (selected.includes('preferences') && await exists(join(target, 'preferences.json'))) {
    const data = validateBackupPreferences(await readValue(target, 'preferences.json', 64 * 1024))
    // Imported settings may express preferences, never authorization to start tooling.
    await durableJson(join(target, 'preferences.json'), { ...data, settings: { ...data.settings, smartLanguages: [] }, recents: data.recents.filter(isRecent) })
  }
  if (selected.includes('projects')) {
    const outputs = new Set<string>()
    const records = []
    for (const entry of manifest.entries.filter(e => e.category === 'projects')) {
      const name = entry.path.slice(8), file = name.slice('projects-v1/'.length)
      const data = validateSavedProject(await readValue(target, name, 512 * 1024))
      const mapping = choices.mappings.find(m => m.id === file), root = mapping && mappings.get(mapping.folderId)
      if (mapping && !root) throw new Error('Choose the relocated folder again. Its access token expired.')
      const output = root ? sha256(root) + '.json' : file
      if (outputs.has(output)) throw new Error('Two roadmaps map to the same folder. Choose distinct folders.')
      outputs.add(output)
      const historical = [...(data.restoredEvidence ?? []), ...data.evidence]
      const history = [...new Map(historical.map(e => [e.testId, e])).values()]
      records.push({ name: 'projects-v1/' + output, data: { schema: 1, ...data, revision: randomUUID(), approved: [], evidence: [], restoredEvidence: history } })
    }
    // Mapping can change filenames; clear only our disposable target directory.
    const { rm } = await import('node:fs/promises')
    await rm(join(target, 'projects-v1'), { recursive: true, force: true })
    if (records.length) await mkdir(join(target, 'projects-v1'), { mode: 0o700 })
    for (const record of records) await durableJson(join(target, record.name), record.data)
  }
  if (selected.includes('tests')) {
    const outputs = new Set<string>()
    for (const entry of manifest.entries.filter(e => e.category === 'tests')) {
      aborted(signal)
      const name = entry.path.slice('profile/'.length)
      const record = restoreStoredTests(await readValue(join(payload, 'profile'), name, maxTestRecordBytes))
      const mapping = choices.mappings.find(m => m.id === name)
      if (mapping) {
        const root = mappings.get(mapping.folderId)
        if (!root) throw new Error('Choose the relocated test history folder again.')
        record.snapshot.root = root
      }
      const output = sha256(record.snapshot.root) + '.json'
      if (outputs.has(output)) throw new Error('Two test histories map to the same folder. Choose distinct folders.')
      outputs.add(output)
      await mkdir(join(target, 'test-explorer-v1'), { recursive: true, mode: 0o700 })
      await durableJson(join(target, 'test-explorer-v1', output), record)
    }
  }
  if (selected.includes('practice')) {
    for (const entry of manifest.entries.filter(e => e.category === 'practice' && e.path.endsWith('.submissions.json'))) {
      const name = entry.path.slice(8)
      const ledger = validatePracticeSubmissions(await readValue(target, name, 64 * 1024))
      await durableJson(join(target, name), { ...ledger, submissions: ledger.submissions.map(row => ({ ...row, restored: true })) })
    }
    for (const entry of manifest.entries.filter(e => e.category === 'practice' && e.path.endsWith('.report.json'))) {
      const name = entry.path.slice(8), report = validatePracticeReport(await readValue(target, name, 1024 * 1024))
      await durableJson(join(target, name), { ...report, restored: true })
    }
  }
  const draftIds = new Map<string, string>()
  if (selected.includes('recovery')) {
    const current = await profileFiles(profile, ['recovery'], signal), incoming = manifest.entries.filter(e => e.category === 'recovery')
    if (current.length + incoming.length > 64) throw new Error('Current and restored drafts exceed the 64-draft limit. Recover or remove some drafts first.')
    const { rm } = await import('node:fs/promises')
    await rm(join(target, 'recovery'), { recursive: true, force: true }); await mkdir(join(target, 'recovery'), { mode: 0o700 })
    for (const file of current) await copyChecked(profile, file.name, join(target, file.name), file.limit, signal)
    const used = new Set(current.map(f => f.name.slice('recovery/'.length, -6)))
    const source = new RecoveryStore(join(payload, 'profile', 'recovery')), destination = new RecoveryStore(join(target, 'recovery'))
    for (const entry of incoming) {
      aborted(signal)
      const id = entry.path.slice('profile/recovery/'.length, -6), metadata = await source.inspect(id, true)
      let remapped = randomUUID()
      while (used.has(remapped)) remapped = randomUUID()
      used.add(remapped)
      draftIds.set(id, remapped)
      // No originalPath: even a trusted-looking archived path is only history.
      await destination.write({ id: remapped, name: metadata.name, text: await source.read(id, true) })
    }
  }
  if (selected.includes('session') && await exists(join(target, 'editor-session.json'))) {
    const data = validateEditorSnapshot(await readValue(target, 'editor-session.json', 1024 * 1024), inertPath)
    const active = data.tabs[data.activeIndex]?.draftId
    const tabs = data.tabs.filter(t => t.draftId && draftIds.has(t.draftId)).map(t => ({ ...t, path: null, draftId: draftIds.get(t.draftId!) }))
    const references = [...new Map([...(data.restoredReferences ?? []), ...data.tabs.filter(t => t.path !== null).map(({ draftId: _draftId, ...tab }) => tab)].map(t => [t.path, t])).values()].slice(-64)
    await durableJson(join(target, 'editor-session.json'), { version: 1, rootPath: null, activeIndex: active ? tabs.findIndex(t => t.draftId === draftIds.get(active)) : -1,
      tabs, restoredReferences: references, ...((data.rootPath || data.restoredRoot) ? { restoredRoot: data.rootPath || data.restoredRoot } : {}) })
  }
  await profileFiles(target, selected, signal)
  return selected
}
