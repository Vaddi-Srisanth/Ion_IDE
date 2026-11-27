import { opendir } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { BackupCategory } from '../../shared/backup'
import { validateBackupPreferences } from '../preferences'
import { validateEditorSnapshot } from '../editor-session'
import { validateLearningHistory } from '../learning'
import { LearningPackStore, packProfileFiles, parseInstalledLibrary } from '../learning/catalog-store'
import { validatePracticeProblem, validatePracticeReport, validatePracticeSubmissions } from '../practice/store'
import { validateSavedProject } from '../projects/repository'
import { testId, validateStoredTests, maxTestRecordBytes } from '../test-explorer/model'
import { RecoveryStore } from '../recovery'
import { ThemeStore } from '../themes'
import { limits, categoryRoots, plain, portablePath } from './format'
import { aborted, checkedPath, directory, exists, fingerprint, within, readBounded, readValue } from './safe-fs'

const KiB = 1024, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export interface ProfileFile { name: string; category: BackupCategory; limit: number }
export function inertPath(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)
    || !(posix.isAbsolute(value) || win32.isAbsolute(value))) throw new Error('Invalid stored location.')
  return value
}
async function children(root: string, name: string): Promise<string[]> {
  if (!await exists(join(root, name))) return []
  await directory(join(root, name))
  const result: string[] = []
  for await (const entry of await opendir(join(root, name))) {
    if (result.length >= limits.files) throw new Error('Too many profile records.')
    result.push(entry.name)
  }
  return result.sort()
}
// Only authoritative records are eligible. Caches, temporary files, credentials,
// trust databases and unreferenced practice files never enter the snapshot.
export async function profileFiles(root: string, categories: readonly BackupCategory[], signal?: AbortSignal): Promise<ProfileFile[]> {
  const result: ProfileFile[] = []
  const add = async (category: BackupCategory, name: string, limit: number, required = false) => {
    aborted(signal); portablePath(name)
    if (!await exists(join(root, name))) { if (required) throw new Error('Required profile record is missing: ' + name); return }
    await fingerprint(root, name, limit, signal)
    result.push({ name, category, limit })
    if (result.length > limits.files) throw new Error('Too many backup records.')
  }
  for (const category of categories) {
    const name = categoryRoots[category]
    if (category === 'preferences') {
      await add(category, name, 64 * KiB)
      if (await exists(join(root, name))) validateBackupPreferences(await readValue(root, name, 64 * KiB))
    } else if (category === 'learning') {
      await add(category, name, 512 * KiB)
      if (await exists(join(root, name))) validateLearningHistory((await readBounded(root, name, 512 * KiB)).toString('utf8'))
    } else if (category === 'session') {
      await add(category, name, 1024 * KiB)
      if (await exists(join(root, name))) {
        const data = plain(await readValue(root, name, 1024 * KiB))
        if (data.version !== 1) throw new Error('Unsupported editor session version.')
        validateEditorSnapshot(data, inertPath)
      }
    } else if (category === 'projects') {
      const records = (await children(root, name)).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
      if (records.length > 512) throw new Error('Too many project records.')
      for (const file of records) {
        await add(category, name + '/' + file, 512 * KiB)
        validateSavedProject(await readValue(root, name + '/' + file, 512 * KiB))
      }
    } else if (category === 'tests') {
      const records = (await children(root, name)).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
      if (records.length > 512) throw new Error('Too many Test Explorer records.')
      for (const file of records) {
        await add(category, name + '/' + file, maxTestRecordBytes)
        const record = validateStoredTests(await readValue(root, name + '/' + file, maxTestRecordBytes))
        if (file !== testId(record.snapshot.root) + '.json') throw new Error('Test history belongs to a different workspace identity.')
      }
    } else if (category === 'recovery') {
      const records = (await children(root, name)).filter(n => uuid.test(n.replace(/\.draft$/, '')) && n.endsWith('.draft'))
      if (records.length > 64) throw new Error('Recovery storage exceeds 64 drafts.')
      const store = new RecoveryStore(join(root, name))
      for (const file of records) {
        await add(category, name + '/' + file, 16 * 1024 * KiB + 32 * KiB + 8)
        await store.inspect(file.slice(0, -6), true)
        await store.read(file.slice(0, -6), true)
      }
    } else if (category === 'themes') {
      if (!await exists(join(root, name, 'registry.json'))) continue
      await add(category, name + '/registry.json', 512 * KiB)
      const store = new ThemeStore(root, ''), themes = (await store.list()).filter(t => t.source === 'custom')
      for (const theme of themes) {
        await add(category, name + '/' + theme.id + '.json', 8 * KiB, true)
        await store.load(theme.id)
      }
    } else if (category === 'content') {
      if (!await exists(join(root, name, 'library.json'))) continue
      await add(category, name + '/library.json', 2 * 1024 * KiB)
      const registry = parseInstalledLibrary((await readBounded(root, name + '/library.json', 2 * 1024 * KiB)).toString('utf8'))
      const store = new LearningPackStore(root, '')
      for (const pack of registry.installed) {
        for (const file of await packProfileFiles(join(root, name), pack)) {
          await add(category, name + '/' + file.name.split('\\').join('/'), file.limit, true)
        }
        for (const topic of await store.getTopics(pack.id)) await store.getLesson(pack.id, topic.id)
      }
    } else if (category === 'practice') {
      const problems = (await children(root, name)).filter(n => uuid.test(n))
      if (problems.length > 200) throw new Error('Too many practice problems.')
      for (const id of problems) {
        const base = name + '/' + id
        await add(category, base + '/problem.json', 1024 * KiB, true)
        const problem = validatePracticeProblem(await readValue(root, base + '/problem.json', 1024 * KiB), id)
        const extensions = { c: 'c', cpp: 'cpp', java: 'java', python: 'py', javascript: 'js' }
        for (const attempt of problem.attempts) {
          const source = base + '/attempt-' + attempt.id + (problem.language === 'java' ? '/Main.java' : '.' + extensions[problem.language])
          await add(category, source, 2 * 1024 * KiB, true)
          new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(root, source, 2 * 1024 * KiB))
          const submissions = base + '/attempt-' + attempt.id + '.submissions.json'
          await add(category, submissions, 64 * KiB)
          if (await exists(join(root, submissions))) validatePracticeSubmissions(await readValue(root, submissions, 64 * KiB))
          const report = base + '/attempt-' + attempt.id + '.report.json'
          await add(category, report, 1024 * KiB)
          if (await exists(join(root, report))) {
            const parsed = validatePracticeReport(await readValue(root, report, 1024 * KiB))
            if (parsed.results.some(r => !problem.samples.some(s => s.id === r.id))) throw new Error('Practice results refer to missing samples.')
          }
        }
      }
    }
  }
  // A session must not claim to recover a missing draft when recovery is included.
  if (categories.includes('session') && categories.includes('recovery') && await exists(join(root, 'editor-session.json'))) {
    const data = validateEditorSnapshot(await readValue(root, 'editor-session.json', 1024 * KiB), inertPath)
    for (const tab of data.tabs) if (tab.draftId && !result.some(f => f.name === 'recovery/' + tab.draftId + '.draft')) throw new Error('Editor session references a missing recovery draft.')
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

const excludedDirectories = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'env', '__pycache__', '.cache', '.next', '.gradle', '.idea', 'build', 'dist', 'out', 'target', 'bin', 'obj', 'coverage'])
const secret = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
export function workspaceExclusion(name: string, isDirectory: boolean): string | undefined {
  if (isDirectory && excludedDirectories.has(name.toLowerCase())) return 'Dependency, build, cache or repository directory'
  if (secret.test(name)) return 'Credential or environment-secret filename'
  return undefined
}
export async function workspaceFiles(root: string, exclude: (name: string, reason: string) => void, signal?: AbortSignal, forbidden: string[] = []) {
  await directory(root); const files: Array<{ name: string; bytes: number; sha256: string }> = []; let visits = 0
  async function walk(folder: string, prefix: string, depth: number) {
    if (depth > limits.depth) throw new Error('Workspace exceeds the 32-level depth limit.')
    for await (const entry of await opendir(folder)) {
      aborted(signal); if (++visits > limits.visits) throw new Error('Workspace exceeds the inspection limit. Choose a smaller folder.')
      const name = prefix + entry.name
      let reason = forbidden.some(path => within(path, join(root, name))) ? 'Active Ion profile and private staging' : workspaceExclusion(entry.name, entry.isDirectory())
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) reason = 'Filesystem link or special file'
      try { portablePath(name) } catch { reason = 'Non-portable filename' }
      if (reason) { exclude(name, reason); continue }
      if (entry.isDirectory()) { await directory(join(root, name)); await walk(join(root, name), name + '/', depth + 1) }
      else {
        const path = await checkedPath(root, name)
        const { lstat } = await import('node:fs/promises')
        const info = await lstat(path)
        if (info.nlink !== 1) { exclude(name, 'Filesystem hard link'); continue }
        if (info.size > limits.fileBytes) { exclude(name, 'Larger than the 128 MiB payload limit'); continue }
        const item = await fingerprint(root, name, limits.fileBytes, signal)
        files.push({ name, bytes: item.bytes, sha256: item.sha256 })
        if (files.length > limits.files) throw new Error('Too many working files.')
      }
    }
  }
  await walk(root, '', 0)
  return files.sort((a, b) => a.name.localeCompare(b.name))
}
