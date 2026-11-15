import { basename, join } from 'node:path'
import type { ProjectLensOpenResult, ProjectLensReference, ProjectLensSnapshot } from '../../shared/project-lens'
import { isWithin, revision, type WorkspaceFiles } from '../files'
import { analyzeProject } from './analyze'

function referenceKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Project Lens reference.')
  const candidate = value as Partial<ProjectLensReference>
  const keys = Object.keys(candidate)
  if (keys.some(key => !['path', 'revision', 'range'].includes(key)) || typeof candidate.path !== 'string'
    || !Object.hasOwn(candidate, 'path') || !Object.hasOwn(candidate, 'revision')
    || !candidate.path || Buffer.byteLength(candidate.path) > 1024 || candidate.path.includes('\\')
    || candidate.path.split('/').some(part => !part || part === '.' || part === '..')
    || typeof candidate.revision !== 'string' || candidate.revision.length > 256 || !candidate.revision) {
    throw new Error('Invalid Project Lens reference.')
  }
  const range = candidate.range
  if (range !== undefined) {
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || Object.keys(range).length !== 4 || Object.keys(range).some(key => !['startLine', 'startColumn', 'endLine', 'endColumn'].includes(key))
      || ![range.startLine, range.startColumn, range.endLine, range.endColumn].every(value => Number.isSafeInteger(value) && value > 0)
      || range.endLine < range.startLine || range.endLine === range.startLine && range.endColumn < range.startColumn) {
      throw new Error('Invalid Project Lens source range.')
    }
  }
  return JSON.stringify([candidate.path, candidate.revision, range ? [range.startLine, range.startColumn, range.endLine, range.endColumn] : null])
}

function references(snapshot: ProjectLensSnapshot): ProjectLensReference[] {
  return [...snapshot.files.map(file => file.reference), ...snapshot.manifests.map(manifest => manifest.reference),
    ...snapshot.frameworks.map(framework => framework.reference), ...snapshot.entryPoints.map(entry => entry.reference),
    ...snapshot.documentation, ...snapshot.tests]
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

/** One on-demand request/snapshot. The owning workspace must call close on lease release. */
export class ProjectLensSession {
  private generation = 0
  private controller?: AbortController
  private snapshot?: { scope: WorkspaceFiles; value: ProjectLensSnapshot; rootDevice: bigint; rootInode: bigint }

  constructor(private readonly currentScope: () => WorkspaceFiles) {}

  cancel(): void {
    this.generation++
    this.controller?.abort()
    // Keep ownership until analyze's finally runs: abort cannot interrupt an
    // already pending OS filesystem call or its required resource closure.
    this.snapshot = undefined
  }

  close(): void { this.cancel() }

  /** Main-only evidence lease. This neither analyzes again nor grants paths. */
  lease(root: string): {
    snapshot: ProjectLensSnapshot
    validate(): Promise<void>
    openReference(reference: ProjectLensReference): Promise<ProjectLensOpenResult>
  } {
    const selected = this.snapshot
    const generation = this.generation
    if (!selected || this.currentScope() !== selected.scope || selected.scope.rootPath !== root || selected.value.root !== root) {
      throw new Error('Analyze the current folder again before reviewing its explanation context.')
    }
    const current = () => this.snapshot === selected && this.generation === generation
      && this.currentScope() === selected.scope && selected.scope.rootPath === root
    const validate = async () => {
      if (!current()) throw new Error('The Project Lens evidence lease changed.')
      const before = await selected.scope.inspect(root, 'folder')
      if (!current() || before.stats.dev !== selected.rootDevice || before.stats.ino !== selected.rootInode) {
        throw new Error('The Project Lens folder changed.')
      }
      // Manifest content and inspected file metadata are the evidence sent to
      // the provider; validate their saved revisions without reading sources.
      const unique = new Map(references(selected.value).map(reference => [reference.path, reference]))
      for (const reference of unique.values()) {
        if (!current()) throw new Error('The Project Lens evidence lease changed.')
        const file = await selected.scope.inspect(join(root, reference.path), 'file')
        if (!current() || revision(file.stats) !== reference.revision) throw new Error('The Project Lens evidence changed on disk.')
      }
      const after = await selected.scope.inspect(root, 'folder')
      if (!current() || after.stats.dev !== selected.rootDevice || after.stats.ino !== selected.rootInode) {
        throw new Error('The Project Lens folder changed.')
      }
    }
    return Object.freeze({ snapshot: selected.value, validate,
      openReference: async (reference: ProjectLensReference) => {
        await validate()
        if (!current()) throw new Error('The Project Lens evidence lease changed.')
        const result = await this.openReference(root, reference)
        if (!current()) throw new Error('The Project Lens evidence lease changed.')
        return result
      },
    })
  }

  async analyze(root: string): Promise<ProjectLensSnapshot> {
    const scope = this.currentScope()
    if (typeof root !== 'string' || !root || scope.rootPath !== root) throw new Error('Analyze the exact currently open folder.')
    if (this.controller) {
      this.cancel()
      throw new Error('Previous Project Lens analysis is still stopping. Try Analyze again once it finishes.')
    }
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    try {
      const anchor = await scope.inspect(root, 'folder')
      const value = await analyzeProject(scope, root, { signal: controller.signal })
      const validScope = this.currentScope() === scope && scope.rootPath === root
      if (generation !== this.generation || controller.signal.aborted || !validScope) {
        return { ...value, status: validScope ? 'cancelled' : 'invalidated' }
      }
      const current = await scope.inspect(root, 'folder')
      if (this.currentScope() !== scope || scope.rootPath !== root || current.stats.dev !== anchor.stats.dev
        || current.stats.ino !== anchor.stats.ino) return { ...value, status: 'invalidated' }
      if (generation !== this.generation || controller.signal.aborted) return { ...value, status: 'cancelled' }
      if (value.status === 'complete' || value.status === 'partial') {
        this.snapshot = { scope, value: freezeSnapshot(value), rootDevice: anchor.stats.dev, rootInode: anchor.stats.ino }
      }
      return value
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }

  async openReference(root: string, requested: unknown): Promise<ProjectLensOpenResult> {
    // Canonicalize the supplied data before awaiting anything; renderer mutation
    // cannot change which reference is checked or returned later.
    const key = referenceKey(requested)
    const selected = this.snapshot
    if (!selected || this.currentScope() !== selected.scope || selected.scope.rootPath !== root || selected.value.root !== root) {
      throw new Error('Analyze the current folder again before opening evidence.')
    }
    const reference = references(selected.value).find(candidate => referenceKey(candidate) === key)
    if (!reference) throw new Error('This reference is not part of the last Project Lens snapshot.')
    const path = join(root, reference.path)
    if (!isWithin(root, path)) throw new Error('Project Lens reference is outside its folder.')
    const current = () => this.snapshot === selected && this.currentScope() === selected.scope && selected.scope.rootPath === root
    if (!current()) throw new Error('The workspace changed before opening Project Lens evidence.')
    const beforeRoot = await selected.scope.inspect(root, 'folder')
    if (!current()) throw new Error('The workspace changed before opening Project Lens evidence.')
    if (beforeRoot.stats.dev !== selected.rootDevice || beforeRoot.stats.ino !== selected.rootInode) {
      throw new Error('The folder changed. Analyze it again before opening Project Lens evidence.')
    }
    const inspected = await selected.scope.inspect(path, 'file')
    if (!current()) throw new Error('The workspace changed before opening Project Lens evidence.')
    if (revision(inspected.stats) !== reference.revision) throw new Error('This evidence changed on disk. Analyze the folder again.')
    const afterRoot = await selected.scope.inspect(root, 'folder')
    if (!current()) throw new Error('The workspace changed before opening Project Lens evidence.')
    if (afterRoot.stats.dev !== selected.rootDevice || afterRoot.stats.ino !== selected.rootInode) {
      throw new Error('The folder changed. Analyze it again before opening Project Lens evidence.')
    }
    return { entry: { path: inspected.path, name: basename(inspected.path), kind: 'file' },
      ...(reference.range ? { range: { ...reference.range } } : {}) }
  }
}
