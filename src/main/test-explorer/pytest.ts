import { constants } from 'node:fs'
import { access, open, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, join, relative, sep } from 'node:path'
import type { TestCaseResult, TestNode } from '../../shared/test-explorer'
import type { WorkspaceFiles } from '../files'
import { isWithin, revision } from '../files'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { type execute } from '../runner'
import { relativeTestPath, testId, testLimits, text, validateSelector } from './model'
import { pytestHelper } from './pytest-helper'

export interface TestPlan {
  executable: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; timeoutMs: number
  report: string; operation: 'discover' | 'run'
}
export interface CollectedCase { selector: string; label: string; location: { path: string; line: number } }
export interface FrameworkCase extends Omit<TestCaseResult, 'id'> { selector: string; finished: boolean }
export interface PytestReport { nodes: CollectedCase[]; cases: FrameworkCase[]; errors: string[]; durationMs: number; exitCode: number; complete: boolean }
export type TestExecute = typeof execute

export async function trustedPython(roots: readonly string[]): Promise<string> {
  if (!roots.length) throw new Error('Open a workspace first.')
  const allowed = new Set((await commandPaths(roots[0])).filter(path => roots.every(root => !isWithin(root, path))))
  const paths = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...allowed])].filter(path => allowed.has(path))
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const tool = await onPath(name, roots[0], paths, process.platform === 'darwin' ? ['/usr/bin/python3'] : [])
    // Keep the approved lexical venv launcher: resolving it would change Python's sys.prefix.
    if (tool && await safeTool(tool, roots)) return tool
  }
  throw new Error('Install Python and pytest outside your workspace, then add Python to PATH. Ion does not download tools automatically.')
}
export async function safeTool(tool: string, roots: readonly string[]): Promise<boolean> {
  try {
    const canonical = await realpath(tool)
    if (roots.some(root => isWithin(root, tool) || isWithin(root, canonical)) || !(await stat(canonical)).isFile()) return false
    await access(canonical, constants.X_OK)
    return true
  } catch { return false }
}

const excluded = new Set(['.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'build', 'dist', 'target', '.tox', '.nox'])
export async function sourceRevisions(scope: WorkspaceFiles, root: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const result: Record<string, string> = {}; let visited = 0, bytes = 0
  async function walk(path: string, depth: number) {
    signal?.throwIfAborted()
    if (depth > 32) throw new Error('Test workspace exceeds the inspection depth limit.')
    for (const entry of await scope.list(path)) {
      signal?.throwIfAborted()
      if (++visited > 10_000) throw new Error('Test workspace exceeds the bounded inspection limit. Open a smaller root.')
      if (entry.kind === 'folder') { if (!excluded.has(entry.name)) await walk(entry.path, depth + 1); continue }
      if (!entry.name.endsWith('.py') && !['pytest.ini', '.pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].includes(entry.name)) continue
      if (Object.keys(result).length >= testLimits.sources) throw new Error('Too many Python/configuration files. Open a smaller root.')
      const inspected = await scope.inspect(entry.path, 'file')
      bytes += Number(inspected.stats.size)
      if (bytes > testLimits.sourceBytes) throw new Error('Python/configuration sources exceed the 16 MiB inspection limit.')
      result[relativeTestPath(relative(root, entry.path).split(sep).join('/'))] = revision(inspected.stats)
    }
  }
  await walk(root, 0)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

export async function preparePytest(root: string, roots: readonly string[], scratch: string, operation: 'discover' | 'run', selectors: string[],
  resolvePython: (roots: readonly string[]) => Promise<string> = trustedPython): Promise<TestPlan> {
  const executable = await resolvePython(roots)
  if (!await safeTool(executable, roots)) throw new Error('Python must be a trusted executable outside every workspace root.')
  const helper = join(scratch, 'ion_pytest.py'), request = join(scratch, 'request.json'), report = join(scratch, 'report.json')
  await writeFile(helper, pytestHelper, { mode: 0o600, flag: 'wx' })
  await writeFile(request, JSON.stringify({ root, operation, selectors: selectors.map(validateSelector) }), { mode: 0o600, flag: 'wx' })
  const paths = (await commandPaths(root)).filter(path => roots.every(r => !isWithin(r, path)))
  const environment = { ...envFor(paths, scratch), PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
  return { executable, args: ['-I', '-B', helper, request, report], cwd: root, environment,
    timeoutMs: operation === 'discover' ? testLimits.discoveryMs : testLimits.runMs, report, operation }
}

export async function readPytestReport(plan: TestPlan, allowPartial = false): Promise<PytestReport> {
  if (await realpath(plan.report) !== plan.report) throw new Error('The test report path changed.')
  const handle = await open(plan.report, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let value: unknown
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > testLimits.reportBytes) throw new Error('Invalid or oversized test report.')
    const bytes = Buffer.alloc(info.size + 1); let length = 0
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
    if (length !== info.size) throw new Error('Test report changed while reading.')
    const data = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    const lines = data.split('\n')
    if (lines.at(-1) !== '' && !allowPartial) throw new Error('Truncated pytest report.')
    lines.pop() // A killed process may leave an incomplete final event; preserve earlier complete events.
    let collected: unknown[] | undefined, footer: Record<string, unknown> | undefined
    const outcomes: unknown[] = []
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>
      if (!event || typeof event !== 'object' || footer) throw new Error('Invalid pytest event sequence.')
      if (event.kind === 'collection' && !collected && Array.isArray(event.nodes)) collected = event.nodes
      else if (event.kind === 'case' && collected) outcomes.push(event.case)
      else if (event.kind === 'complete') footer = event
      else throw new Error('Invalid pytest event sequence.')
    }
    if (!footer && !allowPartial) throw new Error('Pytest did not finish its report.')
    value = { ...(footer ?? { version: 1, complete: false, exitCode: 2, durationMs: 0, errors: [] }), nodes: collected ?? [], cases: outcomes }
  } finally { await handle.close() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pytest report.')
  const row = value as Record<string, unknown>
  if (row.version !== 1 || (row.complete !== true && !allowPartial) || !Number.isSafeInteger(row.exitCode) || Number(row.exitCode) < 0 || Number(row.exitCode) > 5
    || !Number.isSafeInteger(row.durationMs) || Number(row.durationMs) < 0 || !Array.isArray(row.nodes) || row.nodes.length > testLimits.cases
    || !Array.isArray(row.cases) || row.cases.length > testLimits.cases || !Array.isArray(row.errors) || row.errors.length > 16) throw new Error('Incomplete or oversized pytest report.')
  const location = (value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid pytest location.')
    const loc = value as Record<string, unknown>
    if (!Number.isSafeInteger(loc.line) || Number(loc.line) < 1 || Number(loc.line) > 10_000_000) throw new Error('Invalid pytest line.')
    return { path: relativeTestPath(loc.path), line: Number(loc.line) }
  }
  const nodes = row.nodes.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid collected test.')
    const n = value as Record<string, unknown>, selector = validateSelector(n.selector), loc = location(n.location)
    if (selector.split('::')[0] !== loc.path) throw new Error('Pytest selector and location disagree.')
    return { selector, label: text(n.label), location: loc }
  })
  if (new Set(nodes.map(n => n.selector)).size !== nodes.length) throw new Error('Duplicate pytest identities.')
  const cases = row.cases.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid pytest case.')
    const c = value as Record<string, unknown>, selector = validateSelector(c.selector)
    const loc = location(c.location), collected = nodes.find(n => n.selector === selector)
    if (!nodes.some(n => n.selector === selector) || !['passed', 'failed', 'skipped', 'error'].includes(String(c.outcome))
      || !Number.isSafeInteger(c.durationMs) || Number(c.durationMs) < 0 || typeof c.finished !== 'boolean'
      || loc.path !== collected?.location.path || loc.line !== collected.location.line) throw new Error('Invalid pytest outcome.')
    return { selector, outcome: c.outcome as FrameworkCase['outcome'], durationMs: Number(c.durationMs), message: text(c.message), output: text(c.output),
      location: loc, finished: c.finished }
  })
  if (new Set(cases.map(c => c.selector)).size !== cases.length) throw new Error('Duplicate pytest outcomes.')
  return { nodes, cases, errors: row.errors.map(value => text(value)), durationMs: Number(row.durationMs), exitCode: Number(row.exitCode), complete: row.complete === true }
}

export function testTree(collected: CollectedCase[]) {
  const suiteId = testId('pytest'), nodes: TestNode[] = [{ id: suiteId, parentId: null, kind: 'suite', label: 'pytest' }]
  const selectors: Record<string, string> = {}, groups = new Set<string>()
  for (const item of collected) {
    const file = item.location.path, groupId = testId('file:' + file)
    if (!groups.has(groupId)) { groups.add(groupId); nodes.push({ id: groupId, parentId: suiteId, kind: 'file', label: file, location: { path: file, line: 1 } }) }
    const id = testId('pytest:' + item.selector)
    nodes.push({ id, parentId: groupId, kind: 'test', label: item.label || basename(file), location: item.location })
    selectors[id] = item.selector
  }
  return { nodes, selectors }
}
