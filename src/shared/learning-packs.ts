import type { Entry } from './contracts'

export const packCategories = ['core', 'web', 'automation', 'data', 'systems'] as const
export const packDifficulties = ['beginner', 'intermediate', 'advanced'] as const
export const packKinds = ['language', 'markup', 'stylesheet', 'query', 'data-format', 'framework'] as const
export type PackCategory = typeof packCategories[number]
export type PackDifficulty = typeof packDifficulties[number]
export type PackKind = typeof packKinds[number]

export const diagnosticPackIds = ['c', 'java', 'python', 'cpp', 'javascript'] as const

export interface PackReference {
  title: string
  url: string
}

export interface PackMetadata {
  kind: PackKind
  categories: PackCategory[]
  languageVersion: string
  prerequisites: string[]
  miniProject: string
  references: PackReference[]
  attribution: { author: string; license: string }
  minimumIonVersion?: string
}

export interface PackSummary {
  id: string
  name: string
  summary: string
  version: number
  topicCount: number
  kind?: PackKind
  categories?: PackCategory[]
  languageVersion?: string
  author?: string
  license?: string
  byteSize?: number
  difficulties?: PackDifficulty[]
  keywords?: string[]
  offline?: true
  source?: 'catalog' | 'local'
  diagnostics?: boolean
  minimumIonVersion?: string
}

export interface PackTopic {
  id: string
  title: string
  section: string
  difficulty?: PackDifficulty
  prerequisites?: string[]
  related?: string[]
  keywords?: string[]
}

export interface PackExercise {
  expected: string
  completion: string
  samples?: { input: string; expectedOutput: string }[]
}

export interface PackLesson extends PackTopic {
  explanation: string
  example: string
  api: Array<{ name: string; description: string }>
  practice: string
  pitfall?: string
  exampleFile?: string
  exampleMode?: 'program' | 'fragment'
  expectedOutput?: string
  references?: PackReference[]
  exercise?: PackExercise
}

export interface PackDetails {
  pack: PackSummary
  topics: PackTopic[]
  prerequisites: string[]
  references: PackReference[]
  miniProject?: string
}

export interface PackImportPreview {
  token: string
  details: PackDetails
  update: boolean
}

export interface PackLibrary {
  catalog: PackSummary[]
  installed: PackSummary[]
  selected: string | null
  recent?: string[]
}

export interface LearningPacksBridge {
  getLibrary(includeCatalog?: boolean): Promise<PackLibrary>
  install(id: string): Promise<PackLibrary>
  remove(id: string): Promise<PackLibrary>
  select(id: string | null, includeCatalog?: boolean): Promise<PackLibrary>
  previewImport(): Promise<PackImportPreview | null>
  confirmImport(token: string): Promise<PackLibrary>
  discardImport(token: string): Promise<void>
  exportPack(id: string): Promise<boolean>
  getDetails(id: string): Promise<PackDetails>
  getTopics(id: string): Promise<PackTopic[]>
  getLesson(id: string, topic: string): Promise<PackLesson>
  startExercise(id: string, topic: string): Promise<{ entry: Entry; problemId: string }>
}
