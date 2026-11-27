// Vitest collects a module again when running it. Its IDs depend on declaration order.
// Check the worker's actual names and lines before any body in that file can execute.
export const vitestSelectionGuard = String.raw`import { readFileSync, realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
const { root, approved } = JSON.parse(readFileSync(selectionFile, 'utf8'))
const identities = new Set(approved)
beforeAll(({}, file) => {
  const path = relative(root, realpathSync(file.filepath)).split(sep).join('/')
  function check(suite) {
    for (const task of suite.tasks) {
      if (task.mode === 'skip' || task.mode === 'todo') continue
      if (task.type === 'suite') { check(task); continue }
      const identity = [path, file.projectName || '', task.id, task.fullTestName, task.location?.line ?? 1]
      if (!identities.has(JSON.stringify(identity))) throw new Error('Vitest test identity changed before execution. Discover the tests again.')
    }
  }
  check(file)
})
`

/** Runs only after native approval, in the existing owned/cancellable process tree. No Vitest runtime dependency in Ion. */
export const vitestHelper = String.raw`import { openSync, readFileSync, writeFileSync, writeSync, closeSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [requestFile, reportFile] = process.argv.slice(2)
const request = JSON.parse(readFileSync(requestFile, 'utf8'))
const root = realpathSync(request.root), started = performance.now()
const stream = openSync(reportFile, 'wx', 0o600)
let written = 0, context, collected = false, running = false, exitCode = 3
const errors = [], selected = new Map(), emitted = new Set(), logs = new Map()
let logged = 0
function clip(value, limit = 2048) {
  const bytes = Buffer.from(String(value ?? '').replaceAll('\0', ''))
  if (bytes.length <= limit) return bytes.toString('utf8')
  let end = limit
  while (end && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}
function fail(error) { if (errors.length < 16) errors.push(clip(error?.stack || error?.message || error)) }
function emit(row, footer = false) {
  const data = Buffer.from(JSON.stringify(row) + '\n')
  if (written + data.length > 2 * 1024 * 1024 - (footer ? 0 : 40 * 1024)) throw new Error('Ion test report exceeded 2 MiB.')
  let offset = 0
  while (offset < data.length) offset += writeSync(stream, data, offset, data.length - offset)
  written += data.length
}
function inside(path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
function file(path) {
  if (!isAbsolute(path) || !inside(path)) throw new Error('Vitest test/configuration escaped the selected root.')
  const canonical = realpathSync(path)
  if (!inside(canonical) || !statSync(canonical).isFile()) throw new Error('Vitest test/configuration must be an in-root regular file.')
  const rel = relative(root, canonical).split(sep).join('/')
  if (!rel || rel.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(rel) || rel.split('/').some(part => !part || part === '.' || part === '..'
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe Vitest source location.')
  return rel
}
function node(test) {
  const path = file(test.module.moduleId)
  const identity = [test.project.name, test.id, test.fullName]
  if (identity.some((part, index) => typeof part !== 'string' || Buffer.byteLength(part) > (index === 2 ? 1024 : 256))) throw new Error('Vitest identity is too large.')
  const selector = path + '::' + Buffer.from(JSON.stringify(identity)).toString('base64url')
  if (Buffer.byteLength(selector) > 2048) throw new Error('Vitest selector is too large.')
  const line = test.location?.line ?? 1
  if (!Number.isSafeInteger(line) || line < 1 || line > 10000000) throw new Error('Invalid Vitest source line.')
  return { selector, label: clip(test.fullName), location: { path, line } }
}
function frameworkErrors(result) {
  for (const error of result.unhandledErrors ?? []) fail(error)
  for (const module of result.testModules ?? []) {
    for (const error of module.errors()) fail(error)
    for (const suite of module.children.allSuites()) for (const error of suite.errors()) fail(error)
  }
}
function result(test) {
  if (!running) return
  const row = node(test), collectedNode = selected.get(row.selector)
  if (!collectedNode || emitted.has(row.selector)) return // Framework also reports deliberately deselected tests as skipped.
  if (row.location.path !== collectedNode.location.path || row.location.line !== collectedNode.location.line) throw new Error('Vitest location changed after collection.')
  const outcome = test.result(), duration = test.diagnostic()?.duration ?? 0
  if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid Vitest duration.')
  const state = outcome.state
  if (!['passed', 'failed', 'skipped'].includes(state)) return
  emit({ kind: 'case', case: { selector: row.selector, outcome: state, durationMs: Math.round(duration),
    message: clip((outcome.errors ?? []).map(error => error.stack || error.message || String(error)).join('\n') || outcome.note || ''),
    output: logs.get(test.id) ?? '', location: collectedNode.location, finished: true } })
  emitted.add(row.selector); logs.delete(test.id)
}
const reporter = {
  onTestCaseResult: result,
  onUserConsoleLog(log) {
    if (!running || !log.taskId || logged >= 256 * 1024) return
    const current = logs.get(log.taskId) ?? '', next = clip(current + clip(log.content), Math.min(2048, 256 * 1024 - logged))
    logged += Math.max(0, Buffer.byteLength(next) - Buffer.byteLength(current))
    if (logs.size < 1000 || logs.has(log.taskId)) logs.set(log.taskId, next)
  },
}
try {
  file(request.entry)
  if (request.config) file(request.config)
  const { createVitest } = await import(pathToFileURL(request.entry).href)
  context = await createVitest('test', {
    root, config: request.config, watch: false, ui: false, api: false,
    browser: { enabled: false }, coverage: { enabled: false }, maxWorkers: 1, fileParallelism: false,
    includeTaskLocation: true, pool: 'forks', reporters: [reporter], update: false,
    passWithNoTests: true, cache: false,
  }, { server: { watch: null }, cacheDir: join(dirname(requestFile), 'vite-cache') })
  await context.init()
  let specifications = await context.globTestSpecifications()
  if (specifications.length > 1000) throw new Error('Vitest collection exceeds 1000 test modules.')
  for (const spec of specifications) {
    file(spec.moduleId)
    if (!inside(realpathSync(spec.project.config.root)) || spec.project.isBrowserEnabled()) throw new Error('Vitest projects must use the selected root and a local Node pool.')
    if (!['forks', 'threads', 'vmForks', 'vmThreads'].includes(spec.project.config.pool)) throw new Error('Custom Vitest pools are not supported.')
    spec.project.config.snapshotOptions.updateSnapshot = 'none'
  }
  const wanted = new Set(request.selectors)
  if (request.operation === 'run') {
    const files = new Set(request.selectors.map(selector => selector.slice(0, selector.indexOf('::'))))
    specifications = specifications.filter(spec => files.has(file(spec.moduleId)))
  }
  const discovery = await context.collectTests(specifications)
  frameworkErrors(discovery)
  const cases = []
  for (const module of discovery.testModules) for (const test of module.children.allTests()) {
    if (cases.length >= 1000) throw new Error('Vitest collection exceeds 1000 cases.')
    cases.push(test)
  }
  for (const test of cases) {
    const row = node(test)
    if (request.operation === 'run' && !wanted.has(row.selector)) continue
    if (selected.has(row.selector)) throw new Error('Duplicate Vitest test identity.')
    selected.set(row.selector, row)
  }
  emit({ kind: 'collection', nodes: [...selected.values()] }); collected = true
  if (errors.length) throw new Error('Vitest collection failed. No test callbacks were run.')
  if (request.operation === 'run') {
    if (selected.size !== wanted.size) throw new Error('Selected Vitest identities changed. Discover the tests again.')
    const groups = new Map(), approved = []
    for (const test of cases) {
      const row = node(test)
      if (!selected.has(row.selector)) continue
      approved.push(JSON.stringify([row.location.path, test.project.name, test.id, test.fullName, row.location.line]))
      const key = JSON.stringify([test.project.name, test.module.moduleId])
      if (!groups.has(key)) groups.set(key, { module: test.module, tests: [] })
      groups.get(key).tests.push(test)
    }
    writeFileSync(request.selectionFile, JSON.stringify({ root, approved }), { mode: 0o600, flag: 'wx' })
    for (const project of new Set([...groups.values()].map(group => group.module.project))) {
      project.config.setupFiles = [request.guard.split(sep).join('/'), ...project.config.setupFiles]
    }
    running = true
    const run = await context.runTestSpecifications([...groups.values()].map(group => group.module.toTestSpecification(group.tests)))
    frameworkErrors(run)
    for (const module of run.testModules) for (const test of module.children.allTests()) result(test)
    if (emitted.size !== selected.size) fail('Vitest did not deliver a final result for every selected test.')
    exitCode = errors.length ? 3 : run.testModules.some(module => !module.ok()) ? 1 : 0
  } else exitCode = selected.size ? 0 : 5
} catch (error) { fail(error); exitCode = 3 }
finally {
  running = false
  try { await context?.close() } catch (error) { fail(error); exitCode = 3 }
  try {
    if (!collected) emit({ kind: 'collection', nodes: [] })
    emit({ kind: 'complete', version: 1, complete: true, exitCode,
      durationMs: Math.round(performance.now() - started), errors }, true)
  } catch {
    const footer = Buffer.from('{"kind":"complete","version":1,"complete":true,"exitCode":3,"durationMs":0,"errors":["Test report exceeded its limit."]}\n')
    if (written + footer.length <= 2 * 1024 * 1024) writeSync(stream, footer)
    exitCode = 3
  }
  closeSync(stream)
}
process.exitCode = exitCode
`
