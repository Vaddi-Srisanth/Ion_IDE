import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExplanationCitation, ExplanationOpenResult, ExplanationRequest, ReviewedSource } from '../../shared/explanations'
import type { PackLesson } from '../../shared/learning-packs'
import type { ProjectLensOpenResult, ProjectLensReference, ProjectLensSnapshot } from '../../shared/project-lens'
import { isWithin, revision, type WorkspaceFiles } from '../files'
import { isId, isLesson, isTopicId } from '../learning/pack-format'
import type { ExplanationContext } from './session'

export type ExplanationContextRequest = ExplanationRequest
export interface ExplanationContextOptions {
  scope(): WorkspaceFiles
  isCurrent(): boolean
  lesson(packId: string, lessonId: string): Promise<PackLesson>
  lens(root: string): Promise<{
    snapshot: ProjectLensSnapshot
    validate(): Promise<void>
    openReference(reference: ProjectLensReference): Promise<ProjectLensOpenResult>
  }>
}

const unsafe = 'The selected explanation context is unavailable, unsafe to share, or changed. Review the selection again. No context was sent.'
const invalid = (): never => { throw new Error(unsafe) }
const bytes = (text: string) => Buffer.byteLength(text)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const tutorActions = ['hint', 'concept', 'debug', 'walkthrough', 'review-attempt', 'quiz', 'complexity', 'explain-file', 'explain-selection', 'find-bug', 'design-tests', 'edit-code']
const projectActions = ['understand', 'architecture', 'health', 'teach-project', 'next-steps', 'ask-codebase']
const excludedDirectories = /^(?:node_modules|vendors?|target|dist|build|out|coverage|generated|gen|bin|obj|__pycache__|venv|env|pods|carthage|secrets?|credentials?|private[-_]?keys?)$/i
const secretName = /(?:^\.|(?:^|[._-])(?:secrets?|credentials?|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$|(?:lock$)|^go\.sum$)/i
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'])
const textExtensions = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.java', '.py', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.less', '.json', '.md', '.markdown', '.txt', '.sql', '.rs', '.go',
  '.swift', '.kt', '.kts', '.rb', '.php', '.sh', '.bash', '.zsh', '.xml', '.toml', '.yaml', '.yml', '.gradle', '.r', '.cs'])
const obviousSecret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|credentials?)\s*[=:]\s*["'][^"'\r\n]{4,}["']/i

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || bytes(value) > limit
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF]/u.test(value) || obviousSecret.test(value)) invalid()
  return value as string
}
function prefix(value: string, limit: number): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value).subarray(0, limit), { stream: true })
}
function reference(value: unknown): ProjectLensReference {
  const data = object(value, ['path', 'revision'], ['range'])
  const path = text(data.path, 1024), token = text(data.revision, 256)
  if (path.includes('\\') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')
    || /[\r\n]/.test(path) || /^[A-Za-z]:/.test(path)) invalid()
  let range: ProjectLensReference['range']
  if (data.range !== undefined) {
    const row = object(data.range, ['startLine', 'startColumn', 'endLine', 'endColumn'])
    if (Object.values(row).some(value => !Number.isSafeInteger(value) || (value as number) < 1)
      || (row.endLine as number) < (row.startLine as number)
      || row.endLine === row.startLine && (row.endColumn as number) < (row.startColumn as number)) invalid()
    range = row as unknown as NonNullable<ProjectLensReference['range']>
  }
  return { path, revision: token, ...(range ? { range: { ...range } } : {}) }
}
function referenceKey(value: ProjectLensReference) {
  const range = value.range
  return JSON.stringify([value.path, value.revision,
    range ? [range.startLine, range.startColumn, range.endLine, range.endColumn] : null])
}
function parse(value: unknown): ExplanationContextRequest {
  const data = object(value, ['purpose', 'action', 'question'], ['lesson', 'code', 'diagnostic', 'project', 'stream'])
  if (data.purpose === 'ask') {
    if (data.action !== 'ask-question' || data.lesson !== undefined || data.diagnostic !== undefined || data.project !== undefined) invalid()
  } else if (data.purpose !== 'tutor' && data.purpose !== 'project-lens'
    || !(data.purpose === 'tutor' ? tutorActions : projectActions).includes(data.action as string)) invalid()
  const result = { purpose: data.purpose, action: data.action, question: text(data.question, 2048, data.purpose !== 'ask') } as ExplanationContextRequest
  if (data.stream !== undefined) {
    if (typeof data.stream !== 'boolean') invalid()
    result.stream = data.stream as boolean
  }
  if (data.lesson !== undefined) {
    const selected = object(data.lesson, ['packId', 'lessonId'])
    if (!isId(selected.packId) || !isTopicId(selected.lessonId)) invalid()
    result.lesson = { packId: selected.packId as string, lessonId: selected.lessonId as string }
  }
  if (data.code !== undefined) {
    const code = object(data.code, ['label', 'text', 'version'], ['path'])
    const label = text(code.label, 256), content = text(code.text, 8192, true)
    if (/[\r\n]/.test(label) || /^(?:[/\\]|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(label)
      || !Number.isSafeInteger(code.version) || (code.version as number) < 0) invalid()
    const path = code.path === undefined ? undefined : text(code.path, 4096)
    if (path !== undefined && (!isAbsolute(path) || resolve(path) !== path || /[\r\n]/.test(path))) invalid()
    result.code = { label, text: content, version: code.version as number, ...(path ? { path } : {}) }
  }
  if (['complexity', 'explain-file', 'find-bug', 'design-tests'].includes(result.action)
    && (!result.code || !result.code.text.trim())) invalid()
  if (result.action === 'edit-code' && (!result.code || !result.code.text.trim())) invalid()
  if (data.diagnostic !== undefined) result.diagnostic = text(data.diagnostic, 2048)
  if (data.project !== undefined) {
    const project = object(data.project, ['root', 'refs'])
    if (typeof project.root !== 'string' || !Array.isArray(project.refs) || project.refs.length > 4) invalid()
    const refs = (project.refs as unknown[]).map(reference)
    if (new Set(refs.map(referenceKey)).size !== refs.length) invalid()
    result.project = { root: project.root as string, refs }
  }
  return result
}
function eligible(root: string | null, path: string) {
  if (root && (basename(root).startsWith('.') || excludedDirectories.test(basename(root)))) invalid()
  const parts = (root ? relative(root, path) : path).split(sep).filter(Boolean)
  if (parts.some(part => part.startsWith('.') || excludedDirectories.test(part)) || secretName.test(basename(path))
    || lockfiles.has(basename(path)) || /(?:^|[._-])(?:generated|min)(?:[._-]|$)/i.test(basename(path))) invalid()
  if (!textExtensions.has(extname(path).toLowerCase()) && !['Makefile', 'CMakeLists.txt'].includes(basename(path))) invalid()
}

function structureExcerpt(snapshot: ProjectLensSnapshot): string {
  // Metadata comes exclusively from the private Lens lease. Paths are retained
  // whole or omitted; clipping one could invent a different filename.
  const path = (value: string) => typeof value === 'string' && bytes(value) <= 1024
    && !/[\\\x00-\x1f\x7f]/.test(value) && !isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..') ? value : undefined
  const summary = {
    status: snapshot.status, counts: snapshot.counts,
    languages: snapshot.languages.slice(0, 12),
    frameworks: snapshot.frameworks.slice(0, 12).map(item => ({ name: item.name, confidence: item.confidence })),
    manifests: [] as Array<{ path: string; kind: string; status: string }>,
    entryPoints: [] as Array<{ path: string; kind: string; declaredOrObservedAt: string }>,
    files: [] as Array<{ path: string; language: string; bytes: number }>,
    tests: [] as string[], documentation: [] as string[],
    omittedItems: { languages: Math.max(0, snapshot.languages.length - 12), frameworks: Math.max(0, snapshot.frameworks.length - 12),
      manifests: snapshot.manifests.length, entryPoints: snapshot.entryPoints.length, files: snapshot.files.length,
      tests: snapshot.tests.length, documentation: snapshot.documentation.length },
    limitations: ['Point-in-time metadata from the explicitly reviewed, bounded offline snapshot; not a complete project tree.',
      'Entry candidates and manifest declarations do not prove working functionality, security, passing tests, or mastery.',
      'Source and document contents, manifest scripts and dependency lists are omitted here. Only separately selected source excerpts are included.',
      'Item counts below report omissions from this excerpt. Snapshot traversal limits and exclusions can omit additional files.'],
    snapshotTruncated: snapshot.truncated.slice(0, 12), snapshotExclusions: snapshot.exclusions,
  }
  const fit = () => bytes(JSON.stringify(summary, null, 2)) <= 8192
  if (!fit()) invalid()
  function include<T>(key: keyof Pick<typeof summary, 'manifests' | 'entryPoints' | 'files' | 'tests' | 'documentation'>,
    target: T[], input: readonly unknown[], max: number, item: (value: unknown) => T | undefined) {
    for (let index = 0; index < Math.min(input.length, max); index++) {
      const candidate = item(input[index])
      if (candidate === undefined) continue
      target.push(candidate)
      summary.omittedItems[key]--
      if (!fit()) { target.pop(); summary.omittedItems[key]++ }
    }
  }
  include('manifests', summary.manifests, snapshot.manifests, 8, value => {
    const item = value as ProjectLensSnapshot['manifests'][number], selected = path(item.reference.path)
    return selected ? { path: selected, kind: item.kind, status: item.status } : undefined
  })
  include('entryPoints', summary.entryPoints, snapshot.entryPoints, 12, value => {
    const item = value as ProjectLensSnapshot['entryPoints'][number], selected = path(item.path), declared = path(item.reference.path)
    return selected && declared ? { path: selected, kind: item.kind, declaredOrObservedAt: declared } : undefined
  })
  include('tests', summary.tests, snapshot.tests, 12, value => path((value as ProjectLensReference).path))
  include('documentation', summary.documentation, snapshot.documentation, 8, value => path((value as ProjectLensReference).path))
  include('files', summary.files, snapshot.files, 24, value => {
    const item = value as ProjectLensSnapshot['files'][number], selected = path(item.reference.path)
    return selected ? { path: selected, language: item.language, bytes: item.bytes } : undefined
  })
  return JSON.stringify(summary, null, 2)
}

/** Assemble only explicitly selected evidence. No grants, full-file reads, execution or provider calls. */
export async function prepareContext(request: unknown, signal: AbortSignal, options: ExplanationContextOptions): Promise<ExplanationContext> {
  try { return await prepare(parse(request), signal, options) } catch { return invalid() }
}

async function prepare(request: ExplanationContextRequest, signal: AbortSignal, options: ExplanationContextOptions): Promise<ExplanationContext> {
  const scope = options.scope(), root = scope.rootPath
  const check = () => {
    if (signal.aborted || !options.isCurrent() || options.scope() !== scope || scope.rootPath !== root) invalid()
  }
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value }
  check()
  const rootAnchor = root ? await checked(() => scope.inspect(root, 'folder')) : undefined
  const exclusions = ['Only explicitly selected excerpts are included; other files are not read.',
    'Obvious secret and generated-file checks are best effort, not a guarantee that every secret is detected. Review the complete request.']
  if (request.purpose === 'project-lens' && !request.project) {
    exclusions.push('No project structure was selected. Project behavior, architecture and health remain unknown without supplied evidence.')
  }
  const sources: ReviewedSource[] = []
  type Bound = { source: ReviewedSource; path?: string; reference?: ProjectLensReference; lesson?: { packId: string; lessonId: string } }
  const bound = new Map<string, Bound>()
  const saved = new Map<string, string>()
  let total = 0
  function add(origin: ReviewedSource['origin'], label: string, value: string, token: string, binding: Omit<Bound, 'source'> = {}) {
    const content = text(value, 8192, true)
    total += bytes(content)
    if (sources.length >= 8 || total > 32768) invalid()
    const source: ReviewedSource = { id: 'source-' + randomUUID(), label: text(label, 256), origin, revision: token,
      startLine: 1, endLine: content.split(/\r\n|\r|\n/).length, text: content }
    Object.freeze(source)
    sources.push(source); bound.set(source.id, { source, ...binding })
  }
  async function verifyRoot() {
    check()
    if (root && rootAnchor) {
      const current = await checked(() => scope.inspect(root, 'folder'))
      if (!identity(current.stats, rootAnchor.stats)) invalid()
    }
  }
  async function inspectSource(path: string) {
    eligible(root, path)
    if (root && !isWithin(root, path)) invalid()
    const inspected = await checked(() => scope.inspect(path, 'file'))
    if (inspected.path !== path || !inspected.stats.isFile() || inspected.stats.size > 2n * 1024n * 1024n) invalid()
    return inspected
  }
  type Anchor = { path: string; stats: BigIntStats }
  async function chain(path: string): Promise<Anchor[]> {
    const anchors: Anchor[] = []
    let directory = dirname(path)
    for (;;) {
      if (anchors.length >= 64) invalid()
      const inspected = await checked(() => scope.inspect(directory, 'folder'))
      anchors.push(inspected)
      if (directory === root || !root) break
      const parent = dirname(directory)
      if (parent === directory || !isWithin(root, parent)) invalid()
      directory = parent
    }
    return anchors
  }
  async function verifyChain(anchors: Anchor[]) {
    for (const anchor of anchors) {
      const current = await checked(() => scope.inspect(anchor.path, 'folder'))
      if (!identity(current.stats, anchor.stats)) invalid()
    }
    await verifyRoot()
  }
  async function sourcePrefix(path: string, expected: string) {
    await verifyRoot()
    const inspected = await inspectSource(path)
    if (revision(inspected.stats) !== expected) invalid()
    const anchors = await chain(path)
    await verifyChain(anchors)
    check()
    // Ownership begins as soon as open resolves, even if cancellation arrived
    // during the system call. Never throw between acquiring and owning it.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      check()
      const before = await checked(() => handle.stat({ bigint: true }))
      if (!before.isFile() || revision(before) !== expected) invalid()
      await verifyChain(anchors)
      const buffer = Buffer.alloc(Number(before.size > 8192n ? 8192n : before.size))
      let offset = 0
      while (offset < buffer.length) {
        const part = await checked(() => handle.read(buffer, offset, buffer.length - offset, offset))
        if (!part.bytesRead) invalid()
        offset += part.bytesRead
      }
      const after = await inspectSource(path)
      const final = await checked(() => handle.stat({ bigint: true }))
      await verifyChain(anchors)
      if (revision(after.stats) !== expected || revision(final) !== expected) invalid()
      if (before.size > 8192n) exclusions.push('A selected file is limited to its first 8 KiB; later contents and any incomplete trailing UTF-8 character are omitted.')
      return text(new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: before.size > 8192n }), 8192, true)
    } finally { await handle.close() }
  }

  let lessonIdentity: { packId: string; lessonId: string; hash: string } | undefined
  if (request.lesson) {
    const selected = request.lesson
    const lesson = await checked(() => options.lesson(selected.packId, selected.lessonId))
    if (!isLesson(lesson) || lesson.id !== selected.lessonId) invalid()
    lessonIdentity = { ...selected, hash: digest(JSON.stringify(lesson)) }
    const content = [lesson.title, lesson.objective, lesson.explanation, 'Example', lesson.example, 'Practice', lesson.practice].filter(Boolean).join('\n\n')
    if (bytes(content) > 8192) exclusions.push('The selected lesson is limited to an 8 KiB excerpt; later lesson material is omitted.')
    add('lesson', prefix('Lesson: ' + lesson.title, 256), prefix(content, 8192), lessonIdentity.hash, { lesson: selected })
  }
  if (request.code) {
    const code = request.code
    if (code.path) {
      await verifyRoot()
      const inspected = await inspectSource(code.path)
      saved.set(code.path, revision(inspected.stats))
    }
    exclusions.push('Editor-buffer text and its version are renderer-provided, unverified context; they do not prove saved content or test results.')
    add('editor-buffer', code.label, code.text, 'provided-version-' + code.version + '-' + digest(code.text))
  }
  if (request.diagnostic) {
    exclusions.push('The selected diagnostic is provided context, not independent proof that a compiler or test ran.')
    add('diagnostic', 'Provided diagnostic', request.diagnostic, digest(request.diagnostic))
  }

  let lease: Awaited<ReturnType<ExplanationContextOptions['lens']>> | undefined
  if (request.project) {
    const project = request.project
    if (!root || project.root !== root) invalid()
    lease = await checked(() => options.lens(project.root))
    await checked(() => lease!.validate())
    const snapshot = lease.snapshot
    if (snapshot.root !== root || !['complete', 'partial'].includes(snapshot.status)) invalid()
    const membership = [...snapshot.files.map(item => item.reference), ...snapshot.manifests.map(item => item.reference),
      ...snapshot.frameworks.map(item => item.reference), ...snapshot.entryPoints.map(item => item.reference), ...snapshot.documentation, ...snapshot.tests]
    const structure = structureExcerpt(snapshot)
    add('structure', 'Reviewed project structure', structure, digest(structure))
    for (const selected of project.refs) {
      const match = membership.find(item => referenceKey(item) === referenceKey(selected))
      if (!match) invalid()
      const selectedReference = structuredClone(match!)
      const path = join(project.root, selectedReference.path)
      const selectedText = await sourcePrefix(path, selectedReference.revision)
      saved.set(path, selectedReference.revision)
      add('saved-file', prefix(selectedReference.path, 256), selectedText, selectedReference.revision, { path, reference: selectedReference })
    }
    exclusions.push('Source contents are limited to selected prefixes. Unselected files, excluded paths and remaining file contents are not inspected for secrets.')
  }

  const validate = async () => {
    try {
      await verifyRoot()
      if (lease) await checked(() => lease!.validate())
      for (const [path, token] of saved) {
        if (revision((await inspectSource(path)).stats) !== token) invalid()
      }
      if (lessonIdentity) {
        const next = await checked(() => options.lesson(lessonIdentity!.packId, lessonIdentity!.lessonId))
        if (!isLesson(next) || digest(JSON.stringify(next)) !== lessonIdentity.hash) invalid()
      }
      await verifyRoot()
    } catch { invalid() }
  }
  const openCitation = async (citation: ExplanationCitation): Promise<ExplanationOpenResult> => {
    try {
      const data = object(citation, ['sourceId', 'startLine', 'endLine'])
      const selected = typeof data.sourceId === 'string' ? bound.get(data.sourceId) : undefined
      if (!selected || !Number.isSafeInteger(data.startLine) || !Number.isSafeInteger(data.endLine)
        || (data.startLine as number) < selected.source.startLine || (data.endLine as number) > selected.source.endLine
        || (data.endLine as number) < (data.startLine as number)) invalid()
      await validate()
      const startLine = data.startLine as number, endLine = data.endLine as number
      if (selected!.path && selected!.reference && lease) {
        const opened = await checked(() => lease!.openReference(selected!.reference!))
        if (opened.entry.path !== selected!.path || opened.entry.kind !== 'file') invalid()
        await validate()
        return { entry: { ...opened.entry }, range: { startLine, startColumn: 1, endLine,
          endColumn: selected!.source.text.split(/\r\n|\r|\n/)[endLine - 1].length + 1 } }
      }
      if (selected!.lesson) return { lesson: { ...selected!.lesson }, label: selected!.source.label }
      return { label: selected!.source.label, text: selected!.source.text.split(/\r\n|\r|\n/).slice(startLine - 1, endLine).join('\n') }
    } catch { return invalid() }
  }
  await validate()
  Object.freeze(sources)
  return { stream: request.stream === true, input: Object.freeze({ purpose: request.purpose, action: request.action, question: request.question, sources }), exclusions, validate, openCitation }
}
