import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { maxFileBytes, revision, WorkspaceFiles } from '../src/main/files'
import { MissingToolchainError, prepareRun, type CommandPlan } from '../src/main/run-console/plans'
import { readNativeProject } from '../src/main/run-console/project-build'

const execute = promisify(execFile)

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ion project café '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'workspace')
  const manifest = join(root, '.ion', 'build.json')
  const scratch = join(directory, 'private build')
  await Promise.all([mkdir(join(root, '.ion'), { recursive: true }), mkdir(scratch)])
  const scope = new WorkspaceFiles()
  await scope.grant(root, 'folder', true)
  return { directory, root, manifest, scope, scratch }
}

test('uses a bounded workspace manifest only when the active source is listed', async (t) => {
  const { manifest, root, scope } = await fixture(t)
  const entry = join(root, 'main.c')
  const header = join(root, 'helpers.h')
  const other = join(root, 'other.c')
  await Promise.all([writeFile(entry, ''), writeFile(other, ''), writeFile(header, '')])
  assert.equal(await readNativeProject(scope, root, entry), undefined)

  await writeFile(manifest, JSON.stringify({ version: 1, sources: ['main.c'], headers: ['helpers.h'] }))
  const project = await readNativeProject(scope, root, entry)
  assert.ok(project)
  assert.equal(project.manifest, manifest)
  assert.deepEqual(project.sources, [entry])
  assert.deepEqual(project.includeDirectories, [])
  assert.deepEqual(project.inputs.map(({ path }) => path), [manifest, entry, header])
  assert.equal(await readNativeProject(scope, root, other), undefined)
  assert.equal(await readNativeProject(scope, root, join(root, 'Test.java')), undefined)
  const previous = project.inputs[2].revision
  await appendFile(header, '// changed')
  assert.notEqual(revision((await scope.inspect(header, 'file')).stats), previous)
  assert.notEqual((await readNativeProject(scope, root, entry))?.inputs[2].revision, previous)
})

test('rejects commands, invalid schemas, unsafe paths, bad file kinds, and oversized inputs', async (t) => {
  const { manifest, root, scope } = await fixture(t)
  const entry = join(root, 'main.c')
  await writeFile(entry, '')
  const invalid = async (config: unknown, message: RegExp) => {
    await writeFile(manifest, JSON.stringify(config))
    await assert.rejects(readNativeProject(scope, root, entry), message)
  }
  await invalid({ version: 2, sources: ['main.c'] }, /version 1/)
  await invalid({ version: 1, sources: ['main.c'], command: 'make' }, /sources, headers and includeDirectories only/)
  await invalid({ version: 1, sources: ['main.c', 'main.c'] }, /duplicate/)
  await invalid({ version: 1, sources: ['main.c', 'other.cpp'] }, /one language/)
  await invalid({ version: 1, sources: ['main.c', '../other.c'] }, /workspace-relative/)
  await invalid({ version: 1, sources: ['main.c', './other.c'] }, /workspace-relative/)
  await invalid({ version: 1, sources: ['main.c', 'nested\\other.c'] }, /workspace-relative/)
  await invalid({ version: 1, sources: ['main.c', '/tmp/other.c'] }, /workspace-relative/)
  await invalid({ version: 1, sources: ['main.c', 'C:/other.c'] }, /invalid path/)
  await invalid({ version: 1, sources: ['main.c'], headers: ['main.c'] }, /header extension/)
  await invalid({ version: 1, sources: ['main.c'], headers: null }, /headers to be a list/)
  await invalid({ version: 1, sources: ['main.c'], includeDirectories: ['main.c'] }, /no longer a folder/)
  await invalid({ version: 1, sources: ['main.c', 'missing.c'] }, /ENOENT/)
  await invalid({ version: 1, sources: ['main.c', 'a'.repeat(16 * 1024)] }, /exceeds 16 KiB/)
  await writeFile(manifest, JSON.stringify({ version: 1, sources: ['main.c'] }))
  await truncate(entry, maxFileBytes + 1)
  await assert.rejects(readNativeProject(scope, root, entry), /2 MiB per file/)
  await writeFile(manifest, Buffer.from([0xff, 0xff]))
  await assert.rejects(readNativeProject(scope, root, entry), /UTF-8 JSON/)
})

test('rejects workspace symlinks in a native manifest', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, manifest, root, scope } = await fixture(t)
  const entry = join(root, 'main.c')
  const outside = join(directory, 'outside.c')
  await Promise.all([writeFile(entry, ''), writeFile(outside, '')])
  await symlink(outside, join(root, 'linked.c'))
  await writeFile(manifest, JSON.stringify({ version: 1, sources: ['main.c', 'linked.c'] }))
  await assert.rejects(readNativeProject(scope, root, entry), /regular file or folder/)
  await symlink(directory, join(root, 'linked directory'))
  await writeFile(manifest, JSON.stringify({ version: 1, sources: ['main.c'], includeDirectories: ['linked directory'] }))
  await assert.rejects(readNativeProject(scope, root, entry), /regular file or folder/)
})

test('builds real two-file C and C++ programs with explicit include folders', async (t) => {
  for (const extension of ['c', 'cpp']) {
    await t.test(extension, async (context) => {
      const { manifest, root, scope, scratch } = await fixture(context)
      const entry = join(root, 'main.' + extension)
      const helper = join(root, 'helper.' + extension)
      const include = join(root, 'include files')
      await mkdir(include)
      await Promise.all([
        writeFile(entry, '#include <stdio.h>\n#include "helper.h"\nint main(void) { printf("%d\\n", answer()); return 0; }\n'),
        writeFile(helper, '#include "helper.h"\nint answer(void) { return 42; }\n'),
        writeFile(join(include, 'helper.h'), 'int answer(void);\n'),
        writeFile(manifest, JSON.stringify({
          version: 1, sources: ['main.' + extension, 'helper.' + extension],
          includeDirectories: ['include files'], headers: ['include files/helper.h'],
        })),
      ])
      const nativeProject = await readNativeProject(scope, root, entry)
      assert.ok(nativeProject)
      const plan = await prepareRun({ path: entry, root, scratch, signal: new AbortController().signal, nativeProject })
        .catch((error: unknown) => {
          if (error instanceof MissingToolchainError) return null
          throw error
        })
      if (!plan?.compile) return context.skip('A local compiler is needed')
      assert.deepEqual(plan.compile.args.slice(-6, -2), ['-I', include, entry, helper])
      const invoke = ({ executable, args, environment }: CommandPlan) =>
        execute(executable, args, { cwd: root, env: environment, timeout: 20_000 })
      await invoke(plan.compile)
      assert.match((await invoke(plan.run)).stdout, /^42\r?\n$/)
    })
  }
})
