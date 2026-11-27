import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { removeServiceScratch, serviceScratchRemovalOptions } from '../src/main/language-tools/service-scratch'

test('language service scratch cleanup enables only bounded Windows filesystem retries', async () => {
  assert.deepEqual(serviceScratchRemovalOptions('win32'), {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  })
  assert.deepEqual(serviceScratchRemovalOptions('darwin'), {
    recursive: true, force: true, maxRetries: 0, retryDelay: 100,
  })

  let observed: unknown
  const remove: typeof rm = async (_path, options) => {
    observed = options
  }
  await removeServiceScratch('C:\\disposable\\ion-lsp-test', remove, 'win32')
  assert.deepEqual(observed, serviceScratchRemovalOptions('win32'))
})
