import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DebugBridge, DebugEvent, DebugSession, DebugStartRequest } from '../src/shared/debug'
import { debugLimits } from '../src/shared/debug'
import { DebugController } from '../src/renderer/debug/controller'

const session: DebugSession = {
  id: 'debug-session', state: 'running', sourcePath: '/workspace/main.c', adapter: '/trusted/lldb-dap',
  compiler: '/trusted/clang', breakpoints: [{ path: '/workspace/main.c', line: 3, verified: true }],
}

class FakeBridge implements DebugBridge {
  starts = 0
  stops = 0
  actions: string[] = []
  listeners = new Set<(event: DebugEvent) => void>()
  current: DebugSession | null = null
  evaluations: string[] = []
  startSession: DebugSession = session
  async start(_request: DebugStartRequest) { this.starts++; this.current = this.startSession; return this.startSession }
  async stop() { this.stops++; this.current = null }
  async action(_id: string, action: import('../src/shared/debug').DebugAction) { this.actions.push(action) }
  async stack() { return [{ id: 7, name: 'main', path: '/workspace/main.c', line: 3, column: 1 }] }
  async scopes() { return [{ name: 'Locals', variablesReference: 9, expensive: false }] }
  async variables() { return [{ name: 'count', value: '4', type: 'int', variablesReference: 0 }] }
  async evaluate(_id: string, expression: string) {
    this.evaluations.push(expression)
    return { result: expression === 'count' ? '4' : 'value', type: 'int', variablesReference: 0 }
  }
  async status() { return this.current }
  onEvent(callback: (event: DebugEvent) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  emit(event: DebugEvent) { for (const listener of this.listeners) listener(event) }
}

const request: DebugStartRequest = { sourcePath: '/workspace/main.c', language: 'c', version: 0,
  expectedRevision: 'revision', breakpoints: [{ path: '/workspace/main.c', line: 3 }] }
const drain = () => new Promise((resolve) => setTimeout(resolve, 0))

test('opening the lazy debug controller inspects state without starting a process', async () => {
  const bridge = new FakeBridge()
  const controller = new DebugController(bridge)
  await drain()
  assert.equal(bridge.starts, 0)
  assert.equal(controller.getSnapshot().phase, 'idle')
  await controller.dispose()
  assert.equal(bridge.listeners.size, 0)
})
test('session events load stack, scopes and variables only after a paused generation', async () => {
  const bridge = new FakeBridge()
  const controller = new DebugController(bridge)
  await controller.start(request)
  assert.equal(controller.getSnapshot().phase, 'running')
  bridge.emit({ type: 'state', sessionId: session.id, state: 'stopped', threadId: 2, reason: 'Breakpoint' })
  await drain(); await drain()
  const paused = controller.getSnapshot()
  assert.equal(paused.phase, 'paused')
  assert.deepEqual(paused.frames.map(({ name, line, selected }) => ({ name, line, selected })), [
    { name: 'main', line: 3, selected: true },
  ])
  assert.deepEqual(paused.scopes.map(({ name, expanded }) => ({ name, expanded })), [{ name: 'Locals', expanded: false }])
  await controller.expandScope(9)
  assert.deepEqual(controller.getSnapshot().scopes[0].variables?.map(({ name, value }) => ({ name, value })), [
    { name: 'count', value: '4' },
  ])
  await controller.dispose(true)
})

test('an early stopped start result retains its thread and loads paused state', async () => {
  const bridge = new FakeBridge()
  bridge.startSession = { ...session, state: 'stopped', threadId: 2 }
  const controller = new DebugController(bridge)
  await controller.start(request)
  await drain(); await drain()
  const paused = controller.getSnapshot()
  assert.equal(paused.phase, 'paused')
  assert.equal(paused.canEvaluate, true)
  assert.deepEqual(paused.frames.map(({ name, line }) => ({ name, line })), [{ name: 'main', line: 3 }])
  await controller.dispose(true)
})

test('watches evaluate only while paused and stale session events are ignored', async () => {
  const bridge = new FakeBridge()
  const controller = new DebugController(bridge)
  await controller.start(request)
  await controller.addWatch('count')
  assert.deepEqual(bridge.evaluations, [])
  bridge.emit({ type: 'output', sessionId: 'stale', category: 'stderr', output: 'must not appear' })
  assert.equal(controller.getSnapshot().output.length, 0)
  bridge.emit({ type: 'state', sessionId: session.id, state: 'stopped', threadId: 2 })
  await drain(); await drain()
  assert.deepEqual(bridge.evaluations, ['count'])
  assert.equal(controller.getSnapshot().watches[0].value, '4')
  await controller.dispose(true)
})

test('debug output is bounded and explicit stop clears active frame state', async () => {
  const bridge = new FakeBridge()
  const controller = new DebugController(bridge)
  await controller.start(request)
  bridge.emit({ type: 'output', sessionId: session.id, category: 'stdout', output: 'x'.repeat(debugLimits.outputBytes * 2) })
  bridge.emit({ type: 'output', sessionId: session.id, category: 'stdout', output: '😀'.repeat(debugLimits.outputBytes) })
  const retained = controller.getSnapshot().output.reduce((total, item) => total + Buffer.byteLength(item.text), 0)
  assert.ok(retained <= debugLimits.outputBytes)
  await controller.stop()
  assert.equal(bridge.stops, 1)
  assert.equal(controller.getSnapshot().phase, 'finished')
  assert.equal(controller.getSnapshot().frames.length, 0)
  await controller.dispose()
})
