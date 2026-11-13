import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import {
  diagnosticConcepts, diagnosticTitles, type ConceptId, type DiagnosticCategory, type LearningConcept, type LearningDiagnostic,
  type LearningFeedback, type LearningHistory, type LearningTopic,
} from '../../shared/learning'
import type { RunLanguage } from '../../shared/run-console'
import { retryFingerprint } from './retry'
import { diagnose, packDiagnostics, type ClassifiedDiagnostic } from './diagnostics'

export { compilerProblems } from './diagnostics'

const topics: readonly LearningTopic[] = [
  { id: 'statements', title: 'Statements and semicolons' },
  { id: 'names', title: 'Variables and declarations' },
  { id: 'types', title: 'Data types and expressions' },
  { id: 'operators', title: 'Operators and evaluation' },
  { id: 'conditions', title: 'Conditions and branches' },
  { id: 'loops', title: 'Loops and termination' },
  { id: 'scope', title: 'Names and scope' },
  { id: 'functions', title: 'Function calls and parameters' },
  { id: 'arrays', title: 'Arrays and indices' },
  { id: 'pointers', title: 'Pointers and dereferencing' },
  { id: 'memory', title: 'Memory access and lifetime' },
  { id: 'diagnostics', title: 'Reading compiler diagnostics' },
]
const topicById = new Map(topics.map((topic) => [topic.id, topic]))
const maxFiles = 96
const maxEpisodes = 8
const maxFingerprints = 8
const maxRetryFingerprints = 4
const maxHistoryBytes = 512 * 1024
const historyReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

interface Episode {
  category: DiagnosticCategory
  hashes: string[]
  retryHashes?: string[]
}

interface FileHistory {
  episodes: Record<string, Episode>
  lastFailure?: { source: string; diagnosticSet: string; retryHash?: string }
}

type CategoryStats = Omit<LearningHistory['categories'][number], 'category'>
type TopicStats = Omit<LearningHistory['topics'][number], 'id'>
interface State {
  version: 1
  files: Record<string, FileHistory>
  categories: Partial<Record<DiagnosticCategory, CategoryStats>>
  topics: Partial<Record<ConceptId, TopicStats>>
}

interface Observation {
  path: string
  sourceHash: string
  result: RunResult
  language?: RunLanguage
  readSource?: () => Promise<string | undefined>
}

function fresh(): State {
  return { version: 1, files: {}, categories: {}, topics: {} }
}

function isCategory(value: unknown): value is DiagnosticCategory {
  return typeof value === 'string' && Object.hasOwn(diagnosticTitles, value)
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function boundedHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function counts(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false
  return keys.every((key) => {
    const count = (value as Record<string, unknown>)[key]
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  })
}

function parseState(text: string): State {
  const state = JSON.parse(text) as State
  if (!state || state.version !== 1 || !state.files || !state.categories || !state.topics) {
    throw new Error('Learning history could not be read. You can clear it in the History panel.')
  }
  const fileEntries = Object.entries(state.files)
  if (fileEntries.length > maxFiles
    || fileEntries.some(([file, row]) => !validHash(file) || !row || !row.episodes
      || (row.lastFailure !== undefined && (!row.lastFailure
        || !validHash(row.lastFailure.source) || !validHash(row.lastFailure.diagnosticSet)
        || (row.lastFailure.retryHash !== undefined && !validHash(row.lastFailure.retryHash))))
      || Object.entries(row.episodes).length > maxEpisodes
      || Object.entries(row.episodes).some(([key, episode]) => !/^[a-z-]+:[a-f0-9]{32}$/.test(key)
        || !episode || !isCategory(episode.category) || !Array.isArray(episode.hashes)
        || episode.hashes.length < 1 || episode.hashes.length > maxFingerprints || !episode.hashes.every(validHash)
        || (episode.retryHashes !== undefined && (!Array.isArray(episode.retryHashes)
          || episode.retryHashes.length > maxRetryFingerprints || !episode.retryHashes.every(validHash)))))
    || Object.entries(state.categories).some(([key, row]) => !isCategory(key) || !counts(row, ['encountered', 'repeated', 'resolved']))
    || Object.entries(state.topics).some(([key, row]) => !topicById.has(key as ConceptId) || !counts(row, ['viewed', 'selected']))) {
    throw new Error('Learning history could not be read. You can clear it in the History panel.')
  }
  return state
}

function resolution(category: DiagnosticCategory, result: RunResult, language: RunLanguage, compilerReportedErrors: boolean): boolean {
  if (category === 'runtime-memory-fault' || category === 'unclassified-runtime' || category === 'cpp-memory-access'
    || category === 'java-null-reference' || category === 'java-array-index'
    || category.startsWith('python-') || category.startsWith('javascript-')) return result.status === 'success'
  if (language === 'c' && (category === 'unclassified-compiler' || result.compileVerified !== true || compilerReportedErrors)) return false
  return result.status === 'success' || result.status === 'runtime-error'
}

function trackingKey(diagnostic: ClassifiedDiagnostic, result: RunResult): string | undefined {
  if ((diagnostic.severity !== 'error' && diagnostic.severity !== 'fatal error')
    || (diagnostic.confidence === 'uncertain' && (diagnostic.language !== 'c' || diagnostic.phase === 'compile'))
    || (diagnostic.phase === 'compile' && result.status !== 'compile-error')
    || (diagnostic.phase === 'runtime' && result.status !== 'runtime-error')) return
  return diagnostic.category + ':' + boundedHash(diagnostic.context ?? '')
}

export class LearningService {
  private data: State | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string, private readonly packs = join(__dirname, 'learning-packs')) {}

  release(): Promise<void> {
    return this.serial(async () => {
      this.data = undefined
    })
  }

  getTopics(): LearningTopic[] {
    return topics.slice()
  }

  async getConcept(id: unknown): Promise<LearningConcept> {
    const topic = topicById.get(id as ConceptId)
    if (!topic) throw new Error('Unknown learning topic.')
    const content = JSON.parse(await readFile(join(this.packs, topic.id + '.json'), 'utf8')) as Omit<LearningConcept, keyof LearningTopic>
    return { ...content, ...topic }
  }

  getHistory(): Promise<LearningHistory> {
    return this.serial(async () => {
      const state = await this.read()
      return {
        categories: Object.entries(state.categories).map(([category, stats]) => ({
          category: category as DiagnosticCategory, ...stats,
        })).sort((a, b) => b.encountered - a.encountered),
        topics: Object.entries(state.topics).map(([id, stats]) => ({ id: id as ConceptId, ...stats })),
      }
    })
  }

  recordTopic(id: unknown, action: unknown): Promise<void> {
    const topic = topicById.get(id as ConceptId)
    if (!topic || (action !== 'viewed' && action !== 'selected')) {
      return Promise.reject(new Error('Unknown learning topic action.'))
    }
    return this.serial(async () => {
      const state = await this.read()
      const previous = state.topics[topic.id] ?? { viewed: 0, selected: 0 }
      await this.write({
        ...state,
        topics: { ...state.topics, [topic.id]: {
          viewed: previous.viewed + 1,
          selected: previous.selected + Number(action === 'selected'),
        } },
      })
    })
  }

  clearHistory(): Promise<void> {
    return this.serial(() => this.write(fresh()))
  }

  observe({ path, sourceHash, result, language = 'c', readSource }: Observation): Promise<LearningFeedback> {
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) return Promise.reject(new Error('Invalid learning source fingerprint.'))
    const hash = sourceHash.slice(0, 32)
    const file = boundedHash(path)
    const records = diagnose(result, language, path)
    const keyed = records.map((record) => {
      const key = trackingKey(record, result)
      const { context: _context, ...diagnostic } = record
      return { key, diagnostic }
    })
    const keys = [...new Set(keyed.flatMap(({ key }) => key ? [key] : []))]
    const diagnosticSet = keys.length ? boundedHash(keys.sort().join('\n')) : undefined
    const reportedCategories = new Set(records.filter(({ severity }) => severity !== 'note').map(({ category }) => category))
    const compilerReportedErrors = records.some(({ phase, severity }) => phase === 'compile'
      && (severity === 'error' || severity === 'fatal error'))
    const compareTokens = (language !== 'c' || readSource !== undefined)
      && (result.status === 'compile-error' || result.status === 'runtime-error')
    return this.serial(async () => {
      const state = await this.read()
      const source = compareTokens && diagnosticSet && readSource ? await readSource().catch(() => undefined) : undefined
      const retryHash = source === undefined ? undefined : retryFingerprint(language, source, sourceHash)
      const fileHistory = state.files[file]
      const previous = fileHistory?.episodes ?? {}
      const lastFailure = fileHistory?.lastFailure
      const unchangedFailure = diagnosticSet !== undefined && lastFailure?.diagnosticSet === diagnosticSet
        && (lastFailure.source === hash || (retryHash !== undefined && lastFailure.retryHash === retryHash))
      const episodes = { ...previous }
      const categories = { ...state.categories }
      const resolved = new Set<DiagnosticCategory>()
      const occurrences = new Map<string, NonNullable<LearningDiagnostic['occurrence']>>()
      const diagnostics: LearningDiagnostic[] = []
      let changed = false

      for (const { key, diagnostic } of keyed) {
        const { category, concepts } = diagnostic
        if (!key) {
          diagnostics.push(diagnostic)
          continue
        }
        let occurrence = occurrences.get(key)
        if (!occurrence) {
          const existing = previous[key]
          const exactMatch = existing?.hashes.includes(hash)
          const sameTokens = retryHash !== undefined && existing?.retryHashes?.includes(retryHash)
          if (unchangedFailure || exactMatch || sameTokens) occurrence = 'unchanged'
          else if (existing) {
            occurrence = compareTokens && (!retryHash || !existing.retryHashes?.length) ? 'unchanged' : 'repeated'
          } else {
            const related = Object.values(previous).some((entry) => entry.category !== category
              && ((diagnosticConcepts[entry.category] ?? []).some((concept) => concepts.includes(concept))
                || (language !== 'c' && diagnostic.packTopic && packDiagnostics[entry.category]?.packTopic === diagnostic.packTopic)))
            occurrence = related ? 'related' : 'new'
          }
          occurrences.set(key, occurrence)
          if (occurrence !== 'unchanged') {
            changed = true
            delete episodes[key]
            episodes[key] = { category, hashes: [...(existing?.hashes ?? []).slice(1 - maxFingerprints), hash] }
            const retryHashes = retryHash ? [...(existing?.retryHashes ?? []).slice(1 - maxRetryFingerprints), retryHash]
              : existing?.retryHashes
            if (retryHashes) episodes[key].retryHashes = retryHashes
            const stats = categories[category] ?? { encountered: 0, repeated: 0, resolved: 0 }
            categories[category] = { ...stats, encountered: stats.encountered + 1, repeated: stats.repeated + Number(occurrence === 'repeated') }
          } else if (existing && retryHash && !sameTokens && (exactMatch || !existing.retryHashes?.length)) {
            // Seed token comparison for older or ambiguous histories without adding an encounter.
            changed = true
            episodes[key] = {
              ...existing,
              hashes: exactMatch ? existing.hashes : [...existing.hashes.slice(1 - maxFingerprints), hash],
              retryHashes: [...(existing.retryHashes ?? []).slice(1 - maxRetryFingerprints), retryHash],
            }
          }
        }
        diagnostics.push({ ...diagnostic, occurrence })
      }

      for (const [key, episode] of Object.entries(previous)) {
        if (reportedCategories.has(episode.category) || !resolution(episode.category, result, language, compilerReportedErrors)) continue
        changed = true
        delete episodes[key]
        resolved.add(episode.category)
        const stats = categories[episode.category] ?? { encountered: 0, repeated: 0, resolved: 0 }
        categories[episode.category] = { ...stats, resolved: stats.resolved + 1 }
      }

      if (changed) {
        const files = { ...state.files }
        delete files[file]
        if (Object.keys(episodes).length) {
          files[file] = {
            episodes: Object.fromEntries(Object.entries(episodes).slice(-maxEpisodes)),
            ...(diagnosticSet ? { lastFailure: { source: hash, diagnosticSet, ...(retryHash ? { retryHash } : {}) } } : {}),
          }
        }
        await this.write({ ...state, files: Object.fromEntries(Object.entries(files).slice(-maxFiles)), categories })
      }
      return { language, diagnostics, resolved: [...resolved] }
    }).catch(() => {
      const diagnostics = keyed.map(({ diagnostic }) => diagnostic)
      return { language, diagnostics, resolved: [], historyUnavailable: true }
    })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(): Promise<State> {
    if (this.data) return this.data
    const handle = await open(this.file, historyReadFlags).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return (this.data = fresh())
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maxHistoryBytes) throw new Error('Invalid learning history file.')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      this.data = parseState(bytes.toString('utf8', 0, offset))
      return this.data
    } finally {
      await handle.close()
    }
  }

  private async write(state: State): Promise<void> {
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
      this.data = state
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
