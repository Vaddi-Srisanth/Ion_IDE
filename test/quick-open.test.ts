import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { quickOpenQuery, searchWorkspace } from '../src/main/quick-open'

test('Quick Open finds unopened nested workspace files without following symlinks or generated directories', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-quick-open-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const workspace = join(temporary, 'Lab with spaces')
  const nested = join(workspace, 'src')
  const external = join(temporary, 'outside')
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(external), mkdir(join(workspace, 'node_modules'), { recursive: true })])
  await Promise.all([
    writeFile(join(nested, 'Calculáte.c'), ''),
    writeFile(join(workspace, 'calculate-extra.txt'), ''),
    writeFile(join(external, 'hidden.c'), ''),
    writeFile(join(workspace, 'node_modules', 'generated.c'), ''),
    symlink(external, join(workspace, 'linked'), 'dir'),
  ])
  const scope = new WorkspaceFiles()
  const root = (await scope.grant(workspace, 'folder')).path
  const signal = new AbortController().signal
  assert.deepEqual((await searchWorkspace(scope, root, quickOpenQuery(' SRC CALCULA\u0301TE '), signal)).entries,
    [{ name: 'Calculáte.c', kind: 'file', path: join(root, 'src', 'Calculáte.c') }])
  assert.deepEqual((await searchWorkspace(scope, root, 'hidden', signal)).entries, [])
  assert.deepEqual((await searchWorkspace(scope, root, 'generated', signal)).entries, [])
  assert.throws(() => quickOpenQuery('x'.repeat(201)), /Invalid Quick Open/)

  const stale = new AbortController()
  stale.abort()
  await assert.rejects(searchWorkspace(scope, root, 'calculate', stale.signal), { name: 'AbortError' })
  await scope.grant(external, 'folder')
  await assert.rejects(searchWorkspace(scope, root, 'calculate', signal), /workspace changed/)
})
