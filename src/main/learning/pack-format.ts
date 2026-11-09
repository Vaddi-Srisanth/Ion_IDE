import {
  diagnosticPackIds, packCategories, packDifficulties, packKinds,
  type PackDetails, type PackLesson, type PackMetadata, type PackReference, type PackSummary, type PackTopic,
} from '../../shared/learning-packs'

export const maxLessons = 64
export const maxPacks = 128
export const maxLearningPackBytes = 256 * 1024
export const maxLearningLibraryBytes = 2 * 1024 * 1024
export const maxPackLessonBytes = 48 * 1024
export const maxPackIndexBytes = 256 * 1024

export const coreSummaryKeys = ['id', 'name', 'summary', 'version', 'topicCount'] as const
const topicKeys = ['id', 'title', 'section'] as const
const topicOptions = ['difficulty', 'prerequisites', 'related', 'keywords'] as const
const lessonKeys = [...topicKeys, 'explanation', 'example', 'api', 'practice'] as const
const lessonOptions = ['pitfall', 'exampleFile', 'exampleMode', 'expectedOutput', 'references', 'exercise', ...topicOptions] as const
const metadataKeys = ['kind', 'categories', 'languageVersion', 'prerequisites', 'miniProject', 'references', 'attribution'] as const
const reserved = /^(?:index|library|aux|con|nul|prn|com[0-9]|lpt[0-9])$/
const releaseVersion = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const legacyIds = ['c', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'python', 'rust', 'sql', 'typescript']

interface PackDefinition {
  schema: 1 | 2
  id: string
  name: string
  summary: string
  version: number
  lessons: PackLesson[]
  metadata?: PackMetadata
}

export interface PackManifest {
  schema: 1 | 2
  id: string
  name: string
  summary: string
  version: number
  metadata?: PackMetadata
  topics: PackTopic[]
}

export function hasKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

export function isTopicId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && value === value.trim()
}

export function isId(value: unknown): value is string {
  return isTopicId(value) && !reserved.test(value)
}

function text(value: unknown, limit: number, multiline = false, empty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (empty || value.trim().length > 0)
    && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function optional(value: Record<string, unknown>, key: string, validate: (field: unknown) => boolean): boolean {
  return !Object.hasOwn(value, key) || validate(value[key])
}

function array(value: unknown, max: number, validate: (field: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= max && value.every(validate)
}

function choice<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.some((option) => option === value)
}

function unique(value: unknown, max: number, validate: (field: unknown) => boolean): boolean {
  return Array.isArray(value) && array(value, max, validate) && new Set(value).size === value.length
}

function version(value: unknown): value is string {
  return typeof value === 'string' && releaseVersion.test(value)
}

export function isCompatible(minimum: string | undefined, current: string): boolean {
  if (!minimum) return true
  const match = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(current)
  if (!match || !version(match[1])) return false
  const installed = match[1].split('.').map(Number)
  const requested = minimum.split('.').map(Number)
  for (let part = 0; part < 3; part++) {
    if (installed[part] !== requested[part]) return installed[part] > requested[part]
  }
  return true
}

function reference(value: unknown): value is PackReference {
  if (!hasKeys(value, ['title', 'url']) || !text(value.title, 100) || !text(value.url, 500)) return false
  if (!/^https:\/\//i.test(value.url)) return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.port
  } catch {
    return false
  }
}

function metadata(value: unknown): value is PackMetadata {
  return hasKeys(value, metadataKeys, ['minimumIonVersion']) && choice(value.kind, packKinds)
    && Array.isArray(value.categories) && value.categories.length > 0
    && unique(value.categories, packCategories.length, (item) => choice(item, packCategories))
    && text(value.languageVersion, 120)
    && array(value.prerequisites, 12, (item) => text(item, 240))
    && text(value.miniProject, 2000, true) && Array.isArray(value.references) && value.references.length > 0
    && array(value.references, 12, reference)
    && hasKeys(value.attribution, ['author', 'license']) && text(value.attribution.author, 120)
    && text(value.attribution.license, 120) && optional(value, 'minimumIonVersion', version)
}

function topic(value: Record<string, unknown>): boolean {
  return isTopicId(value.id) && text(value.title, 120) && text(value.section, 48)
    && optional(value, 'difficulty', (item) => choice(item, packDifficulties))
    && optional(value, 'prerequisites', (items) => unique(items, 12, isTopicId))
    && optional(value, 'related', (items) => unique(items, 12, isTopicId))
    && optional(value, 'keywords', (items) => unique(items, 12, (item) => text(item, 48)))
}

export function isLesson(value: unknown): value is PackLesson {
  return hasKeys(value, lessonKeys, lessonOptions) && topic(value)
    && text(value.explanation, 6000, true) && text(value.example, 8000, true, true) && text(value.practice, 2000, true)
    && optional(value, 'pitfall', (item) => text(item, 2000, true))
    && optional(value, 'exampleFile', (item) => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}\.[a-zA-Z0-9]{1,10}$/.test(item))
    && optional(value, 'exampleMode', (item) => item === 'program' || item === 'fragment')
    && optional(value, 'expectedOutput', (item) => text(item, 4000, true, true))
    && optional(value, 'references', (items) => array(items, 8, reference))
    && optional(value, 'exercise', (exercise) => hasKeys(exercise, ['expected', 'completion'], ['samples'])
      && text(exercise.expected, 2000, true) && text(exercise.completion, 1000, true)
      && optional(exercise, 'samples', (items) => array(items, 8, (item) =>
        hasKeys(item, ['input', 'expectedOutput']) && text(item.input, 4096, true, true)
        && text(item.expectedOutput, 4096, true, true))))
    && array(value.api, 24, (entry) => hasKeys(entry, ['name', 'description'])
      && text(entry.name, 100) && text(entry.description, 600, true))
}

export function lessonByteLimit(schema: PackDefinition['schema']): number {
  return schema === 1 ? maxLearningPackBytes : maxPackLessonBytes
}

function validTopics(topics: PackTopic[]): boolean {
  const byId = new Map(topics.map((item) => [item.id, item]))
  if (byId.size !== topics.length) return false
  // Prerequisites point to an earlier lesson. Related topics may point either way.
  const earlier = new Set<string>()
  for (const item of topics) {
    if (item.prerequisites?.some((id) => !earlier.has(id)) || item.related?.some((id) => id === item.id || !byId.has(id))) return false
    earlier.add(item.id)
  }
  return true
}

export function parsePack(value: unknown): PackDefinition {
  if (!hasKeys(value, ['schema', 'id', 'name', 'summary', 'version', 'lessons'], ['metadata'])
    || (value.schema !== 1 && value.schema !== 2) || !isId(value.id) || !text(value.name, 72)
    || !text(value.summary, 360) || !positive(value.version) || !Array.isArray(value.lessons)
    || value.lessons.length < 1 || value.lessons.length > maxLessons || !value.lessons.every(isLesson)
    || (value.schema === 2 && !value.lessons.every((lesson) => packBytes(lesson) <= maxPackLessonBytes))
    || !validTopics(value.lessons)
    || (value.schema === 2 ? !metadata(value.metadata) : Object.hasOwn(value, 'metadata'))
    || packBytes(value) > maxLearningPackBytes) {
    throw new Error('Invalid learning pack. Check its schema version, fields, lesson IDs, prerequisites, and size.')
  }
  return value as unknown as PackDefinition
}

export function packBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data)) + 1
}

export function topicIndex({ id, title, section, difficulty, prerequisites, related, keywords }: PackTopic): PackTopic {
  return { id, title, section, ...(difficulty && { difficulty }), ...(prerequisites && { prerequisites }),
    ...(related && { related }), ...(keywords && { keywords }) }
}

export function manifestFor(pack: PackDefinition): PackManifest {
  const { schema, id, name, summary, version, metadata } = pack
  return { schema, id, name, summary, version, ...(metadata && { metadata }), topics: pack.lessons.map(topicIndex) }
}

export function parseManifest(value: unknown): PackManifest {
  if (!hasKeys(value, ['schema', 'id', 'name', 'summary', 'version', 'topics'], ['metadata'])
    || (value.schema !== 1 && value.schema !== 2) || !isId(value.id) || !text(value.name, 72) || !text(value.summary, 360)
    || !positive(value.version) || (value.schema === 2 ? !metadata(value.metadata) : Object.hasOwn(value, 'metadata'))
    || !Array.isArray(value.topics)
    || !value.topics.length || value.topics.length > maxLessons
    || !value.topics.every((item: unknown) => hasKeys(item, topicKeys, topicOptions) && topic(item))
    || !validTopics(value.topics as PackTopic[])) throw new Error('The installed learning pack index is invalid.')
  return value as unknown as PackManifest
}

export function isSummary(value: unknown): value is PackSummary {
  return hasKeys(value, coreSummaryKeys, ['kind', 'categories', 'languageVersion', 'author', 'license', 'byteSize',
    'difficulties', 'keywords', 'offline', 'source', 'diagnostics', 'minimumIonVersion', 'storage'])
    && isId(value.id) && text(value.name, 72) && text(value.summary, 360) && positive(value.version)
    && positive(value.topicCount) && value.topicCount <= maxLessons
    && optional(value, 'kind', (item) => choice(item, packKinds))
    && optional(value, 'categories', (items) => unique(items, packCategories.length, (item) => choice(item, packCategories)))
    && optional(value, 'languageVersion', (item) => text(item, 120))
    && optional(value, 'author', (item) => text(item, 120))
    && optional(value, 'license', (item) => text(item, 120))
    && optional(value, 'byteSize', (item) => positive(item) && item <= maxLearningPackBytes)
    && optional(value, 'difficulties', (items) => unique(items, packDifficulties.length, (item) => choice(item, packDifficulties)))
    && optional(value, 'keywords', (items) => unique(items, 128, (item) => text(item, 120)))
    && optional(value, 'offline', (item) => item === true)
    && optional(value, 'source', (item) => item === 'catalog' || item === 'local')
    && optional(value, 'diagnostics', (item) => typeof item === 'boolean')
    && optional(value, 'minimumIonVersion', version)
    && optional(value, 'storage', (item) => typeof item === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item))
}

export function isSummaryList(value: unknown): value is PackSummary[] {
  return Array.isArray(value) && value.length <= maxPacks && value.every(isSummary)
    && new Set(value.map(({ id }) => id)).size === value.length
}

export function legacySource(id: string): 'catalog' | 'local' {
  return legacyIds.includes(id) ? 'catalog' : 'local'
}

export function describe(pack: PackDefinition, source: 'catalog' | 'local'): PackSummary {
  const { id, name, summary, version, lessons, metadata: info } = pack
  const diagnostics = source === 'catalog' && diagnosticPackIds.some((item) => item === id)
  const categories = info?.categories ?? (source === 'catalog'
    ? id === 'sql' ? ['web', 'data'] as const
      : ['html', 'css'].includes(id) ? ['web'] as const : ['core'] as const : [])
  const kind = info?.kind ?? (id === 'sql' ? 'query' : id === 'html' ? 'markup' : id === 'css' ? 'stylesheet' : 'language')
  const keywords = [...new Set([...lessons.map(({ title }) => title),
    ...lessons.flatMap(({ section, keywords }) => [section, ...(keywords ?? [])])])]
    .slice(0, 128)
  return {
    id, name, summary, version, topicCount: lessons.length, kind, categories: [...categories],
    byteSize: packBytes(pack), source, offline: true, diagnostics, keywords,
    difficulties: packDifficulties.filter((difficulty) => lessons.some((lesson) => (lesson.difficulty ?? 'beginner') === difficulty)),
    ...(info && { languageVersion: info.languageVersion, author: info.attribution.author, license: info.attribution.license }),
    ...(info?.minimumIonVersion && { minimumIonVersion: info.minimumIonVersion }),
  }
}

export function details(pack: PackSummary, topics: PackTopic[], info?: PackMetadata): PackDetails {
  return { pack, topics, prerequisites: info?.prerequisites ?? [], references: info?.references ?? [],
    ...(info?.miniProject && { miniProject: info.miniProject }) }
}
