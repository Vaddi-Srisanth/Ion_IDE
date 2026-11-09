import type { Entry } from './contracts'
import type { RunLanguage } from './run-console'

export const catalogDifficulties = ['Easy', 'Medium', 'Hard'] as const
export const practiceDifficulties = ['Unrated', ...catalogDifficulties] as const
export const practiceCompletion = ['Not started', 'In progress', 'Completed'] as const
export const practiceLanguages = {
  python: 'Python', javascript: 'JavaScript', java: 'Java', c: 'C', cpp: 'C++',
} satisfies Record<RunLanguage, string>
export const practiceTopics = [
  'Basics', 'Strings', 'Arrays', 'Hash maps', 'Sorting', 'Search',
  'Stacks and queues', 'Graphs', 'Dynamic programming',
] as const
export const maxPracticeSamples = 8

export type CatalogDifficulty = typeof catalogDifficulties[number]
export type PracticeTopic = typeof practiceTopics[number]
export type PracticeDifficulty = typeof practiceDifficulties[number]
export type PracticeCompletion = typeof practiceCompletion[number]

export interface PracticeFilters {
  language?: RunLanguage
  topic?: PracticeTopic
  difficulty: CatalogDifficulty
}

export interface PracticeChallengeSummary {
  id: string
  title: string
  topic: PracticeTopic
  difficulty: CatalogDifficulty
}

export interface PracticeChallenge extends PracticeChallengeSummary {
  statement: string
  samples: readonly Omit<PracticeSample, 'id'>[]
}

export interface PracticeSample {
  id: string
  label: string
  input: string
  expectedOutput: string
}

export interface PracticeFields {
  title: string
  sourceUrl: string
  difficulty: PracticeDifficulty
  topic: string
  completion: PracticeCompletion
  statement: string
  notes: string
  samples: PracticeSample[]
}

export interface PracticeDraft extends PracticeFields {
  id?: string
  revision?: number
  language?: RunLanguage
}

export type PracticeSampleStatus = 'passed' | 'failed' | 'unavailable' | 'skipped'

export interface PracticeSampleResult {
  id: string
  label: string
  status: PracticeSampleStatus
  message: string
  expected: string
  stdout: string
  stderr: string
}

export interface PracticeReport {
  testedAt: number
  current: boolean
  results: PracticeSampleResult[]
}

export interface PracticeAttempt {
  id: string
  label: string
  createdAt: number
  lastRun?: PracticeReport
}

export interface PracticeProblem extends PracticeFields {
  id: string
  revision: number
  language: RunLanguage
  attempts: PracticeAttempt[]
}

export interface PracticeSummary {
  id: string
  title: string
  difficulty: PracticeDifficulty
  topic: string
  completion: PracticeCompletion
  language: RunLanguage
}

export interface PracticeLibrary {
  problems: PracticeSummary[]
  unavailable: number
}

export interface PracticeBridge {
  browse(filters: PracticeFilters): Promise<PracticeChallengeSummary[]>
  getChallenge(challengeId: string): Promise<PracticeChallenge>
  start(challengeId: string, language: RunLanguage): Promise<{ problem: PracticeProblem; attempt: PracticeAttempt; entry: Entry }>
  list(): Promise<PracticeLibrary>
  get(problemId: string): Promise<PracticeProblem>
  save(draft: PracticeDraft): Promise<PracticeProblem>
  createAttempt(problemId: string, label: string): Promise<{ problem: PracticeProblem; attempt: PracticeAttempt }>
  openAttempt(problemId: string, attemptId: string): Promise<Entry>
  runSamples(problemId: string, attemptId: string): Promise<PracticeProblem>
}
