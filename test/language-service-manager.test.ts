import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolSnapshot } from '../src/shared/language-tools'
import { LanguageServiceManager, type LanguageServiceDescriptor, type ManagedLanguageService } from '../src/main/language-tools/manager'

const snapshot = (version = 1): ToolSnapshot => ({
  language: 'c', path: '/work/a.c', version, text: 'int main() {}', operation: 'definition', offset: 4,
})
const descriptor = (root = '/work'): LanguageServiceDescriptor => ({ adapter: 'fake', language: 'c', root, path: root + '/a.c' })

test('language manager is inert until the first request and isolates workspace roots', async () => {
  let starts = 0
  let stops = 0
  const manager = new LanguageServiceManager(async (): Promise<ManagedLanguageService> => {
    starts++
    return { closed: false, query: async item => ({ version: item.version, rows: [] }), stop: async () => { stops++ } }
  })
  assert.equal(starts, 0)
  await manager.query(descriptor('/one'), snapshot())
  await manager.query(descriptor('/one'), snapshot(2))
  await manager.query(descriptor('/two'), { ...snapshot(), path: '/two/a.c' })
  assert.equal(starts, 2)
  assert.equal(manager.statuses().length, 2)
  await manager.release(true)
  assert.equal(stops, 2)
  assert.equal(manager.statuses().filter(status => status.state === 'stopped').length, 2)
})

test('language manager rejects stale adapter versions', async () => {
  const manager = new LanguageServiceManager(async () => ({
    closed: false,
    query: async item => ({ version: item.version - 1, rows: [['stale']] }),
    stop: async () => {},
  }))
  assert.equal(await manager.query(descriptor(), snapshot(7)), null)
  await manager.stopAll()
})

test('language manager rate-limits repeatedly crashing services', async () => {
  let now = 1_000
  const manager = new LanguageServiceManager(async () => { throw new Error('crashed') }, () => now)
  await assert.rejects(() => manager.query(descriptor(), snapshot()), /crashed/)
  now++
  await assert.rejects(() => manager.query(descriptor(), snapshot()), /crashed/)
  now++
  await assert.rejects(() => manager.query(descriptor(), snapshot()), /restart limit/)
})

test('language manager cancels a renderer-owned request without stopping the reusable service', async () => {
  let complete!: (value: { version: number; rows: string[][] }) => void
  const manager = new LanguageServiceManager(async () => ({
    closed: false,
    query: item => new Promise(resolve => { complete = value => resolve({ ...value, version: item.version }) }),
    stop: async () => {},
  }))
  const requestId = '12345678-abcd-4321-abcd-123456789abc'
  const pending = manager.query(descriptor(), { ...snapshot(), requestId })
  await new Promise(resolve => setImmediate(resolve))
  manager.cancel(requestId)
  assert.equal(await pending, null)
  complete({ version: 1, rows: [] })
  assert.equal(manager.statuses().at(-1)?.state, 'ready')
  await manager.stopAll()
})
