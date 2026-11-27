import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { startCopilotService } from '../src/main/copilot/service'
import type { CopilotTransport } from '../src/main/copilot/client'
import { LspProcess } from '../src/main/language-tools/lsp-process'

function fakeServer(capabilities: Record<string, unknown>) {
  const calls: string[] = []
  const server = {
    capabilities, version: '1.575.0',
    request: async (method: string) => { calls.push('request:' + method); return null },
    notify: async (method: string) => { calls.push('notify:' + method) },
    onNotification: (_method: string, _handler: (params: unknown) => void) => ({ dispose() {} }),
    stop: async () => { calls.push('stop') },
  }
  return { server: server as unknown as LspProcess & CopilotTransport, calls }
}

test('Copilot service starts only the official protocol shape with an isolated environment', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'ion-copilot-service-'))
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  let received: Parameters<typeof LspProcess.start>[0] | undefined
  const { server, calls } = fakeServer({ textDocumentSync: { change: 2 }, inlineCompletionProvider: {} })
  const start = (async options => { received = options; return server }) as typeof LspProcess.start
  const service = await startCopilotService({ executable: join(parent, 'copilot-language-server'), profile: join(parent, 'profile'),
    root: null, applicationVersion: '0.9.9', start }, new AbortController().signal)
  assert.equal(service.version, '1.575.0')
  assert.deepEqual(received?.args, ['--stdio'])
  assert.equal(received?.cwd, join(await realpath(join(parent, 'profile')), 'scratch'))
  assert.equal(received?.initializationOptions && (received.initializationOptions as any).editorInfo.name, 'Ion IDE')
  assert.equal((received?.configuration as any).telemetry.telemetryLevel, 'off')
  assert.equal(received?.env.GH_TOKEN, undefined)
  assert.equal(received?.env.GITHUB_TOKEN, undefined)
  assert.equal(received?.env.HTTPS_PROXY, undefined)
  assert.equal(received?.env.PATH?.includes(process.env.PATH ?? ''), false)
  await service.close()
  assert.deepEqual(calls, ['stop'])
})

test('Copilot service rejects a workspace-owned private profile before launching a process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ion-copilot-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  let starts = 0
  const { server } = fakeServer({ textDocumentSync: { change: 2 }, inlineCompletionProvider: {} })
  const start = (async () => { starts++; return server }) as unknown as typeof LspProcess.start
  await assert.rejects(startCopilotService({ executable: join(root, 'server'), profile: join(root, '.ion-profile'),
    root, applicationVersion: '0.9.9', start }, new AbortController().signal), /private application profile/)
  assert.equal(starts, 0)
})

test('Copilot service terminates a runtime that lacks required inline capabilities', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'ion-copilot-capabilities-'))
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  let starts = 0
  const { server, calls } = fakeServer({ textDocumentSync: { change: 1 }, inlineCompletionProvider: false })
  const start = (async () => { starts++; return server }) as unknown as typeof LspProcess.start
  await assert.rejects(startCopilotService({ executable: join(parent, 'server'), profile: join(parent, 'profile'),
    root: null, applicationVersion: '0.9.9', start }, new AbortController().signal), /does not advertise/)
  assert.equal(starts, 1)
  assert.deepEqual(calls, ['stop'])
})
