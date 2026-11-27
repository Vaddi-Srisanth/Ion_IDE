import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupCategory, BackupProgress } from '../../shared/backup'
import { limits, sha256, type BackupManifest, type FolderRecord } from './format'
import { profileFiles, workspaceFiles } from './profile'
import { aborted, copyChecked, fingerprint, names } from './safe-fs'

export interface FolderSource extends FolderRecord { root: string }
export interface Snapshot { manifest: BackupManifest; sources: Array<{ root: string; name: string; path: string; sha256: string }>; inventory: string }
export async function snapshot(profile: string, stage: string, categories: BackupCategory[], folders: FolderSource[], appVersion: string,
  progress: (p: BackupProgress) => void = () => {}, signal?: AbortSignal): Promise<Snapshot> {
  const exclusions = [{ name: 'Profile exclusions', reason: 'Credentials, browser data, execution trust, caches, logs and temporary files' },
    { name: 'Working-folder exclusions', reason: 'Dependencies, builds, .git, secret filenames, links, special and non-portable files' }]
  let exclusionsOmitted = 0, bytes = 0
  const addExclusion = (name: string, reason: string) => { if (exclusions.length < limits.exclusions) exclusions.push({ name: name.slice(0, 512), reason }); else exclusionsOmitted++ }
  const entries: BackupManifest['entries'] = [], sources: Snapshot['sources'] = []
  const copy = async (root: string, name: string, path: string, limit: number, category?: BackupCategory, folder?: string) => {
    aborted(signal); if (entries.length >= limits.files) throw new Error('Backup exceeds 10,000 entries.')
    const info = await fingerprint(root, name, limit, signal)
    bytes += info.bytes; if (bytes > limits.bytes) throw new Error('Backup exceeds 2 GiB.')
    const copied = await copyChecked(root, name, join(stage, ...path.split('/')), limit, signal)
    if (info.sha256 !== copied.sha256) throw new Error('Data changed during snapshotting. Review again.')
    entries.push({ path, bytes: info.bytes, sha256: info.sha256, ...(category ? { category } : {}), ...(folder ? { folder } : {}) })
    sources.push({ root, name, path, sha256: info.sha256 })
    progress({ phase: 'copying', files: entries.length, bytes })
  }
  const inventory = await profileFiles(profile, categories, signal)
  for (const file of inventory) await copy(profile, file.name, 'profile/' + file.name, file.limit, file.category)
  for (const folder of folders) {
    if (folder.mode !== 'copy') continue
    for (const file of await workspaceFiles(folder.root, (name, reason) => addExclusion(folder.name + '/' + name, reason), signal, [profile])) {
      await copy(folder.root, file.name, 'workspaces/' + folder.id + '/' + file.name, limits.fileBytes, undefined, folder.id)
    }
    // An empty working folder must survive even though ZIP has no directory entries.
    await mkdir(join(stage, 'workspaces', folder.id), { recursive: true, mode: 0o700 })
  }
  const manifest: BackupManifest = { format: 'ion-backup', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), appVersion,
    schemas: Object.fromEntries(categories.map(c => [c, 1])), categories, entries,
    folders: folders.map(({ root: _root, ...f }) => f), exclusions, exclusionsOmitted,
    projects: entries.filter(e => e.category === 'projects').map(e => {
      const file = e.path.slice('profile/projects-v1/'.length), matching = folders.find(f => sha256(f.originalPath) + '.json' === file)
      return { file, ...(matching ? { originalPath: matching.originalPath } : {}) }
    }) }
  const value = { manifest, sources, inventory: inventory.map(f => f.name).join('\n') }
  await verifySnapshot(profile, value, folders, signal)
  // Re-run existing schemas against the copied records, never a live mutable store.
  await profileFiles(join(stage, 'profile'), categories, signal)
  return value
}
export async function verifySnapshot(profile: string, value: Snapshot, folders: FolderSource[], signal?: AbortSignal) {
  if ((await profileFiles(profile, value.manifest.categories, signal)).map(f => f.name).join('\n') !== value.inventory) throw new Error('Selected profile records changed. Review again.')
  for (const file of value.sources) if ((await fingerprint(file.root, file.name, limits.fileBytes, signal)).sha256 !== file.sha256) throw new Error('Selected data changed. Review the backup or restore again.')
  for (const folder of folders.filter(f => f.mode === 'copy')) {
    const current = (await workspaceFiles(folder.root, () => {}, signal, [profile])).map(f => f.name)
    const before = value.sources.filter(s => s.root === folder.root && s.path.startsWith('workspaces/')).map(f => f.name)
    if (JSON.stringify(current.sort()) !== JSON.stringify(before.sort())) throw new Error('Working files changed. Review again.')
  }
}
export async function validatePayload(stage: string, manifest: BackupManifest, signal?: AbortSignal) {
  const expected = manifest.entries.filter(e => e.category).map(e => e.path.slice(8)).sort()
  await mkdir(join(stage, 'profile'), { recursive: true, mode: 0o700 })
  const validated = (await profileFiles(join(stage, 'profile'), manifest.categories, signal)).map(f => f.name).sort()
  if (JSON.stringify(expected) !== JSON.stringify(validated)) throw new Error('Archive contains unreferenced or missing profile records.')
  const actual = (await names(stage, signal)).sort(), all = manifest.entries.map(e => e.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(all)) throw new Error('Archive payload does not match its manifest.')
  for (const folder of manifest.folders.filter(f => f.mode === 'copy')) await mkdir(join(stage, 'workspaces', folder.id), { recursive: true, mode: 0o700 })
}
