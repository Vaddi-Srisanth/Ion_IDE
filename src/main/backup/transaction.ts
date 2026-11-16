import { randomUUID } from 'node:crypto'
import { mkdir, link, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { backupCategories, type BackupCategory } from '../../shared/backup'
import { categoryRoots, limits, plain, sha256 } from './format'
import { checkedPath, clean, copyChecked, directory, exists, fingerprint, names, readValue } from './safe-fs'
import { syncDirectory } from './archive'

export const pendingName = 'ion-pending-restore.json'
export async function durableJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  let owned = false
  try {
    const file = await open(temporary, 'wx', 0o600); owned = true
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, path); await syncDirectory(join(path, '..'))
  } finally { if (owned) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function treeHash(root: string, name: string): Promise<string | null> {
  if (!await exists(join(root, name))) return null
  const path = await checkedPath(root, name), { lstat } = await import('node:fs/promises'), info = await lstat(path)
  if (info.isFile()) { const value = await fingerprint(root, name); return sha256(JSON.stringify([name, value.bytes, value.sha256])) }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Restore target uses a link or special file.')
  let total = 0; const values = []
  for (const file of await names(path)) {
    const value = await fingerprint(path, file); total += value.bytes
    if (total > limits.bytes) throw new Error('Current restore category exceeds 2 GiB.')
    values.push([file, value.bytes, value.sha256])
  }
  return sha256(JSON.stringify(values))
}
interface Step { category: BackupCategory; before: string | null; after: string | null }
interface Journal { version: 1; id: string; state: 'prepared' | 'applying' | 'rollback' | 'done'; steps: Step[]; rollback: string }
async function syncTree(path: string) {
  await directory(path)
  for await (const entry of await opendir(path)) if (entry.isDirectory()) await syncTree(join(path, entry.name))
  await syncDirectory(path)
}
export async function stageTransaction(profile: string, stage: string, categories: BackupCategory[], rollback: string) {
  await directory(profile)
  const id = randomUUID(), base = join(profile, '.ion-restores')
  if (!await exists(base)) await mkdir(base, { mode: 0o700 })
  await directory(base)
  const folder = join(base, id); await mkdir(folder, { mode: 0o700 })
  try {
    await mkdir(join(folder, 'incoming'), { mode: 0o700 })
    const steps: Step[] = []
    for (const category of categories) {
      const name = categoryRoots[category]
      if (await exists(join(stage, name))) {
        const { lstat } = await import('node:fs/promises')
        if ((await lstat(join(stage, name))).isFile()) await copyChecked(stage, name, join(folder, 'incoming', name))
        else {
          await mkdir(join(folder, 'incoming', name), { recursive: true, mode: 0o700 })
          for (const file of await names(join(stage, name))) await copyChecked(stage, name + '/' + file, join(folder, 'incoming', name, file))
        }
      }
      steps.push({ category, before: await treeHash(profile, name), after: await treeHash(join(folder, 'incoming'), name) })
    }
    const journal: Journal = { version: 1, id, state: 'prepared', steps, rollback }
    await syncTree(join(folder, 'incoming'))
    await durableJson(join(folder, 'journal.json'), journal)
    await syncDirectory(folder); await syncDirectory(base)
    return { id, folder, journal }
  } catch (error) { await clean(folder); throw error }
}
export async function armTransaction(profile: string, id: string) {
  if (await exists(join(profile, pendingName))) throw new Error('A restore is already pending.')
  const folder = await directory(join(profile, '.ion-restores', id))
  const journal = parseJournal(await readValue(folder, 'journal.json', 64 * 1024), id)
  for (const step of journal.steps) if (await treeHash(profile, categoryRoots[step.category]) !== step.before) throw new Error('Current data changed. Review the restore again.')
  // A partial marker is never visible; the file is flushed before exclusive publication.
  const temporary = join(profile, '.ion-pending-restore-' + randomUUID() + '.tmp')
  let owned = false
  try {
    const file = await open(temporary, 'wx', 0o600); owned = true
    try { await file.writeFile(JSON.stringify({ version: 1, id }) + '\n'); await file.sync() } finally { await file.close() }
    await link(temporary, join(profile, pendingName)); await syncDirectory(profile)
  } finally { if (owned) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
function parseJournal(value: unknown, id: string): Journal {
  const data = plain(value)
  if (data.version !== 1 || data.id !== id || !['prepared', 'applying', 'rollback', 'done'].includes(String(data.state))
    || !Array.isArray(data.steps) || data.steps.length > backupCategories.length || typeof data.rollback !== 'string') throw new Error('Invalid restore journal.')
  const seen = new Set<string>()
  for (const item of data.steps) {
    const step = plain(item)
    if (!backupCategories.includes(step.category as BackupCategory) || seen.has(String(step.category))
      || [step.before, step.after].some(v => v !== null && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)))) throw new Error('Invalid restore journal step.')
    seen.add(String(step.category))
  }
  return data as unknown as Journal
}
export type Boundary = (stage: string, category?: BackupCategory) => Promise<void>
// Called before normal stores exist. The journal records intent; file identities
// determine whether a rename completed if the process died before the next write.
export async function finishPendingRestore(profile: string, boundary: Boundary = async () => {}): Promise<'none' | 'applied' | 'rolled-back'> {
  if (!await exists(join(profile, pendingName))) return 'none'
  profile = await realpath(profile)
  await directory(profile)
  const marker = plain(await readValue(profile, pendingName, 1024))
  if (marker.version !== 1 || typeof marker.id !== 'string' || !/^[a-f0-9-]{36}$/.test(marker.id)) throw new Error('Invalid pending restore marker. Preserve the profile and repair it before editing.')
  await directory(join(profile, '.ion-restores'))
  const folder = await directory(join(profile, '.ion-restores', marker.id)), incoming = await directory(join(folder, 'incoming'))
  const old = join(folder, 'previous'), failed = join(folder, 'unapplied')
  for (const path of [old, failed]) { if (!await exists(path)) await mkdir(path, { mode: 0o700 }); await directory(path) }
  const journal = parseJournal(await readValue(folder, 'journal.json', 64 * 1024), marker.id)
  const save = () => durableJson(join(folder, 'journal.json'), journal)
  const move = async (source: string, destination: string) => {
    await rename(source, destination); await syncDirectory(join(source, '..')); await syncDirectory(join(destination, '..'))
  }
  let result: 'applied' | 'rolled-back' = 'applied'
  try {
    if (journal.state === 'rollback') throw new Error('Resuming restore rollback.')
    journal.state = 'applying'; await save(); await boundary('journal')
    for (const step of journal.steps) {
      const name = categoryRoots[step.category]
      let current = await treeHash(profile, name), prior = await treeHash(old, name), next = await treeHash(incoming, name)
      // Already published (including a deliberate category deletion).
      if (current === step.after && next === null && (step.before === null || prior === step.before)) continue
      if (step.before !== null && prior === null) {
        if (current !== step.before) throw new Error('Restore conflict: current data changed.')
        await move(join(profile, name), join(old, name)); await boundary('previous-moved', step.category); current = null; prior = step.before
      }
      if (current !== null || prior !== step.before || next !== step.after) throw new Error('Restore transaction contents changed.')
      if (next !== null) { await move(join(incoming, name), join(profile, name)); await boundary('published', step.category) }
      if (await treeHash(profile, name) !== step.after) throw new Error('Restored data verification failed.')
    }
    journal.state = 'done'; await save(); await boundary('committed')
  } catch (error) {
    journal.state = 'rollback'; await save()
    for (const step of [...journal.steps].reverse()) {
      const name = categoryRoots[step.category], current = await treeHash(profile, name), prior = await treeHash(old, name)
      if (prior === null && current === step.before) continue
      if (prior !== step.before) throw new Error('Restore repair stopped. Both versions are preserved in ' + folder, { cause: error })
      if (current !== null) {
        if (current !== step.after || await exists(join(failed, name))) throw new Error('Restore repair found changed data. Both versions are preserved in ' + folder, { cause: error })
        await move(join(profile, name), join(failed, name))
      }
      if (prior !== null) await move(join(old, name), join(profile, name))
      await boundary('rolled-back', step.category)
    }
    result = 'rolled-back'
  }
  await unlink(join(profile, pendingName)); await syncDirectory(profile)
  // Keep previous/unapplied versions and the verified rollback archive locally.
  // They are never swept automatically, so unsupported old files are preserved.
  return result
}
