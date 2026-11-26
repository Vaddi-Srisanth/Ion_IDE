import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type {
  DebugAction, DebugEvaluation, DebugEvent, DebugFrame, DebugScope,
  DebugSession, DebugStartRequest, DebugVariable,
} from '../../shared/debug'
import { debugLimits, validDebugDocumentVersion } from '../../shared/debug'
import { revision } from '../files'
import { execute } from '../runner'
import { DapProcess, type DapEvent } from './dap-process'
import { discoverDebugTools } from './discovery'

const requestTimeout = 8_000
const text = (value: unknown, limit = debugLimits.stringBytes) => typeof value === 'string'
  ? Buffer.from(value).subarray(0, limit).toString('utf8') : ''
const integer = (value: unknown, fallback = 0) => Number.isSafeInteger(value) ? value as number : fallback
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

function inside(root: string, path: string) {
  const relation = relative(root, path)
  return relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation)
}

/**
 * A DAP adapter may publish `stopped` before its launch response resolves.
 * Launch completion must not overwrite that newer adapter-owned state.
 */
export function completeDebugLaunch(session: DebugSession): boolean {
  if (session.state !== 'starting') return false
  session.state = 'running'
  return true
}

export async function validateDebugSource(path: string, root: string, expectedRevision: string): Promise<string> {
  if (!isAbsolute(path) || !isAbsolute(root) || !expectedRevision || expectedRevision.length > 256) {
    throw new Error('The saved source revision is invalid.')
  }
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(path)
  if (!inside(canonicalRoot, canonical) || canonical !== path) throw new Error('The debug source must be a canonical file in the open workspace.')
  const stats = await lstat(canonical, { bigint: true })
  if (!stats.isFile() || revision(stats) !== expectedRevision) throw new Error('The source changed before debugging. Save and review it again.')
  return canonical
}

interface Active {
  session: DebugSession
  process: DapProcess
  scratch: string
  root: string
  threadId?: number
  outputBytes: number
  stopping?: Promise<void>
}

/** One-window debug owner. Construction performs no discovery or process work. */
export class DebugService {
  private active?: Active
  constructor(private readonly emit: (event: DebugEvent) => void) {}

  status(): DebugSession | null { return this.active ? { ...this.active.session, breakpoints: [...this.active.session.breakpoints] } : null }

  async start(request: DebugStartRequest, root: string, signal: AbortSignal): Promise<DebugSession> {
    if (this.active) throw new Error('Stop the current debug session before starting another.')
    if (!request.expectedRevision || request.expectedRevision.length > 256 || !validDebugDocumentVersion(request.version)) {
      throw new Error('The saved source revision is invalid.')
    }
    if (!isAbsolute(request.sourcePath) || request.breakpoints.length > debugLimits.breakpoints) throw new Error('The debug request is invalid.')
    const canonicalRoot = await realpath(root)
    const source = await validateDebugSource(request.sourcePath, canonicalRoot, request.expectedRevision)
    const breakpoints = request.breakpoints.map(point => {
      if (point.path !== source || !Number.isInteger(point.line) || point.line < 1 || point.line > 10_000_000
        || point.column !== undefined && (!Number.isInteger(point.column) || point.column < 1 || point.column > 100_000)) {
        throw new Error('A breakpoint is outside the reviewed source.')
      }
      return { ...point }
    })
    const scratch = await mkdtemp(join(tmpdir(), 'ion-debug-'))
    let adapterProcess: DapProcess | undefined
    try {
      const tools = await discoverDebugTools(canonicalRoot, scratch, request.language, signal)
      const binary = join(scratch, globalThis.process.platform === 'win32' ? 'program.exe' : 'program')
      const compilation = await execute(tools.compiler, [
        '-x', request.language === 'cpp' ? 'c++' : 'c', request.language === 'cpp' ? '-std=c++20' : '-std=c17',
        '-g', '-O0', '-fno-omit-frame-pointer', ...tools.compilerArgs, source, '-o', binary,
      ], { cwd: scratch, input: '', signal, timeoutMs: 15_000, budget: { remaining: 256 * 1024 }, environment: tools.environment, splitOutput: true })
      if (compilation.state !== 'exited' || compilation.exitCode !== 0) {
        throw new Error(text(compilation.stderr || compilation.output, 4_096) || compilation.detail || 'Debug compilation failed.')
      }
      await validateDebugSource(source, canonicalRoot, request.expectedRevision).catch(error => {
        if (error instanceof Error && /source changed/.test(error.message)) {
          throw new Error('The source changed while preparing the debugger. Save and review it again.')
        }
        throw error
      })
      const id = randomUUID()
      const session: DebugSession = { id, state: 'starting', sourcePath: source, adapter: basename(tools.adapter),
        compiler: basename(tools.compiler), breakpoints: breakpoints.map(point => ({ ...point, verified: false })) }
      const active: Active = { session, process: null as never, scratch, root: canonicalRoot, outputBytes: 0 }
      adapterProcess = await DapProcess.start({ executable: tools.adapter, args: [], cwd: scratch, env: tools.environment,
        onEvent: event => this.event(active, event), onExit: error => this.exited(active, error) }, signal)
      active.process = adapterProcess
      this.active = active
      await adapterProcess.request('initialize', {
        clientID: 'ion-ide', clientName: 'Ion IDE', adapterID: 'lldb-dap', pathFormat: 'path',
        linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true,
        supportsRunInTerminalRequest: false, supportsProgressReporting: false,
      }, requestTimeout, signal)
      const initialized = adapterProcess.waitForEvent('initialized', undefined, requestTimeout, signal)
      const launch = adapterProcess.request('launch', { program: binary, cwd: scratch, args: [], env: {}, stopOnEntry: false,
        disableASLR: false }, requestTimeout, signal)
      await initialized
      const response = object(await adapterProcess.request('setBreakpoints', { source: { path: source, name: basename(source) },
        breakpoints: breakpoints.map(({ line, column, condition, hitCondition, logMessage }) => ({
          line, column, condition, hitCondition, logMessage,
        })), sourceModified: false }, requestTimeout, signal))
      session.breakpoints = array(response.breakpoints).slice(0, debugLimits.breakpoints).map((value, index) => {
        const row = object(value); const requested = breakpoints[index] ?? breakpoints.at(-1)!
        return { ...requested, id: integer(row.id) || undefined, verified: row.verified === true,
          line: integer(row.line, requested.line), column: integer(row.column) || requested.column,
          message: text(row.message, 500) || undefined }
      })
      this.emit({ type: 'breakpoints', sessionId: id, breakpoints: session.breakpoints })
      await adapterProcess.request('configurationDone', {}, requestTimeout, signal)
      await launch
      if (completeDebugLaunch(session)) this.emit({ type: 'state', sessionId: id, state: 'running' })
      return this.status()!
    } catch (error) {
      await adapterProcess?.stop().catch(() => undefined)
      if (this.active?.process === adapterProcess) this.active = undefined
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async action(sessionId: string, action: DebugAction, threadId?: number): Promise<void> {
    const active = this.require(sessionId)
    if (action === 'restart') { await active.process.request('restart', {}); return }
    let id = threadId ?? active.threadId
    if (action === 'pause' && !id) {
      const response = object(await active.process.request('threads', {}))
      id = integer(object(array(response.threads)[0]).id) || undefined
    }
    if (!id || !Number.isSafeInteger(id) || id < 1) throw new Error('Select a stopped debug thread first.')
    const command = action
    await active.process.request(command, { threadId: id })
    if (action !== 'pause') {
      active.session.state = 'running'
      this.emit({ type: 'state', sessionId, state: 'running' })
    }
  }

  async stack(sessionId: string, threadId: number): Promise<DebugFrame[]> {
    const active = this.requireStopped(sessionId)
    const response = object(await active.process.request('stackTrace', { threadId, startFrame: 0, levels: debugLimits.frames }))
    const rows: DebugFrame[] = []
    for (const value of array(response.stackFrames).slice(0, debugLimits.frames)) {
      const frame = object(value); const source = object(frame.source); const rawPath = text(source.path, 4_096)
      let path: string | undefined
      if (rawPath && isAbsolute(rawPath)) {
        const canonical = await realpath(rawPath).catch(() => null)
        if (canonical && inside(active.root, canonical)) path = canonical
      }
      rows.push({ id: integer(frame.id), name: text(frame.name, 500) || 'Frame', path,
        line: Math.max(1, integer(frame.line, 1)), column: Math.max(1, integer(frame.column, 1)) })
    }
    return rows
  }

  async scopes(sessionId: string, frameId: number): Promise<DebugScope[]> {
    const active = this.requireStopped(sessionId)
    const response = object(await active.process.request('scopes', { frameId }))
    return array(response.scopes).slice(0, debugLimits.scopes).map(value => { const row = object(value); return {
      name: text(row.name, 500) || 'Scope', variablesReference: Math.max(0, integer(row.variablesReference)), expensive: row.expensive === true,
    } })
  }

  async variables(sessionId: string, variablesReference: number): Promise<DebugVariable[]> {
    const active = this.requireStopped(sessionId)
    const response = object(await active.process.request('variables', { variablesReference, start: 0, count: debugLimits.variables }))
    return array(response.variables).slice(0, debugLimits.variables).map(value => { const row = object(value); return {
      name: text(row.name, 500), value: text(row.value), type: text(row.type, 500) || undefined,
      variablesReference: Math.max(0, integer(row.variablesReference)),
    } })
  }

  async evaluate(sessionId: string, expression: string, frameId?: number): Promise<DebugEvaluation> {
    const active = this.requireStopped(sessionId)
    if (!expression.trim() || Buffer.byteLength(expression) > debugLimits.expressionBytes) throw new Error('The debug expression is empty or too large.')
    const response = object(await active.process.request('evaluate', { expression, frameId, context: 'watch' }))
    return { result: text(response.result), type: text(response.type, 500) || undefined,
      variablesReference: Math.max(0, integer(response.variablesReference)) }
  }

  async stop(sessionId: string): Promise<void> {
    const active = this.require(sessionId)
    if (active.session.state !== 'terminated') {
      active.session.state = 'terminated'
      this.emit({ type: 'state', sessionId, state: 'terminated' })
    }
    await this.stopActive(active)
  }
  async dispose(): Promise<void> { if (this.active) await this.stopActive(this.active) }

  private require(sessionId: string) {
    if (!this.active || this.active.session.id !== sessionId) throw new Error('The debug session is no longer active.')
    return this.active
  }
  private requireStopped(sessionId: string) {
    const active = this.require(sessionId)
    if (active.session.state !== 'stopped') throw new Error('Pause at a breakpoint before inspecting debug state.')
    return active
  }
  private event(active: Active, event: DapEvent) {
    if (this.active !== active) return
    const body = object(event.body)
    if (event.event === 'stopped') {
      active.threadId = integer(body.threadId) || undefined
      active.session.threadId = active.threadId
      active.session.state = 'stopped'
      this.emit({ type: 'state', sessionId: active.session.id, state: 'stopped', reason: text(body.reason, 200) || undefined, threadId: active.threadId })
    } else if (event.event === 'continued') {
      active.threadId = undefined
      active.session.threadId = undefined
      active.session.state = 'running'
      this.emit({ type: 'state', sessionId: active.session.id, state: 'running' })
    } else if (event.event === 'terminated' || event.event === 'exited') {
      active.session.state = 'terminated'; this.emit({ type: 'state', sessionId: active.session.id, state: 'terminated' })
      void this.stopActive(active)
    } else if (event.event === 'output') {
      const output = text(body.output, debugLimits.outputBytes - active.outputBytes)
      if (!output) return
      active.outputBytes += Buffer.byteLength(output)
      const raw = body.category; const category = raw === 'stdout' || raw === 'stderr' ? raw : 'console'
      this.emit({ type: 'output', sessionId: active.session.id, category, output })
    }
  }
  private exited(active: Active, error?: Error) {
    if (this.active !== active || active.stopping) return
    active.session.state = error ? 'error' : 'terminated'
    this.emit({ type: 'state', sessionId: active.session.id, state: active.session.state, reason: error?.message.slice(0, 500) })
    void this.stopActive(active)
  }
  private stopActive(active: Active) {
    return active.stopping ??= (async () => {
      await active.process.stop().catch(() => undefined)
      await rm(active.scratch, { recursive: true, force: true }).catch(() => undefined)
      if (this.active === active) this.active = undefined
    })()
  }
}
