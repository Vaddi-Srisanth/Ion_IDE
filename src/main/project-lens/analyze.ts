import { constants, type BigIntStats } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileLanguage } from '../../shared/languages'
import { projectLensLimits, type ProjectLensExclusion, type ProjectLensLimits, type ProjectLensManifest,
  type ProjectLensReference, type ProjectLensSnapshot } from '../../shared/project-lens'
import { isWithin, revision, type WorkspaceFiles } from '../files'

const excludedDirectories = new Set(['node_modules', 'vendor', 'vendors', 'target', 'dist', 'build', 'out', 'coverage',
  'generated', 'gen', 'bin', 'obj', '__pycache__', 'venv', 'env', 'Pods', 'Carthage'])
const binaryExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.gz', '.tar', '.7z', '.rar', '.png', '.jpg',
  '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.class', '.jar', '.pyc', '.wasm', '.sqlite', '.db', '.ipynb'])
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'])
const manifestKinds: Record<string, string> = { 'package.json': 'npm', 'pyproject.toml': 'python', 'requirements.txt': 'python',
  'pom.xml': 'maven', 'build.gradle': 'gradle', 'build.gradle.kts': 'gradle', 'CMakeLists.txt': 'cmake',
  'Cargo.toml': 'cargo', 'go.mod': 'go', 'Makefile': 'make' }
const manifestFrameworks: Record<string, string> = { npm: 'Node.js ecosystem', python: 'Python project', maven: 'Maven',
  gradle: 'Gradle', cmake: 'CMake', cargo: 'Cargo / Rust', go: 'Go modules', make: 'Make' }
const dependencyFrameworks: Record<string, string> = { react: 'React', vite: 'Vite', next: 'Next.js', vue: 'Vue',
  svelte: 'Svelte', '@angular/core': 'Angular', express: 'Express', typescript: 'TypeScript' }
const secretName = /(?:^\.env(?:\.|$)|(?:^|[._-])(?:secrets?|credentials?|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$|^\.(?:npmrc|pypirc|netrc|yarnrc)$)/i
const secretDirectory = /^(?:secrets?|credentials?|private[-_]?keys?)$/i
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Best-effort redaction of obvious credentials, not a promise to detect every secret. */
export function redactProjectLensText(value: string): string {
  return value.replace(/\b(?:https?|ssh|git\+https?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b([\w.-]*(?:token|secret|password|passwd|api[_-]?key|auth)[\w.-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, '$1=[redacted]')
    .replace(/(--?(?:token|password|passwd|secret|api-key|authorization)\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, '$1[redacted]')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted key]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512)
}

class Stop extends Error {
  constructor(readonly status: 'partial' | 'cancelled' | 'invalidated', readonly reason: string) { super(reason) }
}

/** No execution, indexing, network access, source-file reads, grants or persistent cache. */
export async function analyzeProject(scope: WorkspaceFiles, requestedRoot: string, options: {
  signal?: AbortSignal; limits?: Partial<ProjectLensLimits>
} = {}): Promise<ProjectLensSnapshot> {
  if (!requestedRoot || requestedRoot !== scope.rootPath) throw new Error('Project Lens requires the exact currently open folder.')
  const limits = { ...projectLensLimits }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(projectLensLimits, key) || !Number.isSafeInteger(value) || value < (key === 'depth' ? 0 : key === 'resultBytes' ? 2048 : 1)
      || value > projectLensLimits[key as keyof ProjectLensLimits]) throw new Error('Invalid Project Lens limit.')
    limits[key as keyof ProjectLensLimits] = value
  }
  const started = performance.now()
  const result: ProjectLensSnapshot = { version: 1, root: requestedRoot, status: 'complete', durationMs: 0, limits,
    counts: { visitedEntries: 0, directoriesInspected: 0, regularFilesSeen: 0, filesInspected: 0, returnedFiles: 0, manifestBytesRead: 0 },
    languages: [], files: [], manifests: [], frameworks: [], entryPoints: [], documentation: [], tests: [], exclusions: {}, truncated: [],
    limitations: ['File counts and language totals cover inspected eligible files within the reported limits; exclusions are not traversed.',
      'Declarations, file presence and test-shaped paths do not prove working functionality or passing tests.',
      'Only allowlisted manifests are read; source and documentation contents are not read.',
      'Language labels use filename extensions. Known binary extensions are excluded; unread source-shaped files are not verified as text.',
      'Portable pre/post identity checks and no-follow file opens are not race-free descriptor-relative traversal. Concurrent ancestor replacement races remain unproven.',
      'The five-second deadline and cancellation are checked at async boundaries; an operating-system filesystem call cannot be forcibly interrupted.',
      'Obvious credential redaction is best effort; review before sharing this local snapshot.'] }
  const exclude = (reason: ProjectLensExclusion) => { result.exclusions[reason] = (result.exclusions[reason] ?? 0) + 1 }
  const truncate = (reason: string) => { if (!result.truncated.includes(reason)) result.truncated.push(reason); if (result.status === 'complete') result.status = 'partial' }
  const check = () => {
    if (scope.rootPath !== requestedRoot) throw new Stop('invalidated', 'workspace-changed')
    if (options.signal?.aborted) throw new Stop('cancelled', 'cancelled')
    if (performance.now() - started >= limits.durationMs) throw new Stop('partial', 'deadline')
  }
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value }
  type Anchor = { path: string; stats: BigIntStats }
  const inspect = async (path: string, kind: 'folder' | 'file') => {
    if (!isWithin(requestedRoot, path)) throw new Stop('invalidated', 'path-outside-root')
    return checked(() => scope.inspect(path, kind))
  }
  const verify = async (chain: Anchor[]) => {
    for (const anchor of chain) {
      let latest
      try { latest = await inspect(anchor.path, 'folder') }
      catch (error) { if (error instanceof Stop) throw error; throw new Stop('invalidated', 'directory-replaced') }
      if (!identity(anchor.stats, latest.stats)) throw new Stop('invalidated', 'directory-replaced')
    }
  }
  const languageCounts = new Map<string, { id: string; label: string; files: number }>()
  const existing = new Map<string, ProjectLensReference>()
  const declared: Array<{ path: string; reference: ProjectLensReference; reason: string }> = []
  const frameworks = new Set<string>()
  const framework = (name: string, reference: ProjectLensReference, confidence: 'declared' | 'structure-only', reason: string) => {
    const key = name + ':' + reference.path
    if (!frameworks.has(key) && result.frameworks.length < 40) {
      frameworks.add(key); result.frameworks.push({ name, reference, confidence, reason })
    }
  }
  const readManifest = async (path: string, before: BigIntStats, chain: Anchor[], reference: ProjectLensReference) => {
    if (before.size > BigInt(limits.manifestBytes)) { exclude('manifest-size'); truncate('manifest-size'); return }
    if (result.counts.manifestBytesRead + Number(before.size) > limits.totalManifestBytes) { exclude('manifest-budget'); truncate('manifest-budget'); return }
    await verify(chain)
    check()
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let text: string
    try {
      check()
      const opened = await checked(() => handle.stat({ bigint: true }))
      if (!opened.isFile() || revision(opened) !== revision(before)) throw new Error('Manifest changed.')
      await verify(chain)
      const buffer = Buffer.alloc(Number(opened.size))
      let offset = 0
      while (offset < buffer.length) {
        check()
        const part = await handle.read(buffer, offset, buffer.length - offset, offset)
        result.counts.manifestBytesRead += part.bytesRead
        check()
        if (!part.bytesRead) break
        offset += part.bytesRead
      }
      const after = await inspect(path, 'file')
      const final = await checked(() => handle.stat({ bigint: true }))
      await verify(chain)
      if (offset !== buffer.length || revision(after.stats) !== revision(opened) || revision(final) !== revision(opened)) throw new Error('Manifest changed.')
      if (buffer.includes(0)) { exclude('binary'); return }
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } finally { await handle.close() }
    check()
    const lines = text.split(/\r\n|\n|\r/)
    const evidence: ProjectLensReference = { ...reference, range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1 } }
    const kind = manifestKinds[basename(path)]
    const manifest: ProjectLensManifest = { kind, reference: evidence, status: kind === 'npm' ? 'parsed' : 'recognized-text', dependencies: [], scripts: [] }
    result.manifests.push(manifest)
    if (kind !== 'npm') {
      framework(manifestFrameworks[kind], evidence, 'structure-only', 'Recognized manifest filename; content is not semantically validated.')
      return
    }
    let pkg: unknown
    try { pkg = JSON.parse(text); if (!plainObject(pkg)) throw new Error('Invalid package object.') }
    catch { manifest.status = 'malformed'; exclude('invalid-manifest'); return }
    framework('Node.js ecosystem', evidence, 'structure-only', 'A JSON package manifest was inspected; runtime behavior is unverified.')
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const dependencies = pkg[group]
      if (!plainObject(dependencies)) continue
      for (const [name, value] of Object.entries(dependencies)) {
        if (manifest.dependencies.length >= 100) { truncate('dependency-count'); break }
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.length > 128 || typeof value !== 'string') continue
        const version = /^(?:[~^<>=*v0-9][0-9a-zA-Z .|+*~^<>=_-]{0,95}|latest|next|stable)$/.test(value) ? value : '[non-registry reference]'
        manifest.dependencies.push({ name, version, group })
        if (Object.hasOwn(dependencyFrameworks, name)) framework(dependencyFrameworks[name], evidence, 'declared', 'Declared package dependency; installation and working integration are unverified.')
      }
    }
    if (plainObject(pkg.scripts)) for (const [name, command] of Object.entries(pkg.scripts)) {
      if (manifest.scripts.length >= 30) { truncate('script-count'); break }
      if (typeof command === 'string' && /^[\w:.-]{1,64}$/.test(name)) manifest.scripts.push({ name, command: redactProjectLensText(command) })
    }
    for (const field of ['main', 'module', 'types']) {
      const value = pkg[field]
      if (typeof value !== 'string' || !/^(?:\.\/)?[\w./-]{1,200}$/.test(value) || value.split('/').includes('..') || value.startsWith('/')) continue
      const resolved = join(relative(requestedRoot, path).split(sep).slice(0, -1).join(sep), value).split(sep).join('/')
      declared.push({ path: resolved, reference: evidence, reason: 'package.json ' + field + ' declaration; file not yet verified.' })
    }
  }
  try {
    check()
    const root = await inspect(requestedRoot, 'folder')
    const rootAnchor = { path: root.path, stats: root.stats }
    const queue: Array<{ path: string; depth: number; chain: Anchor[] }> = [{ path: root.path, depth: 0, chain: [rootAnchor] }]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      check()
      const directory = queue[cursor]
      await verify(directory.chain)
      check()
      const reader = await opendir(directory.path, { bufferSize: 16 })
      try {
        check()
        await verify(directory.chain)
        result.counts.directoriesInspected++
        for (;;) {
          await verify(directory.chain)
          const item = await checked(() => reader.read())
          if (!item) break
          if (result.counts.visitedEntries >= limits.visits) throw new Stop('partial', 'visit-count')
          result.counts.visitedEntries++
          const path = join(directory.path, item.name)
          const name = item.name
          const relativePath = relative(requestedRoot, path).split(sep).join('/')
          if (Buffer.byteLength(relativePath) > 1024) { exclude('long-path'); continue }
          if (secretName.test(name) || item.isDirectory() && secretDirectory.test(name)) { exclude('secret'); continue }
          if (item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) { exclude('symlink-or-special'); continue }
          if (item.isDirectory()) {
            if (name.startsWith('.') || excludedDirectories.has(name)) { exclude('hidden-or-generated'); continue }
            if (directory.depth >= limits.depth) { exclude('depth'); truncate('depth'); continue }
            try {
              const child = await inspect(path, 'folder')
              const anchor = { path: child.path, stats: child.stats }
              queue.push({ path: child.path, depth: directory.depth + 1, chain: [...directory.chain, anchor] })
            } catch (error) { if (error instanceof Stop) throw error; exclude('unreadable-or-changed') }
            continue
          }
          result.counts.regularFilesSeen++
          if (lockfiles.has(name)) { exclude('lockfile'); continue }
          if (name.startsWith('.')) { exclude('hidden-or-generated'); continue }
          if (binaryExtensions.has(extname(name).toLowerCase())) { exclude('binary'); continue }
          if (result.files.length >= limits.files) throw new Stop('partial', 'file-count')
          try {
            await verify(directory.chain)
            const file = await inspect(path, 'file')
            await verify(directory.chain)
            if (file.stats.size > BigInt(Number.MAX_SAFE_INTEGER)) { exclude('binary'); continue }
            const reference = { path: relativePath, revision: revision(file.stats) }
            const language = fileLanguage(name)
            const count = languageCounts.get(language.id) ?? { id: language.id, label: language.label, files: 0 }
            count.files++; languageCounts.set(language.id, count)
            result.files.push({ reference, language: language.id, bytes: Number(file.stats.size) })
            result.counts.filesInspected++
            existing.set(relativePath, reference)
            if (result.documentation.length < 40 && /(?:^|\/)(?:docs?|documentation)(?:\/|$)|(?:^|\/)(?:readme|contributing|architecture)(?:\.|$)/i.test(relativePath)) result.documentation.push(reference)
            if (result.tests.length < 40 && /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|(?:^|\/)test_[^/]+|\.(?:test|spec)\./i.test(relativePath)) result.tests.push(reference)
            if (Object.hasOwn(manifestKinds, name)) await readManifest(path, file.stats, directory.chain, reference)
          } catch (error) { if (error instanceof Stop) throw error; exclude('unreadable-or-changed') }
        }
        await verify(directory.chain)
      } finally { await reader.close() }
    }
    await verify([rootAnchor])
  } catch (error) {
    if (!(error instanceof Stop)) throw error
    result.status = error.status
    truncate(error.reason)
  }
  // Unconditional resource closure can await after an earlier quota/cancel stop.
  // Recheck authority before publishing even that partial snapshot.
  if (scope.rootPath !== requestedRoot) { result.status = 'invalidated'; truncate('workspace-changed') }
  else if (options.signal?.aborted && result.status !== 'invalidated') { result.status = 'cancelled'; truncate('cancelled') }
  for (const entry of declared.slice(0, 40)) {
    const evidence = existing.get(entry.path)
    result.entryPoints.push(evidence ? { kind: 'existing-candidate', path: entry.path, reference: evidence, reason: 'Declared package entry exists; execution is unverified.' }
      : { kind: 'manifest-reference', ...entry })
  }
  for (const [path, reference] of existing) {
    if (result.entryPoints.length >= 40) break
    if (/(?:^|\/)(?:main\.(?:c|cpp|java|py|ts|tsx|js)|index\.(?:js|ts|tsx)|app\.py)$/i.test(path)
      && !result.entryPoints.some(item => item.path === path)) result.entryPoints.push({ kind: 'existing-candidate', path, reference, reason: 'Conventional entry filename; behavior is unverified.' })
  }
  result.languages = [...languageCounts.values()].sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
  result.counts.returnedFiles = result.files.length
  // Total JSON is bounded independently of traversal/path/dependency limits.
  // Preserve the original collection priority and largest fitting prefix, but
  // avoid serializing the entire snapshot once for every discarded file.
  const fit = () => Buffer.byteLength(JSON.stringify(result)) <= limits.resultBytes
  const collections: unknown[][] = [result.files, result.manifests, result.frameworks, result.entryPoints,
    result.documentation, result.tests, result.languages]
  const shrink = () => {
    if (fit()) return
    truncate('result-bytes')
    for (const items of collections) {
      if (!items.length) continue
      const original = items.slice()
      const prefix = (length: number) => {
        items.length = 0
        for (let index = 0; index < length; index++) items.push(original[index])
        result.counts.returnedFiles = result.files.length
      }
      prefix(0)
      if (!fit()) continue
      let low = 0, high = original.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        prefix(middle)
        if (fit()) low = middle
        else high = middle - 1
      }
      prefix(low)
      break
    }
    if (!fit()) throw new Error('Project Lens result limit cannot hold its metadata.')
  }
  shrink()
  // Include payload fitting in the reported duration. Recheck the final number's
  // serialized width so timing cannot push an exactly bounded result over quota.
  result.durationMs = Math.round((performance.now() - started) * 100) / 100
  shrink()
  return result
}
