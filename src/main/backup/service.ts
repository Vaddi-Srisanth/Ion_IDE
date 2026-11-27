import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { backupCategories, type BackupCategory, type BackupFolder, type BackupProgress, type BackupReview, type BackupScope, type RestoreChoices } from '../../shared/backup'
import { limits, parseScope, type BackupManifest } from './format'
import { readArchive, writeArchive } from './archive'
import { aborted, clean, copyChecked, directory, exists, within, readValue } from './safe-fs'
import { workspaceExclusion } from './profile'
import { snapshot, validatePayload, verifySnapshot, type FolderSource, type Snapshot } from './snapshot'
import { importLegacy, prepareProfile, validateChoices } from './restore'
import { armTransaction, stageTransaction, treeHash } from './transaction'
import { maxTestRecordBytes, validateStoredTests } from '../test-explorer/model'
import { validateSavedProject } from '../projects/repository'

const expiryMs = 10 * 60 * 1000
interface ReviewState { token: string; expiresAt: number; stage: string; manifest: BackupManifest; kind: 'backup' | 'restore'; legacy: boolean
  snapshot?: Snapshot; folders: FolderSource[]; hashes: Partial<Record<BackupCategory, string | null>> }
interface Prepared { token: string; state: ReviewState; choices: RestoreChoices; parent?: string; rollback: string }
export interface BackupOptions { profile: string; appVersion: string; progress?: (value: BackupProgress) => void }
export class BackupService {
  private readonly folders = new Map<string, { root: string; name: string }>()
  private state?: ReviewState
  private prepared?: Prepared
  private controller?: AbortController
  private active?: Promise<unknown>
  private armed = false
  constructor(private readonly options: BackupOptions) {}
  get busy() { return Boolean(this.active) }
  get restartRequired() { return this.armed }
  private progressAt = 0
  private progressPhase = ''
  async addFolder(path: string): Promise<BackupFolder> {
    const root = await realpath(path); await directory(root)
    if (within(this.options.profile, root)) throw new Error('The active profile cannot be selected as a working folder.')
    const previous = [...this.folders].find(([, f]) => f.root === root)
    if (previous) return { id: previous[0], name: previous[1].name, mode: 'reference' }
    if (this.folders.size >= limits.folders) throw new Error('Up to 16 folders can be reviewed per window.')
    const id = randomUUID(), name = basename(root) || root
    this.folders.set(id, { root, name }); return { id, name, mode: 'reference' }
  }
  listFolders(): BackupFolder[] { return [...this.folders].map(([id, f]) => ({ id, name: f.name, mode: 'reference' })) }
  private run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) return Promise.reject(new Error('A backup operation is already running. Cancel it or wait for it to finish.'))
    const controller = new AbortController(); this.controller = controller
    const task = Promise.resolve().then(() => job(controller.signal))
    this.active = task
    return task.finally(() => { if (this.active === task) { this.active = undefined; this.controller = undefined } })
  }
  private progress(value: BackupProgress) {
    const now = performance.now()
    if (value.phase !== this.progressPhase || now - this.progressAt >= 50) {
      this.progressAt = now; this.progressPhase = value.phase; this.options.progress?.(value)
    }
  }
  private async stage() {
    const root = await realpath(this.options.profile); await directory(root)
    return mkdtemp(join(root, '.ion-backup-stage-'))
  }
  async cancel() {
    if (this.armed) return
    this.controller?.abort(); await this.active?.catch(() => {})
    const state = this.state; this.state = undefined; this.prepared = undefined
    if (state) await clean(state.stage)
  }
  private require(token: unknown, kind?: 'backup' | 'restore') {
    if (!this.state || typeof token !== 'string' || token !== this.state.token || Date.now() > this.state.expiresAt || (kind && kind !== this.state.kind)) throw new Error('This review expired. Review the data again.')
    return this.state
  }
  async review(value: BackupScope): Promise<BackupReview> {
    await this.cancel()
    return this.run(async signal => {
      const scope = parseScope(value)
      const folders = scope.folders.filter(f => f.mode !== 'exclude').map(f => {
        const source = this.folders.get(f.id)
        if (!source) throw new Error('Choose the working folder again.')
        return { id: f.id, name: source.name, mode: f.mode as 'reference' | 'copy', originalPath: source.root, root: source.root }
      })
      const stage = await this.stage()
      try {
        await mkdir(join(stage, 'profile'), { mode: 0o700 })
        const value = await snapshot(this.options.profile, stage, scope.categories, folders, this.options.appVersion, p => this.progress(p), signal)
        this.state = { token: randomUUID(), expiresAt: Date.now() + expiryMs, stage, manifest: value.manifest, kind: 'backup', legacy: false, snapshot: value, folders, hashes: {} }
        return await this.metadata(this.state)
      } catch (error) { await clean(stage); throw new Error('Backup review failed: ' + (error instanceof Error ? error.message : String(error)), { cause: error }) }
    })
  }
  create(token: string, destination: string): Promise<string> {
    return this.run(async signal => {
      const state = this.require(token, 'backup')
      await verifySnapshot(this.options.profile, state.snapshot!, state.folders, signal)
      this.progress({ phase: 'writing', files: state.manifest.entries.length, bytes: 0 })
      await writeArchive(state.stage, state.manifest, destination, signal, () => verifySnapshot(this.options.profile, state.snapshot!, state.folders, signal))
      this.progress({ phase: 'finished', files: state.manifest.entries.length, bytes: state.manifest.entries.reduce((n, e) => n + e.bytes, 0) })
      await clean(state.stage); this.state = undefined
      return destination
    })
  }
  async openRestore(source: string, legacy = false): Promise<BackupReview> {
    await this.cancel()
    return this.run(async signal => {
      const stage = await this.stage()
      try {
        this.progress({ phase: 'validating', files: 0, bytes: 0 })
        const manifest = legacy ? await importLegacy(await directory(await realpath(source)), stage, this.options.appVersion, signal) : await readArchive(source, stage, signal)
        for (const entry of manifest.entries.filter(e => e.folder)) {
          const parts = entry.path.split('/').slice(2)
          if (parts.some((p, i) => workspaceExclusion(p, i < parts.length - 1))) throw new Error('Backup working files include an excluded secret or dependency path.')
        }
        await validatePayload(stage, manifest, signal)
        const hashes: ReviewState['hashes'] = {}
        for (const category of manifest.categories) hashes[category] = await treeHash(this.options.profile, categoryRoot(category))
        this.state = { token: randomUUID(), expiresAt: Date.now() + expiryMs, stage, manifest, kind: 'restore', legacy, folders: [], hashes }
        return await this.metadata(this.state)
      } catch (error) { await clean(stage); throw new Error('Backup review failed: ' + (error instanceof Error ? error.message : String(error)), { cause: error }) }
    })
  }
  private async metadata(state: ReviewState): Promise<BackupReview> {
    const { manifest } = state
    const profile = join(state.stage, 'profile')
    const projects: BackupReview['projects'] = []
    for (const p of manifest.projects) {
      const data = validateSavedProject(await readValue(profile, 'projects-v1/' + p.file, 512 * 1024))
      projects.push({ id: p.file, category: 'projects', title: data.spec.title, originalPath: p.originalPath })
    }
    if (state.kind === 'restore') {
      for (const e of manifest.entries.filter(entry => entry.category === 'tests')) {
        const id = e.path.slice('profile/'.length)
        const { snapshot } = validateStoredTests(await readValue(profile, id, maxTestRecordBytes))
        projects.push({ id, category: 'tests', title: 'Test history · ' + snapshot.adapter, originalPath: snapshot.root })
      }
    }
    return { token: state.token, kind: state.kind, expiresAt: state.expiresAt, name: 'Ion data · ' + manifest.createdAt.slice(0, 10),
      files: manifest.entries.length, bytes: manifest.entries.reduce((n, f) => n + f.bytes, 0), legacy: state.legacy,
      categories: manifest.categories.map(id => { const files = manifest.entries.filter(e => e.category === id); return {
        id, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), present: files.length > 0, conflict: state.hashes[id] !== undefined && state.hashes[id] !== null,
      } }), folders: manifest.folders.map(({ id, name, mode }) => ({ id, name, mode })), exclusions: manifest.exclusions, exclusionsOmitted: manifest.exclusionsOmitted,
      entries: manifest.entries.map(({ path, bytes }) => ({ path, bytes })),
      projects,
      warnings: ['Unencrypted: code, notes and drafts can contain sensitive text. Secret detection cannot guarantee otherwise.',
        'SHA-256 checksums verify integrity, not who created this backup.',
        ...(state.legacy ? ['Legacy export: original checksums were not recorded; integrity is checked only from this review onward.'] : []),
        ...(state.kind === 'restore' ? ['Current categories are kept unless selected. Current drafts are preserved; imported drafts are detached copies.',
          'Restored test outcomes are historical and stale. Commands need fresh approval. Imported locations grant no access.',
          'Unmapped roadmaps and inert file references stay local. Use this backup again to explicitly relink roadmaps.'] : [])] }
  }
  private async unchanged(state: ReviewState, categories: BackupCategory[]) {
    for (const category of categories) if (await treeHash(this.options.profile, categoryRoot(category)) !== state.hashes[category]) throw new Error('Current data changed after review. Nothing was replaced; review again.')
  }
  prepareRestore(token: string, value: RestoreChoices, parent?: string): Promise<{ token: string; rollback: string }> {
    return this.run(async () => {
      const state = this.require(token, 'restore'), choices = validateChoices(value, state.manifest)
      if (choices.copyFolders.length && !parent) throw new Error('Choose a new destination parent for copied workspaces.')
      if (parent) { parent = await directory(await realpath(parent)); if (within(this.options.profile, parent)) throw new Error('Choose a workspace destination outside the profile.') }
      for (const mapping of choices.mappings) if (!this.folders.has(mapping.folderId) && !choices.copyFolders.includes(mapping.folderId)) throw new Error('Choose the project mapping folder again.')
      await this.unchanged(state, choices.replace)
      const rollback = join(this.options.profile, '.ion-backups', 'before-restore-' + randomUUID() + '.ionbackup')
      const prepared = { token: randomUUID(), state, choices, parent, rollback }; this.prepared = prepared
      return { token: prepared.token, rollback }
    })
  }
  assertPrepared(token: unknown) {
    if (!this.prepared || token !== this.prepared.token || Date.now() > this.prepared.state.expiresAt) throw new Error('Restore confirmation expired. Review again.')
  }
  // Invoke only after the normal close confirmation and ALL accepted writes drain.
  finalize(token: string): Promise<void> {
    return this.run(async signal => {
      this.assertPrepared(token); const p = this.prepared!, { state, choices } = p
      await this.unchanged(state, choices.replace)
      this.progress({ phase: 'preparing', files: 0, bytes: 0 })
      const mappings = new Map([...this.folders].map(([id, f]) => [id, f.root]))
      let workspaceDestination: string | undefined, transaction: Awaited<ReturnType<typeof stageTransaction>> | undefined
      try {
        if (choices.copyFolders.length) {
          workspaceDestination = await mkdtemp(join(p.parent!, 'Ion Restored Workspaces '))
          for (const id of choices.copyFolders) {
            const folder = state.manifest.folders.find(f => f.id === id)!, target = join(workspaceDestination, folder.id)
            await mkdir(target, { mode: 0o700 }); mappings.set(id, target)
            for (const entry of state.manifest.entries.filter(e => e.folder === id)) await copyChecked(state.stage, entry.path, join(target, entry.path.split('/').slice(2).join('/')), limits.fileBytes, signal)
          }
        }
        const next = join(state.stage, 'restore-profile')
        const categories = await prepareProfile(this.options.profile, state.stage, next, state.manifest, choices, mappings, signal)
        const rollbackStage = join(state.stage, 'rollback'); await mkdir(rollbackStage, { mode: 0o700 }); await mkdir(join(rollbackStage, 'profile'), { mode: 0o700 })
        const previous = await snapshot(this.options.profile, rollbackStage, [...backupCategories], [], this.options.appVersion, () => {}, signal)
        const backups = join(this.options.profile, '.ion-backups')
        if (!await exists(backups)) await mkdir(backups, { mode: 0o700 }); await directory(backups)
        await writeArchive(rollbackStage, previous.manifest, p.rollback, signal)
        const verification = join(state.stage, 'rollback-verified'); await mkdir(verification, { mode: 0o700 })
        await validatePayload(verification, await readArchive(p.rollback, verification, signal), signal)
        await this.unchanged(state, categories)
        transaction = await stageTransaction(this.options.profile, next, categories, p.rollback)
        if (transaction.journal.steps.some(step => step.before !== state.hashes[step.category])) throw new Error('Current data changed during restore staging. Review again.')
        aborted(signal)
        try { await armTransaction(this.options.profile, transaction.id); this.armed = true }
        catch (error) {
          if (await exists(join(this.options.profile, 'ion-pending-restore.json'))) this.armed = true
          throw error
        }
        await clean(state.stage).catch(() => { /* A published restore must restart even if temporary cleanup fails. */ }); this.state = undefined; this.prepared = undefined
      } catch (error) {
        if (transaction && !this.armed) await clean(transaction.folder)
        if (workspaceDestination && !this.armed) await clean(workspaceDestination)
        throw error
      }
    })
  }
}
import { categoryRoots } from './format'
function categoryRoot(category: BackupCategory) { return categoryRoots[category] }
