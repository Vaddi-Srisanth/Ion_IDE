import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import {
  catalogDifficulties, maxPracticeSamples, practiceCompletion, practiceDifficulties, practiceLanguages, practiceTopics,
  type PracticeAttempt, type PracticeChallenge, type PracticeChallengeSummary, type PracticeFields, type PracticeLibrary, type PracticeProblem,
  type PracticeSample, type PracticeSampleResult,
} from '../../shared/practice'
import type { RunLanguage } from '../../shared/run-console'
import { maxFileBytes, revision } from '../files'
import { practiceChallenges } from './catalog-data'

const maxProblems = 200
const maxAttempts = 20
const maxMetadataBytes = 1 * 1024 * 1024
const previewLength = 2000
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
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

type RunSamples = (path: string, inputs: readonly string[], sourceRevision: string) => Promise<readonly RunResult[]>

interface StoredReport {
  version: 1
  testedAt: number
  sourceRevision: string
  samplesKey: string
  results: PracticeSampleResult[]
}

type StoredAttempt = Omit<PracticeAttempt, 'lastRun'>

interface StoredProblem extends Omit<PracticeProblem, 'attempts'> {
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

function parseReport(value: unknown): StoredReport {
  const item = record(value)
  if (item.version !== 1) throw new Error('Unsupported practice result format.')
  return {
    version: 1,
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

export class PracticeStore {
  private root: Promise<string> | undefined
  private pending: Promise<void> = Promise.resolve()
  private running = false

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

  private async problemDirectory(id: string): Promise<string> {
    return this.requireDirectory(join(await this.directory(), id))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.pending.then(operation)
    this.pending = job.then(() => undefined, () => undefined)
    return job
  }

  private async readJson(file: string): Promise<unknown> {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > maxMetadataBytes) throw new Error('Invalid practice metadata file.')
      const buffer = Buffer.allocUnsafe(stats.size)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))) as unknown
    } finally {
      await handle.close()
    }
  }

  private async readProblem(id: string): Promise<StoredProblem> {
    const directory = await this.problemDirectory(id)
    const value = record(await this.readJson(join(directory, 'problem.json')))
    if (value.version !== 1 || value.id !== id) throw new Error('Unsupported practice problem format.')
    return {
      ...fields(value), id, version: 1, revision: integer(value.revision, 'practice revision'),
      language: value.language === undefined ? 'c' : choice(value.language, supportedLanguages, 'practice language'),
      ...(value.catalogId === undefined ? {} : { catalogId: catalogIdentifier(value.catalogId) }),
      attempts: uniqueIds(list(value.attempts, maxAttempts, parseAttempt)),
    }
  }

  private reportName(attempt: StoredAttempt): string {
    return 'attempt-' + attempt.id + '.report.json'
  }

  private async readReport(problem: StoredProblem, attempt: StoredAttempt): Promise<StoredReport | undefined> {
    try {
      const directory = await this.problemDirectory(problem.id)
      return parseReport(await this.readJson(join(directory, this.reportName(attempt))))
    } catch {
      // A missing or unreadable result should not prevent access to the source or problem.
      return undefined
    }
  }

  private async publish(directory: string, name: string, value: StoredProblem | StoredReport): Promise<void> {
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

  private async attemptSource(problem: StoredProblem, attempt: StoredAttempt): Promise<{ path: string; token: string }> {
    const path = this.sourcePath(await this.problemDirectory(problem.id), attempt, problem.language)
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.size > BigInt(maxFileBytes) || await realpath(path) !== path) {
      throw new Error('The attempt must be a regular source file up to 2 MiB inside the practice library.')
    }
    return { path, token: revision(stats) }
  }

  private async view(problem: StoredProblem): Promise<PracticeProblem> {
    const { version: _version, catalogId: _catalogId, attempts, ...fields } = problem
    const key = samplesKey(fields.samples)
    return {
      ...fields,
      attempts: await Promise.all(attempts.map(async (attempt): Promise<PracticeAttempt> => {
        const lastRun = await this.readReport(problem, attempt)
        if (!lastRun) return attempt
        const source = await this.attemptSource(problem, attempt).catch(() => undefined)
        return {
          ...attempt,
          lastRun: {
            testedAt: lastRun.testedAt, results: lastRun.results,
            current: source?.token === lastRun.sourceRevision && lastRun.samplesKey === key,
          },
        }
      })),
    }
  }

  private async problemIds(): Promise<string[]> {
    const ids: string[] = []
    const directory = await opendir(await this.directory())
    let seen = 0
    for await (const entry of directory) {
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

  async get(value: unknown): Promise<PracticeProblem> {
    return this.view(await this.readProblem(identifier(value)))
  }

  browse(value: unknown): PracticeChallengeSummary[] {
    const filters = record(value)
    if (filters.language !== undefined) choice(filters.language, supportedLanguages, 'practice language')
    const topic = filters.topic === undefined ? undefined : choice(filters.topic, practiceTopics, 'practice topic')
    const difficulty = choice(filters.difficulty, catalogDifficulties, 'practice difficulty')
    return practiceChallenges.filter((item) => item.difficulty === difficulty && (topic === undefined || item.topic === topic))
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
        await this.writeSource(staging, attempt, language, starters[language])
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

  async runSamples(value: unknown, attemptValue: unknown, execute: RunSamples): Promise<PracticeProblem> {
    const id = identifier(value)
    const attemptId = identifier(attemptValue)
    if (this.running) throw new Error('Practice samples are already running.')
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
