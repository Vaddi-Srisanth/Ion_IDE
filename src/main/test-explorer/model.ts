import { createHash, randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { TestAdapter, TestCaseResult, TestNode, TestRun, TestSnapshot } from '../../shared/test-explorer'

export const maxTestRecordBytes = 4 * 1024 * 1024
export const testLimits = { cases: 1000, nodes: 2500, sources: 2000, sourceBytes: 16 * 1024 * 1024,
  reportBytes: 2 * 1024 * 1024, outputBytes: 256 * 1024, discoveryMs: 60_000, runMs: 300_000, history: 10 } as const
export interface StoredTests { schema: 1; snapshot: TestSnapshot; selectors: Record<string, string>; sources: Record<string, string> }
const uuid = /^[0-9a-f-]{36}$/i
const idPattern = /^[0-9a-f]{64}$/
export const testId = (value: string) => createHash('sha256').update(value).digest('hex')
export function testAdapter(value: unknown): TestAdapter {
  if (value !== 'pytest' && value !== 'vitest' && value !== 'junit') throw new Error('Choose a supported test framework.')
  return value
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid test record.')
  const row = value as Record<string, unknown>
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))) throw new Error('Invalid test record fields.')
  return row
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || value.includes('\0')) throw new Error('Invalid or oversized test text.')
  return value
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid test number.')
  return value
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Invalid test flag.'); return value }
function id(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid test identity.'); return value }
export function relativeTestPath(value: unknown): string {
  const path = text(value, 1024)
  if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..'
    || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('Test location is not a safe relative file.')
  return path
}
export function validateSelector(value: unknown): string {
  const selector = text(value, 2048)
  const boundary = selector.indexOf('::')
  relativeTestPath(boundary < 0 ? selector : selector.slice(0, boundary))
  if (/[\x00-\x1f\x7f]/.test(selector)) throw new Error('Invalid test selector.')
  return selector
}
function location(value: unknown) {
  const row = object(value, ['path', 'line'])
  return { path: relativeTestPath(row.path), line: integer(row.line, 1, 10_000_000) }
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Test collection exceeds its limit.')
  return value
}
function node(value: unknown): TestNode {
  const row = object(value, ['id', 'parentId', 'kind', 'label'], ['location'])
  if (!['suite', 'file', 'test'].includes(String(row.kind))) throw new Error('Invalid test node.')
  return { id: id(row.id), parentId: row.parentId === null ? null : id(row.parentId), kind: row.kind as TestNode['kind'], label: text(row.label, 2048),
    ...(row.location === undefined ? {} : { location: location(row.location) }) }
}
function result(value: unknown): TestCaseResult {
  const row = object(value, ['id', 'outcome', 'durationMs', 'message', 'output'], ['location', 'label'])
  if (!['passed', 'failed', 'skipped', 'error', 'cancelled'].includes(String(row.outcome))) throw new Error('Invalid test outcome.')
  return { id: id(row.id), outcome: row.outcome as TestCaseResult['outcome'], durationMs: integer(row.durationMs),
    message: text(row.message), output: text(row.output), ...(row.location === undefined ? {} : { location: location(row.location) }),
    ...(row.label === undefined ? {} : { label: text(row.label) }) }
}
function run(value: unknown): TestRun {
  const row = object(value, ['id', 'checkedAt', 'durationMs', 'status', 'selectedIds', 'cases', 'stale'], ['restored', 'adapter'])
  if (!uuid.test(String(row.id)) || !['completed', 'cancelled', 'failed'].includes(String(row.status))) throw new Error('Invalid test run.')
  const selectedIds = array(row.selectedIds, testLimits.cases).map(id), cases = array(row.cases, testLimits.cases).map(result)
  if (new Set(selectedIds).size !== selectedIds.length || new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => !selectedIds.includes(c.id))) throw new Error('Invalid test run references.')
  return { id: row.id as string, checkedAt: integer(row.checkedAt), durationMs: integer(row.durationMs), status: row.status as TestRun['status'],
    selectedIds, cases, stale: bool(row.stale), ...(row.restored === undefined ? {} : { restored: bool(row.restored) }),
    ...(row.adapter === undefined ? {} : { adapter: testAdapter(row.adapter) }) }
}
export function validateStoredTests(value: unknown): StoredTests {
  const row = object(value, ['schema', 'snapshot', 'selectors', 'sources'])
  if (row.schema !== 1) throw new Error('Unsupported stored test version.')
  const s = object(row.snapshot, ['root', 'revision', 'adapter', 'discoveredAt', 'nodes', 'history', 'stale'])
  const root = text(s.root, 4096)
  // Roots are inert association metadata here. Native authority is checked by the service, never this portable validator.
  if (!(posix.isAbsolute(root) || win32.isAbsolute(root)) || /[\x00-\x1f\x7f]/.test(root) || !uuid.test(String(s.revision))) throw new Error('Invalid stored test identity.')
  const adapter = testAdapter(s.adapter)
  const nodes = array(s.nodes, testLimits.nodes).map(node), ids = new Set(nodes.map(n => n.id))
  if (ids.size !== nodes.length || nodes.filter(n => n.kind === 'test').length > testLimits.cases) throw new Error('Invalid test tree.')
  const byId = new Map(nodes.map(n => [n.id, n]))
  for (const n of nodes) {
    let ancestor = n, depth = 0
    while (ancestor.parentId !== null) {
      const parent = byId.get(ancestor.parentId)
      if (!parent || parent.kind === 'test' || ++depth > 32) throw new Error('Invalid or cyclic test tree.')
      ancestor = parent
    }
  }
  const selectors: Record<string, string> = {}, sources: Record<string, string> = {}
  if (!row.selectors || typeof row.selectors !== 'object' || Array.isArray(row.selectors) || Object.keys(row.selectors).length > testLimits.cases
    || !row.sources || typeof row.sources !== 'object' || Array.isArray(row.sources) || Object.keys(row.sources).length > testLimits.sources) throw new Error('Invalid test source map.')
  for (const [key, value] of Object.entries(row.selectors)) {
    if (byId.get(id(key))?.kind !== 'test') throw new Error('Unknown test selector.')
    selectors[key] = validateSelector(value)
  }
  if (nodes.some(n => n.kind === 'test' && !selectors[n.id])) throw new Error('Missing test selector.')
  for (const [path, token] of Object.entries(row.sources)) sources[relativeTestPath(path)] = text(token, 256)
  const snapshot: TestSnapshot = { root, revision: s.revision as string, adapter, discoveredAt: integer(s.discoveredAt), nodes,
    history: array(s.history, testLimits.history).map(run), stale: bool(s.stale) }
  const checked: StoredTests = { schema: 1, snapshot, selectors, sources }
  if (Buffer.byteLength(JSON.stringify(checked)) > maxTestRecordBytes) throw new Error('Stored tests exceed their size limit.')
  return checked
}
export const validateStoredTestSnapshot = validateStoredTests
export function restoreStoredTests(value: unknown): StoredTests {
  const record = validateStoredTests(value)
  return { schema: 1, snapshot: { ...record.snapshot, revision: randomUUID(), nodes: [], stale: true,
    history: record.snapshot.history.map(run => ({ ...run, stale: true, restored: true })) }, selectors: {}, sources: {} }
}
export function selectedTestIds(record: StoredTests, requested: unknown): string[] {
  const selected = array(requested, testLimits.nodes).map(id)
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('Choose distinct tests or groups.')
  const byId = new Map(record.snapshot.nodes.map(n => [n.id, n]))
  if (selected.some(value => !byId.has(value))) throw new Error('The selected test no longer exists. Discover again.')
  return record.snapshot.nodes.filter(n => {
    if (n.kind !== 'test') return false
    let current: TestNode | undefined = n
    while (current) { if (selected.includes(current.id)) return true; current = current.parentId ? byId.get(current.parentId) : undefined }
    return false
  }).map(n => n.id)
}
