import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LspProcess } from '../src/main/language-tools/lsp-process'

test('LSP process host rejects relative executables', async () => {
  const controller = new AbortController()
  await assert.rejects(() => LspProcess.start({ executable: 'node', args: [], cwd: process.cwd(), env: {}, root: null }, controller.signal),
    /absolute trusted path/)
})
test('LSP process host initializes, requests, and stops its owned process', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-lsp-test-'))
  try {
    const host = await LspProcess.start({
      executable: process.execPath,
      args: [join(process.cwd(), 'test/fixtures/fake-lsp.cjs')],
      cwd: scratch,
      env: { ...process.env, ION_FAKE_LSP_LOG: join(scratch, 'methods.log') },
      root: scratch,
    }, new AbortController().signal)
    assert.ok(host.pid)
    assert.deepEqual(await host.request('ion/echo', { ready: true }), { ready: true })
    const cancellation = new AbortController()
    const slow = host.request('ion/slow', {}, 1_000, cancellation.signal).catch(() => null)
    cancellation.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    await host.stop()
    await slow
    assert.equal(host.isClosed, true)
    assert.match(await readFile(join(scratch, 'methods.log'), 'utf8'), /initialized\n.*apply-rejected\n.*ion\/slow\n\$\/cancelRequest\n.*shutdown\nexit\n/s)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
test('aborting startup cannot leave an LSP child alive', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => LspProcess.start({
    executable: process.execPath,
    args: [join(process.cwd(), 'test/fixtures/fake-lsp.cjs')],
    cwd: process.cwd(),
    env: { ...process.env },
    root: null,
  }, controller.signal), /aborted/i)
})

test('LSP process host rejects an oversized response before buffering its body', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-lsp-limit-'))
  const host = await LspProcess.start({ executable: process.execPath,
    args: [join(process.cwd(), 'test/fixtures/fake-lsp.cjs')], cwd: scratch, env: { ...process.env }, root: scratch },
  new AbortController().signal)
  try {
    await assert.rejects(() => host.request('ion/huge', {}))
    assert.equal(host.isClosed, true)
  } finally {
    await host.stop()
    await rm(scratch, { recursive: true, force: true })
  }
})
