import assert from 'node:assert/strict'
import { lstat, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { revision } from '../src/main/files'
import { DebugService, validateDebugSource } from '../src/main/debug/service'

test('debug service remains inert until an explicit start', () => {
  const events: unknown[] = []
  const service = new DebugService(event => events.push(event))
  assert.equal(service.status(), null)
  assert.deepEqual(events, [])
})

test('debug source validation binds canonical path to the exact saved revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ion-debug-source-'))
  const source = join(root, 'main.c')
  try {
    await writeFile(source, 'int main(void) { return 0; }\n')
    const canonicalRoot = await realpath(root), canonicalSource = await realpath(source)
    const token = revision(await lstat(canonicalSource, { bigint: true }))
    assert.equal(await validateDebugSource(canonicalSource, canonicalRoot, token), canonicalSource)
    await writeFile(source, 'int main(void) { return 1; }\n')
    await assert.rejects(() => validateDebugSource(canonicalSource, canonicalRoot, token), /source changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('debug source validation rejects link aliases and paths outside the workspace', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ion-debug-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'ion-debug-outside-'))
  const source = join(outside, 'main.c')
  const link = join(root, 'alias.c')
  try {
    await writeFile(source, 'int main(void) { return 0; }\n')
    const canonicalRoot = await realpath(root), canonicalSource = await realpath(source)
    const token = revision(await lstat(canonicalSource, { bigint: true }))
    await assert.rejects(() => validateDebugSource(canonicalSource, canonicalRoot, token), /open workspace/)
    try { await symlink(source, link) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip('Symlink creation is unavailable on this host.')
      throw error
    }
    await assert.rejects(() => validateDebugSource(link, canonicalRoot, token), /canonical file/)
  } finally {
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true })
  }
})
