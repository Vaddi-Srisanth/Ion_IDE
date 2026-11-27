import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import type { LearningTaskEvidence } from '../../shared/learning'
import {
  catalogDifficulties, maxPracticeSamples, practiceCompletion, practiceDifficulties, practiceLanguages, practiceTopics,
  type PracticeAttempt, type PracticeChallenge, type PracticeChallengeSummary, type PracticeFields, type PracticeLibrary, type PracticeProblem,
  type PracticeProgress, type PracticeSample, type PracticeSampleResult,
} from '../../shared/practice'
import type { RunLanguage } from '../../shared/run-console'
import { maxFileBytes, readStableBytes, revision } from '../files'
import { practiceChallenges } from './catalog-data'
import { isId, isTopicId } from '../learning/pack-format'
import { submissionFileLimit, submissionHistoryLimit, validatePracticeSubmissions, type StoredSubmissions } from './submissions'
export { validatePracticeSubmissions } from './submissions'

const maxProblems = 200
const maxAttempts = 20
const maxMetadataBytes = 1 * 1024 * 1024
const previewLength = 2000
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
// Each released catalog problem has independently verified local cases. Custom and lesson problems keep sample runs.
function suiteVersion(catalogId?: string) {
  return catalogId && practiceChallenges.some(challenge => challenge.id === catalogId) ? 1 : undefined
}

const resultStatuses = ['passed', 'failed', 'unavailable', 'skipped'] as const
const challengeIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const supportedLanguages = Object.keys(practiceLanguages) as RunLanguage[]
const fileExtensions: Record<RunLanguage, string> = { c: 'c', cpp: 'cpp', java: 'java', python: 'py', javascript: 'js' }
const starters: Record<RunLanguage, string> = {
  c: '#include <stdio.h>\n\nint main(void) {\n    // Write your solution here.\n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    // Write your solution here.\n    return 0;\n}\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        // Write your solution here.\n    }\n}\n',
  python: '# Write your solution here.\n',
  javascript: '// Write your solution here. Read input from stdin.\n',
}

type RunSamples = (path: string, inputs: readonly string[], sourceRevision: string, expectedHash?: string) => Promise<readonly RunResult[]>

function withPracticeSuggestion(progress: PracticeProgress): PracticeProgress {
  if (progress.unavailable) return progress
  const history = new Map(progress.challenges.map(item => [item.id, item]))
  const ordered = catalogDifficulties.flatMap(difficulty => practiceChallenges.filter(item => item.difficulty === difficulty))
  const revisit = (state: 'submitted' | 'opened') => ordered.find(({ id }) => {
    const item = history.get(id)
    return item?.state === state && !item.importedOnly
  })
  const submitted = revisit('submitted')
  const opened = submitted ? undefined : revisit('opened')
  const knownTopics = new Set(ordered.filter(({ id }) => history.has(id) && !history.get(id)?.importedOnly).map(({ topic }) => topic))
  const unseen = ordered.filter(({ id }) => !history.has(id))
  const related = unseen.find(({ difficulty, topic }) => difficulty !== 'Hard' && knownTopics.has(topic))
  const challenge = submitted ?? opened ?? related ?? unseen[0]
  if (!challenge) return progress
  const { id, title, topic, difficulty } = challenge
  return { ...progress, suggestion: { id, title, topic, difficulty,
    reason: submitted ? 'submitted' : opened ? 'opened' : related ? 'related' : 'new' } }
}

interface StoredReport {
  restored?: boolean
  version: 1
  testedAt: number
  sourceRevision: string
  samplesKey: string
  results: PracticeSampleResult[]
}

type StoredAttempt = Omit<PracticeAttempt, 'lastRun' | 'submissions'>

interface StoredProblem extends Omit<PracticeProblem, 'attempts' | 'canSubmit'> {
  version: 1
  catalogId?: string
  attempts: StoredAttempt[]
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid practice data.')
  return value as Record<string, unknown>
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + label + '.')
  return value
}

function text(value: unknown, label: string, limit: number, required = false, trim = false): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (required && !value.trim())) {
    throw new Error(label + (required ? ' is required and' : '') + ' must contain at most ' + limit + ' characters.')
  }
  return trim ? value.trim() : value
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid practice identifier.')
  return value
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const result = values.find((candidate) => candidate === value)
  if (!result) throw new Error('Invalid ' + label + '.')
  return result
}

function catalogIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !challengeIdPattern.test(value)) throw new Error('Invalid practice challenge.')
  return value
}

function sourceUrl(value: unknown): string {
  const source = text(value, 'Source URL', 2048, false, true)
  if (!source) return ''
  const url = URL.parse(source)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS source URL without credentials.')
  }
  return source
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw new Error('Practice identifiers must be unique.')
  return items
}

function list<T>(value: unknown, limit: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Practice data exceeds its item limit.')
  return value.map(parse)
}

function fields(value: Record<string, unknown>): PracticeFields {
  return {
    title: text(value.title, 'Title', 120, true, true),
    sourceUrl: sourceUrl(value.sourceUrl),
    difficulty: choice(value.difficulty, practiceDifficulties, 'difficulty'),
    topic: text(value.topic, 'Topic', 120, false, true),
    completion: choice(value.completion, practiceCompletion, 'completion status'),
    statement: text(value.statement, 'Problem statement', 20_000, true),
    notes: text(value.notes, 'Notes', 20_000),
    samples: uniqueIds(list(value.samples, maxPracticeSamples, (item) => {
      const sample = record(item)
      return {
        id: identifier(sample.id),
        label: text(sample.label, 'Sample label', 80, true, true),
        input: text(sample.input, 'Sample input', 12_000),
        expectedOutput: text(sample.expectedOutput, 'Expected output', 12_000),
      }
    })),
  }
}

function sampleResult(value: unknown): PracticeSampleResult {
  const item = record(value)
  return {
    id: identifier(item.id),
    label: text(item.label, 'Sample label', 80, true),
    status: choice(item.status, resultStatuses, 'sample status'),
    message: text(item.message, 'Sample message', previewLength),
    expected: text(item.expected, 'Expected output preview', previewLength),
    stdout: text(item.stdout, 'Program output preview', previewLength),
    stderr: text(item.stderr, 'Program error preview', previewLength),
  }
}

function parseAttempt(value: unknown): StoredAttempt {
  const item = record(value)
  return {
    id: identifier(item.id),
    label: text(item.label, 'Attempt name', 80, true, true),
    createdAt: integer(item.createdAt, 'attempt date'),
  }
}

export function validatePracticeReport(value: unknown): StoredReport {
  const item = record(value)
  if (item.version !== 1) throw new Error('Unsupported practice result format.')
  return {
    version: 1,
    ...(item.restored === true ? { restored: true } : {}),
    testedAt: integer(item.testedAt, 'test date'),
    sourceRevision: text(item.sourceRevision, 'Source revision', 256, true),
    samplesKey: text(item.samplesKey, 'Sample signature', 64, true),
    results: uniqueIds(list(item.results, maxPracticeSamples, sampleResult)),
  }
}

function samplesKey(samples: PracticeSample[]): string {
  return createHash('sha256').update(JSON.stringify(samples)).digest('hex')
}

function preview(value: string): string {
  const slice = value.slice(0, previewLength - 1).replaceAll('\0', '\uFFFD')
  return value.length >= previewLength ? slice + '…' : slice
}

function normalizedOutput(value: string): string {
  return value.replaceAll('\r\n', '\n').replace(/\n$/, '')
}

function compareSample(sample: PracticeSample, run: RunResult): PracticeSampleResult {
  const fields = { id: sample.id, label: sample.label, expected: preview(sample.expectedOutput) }
  const stdout = preview(run.programStdout ?? run.programOutput)
  const stderr = preview(run.programStderr ?? run.compileOutput)
  if (run.outputComplete === false) {
    return { ...fields, status: 'unavailable', message: preview(run.message), stdout, stderr }
  }
  if (run.status !== 'success') {
    const status = run.status === 'runtime-error' ? 'failed' : 'unavailable'
    return { ...fields, status, message: preview(run.message), stdout, stderr }
  }
  if (run.programStdout === undefined) {
    return { ...fields, status: 'unavailable', message: 'The runner did not return separate standard output.', stdout, stderr }
  }
  const matches = normalizedOutput(run.programStdout) === normalizedOutput(sample.expectedOutput)
  return { ...fields, status: matches ? 'passed' : 'failed', message: matches ? 'Standard output matches.' : 'Standard output differs from the expected text.', stdout, stderr }
}

function skipped(sample: PracticeSample, message: string): PracticeSampleResult {
  return { id: sample.id, label: sample.label, status: 'skipped', message, expected: preview(sample.expectedOutput), stdout: '', stderr: '' }
}

export function validatePracticeProblem(input: unknown, id: string): StoredProblem {
  const value = record(input)
  if (value.version !== 1 || value.id !== id) throw new Error('Unsupported practice problem format.')
  return {
    ...fields(value), id, version: 1, revision: integer(value.revision, 'practice revision'),
    language: value.language === undefined ? 'c' : choice(value.language, supportedLanguages, 'practice language'),
    ...(value.catalogId === undefined ? {} : { catalogId: catalogIdentifier(value.catalogId) }),
    attempts: uniqueIds(list(value.attempts, maxAttempts, parseAttempt)),
  }
}

export class PracticeStore {
  private root: Promise<string> | undefined
  private pending: Promise<void> = Promise.resolve()
  private running = false

  drain(): Promise<void> { return this.pending }

  constructor(private readonly path: string) {}

  release(): void {
    this.root = undefined
  }

  private directory(): Promise<string> {
    if (this.root) return this.root
    const opening: Promise<string> = this.openDirectory().catch((error: unknown) => {
      if (this.root === opening) this.root = undefined
      throw error
    })
    return (this.root = opening)
  }

  private async openDirectory(): Promise<string> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const root = join(await realpath(dirname(this.path)), basename(this.path))
    await mkdir(root, { recursive: true, mode: 0o700 })
    return this.requireDirectory(root)
  }

  private async requireDirectory(path: string): Promise<string> {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
      throw new Error('The practice library must use regular local directories.')
    }
    return path
  }

  private async existingDirectory(): Promise<string | null> {
    try {
      return await this.requireDirectory(join(await realpath(dirname(this.path)), basename(this.path)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async problemDirectory(id: string, root?: string): Promise<string> {
    return this.requireDirectory(join(root ?? await this.directory(), id))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.pending.then(operation)
    this.pending = job.then(() => undefined, () => undefined)
    return job
  }

  private async readJson(file: string): Promise<unknown> {
    const original = await lstat(file, { bigint: true })
    if (!original.isFile() || original.size > BigInt(maxMetadataBytes) || await realpath(file) !== file) {
      throw new Error('Invalid practice metadata file.')
    }
    const { data, stats } = await readStableBytes(file, maxMetadataBytes)
    if (revision(original) !== revision(stats)) throw new Error('Practice metadata changed while reading.')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  }

  private async readProblem(id: string, root?: string): Promise<StoredProblem> {
    const directory = await this.problemDirectory(id, root)
    return validatePracticeProblem(await this.readJson(join(directory, 'problem.json')), id)
  }

  private reportName(attempt: StoredAttempt): string {
    return 'attempt-' + attempt.id + '.report.json'
  }

  private async readReport(problem: StoredProblem, attempt: StoredAttempt, root?: string): Promise<StoredReport | undefined> {
    try {
      const directory = await this.problemDirectory(problem.id, root)
      return validatePracticeReport(await this.readJson(join(directory, this.reportName(attempt))))
    } catch {
      // A missing or unreadable result should not prevent access to the source or problem.
      return undefined
    }
  }

  private async publish(directory: string, name: string, value: StoredProblem | StoredReport | StoredSubmissions,
    beforePublish?: () => Promise<void>): Promise<void> {
    const file = join(directory, name)
    const temporary = join(directory, '.problem-' + randomUUID() + '.tmp')
    const contents = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(contents) > maxMetadataBytes) throw new Error('Practice metadata is too large to save.')
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.requireDirectory(directory)
      if (beforePublish) await beforePublish()
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private sourcePath(directory: string, attempt: StoredAttempt, language: RunLanguage): string {
    const stem = 'attempt-' + attempt.id
    return language === 'java' ? join(directory, stem, 'Main.java') : join(directory, stem + '.' + fileExtensions[language])
  }

  private async writeSource(directory: string, attempt: StoredAttempt, language: RunLanguage, content: string): Promise<void> {
    const path = this.sourcePath(directory, attempt, language)
    if (language === 'java') await mkdir(dirname(path), { mode: 0o700 })
    const file = await open(path, 'wx', 0o600)
    try {
      if (content) await file.writeFile(content, 'utf8')
    } finally {
      await file.close()
    }
  }

  private async attemptSource(problem: StoredProblem, attempt: StoredAttempt, root?: string): Promise<{ path: string; token: string }> {
    const path = this.sourcePath(await this.problemDirectory(problem.id, root), attempt, problem.language)
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.size > BigInt(maxFileBytes) || await realpath(path) !== path) {
      throw new Error('The attempt must be a regular source file up to 2 MiB inside the practice library.')
    }
    return { path, token: revision(stats) }
  }

  private async sourceHash(source: { path: string; token: string }): Promise<string> {
    const { data, stats } = await readStableBytes(source.path, maxFileBytes)
    if (revision(stats) !== source.token) throw new Error('The saved attempt changed. Review it and submit again.')
    return createHash('sha256').update(data).digest('hex')
  }

  private async submissionFile(directory: string, attempt: StoredAttempt) {
    const name = 'attempt-' + attempt.id + '.submissions.json'
    const path = join(directory, name)
    try {
      const previous = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (!previous) return { name, token: undefined, file: { version: 1 as const, submissions: [] } }
      if (!previous.isFile() || previous.size > BigInt(submissionFileLimit) || await realpath(path) !== path) throw new Error()
      const { data, stats } = await readStableBytes(path, submissionFileLimit)
      if (revision(previous) !== revision(stats)) throw new Error()
      return { name, token: revision(stats), file: validatePracticeSubmissions(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))) }
    } catch {
      throw new Error('The local submission history could not be read. Its file was preserved.')
    }
  }

  private async view(problem: StoredProblem, root?: string): Promise<PracticeProblem> {
    const { version: _version, catalogId, attempts, ...fields } = problem
    const suite = suiteVersion(catalogId)
    const directory = suite && await this.problemDirectory(problem.id, root)
    const key = samplesKey(fields.samples)
    return {
      ...fields,
      ...(suite && { canSubmit: true }),
      attempts: await Promise.all(attempts.map(async (attempt): Promise<PracticeAttempt> => {
        const lastRun = await this.readReport(problem, attempt, root)
        // An unreadable result must not prevent opening the problem or its independent source files.
        const history = directory ? await this.submissionFile(directory, attempt).catch(() => undefined) : undefined
        if (!lastRun && !history?.file.submissions.length) return attempt
        const source = await this.attemptSource(problem, attempt, root).catch(() => undefined)
        const digest = source && history?.file.submissions.length ? await this.sourceHash(source).catch(() => undefined) : undefined
        return {
          ...attempt,
          ...(lastRun && { lastRun: {
            testedAt: lastRun.testedAt, results: lastRun.results,
            current: !lastRun.restored && source?.token === lastRun.sourceRevision && lastRun.samplesKey === key,
          } }),
          ...(history?.file.submissions.length ? { submissions: history.file.submissions.map(({ restored, suiteVersion, sourceSha256, ...row }) =>
            ({ ...row, current: !restored && suiteVersion === suite && sourceSha256 === digest })) } : {}),
        }
      })),
    }
  }

  private async problemIds(root?: string, signal?: AbortSignal): Promise<string[]> {
    const ids: string[] = []
    const directory = await opendir(root ?? await this.directory())
    let seen = 0
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (++seen > maxProblems + 100) throw new Error('Too many entries in the practice library.')
      if (entry.isDirectory() && idPattern.test(entry.name)) ids.push(entry.name)
    }
    return ids
  }

  async list(): Promise<PracticeLibrary> {
    const result: PracticeLibrary = { problems: [], unavailable: 0 }
    for (const problemId of await this.problemIds()) {
      try {
        const { id, title, topic, difficulty, completion, language } = await this.readProblem(problemId)
        result.problems.push({ id, title, topic, difficulty, completion, language })
      } catch {
        result.unavailable++
      }
    }
    result.problems.sort((a, b) => a.title.localeCompare(b.title))
    return result
  }

  async progress(signal: AbortSignal): Promise<PracticeProgress> {
    signal.throwIfAborted()
    // Start after already queued writes. Later saves can publish while these atomic records are read.
    await this.pending
    signal.throwIfAborted()
    const result: PracticeProgress = { catalogSize: practiceChallenges.length, opened: 0, submitted: 0, accepted: 0, unavailable: 0, challenges: [] }
    const root = await this.existingDirectory()
    signal.throwIfAborted()
    if (!root) return withPracticeSuggestion(result)
    const evidence = new Map<string, { submitted: boolean; accepted: boolean; judgedHere: boolean;
      localWrongAt?: number; localAcceptedAt?: number }>()
    const ids = await this.problemIds(root, signal)
    if (ids.length > maxProblems) throw new Error('Too many practice problems to summarize.')
    for (const id of ids) {
      signal.throwIfAborted()
      let problem: StoredProblem
      try {
        problem = await this.readProblem(id, root)
      } catch {
        result.unavailable++
        continue
      }
      const suite = suiteVersion(problem.catalogId)
      if (!suite || !problem.catalogId || !problem.attempts.length) continue
      const row = evidence.get(problem.catalogId) ?? {
        submitted: false, accepted: false, judgedHere: false,
      }
      evidence.set(problem.catalogId, row)
      // A stored attempt records that the challenge was opened. Progress measures
      // retained verdicts across all languages and never needs the attempt's source.
      for (const attempt of problem.attempts) {
        signal.throwIfAborted()
        try {
          const { file } = await this.submissionFile(join(root, id), attempt)
          for (const item of file.submissions) {
            row.submitted = true
            if (!item.restored) {
              row.judgedHere = true
              if (item.suiteVersion === suite) {
                if (item.verdict === 'wrong-answer') row.localWrongAt = Math.max(row.localWrongAt ?? 0, item.judgedAt)
                if (item.verdict === 'accepted') row.localAcceptedAt = Math.max(row.localAcceptedAt ?? 0, item.judgedAt)
              }
            }
            if (item.verdict === 'accepted' && item.suiteVersion === suite) row.accepted = true
          }
        } catch {
          result.unavailable++
        }
      }
    }
    signal.throwIfAborted()
    for (const { id, title } of practiceChallenges) {
      const row = evidence.get(id)
      if (!row) continue
      result.opened++
      if (row.submitted) result.submitted++
      if (row.accepted) result.accepted++
      result.challenges.push({ id, title, state: row.accepted ? 'accepted' : row.submitted ? 'submitted' : 'opened',
        importedOnly: row.submitted && !row.judgedHere })
    }
    if (!result.unavailable) {
      const topicFailures = practiceTopics.map(topic => ({ topic, unresolvedChallenges: practiceChallenges.filter(challenge => {
        const row = evidence.get(challenge.id)
        return challenge.topic === topic && row?.localWrongAt !== undefined
          && (row.localAcceptedAt === undefined || row.localAcceptedAt < row.localWrongAt)
      }).length })).filter(row => row.unresolvedChallenges >= 2)
        .sort((left, right) => right.unresolvedChallenges - left.unresolvedChallenges
          || practiceTopics.indexOf(left.topic) - practiceTopics.indexOf(right.topic))
      const focus = topicFailures[0]
      if (focus) {
        // Link to one of the locally unresolved challenges so the learner can inspect or retry it.
        const challenge = practiceChallenges.find(item => {
          const row = evidence.get(item.id)
          return item.topic === focus.topic && row?.localWrongAt !== undefined
            && (row.localAcceptedAt === undefined || row.localAcceptedAt < row.localWrongAt)
        })
        if (challenge) result.topicFocus = { ...focus, challenge: { id: challenge.id, title: challenge.title,
          topic: challenge.topic, difficulty: challenge.difficulty } }
      }
    }
    return withPracticeSuggestion(result)
  }

  async get(value: unknown): Promise<PracticeProblem> {
    return this.view(await this.readProblem(identifier(value)))
  }

  browse(value: unknown): PracticeChallengeSummary[] {
    const filters = record(value)
    if (filters.language !== undefined) choice(filters.language, supportedLanguages, 'practice language')
    const topic = filters.topic === undefined ? undefined : choice(filters.topic, practiceTopics, 'practice topic')
    const search = filters.search === undefined ? '' : text(filters.search, 'Search', 100, false, true).toLowerCase()
    const difficulty = filters.difficulty === undefined && search ? undefined : choice(filters.difficulty, catalogDifficulties, 'practice difficulty')
    return practiceChallenges.filter(item => (!difficulty || item.difficulty === difficulty) && (!topic || item.topic === topic)
      && (!search || item.title.toLowerCase().includes(search) || item.topic.toLowerCase().includes(search)))
      .map(({ id, title, topic, difficulty }) => ({ id, title, topic, difficulty }))
  }

  getChallenge(value: unknown): PracticeChallenge {
    const id = catalogIdentifier(value)
    const challenge = practiceChallenges.find((item) => item.id === id)
    if (!challenge) throw new Error('This practice challenge is unavailable.')
    return challenge
  }

  async start(value: unknown, selectedLanguage: unknown): Promise<{ problem: PracticeProblem; attempt: PracticeAttempt }> {
    const challenge = this.getChallenge(value)
    return this.startChallenge(challenge, selectedLanguage)
  }

  async startLearningExercise(pack: string, lesson: string, language: RunLanguage,
    exercise: Omit<PracticeChallenge, 'id' | 'topic'> & { topic: string }, starter?: string) {
    if (!isId(pack) || !isTopicId(lesson)) throw new Error('Invalid learning lesson identity.')
    if (starter !== undefined && (typeof starter !== 'string' || Buffer.byteLength(starter) > 8000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF]/u.test(starter))) {
      throw new Error('Lesson starter must contain valid source text up to 8000 UTF-8 bytes.')
    }
    const id = 'lesson-' + createHash('sha256').update(pack + ':' + lesson).digest('hex')
    return this.startChallenge({ ...exercise, id }, language, starter)
  }

  async learningTaskEvidence(pack: unknown, lesson: unknown): Promise<LearningTaskEvidence> {
    if (!isId(pack) || !isTopicId(lesson)) throw new Error('Invalid learning lesson identity.')
    const catalogId = 'lesson-' + createHash('sha256').update(pack + ':' + lesson).digest('hex')
    return this.serialize(async () => {
      const empty: LearningTaskEvidence = { problemId: null, attemptCount: 0, manualStatus: null, samples: null }
      // Reading lesson evidence must not create a practice library or an attempt.
      const root = await this.existingDirectory()
      if (!root) return empty
      for (const id of await this.problemIds(root)) {
        const problem = await this.readProblem(id, root).catch(() => undefined)
        if (problem?.catalogId !== catalogId || problem.language !== pack) continue
        // Reuse freshness checks without reading the output of every historical attempt.
        const latest = (await this.view({ ...problem, attempts: problem.attempts.slice(-1) }, root)).attempts[0]
        const report = latest?.lastRun
        return {
          problemId: problem.id, attemptCount: problem.attempts.length, manualStatus: problem.completion,
          samples: report && latest ? {
            attemptId: latest.id, testedAt: report.testedAt, current: report.current,
            passed: report.results.filter(({ status }) => status === 'passed').length,
            failed: report.results.filter(({ status }) => status === 'failed').length,
            unavailable: report.results.filter(({ status }) => status === 'unavailable').length,
            skipped: report.results.filter(({ status }) => status === 'skipped').length,
            total: report.results.length,
          } : null,
        }
      }
      return empty
    })
  }

  private async startChallenge(challenge: Omit<PracticeChallenge, 'topic'> & { topic: string }, selectedLanguage: unknown, starter?: string) {
    const id = challenge.id
    const language = choice(selectedLanguage, supportedLanguages, 'practice language')
    return this.serialize(async () => {
      const ids = await this.problemIds()
      for (const problemId of ids) {
        const existing = await this.readProblem(problemId).catch(() => undefined)
        const latest = existing?.attempts.at(-1)
        if (existing?.catalogId === id && existing.language === language && latest) {
          return { problem: await this.view(existing), attempt: latest }
        }
      }
      if (ids.length >= maxProblems) throw new Error('The practice library can hold up to ' + maxProblems + ' problems.')
      const attempt = { id: randomUUID(), label: 'Attempt 1', createdAt: Date.now() }
      const prepared: StoredProblem = {
        ...fields({
          ...challenge, sourceUrl: '', completion: 'Not started', notes: '',
          samples: challenge.samples.map((sample) => ({ ...sample, id: randomUUID() })),
        }),
        id: randomUUID(), catalogId: id, language, version: 1, revision: 1, attempts: [attempt],
      }
      const root = await this.directory()
      const staging = await mkdtemp(join(root, '.challenge-'))
      try {
        await this.writeSource(staging, attempt, language, starter ?? starters[language])
        await this.publish(staging, 'problem.json', prepared)
        await this.requireDirectory(root)
        await rename(staging, join(root, prepared.id))
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
      return { problem: await this.view(prepared), attempt }
    })
  }

  async save(value: unknown): Promise<PracticeProblem> {
    const draft = record(value)
    const next = fields(draft)
    const language = draft.language === undefined ? undefined : choice(draft.language, supportedLanguages, 'practice language')
    return this.serialize(async () => {
      if (draft.id === undefined) {
        if ((await this.problemIds()).length >= maxProblems) throw new Error('The practice library can hold up to ' + maxProblems + ' problems.')
        const id = randomUUID()
        await mkdir(join(await this.directory(), id), { mode: 0o700 })
        const created: StoredProblem = { ...next, id, language: language ?? 'c', version: 1, revision: 1, attempts: [] }
        await this.publish(await this.problemDirectory(id), 'problem.json', created)
        return this.view(created)
      }
      const previous = await this.readProblem(identifier(draft.id))
      if (language !== undefined && language !== previous.language) throw new Error('Choose a language when starting a practice problem.')
      if (integer(draft.revision, 'practice revision') !== previous.revision) {
        throw new Error('This practice problem changed. Reopen it before saving your draft.')
      }
      const changed = { ...previous, ...next, revision: previous.revision + 1 }
      await this.publish(await this.problemDirectory(changed.id), 'problem.json', changed)
      return this.view(changed)
    })
  }

  async createAttempt(value: unknown, name: unknown): Promise<{ problem: PracticeProblem; attempt: PracticeAttempt }> {
    const id = identifier(value)
    const label = text(name, 'Attempt name', 80, false, true)
    return this.serialize(async () => {
      const problem = await this.readProblem(id)
      if (problem.attempts.length >= maxAttempts) throw new Error('A problem can have up to ' + maxAttempts + ' saved attempts.')
      const attempt = { id: randomUUID(), label: label || 'Attempt ' + (problem.attempts.length + 1), createdAt: Date.now() }
      const directory = await this.problemDirectory(id)
      const starter = problem.catalogId || problem.language === 'java' ? starters[problem.language] : ''
      await this.writeSource(directory, attempt, problem.language, starter)
      const changed = { ...problem, revision: problem.revision + 1, attempts: [...problem.attempts, attempt] }
      await this.publish(directory, 'problem.json', changed)
      return { problem: await this.view(changed), attempt }
    })
  }

  private findAttempt(problem: StoredProblem, id: string): StoredAttempt {
    const attempt = problem.attempts.find((item) => item.id === id)
    if (!attempt) throw new Error('This attempt does not belong to the selected practice problem.')
    return attempt
  }

  async openAttempt(value: unknown, attemptId: unknown): Promise<string> {
    const problem = await this.readProblem(identifier(value))
    return (await this.attemptSource(problem, this.findAttempt(problem, identifier(attemptId)))).path
  }

  async submit(value: unknown, attemptValue: unknown, execute: RunSamples, signal: AbortSignal): Promise<PracticeProblem> {
    const id = identifier(value), attemptId = identifier(attemptValue)
    if (this.running) throw new Error('A practice run or submission is already running.')
    this.running = true
    try {
      signal.throwIfAborted()
      const problem = await this.readProblem(id)
      const attempt = this.findAttempt(problem, attemptId)
      const suite = suiteVersion(problem.catalogId)
      if (!suite || !problem.catalogId) throw new Error('Local Submit is unavailable for this problem.')
      const directory = await this.problemDirectory(id)
      const history = await this.submissionFile(directory, attempt)
      const source = await this.attemptSource(problem, attempt)
      const sourceSha256 = await this.sourceHash(source)
      const { judgeChallenge } = await import('./judge')
      signal.throwIfAborted()
      const result = await judgeChallenge(problem.catalogId, inputs => execute(source.path, inputs, source.token, sourceSha256))
      signal.throwIfAborted()
      return await this.serialize(async () => {
        const latest = await this.readProblem(id)
        const current = this.findAttempt(latest, attemptId)
        if (latest.catalogId !== problem.catalogId || latest.language !== problem.language) throw new Error('The practice problem changed during judging.')
        const entry = { ...result, sourceSha256, suiteVersion: suite }
        const file = validatePracticeSubmissions({ version: 1, submissions: [...history.file.submissions, entry].slice(-submissionHistoryLimit) })
        await this.publish(directory, history.name, file, async () => {
          const currentHistory = await this.submissionFile(directory, current)
          if (currentHistory.token !== history.token) throw new Error('The submission history changed. Reopen the problem and submit again.')
          const checked = await this.attemptSource(latest, current)
          if (checked.token !== source.token || await this.sourceHash(checked) !== sourceSha256) {
            throw new Error('The saved attempt changed during judging. Review it and submit again.')
          }
          signal.throwIfAborted()
        })
        return this.view(latest)
      })
    } finally {
      this.running = false
    }
  }

  async runSamples(value: unknown, attemptValue: unknown, execute: RunSamples): Promise<PracticeProblem> {
    const id = identifier(value)
    const attemptId = identifier(attemptValue)
    if (this.running) throw new Error('A practice run or submission is already running.')
    this.running = true
    try {
      const problem = await this.readProblem(id)
      const attempt = this.findAttempt(problem, attemptId)
      if (!problem.samples.length) throw new Error('Add a sample before running it.')
      const source = await this.attemptSource(problem, attempt)
      const key = samplesKey(problem.samples)
      const runs = await execute(source.path, problem.samples.map(({ input }) => input), source.token)
      const results = problem.samples.map((sample, index) => {
        const run = runs[index]
        return run ? compareSample(sample, run) : skipped(sample, 'Skipped because the sample run stopped early.')
      })
      return await this.serialize(async () => {
        const latest = await this.readProblem(id)
        const current = this.findAttempt(latest, attemptId)
        if (samplesKey(latest.samples) !== key || (await this.attemptSource(latest, current)).token !== source.token) {
          throw new Error('The saved source or samples changed during the run. Run samples again.')
        }
        const lastRun: StoredReport = { version: 1, testedAt: Date.now(), sourceRevision: source.token, samplesKey: key, results }
        await this.publish(await this.problemDirectory(id), this.reportName(current), lastRun)
        return this.view(latest)
      })
    } finally {
      this.running = false
    }
  }
}
