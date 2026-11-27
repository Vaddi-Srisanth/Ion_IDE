import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { TestAdapter, TestCaseResult, TestOperationResult, TestRun, TestSnapshot } from '../../shared/test-explorer'
import type { WorkspaceFiles } from '../files'
import { isWithin } from '../files'
import { execute } from '../runner'
import { maxTestRecordBytes, relativeTestPath, selectedTestIds, testAdapter, testLimits, type StoredTests } from './model'
import { preparePytest, readFrameworkReport, safeTool, sourceRevisions, testTree, type TestExecute, type TestPlan } from './pytest'
import { TestRepository } from './repository'

export interface TestReview {
  operation: 'discover' | 'run'; root: string; adapter: TestAdapter; executable: string; args: readonly string[]; cwd: string
  selectedLabels: readonly string[]; timeoutMs: number; outputBytes: number; warning: string
}
export interface TestExplorerOptions {
  profile(): string
  files(): WorkspaceFiles
  approve(review: TestReview, signal: AbortSignal): Promise<boolean>
  execute?: TestExecute
  resolvePython?: (roots: readonly string[]) => Promise<string>
}

/** Owns one explicitly requested discovery/run. Construction and idle lists never spawn tooling. */
export class TestExplorerService {
  private repository?: TestRepository
  private active?: { controller: AbortController; done: Promise<TestOperationResult> }
  private processCleanupError?: Error
  private readonly pendingScratch = new Set<string>()
  constructor(private readonly options: TestExplorerOptions) {}
  get busy() { return Boolean(this.active) }
  private store() { return this.repository ??= new TestRepository(join(this.options.profile(), 'test-explorer-v1')) }
  private async root(value: unknown) {
    const scope = this.options.files(), entry = await scope.inspect(value, 'folder')
    if (!scope.rootPaths.includes(entry.path)) throw new Error('Choose an open workspace root.')
    return { root: entry.path, scope, roots: [...scope.rootPaths] }
  }
  async list(value: unknown): Promise<TestSnapshot | null> {
    const { root, scope } = await this.root(value), record = await this.store().read(root)
    if (!record) return null
    if (record.snapshot.stale) return { ...record.snapshot, history: record.snapshot.history.map(run => ({ ...run, stale: true })) }
    const tracked = Object.entries(record.sources).filter(([, value]) => value.startsWith('tool:')).map(([path]) => join(root, ...path.split('/')))
    // Users can still inspect earlier outcomes after removing a framework or a tracked source.
    // Re-running independently verifies the current files and approval before launch.
    const sources = await reviewedSources(scope, root, record.snapshot.adapter, tracked).catch(() => null)
    if (scope !== this.options.files() || !scope.rootPaths.includes(root)) throw new Error('The workspace closed while reading test history.')
    const stale = sources === null || !same(record.sources, sources)
    return { ...record.snapshot, stale, history: record.snapshot.history.map(run => ({ ...run, stale: run.stale || stale })) }
  }
  discover(root: unknown, adapter: unknown = 'pytest'): Promise<TestOperationResult> { return this.operate('discover', root, undefined, undefined, adapter) }
  run(root: unknown, revision: unknown, ids: unknown): Promise<TestOperationResult> { return this.operate('run', root, revision, ids) }
  cancel(): boolean { if (!this.active) return false; this.active.controller.abort(); return true }
  async drain(): Promise<void> {
    await this.active?.done
    await this.repository?.drain()
    for (const path of this.pendingScratch) {
      await rm(path, { recursive: true, force: true })
      this.pendingScratch.delete(path)
    }
    // execute() returned without proving output/owned-child completion. No later
    // ordinary success can repair that evidence; controlled restart must stop.
    if (this.processCleanupError) throw this.processCleanupError
  }
  async close(): Promise<void> { this.cancel(); await this.drain() }

  private operate(operation: 'discover' | 'run', root: unknown, expected?: unknown, ids?: unknown, adapter?: unknown): Promise<TestOperationResult> {
    if (this.processCleanupError || this.pendingScratch.size) return Promise.resolve({ status: 'failed', stage: 'cleanup', snapshot: null,
      message: 'A previous test operation has unverified cleanup. Resolve it before starting more tests.' })
    if (this.active) return Promise.resolve({ status: 'failed', stage: operation === 'run' ? 'run' : 'discovery', snapshot: null, message: 'A test operation is already active.' })
    const controller = new AbortController(), done = this.perform(operation, root, expected, ids, controller.signal, adapter)
    this.active = { controller, done }
    void done.finally(() => { if (this.active?.done === done) this.active = undefined }).catch(() => undefined)
    return done
  }

  private async perform(operation: 'discover' | 'run', rootValue: unknown, expected: unknown, requested: unknown, signal: AbortSignal, adapterValue?: unknown): Promise<TestOperationResult> {
    let snapshot: TestSnapshot | null = null, scratch: string | undefined, stage: TestOperationResult['stage'] = 'review'
    let result: TestOperationResult
    try {
      const { root, scope, roots } = await this.root(rootValue)
      const owned = () => scope === this.options.files() && same(roots, scope.rootPaths)
      const previous = await this.store().read(root); snapshot = previous?.snapshot ?? null
      const adapter = testAdapter(operation === 'run' ? previous?.snapshot.adapter : adapterValue)
      if (!owned()) throw new Error('The workspace changed before testing.')
      const chosen = operation === 'run' ? (() => {
        if (!previous || previous.snapshot.revision !== expected || previous.snapshot.stale) throw new Error('Tests or saved sources changed. Discover and review again.')
        const selected = selectedTestIds(previous, requested)
        if (!selected.length) throw new Error('Select at least one discovered test.')
        return selected
      })() : []
      signal.throwIfAborted()
      scratch = await mkdtemp(join(await realpath(tmpdir()), 'ion-tests-run-'))
      const selectors = chosen.map(id => previous!.selectors[id])
      let plan: TestPlan
      switch (adapter) {
        case 'pytest': plan = await preparePytest(root, roots, scratch, operation, selectors, this.options.resolvePython); break
        case 'vitest': plan = await (await import('./vitest')).prepareVitest(root, roots, scratch, operation, selectors); break
        case 'junit': plan = await (await import('./junit')).prepareJunit(root, roots, scratch, operation, selectors); break
      }
      const inspectSources = (abort?: AbortSignal) => reviewedSources(scope, root, adapter, plan.trackedFiles ?? [], abort)
      const sources = await inspectSources(signal)
      await plan.stageSources?.(sources)
      if (operation === 'run' && !same(previous!.sources, sources)) throw new Error('Tests or saved sources changed. Discover and review again.')
      const review: TestReview = { operation, root, adapter, executable: plan.executable, args: plan.args, cwd: plan.cwd,
        selectedLabels: chosen.map(id => previous!.snapshot.nodes.find(n => n.id === id)!.label), timeoutMs: plan.timeoutMs, outputBytes: testLimits.outputBytes,
        warning: plan.warning ?? 'pytest imports project tests, conftest and configuration with your account permissions, including file and network access. Ion runs saved files. Plugin autoload and configured addopts are disabled; explicitly configured plugins can still execute. No packages are downloaded.' }
      if (!await this.options.approve(review, signal) || signal.aborted) {
        result = { status: 'cancelled', stage, snapshot, message: 'Test operation cancelled before execution.' }
      } else {
        if (!owned() || !same(sources, await inspectSources(signal)) || !await safeTool(plan.executable, roots)
          || (await this.store().read(root))?.snapshot.revision !== previous?.snapshot.revision) throw new Error('Workspace, saved sources or tests changed while awaiting approval. Review again.')
        stage = operation === 'run' ? 'run' : 'discovery'
        const started = performance.now()
        const process = await (this.options.execute ?? execute)(plan.executable, plan.args, { cwd: plan.cwd, input: '', signal,
          environment: plan.environment, timeoutMs: plan.timeoutMs, budget: { remaining: testLimits.outputBytes }, splitOutput: true })
        const elapsed = Math.round(performance.now() - started)
        if (process.outputComplete === false) {
          stage = 'cleanup'
          this.processCleanupError = new Error('Test process cleanup or output completion could not be verified.')
          throw this.processCleanupError
        }
        const cancelled = signal.aborted || process.state === 'cancelled'
        const report = await readFrameworkReport(plan, cancelled).catch(error => {
          if (cancelled) return null
          throw new Error(`${adapter} did not produce a valid report. Check the installed framework and configuration. ` + String(error instanceof Error ? error.message : error))
        })
        if (operation === 'discover') {
          if (cancelled) result = { status: 'cancelled', stage, snapshot, message: 'Discovery stopped; earlier discovered tests were retained.' }
          else {
            if (process.state !== 'exited' || !report?.complete || report.errors.length || ![0, 5].includes(report.exitCode) || process.exitCode !== report.exitCode) {
              throw new Error(report?.errors[0] || `${adapter} discovery failed (${process.state}, exit ${process.exitCode}).`)
            }
            if (!owned() || !same(sources, await inspectSources(signal))) throw new Error('Saved sources changed during collection. Discover again.')
            await this.validateLocations(scope, root, report.nodes)
            const tree = testTree(report.nodes, adapter)
            const stored = await this.store().save({ schema: 1, snapshot: { root, revision: randomUUID(), adapter, discoveredAt: Date.now(),
              nodes: tree.nodes, history: (snapshot?.history ?? []).map(run => ({ ...run, stale: true })), stale: false }, selectors: tree.selectors, sources }, snapshot?.revision ?? null)
            snapshot = stored.snapshot
            result = { status: 'completed', stage, snapshot, message: `${report.nodes.length} ${adapter} cases discovered from saved files.` }
          }
        } else {
          const changed = !owned() || !same(sources, await inspectSources().catch(() => null))
          if (report) await this.validateLocations(scope, root, report.nodes).catch(error => { if (owned()) throw error })
          const selectedSelectors = new Set(chosen.map(id => previous!.selectors[id]))
          if (report?.nodes.some(n => !selectedSelectors.has(n.selector))) throw new Error(`${adapter} returned unselected test identities.`)
          const cases: TestCaseResult[] = chosen.map(id => {
            const node = previous!.snapshot.nodes.find(n => n.id === id)!, row = report?.cases.find(c => c.selector === previous!.selectors[id])
            if (row?.finished) return { id, label: node.label, outcome: row.outcome, durationMs: row.durationMs, message: row.message, output: row.output, location: node.location }
            return { id, label: node.label, outcome: cancelled ? 'cancelled' : 'error', durationMs: 0,
              message: cancelled ? 'Stopped before this case completed.' : `${adapter} did not provide a complete result for this selected case.`, output: '', location: node.location }
          })
          const expectedExitCode = cases.some(c => c.outcome === 'failed' || c.outcome === 'error') ? 1 : 0
          const failed = !cancelled && (process.state !== 'exited' || !report?.complete || report.errors.length > 0
            || report.exitCode !== expectedExitCode || process.exitCode !== report.exitCode || cases.some(c => c.outcome === 'error'))
          const status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed'
          const run: TestRun = { id: randomUUID(), adapter, checkedAt: Date.now(), durationMs: elapsed, status, selectedIds: chosen, cases, stale: changed }
          const next: StoredTests = { ...previous!, snapshot: { ...previous!.snapshot, stale: changed,
            history: [...previous!.snapshot.history.map(h => changed ? { ...h, stale: true } : h), run].slice(-testLimits.history) } }
          while (Buffer.byteLength(JSON.stringify(next)) > maxTestRecordBytes && next.snapshot.history.length > 1) next.snapshot.history.shift()
          snapshot = (await this.store().save(next, previous!.snapshot.revision)).snapshot
          result = { status, stage, snapshot, message: changed ? 'Saved sources or workspace changed during execution. These outcomes are historical and stale.'
            : cancelled ? 'Testing stopped. Completed results were retained.' : failed ? (report?.errors[0] || `${adapter} could not verify the complete selection (${process.state}).`)
              : `${cases.filter(c => c.outcome === 'passed').length} passed, ${cases.filter(c => c.outcome === 'failed').length} failed, ${cases.filter(c => c.outcome === 'skipped').length} skipped. Outcomes describe this saved-file run.` }
        }
      }
    } catch (error) {
      result = { status: signal.aborted && stage !== 'cleanup' ? 'cancelled' : 'failed', stage, snapshot,
        message: signal.aborted && stage !== 'cleanup' ? 'Test operation stopped.' : String(error instanceof Error ? error.message : error).slice(0, 2048) }
    }
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true }) }
      catch {
        this.pendingScratch.add(scratch)
        result = { ...result, status: 'failed', stage: 'cleanup', message: 'The private test operation directory could not be removed. Test cleanup remains unverified.' }
      }
    }
    return result
  }
  private async validateLocations(scope: WorkspaceFiles, root: string, nodes: Array<{ location: { path: string; line: number } }>) {
    for (const path of new Set(nodes.map(n => n.location.path))) await scope.inspect(join(root, ...path.split('/')), 'file')
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function reviewedSources(scope: WorkspaceFiles, root: string, adapter: TestAdapter, tracked: string[], signal?: AbortSignal) {
  if (tracked.length > 8 || new Set(tracked).size !== tracked.length) throw new Error('Too many framework entry files.')
  const sources = await sourceRevisions(scope, root, signal, adapter)
  for (const file of tracked) {
    signal?.throwIfAborted()
    const inspected = await scope.inspect(file, 'file')
    if (!isWithin(root, inspected.path) || inspected.path !== file) throw new Error('Framework entry escaped its workspace root.')
    const { revision, contentHash } = await scope.read(file)
    sources[relativeTestPath(relative(root, file).split(sep).join('/'))] = `tool:${revision}:${contentHash}`
  }
  return Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))
}
