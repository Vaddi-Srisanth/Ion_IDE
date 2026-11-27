import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copilotExecutableName, installCopilotRuntime } from '../src/main/copilot/runtime'

const payload = Buffer.from('invalid archive with a deliberately incorrect digest')

function fakeFetch() {
  return (async () => new Response(payload, { status: 200 })) as typeof fetch
}

async function harness(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ion-copilot-runtime-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('rejects unsupported platforms before fetching', async () => {
  let fetched = false
  await assert.rejects(installCopilotRuntime({ directory: '/unused/runtime', platform: 'linux', arch: 'x64',
    fetch: (async () => { fetched = true; return new Response(payload) }) as typeof fetch }), /supported only/)
  assert.equal(fetched, false)
})

test('selects the exact native executable filename for each supported platform', () => {
  assert.equal(copilotExecutableName('darwin'), 'copilot-language-server')
  assert.equal(copilotExecutableName('win32'), 'copilot-language-server.exe')
})

test('verifies the archive digest before extraction and leaves no installed runtime on failure', async () => harness(async root => {
  let extracted = false
  await assert.rejects(installCopilotRuntime({ directory: join(root, 'copilot', 'runtime'), platform: 'darwin', arch: 'arm64',
    fetch: fakeFetch(), extract: async () => { extracted = true } }), /integrity check failed/)
  assert.equal(extracted, false)
}))

