import { createHash } from 'node:crypto'
import { backupCategories, type BackupCategory, type BackupScope } from '../../shared/backup'

export const limits = { bytes: 2 * 1024 ** 3, files: 10_000, fileBytes: 128 * 1024 ** 2, manifestBytes: 8 * 1024 ** 2,
  folders: 16, exclusions: 250, pathBytes: 512, depth: 32, visits: 50_000 } as const
export const categoryRoots: Record<BackupCategory, string> = { preferences: 'preferences.json', themes: 'themes', learning: 'learning.json',
  content: 'learning-library', practice: 'practice', projects: 'projects-v1', session: 'editor-session.json', recovery: 'recovery' }
export interface BackupEntry { path: string; bytes: number; sha256: string; category?: BackupCategory; folder?: string }
export interface FolderRecord { id: string; name: string; mode: 'reference' | 'copy'; originalPath: string }
export interface BackupManifest { format: 'ion-backup'; version: 1; id: string; createdAt: string; appVersion: string
  schemas: Record<string, number>; categories: BackupCategory[]; entries: BackupEntry[]; folders: FolderRecord[]
  projects: Array<{ file: string; originalPath?: string }>; exclusions: Array<{ name: string; reason: string }>; exclusionsOmitted: number }
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup object.')
  return value as Record<string, unknown>
}
export function portablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > limits.pathBytes || value !== value.normalize('NFC')
    || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Backup contains a non-portable or unsafe path.')
  }
  return value
}
export function parseScope(value: unknown): BackupScope {
  const data = plain(value)
  if (!Array.isArray(data.categories) || !data.categories.length || data.categories.length > backupCategories.length
    || data.categories.some(v => !backupCategories.includes(v)) || new Set(data.categories).size !== data.categories.length
    || !Array.isArray(data.folders) || data.folders.length > limits.folders) throw new Error('Choose valid backup categories and folders.')
  const folders = data.folders.map(value => {
    const f = plain(value)
    if (typeof f.id !== 'string' || !/^[a-f0-9-]{36}$/.test(f.id) || typeof f.name !== 'string' || f.name.length > 256
      || !['reference', 'copy', 'exclude'].includes(String(f.mode))) throw new Error('Invalid selected backup folder.')
    return { id: f.id, name: f.name, mode: f.mode as 'reference' | 'copy' | 'exclude' }
  })
  if (new Set(folders.map(f => f.id)).size !== folders.length) throw new Error('Duplicate selected backup folders.')
  return { categories: [...data.categories] as BackupCategory[], folders }
}
export function entryCategory(path: string): BackupCategory | undefined {
  return backupCategories.find(category => path === 'profile/' + categoryRoots[category]
    || (!categoryRoots[category].endsWith('.json') && path.startsWith('profile/' + categoryRoots[category] + '/')))
}
export function parseManifest(value: unknown): BackupManifest {
  const d = plain(value)
  if (d.format !== 'ion-backup' || d.version !== 1 || typeof d.id !== 'string' || !/^[a-f0-9-]{36}$/.test(d.id)
    || typeof d.appVersion !== 'string' || d.appVersion.length > 40 || typeof d.createdAt !== 'string' || !Number.isFinite(Date.parse(d.createdAt))
    || !Array.isArray(d.entries) || d.entries.length > limits.files || !Array.isArray(d.folders) || d.folders.length > limits.folders
    || !Array.isArray(d.projects) || d.projects.length > 512 || !Array.isArray(d.exclusions) || d.exclusions.length > limits.exclusions
    || !Number.isSafeInteger(d.exclusionsOmitted) || Number(d.exclusionsOmitted) < 0) throw new Error('Unsupported or invalid Ion backup manifest.')
  const scope = parseScope({ categories: d.categories, folders: [] })
  const schemas = plain(d.schemas)
  if (Object.keys(schemas).some(key => !backupCategories.includes(key as BackupCategory) || schemas[key] !== 1)
    || scope.categories.some(key => schemas[key] !== 1)) throw new Error('Unsupported backup store schema.')
  const folders = d.folders.map(value => {
    const f = plain(value)
    if (typeof f.id !== 'string' || !/^[a-f0-9-]{36}$/.test(f.id) || typeof f.name !== 'string' || !f.name || f.name.length > 256
      || !['copy', 'reference'].includes(String(f.mode)) || typeof f.originalPath !== 'string' || f.originalPath.length > 4096
      || /[\x00-\x1f\x7f]/.test(f.originalPath)) throw new Error('Invalid backup folder association.')
    return f as unknown as FolderRecord
  })
  if (new Set(folders.map(f => f.id)).size !== folders.length) throw new Error('Duplicate backup folder IDs.')
  const seen = new Set<string>(); let bytes = 0
  const entries = d.entries.map(value => {
    const e = plain(value), path = portablePath(e.path), folded = path.toLowerCase()
    if (seen.has(folded) || !Number.isSafeInteger(e.bytes) || Number(e.bytes) < 0 || Number(e.bytes) > limits.fileBytes
      || typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error('Invalid or duplicate backup entry.')
    seen.add(folded); bytes += Number(e.bytes)
    if (bytes > limits.bytes) throw new Error('Backup exceeds the 2 GiB expanded limit.')
    if (path.startsWith('profile/')) {
      const category = entryCategory(path)
      if (!category || e.category !== category || !scope.categories.includes(category) || e.folder !== undefined) throw new Error('Unapproved profile entry in backup.')
    } else if (path.startsWith('workspaces/')) {
      const folder = folders.find(f => f.id === e.folder && f.mode === 'copy')
      if (!folder || !path.startsWith('workspaces/' + folder.id + '/') || e.category !== undefined) throw new Error('Invalid copied workspace entry.')
    } else throw new Error('Backup entry is outside its declared scope.')
    return e as unknown as BackupEntry
  })
  const projectsSeen = new Set<string>()
  for (const value of d.projects) {
    const p = plain(value)
    if (typeof p.file !== 'string' || !/^[a-f0-9]{64}\.json$/.test(p.file) || projectsSeen.has(p.file) || !entries.some(e => e.path === 'profile/projects-v1/' + p.file)
      || (p.originalPath !== undefined && (typeof p.originalPath !== 'string' || p.originalPath.length > 4096 || /[\x00-\x1f]/.test(p.originalPath)))) throw new Error('Invalid project association.')
    projectsSeen.add(p.file as string)
  }
  if (entries.filter(e => e.category === 'projects').length !== projectsSeen.size) throw new Error('Missing project association metadata.')
  for (const value of d.exclusions) {
    const e = plain(value)
    if (typeof e.name !== 'string' || e.name.length > 512 || typeof e.reason !== 'string' || e.reason.length > 120) throw new Error('Invalid backup exclusions.')
  }
  return { ...d, entries, folders } as unknown as BackupManifest
}
