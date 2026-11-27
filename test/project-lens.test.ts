import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { analyzeProject, redactProjectLensText } from '../src/main/project-lens/analyze'
import { projectLensLimits } from '../src/shared/project-lens'

async function fixture(t: TestContext, entries: Record<string, string>, scope = new WorkspaceFiles()) {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-project-lens-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(entries)) {
    const path = join(temporary, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }
  const root = (await scope.grant(temporary, 'folder')).path
  return { root, scope, temporary }
}

test('real React/mixed workspace reports bounded evidence without executing scripts or reading sources', async t => {
  const { root, scope } = await fixture(t, {
    'package.json': JSON.stringify({ dependencies: { react: '^19', vite: '^8' }, scripts: { test: 'touch DO_NOT_EXECUTE',
      preinstall: 'node -e "process.exit(99)"' }, main: 'src/main.tsx', module: 'missing.js' }),
    'src/main.tsx': 'THIS_SOURCE_TEXT_MUST_NOT_APPEAR', 'src/main.c': 'int main(void) { return 0; }',
    'Main.java': 'class Main {}', 'app.py': 'print("hello")', 'README.md': 'PRIVATE_DOC_CONTENT_MUST_NOT_APPEAR',
    'tests/app.test.ts': 'throw new Error("never run")', 'pyproject.toml': '[project]\nname = "fixture"',
    'pom.xml': '<project/>', 'CMakeLists.txt': 'execute_process(COMMAND touch DO_NOT_EXECUTE)',
  })
  const result = await analyzeProject(scope, root)
  assert.equal(result.status, 'complete')
  assert.equal(result.counts.filesInspected, 10)
  assert.equal(result.counts.returnedFiles, 10)
  assert.equal(result.frameworks.some(item => item.name === 'React' && item.confidence === 'declared'), true)
  assert.equal(result.frameworks.some(item => item.name === 'Python project'), true)
  assert.equal(result.frameworks.some(item => item.name === 'Maven'), true)
  assert.equal(result.frameworks.some(item => item.name === 'CMake'), true)
  for (const id of ['typescript', 'c', 'java', 'python']) assert.equal(result.languages.some(item => item.id === id), true)
  assert.equal(result.entryPoints.some(item => item.path === 'src/main.tsx' && item.kind === 'existing-candidate'), true)
  assert.equal(result.entryPoints.some(item => item.path === 'missing.js' && item.kind === 'manifest-reference'), true)
  assert.equal(result.entryPoints.some(item => item.path === 'missing.js' && item.kind === 'existing-candidate'), false)
  assert.equal(result.documentation.some(item => item.path === 'README.md'), true)
  assert.equal(result.tests.some(item => item.path === 'tests/app.test.ts'), true)
  assert.equal(JSON.stringify(result).includes('THIS_SOURCE_TEXT_MUST_NOT_APPEAR'), false)
  assert.equal(JSON.stringify(result).includes('PRIVATE_DOC_CONTENT_MUST_NOT_APPEAR'), false)
  assert.match(result.manifests[0].reference.revision, /:/)
  assert.equal(result.manifests.every(item => item.reference.range?.startLine === 1), true)
  await assert.rejects(access(join(root, 'DO_NOT_EXECUTE')), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, 'src/main.tsx'), 'utf8'), 'THIS_SOURCE_TEXT_MUST_NOT_APPEAR')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= projectLensLimits.resultBytes)
})

test('requires the exact active folder even when another file is individually granted', async t => {
  const { root, scope, temporary } = await fixture(t, { 'src/main.c': 'int main(){}' })
  const outside = await mkdtemp(join(tmpdir(), 'ion-lens-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'private.c'), 'PRIVATE')
  await scope.grant(join(outside, 'private.c'), 'file')
  await assert.rejects(analyzeProject(scope, join(outside, 'private.c')), /exact currently open folder/)
  await assert.rejects(analyzeProject(scope, join(root, 'src')), /exact currently open folder/)
  const onlyFile = new WorkspaceFiles()
  await onlyFile.grant(join(temporary, 'src/main.c'), 'file')
  await assert.rejects(analyzeProject(onlyFile, root), /exact currently open folder/)
  assert.equal((await analyzeProject(scope, root)).files.some(item => item.reference.path.includes('private')), false)
})

test('known secrets, lockfiles, binary and generated folders are excluded, obvious command secrets redacted', async t => {
  const { root, scope } = await fixture(t, { '.env': 'AUTH_TOKEN=DO_NOT_LEAK', 'secrets/password.txt': 'DO_NOT_LEAK',
    'node_modules/pkg/index.js': 'GENERATED', 'build/output.c': 'GENERATED', '.git/config': 'GIT_SECRET',
    'package-lock.json': 'LOCKFILE_SECRET', 'icon.png': '\0BINARY', 'certificate.pem': 'CERTIFICATE',
    'package.json': JSON.stringify({ dependencies: { react: 'https://user:pass@example.test/private?token=SECRET' },
      scripts: { start: 'AUTH_TOKEN=DO_NOT_LEAK run --password "SECRET_PASS" https://user:pass@example.test/?key=PRIVATE' } }),
    'index.js': 'console.log(1)',
  })
  const result = await analyzeProject(scope, root)
  const serialized = JSON.stringify(result)
  for (const secret of ['DO_NOT_LEAK', 'SECRET_PASS', 'user:pass', 'GIT_SECRET', 'LOCKFILE_SECRET', 'PRIVATE']) assert.equal(serialized.includes(secret), false)
  assert.ok(result.exclusions.secret! >= 3)
  assert.ok(result.exclusions['hidden-or-generated']! >= 2)
  assert.equal(result.exclusions.lockfile, 1)
  assert.equal(result.exclusions.binary, 1)
  assert.equal(result.files.length, 2)
  assert.match(result.manifests[0].scripts[0].command, /\[redacted\]/)
  assert.equal(result.manifests[0].dependencies[0].version, '[non-registry reference]')
  assert.equal(redactProjectLensText('TOKEN="quoted secret" --token secret Bearer ABC123'), 'TOKEN=[redacted] --token [redacted] Bearer [redacted]')
})

test('malformed and binary manifest content fails conservatively without inventing framework dependencies', async t => {
  const { root, scope } = await fixture(t, { 'package.json': '{"dependencies":', 'sub/package.json': '\0BINARY' })
  const result = await analyzeProject(scope, root)
  assert.equal(result.manifests.length, 1)
  assert.equal(result.manifests[0].status, 'malformed')
  assert.equal(result.frameworks.length, 0)
  assert.equal(result.exclusions['invalid-manifest'], 1)
  assert.equal(result.exclusions.binary, 1)
})

test('symlink files and folders do not expose external or redirected content', async t => {
  const { root, scope } = await fixture(t, { 'main.c': 'int main(){}' })
  const outside = await mkdtemp(join(tmpdir(), 'ion-lens-link-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'package.json'), '{"dependencies":{"react":"1"}}')
  try {
    await symlink(join(outside, 'package.json'), join(root, 'package.json'))
    await symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') { t.skip('Windows symlink permission unavailable.'); return }
    throw error
  }
  const result = await analyzeProject(scope, root)
  assert.equal(result.manifests.length, 0)
  assert.equal(result.files.length, 1)
  assert.equal(result.exclusions['symlink-or-special'], 2)
})

test('file, visit, depth, manifest and total-byte quotas are explicit and do not grow results unbounded', async t => {
  const { root, scope } = await fixture(t, { 'main.c': 'int main(){}', 'other.py': 'pass',
    'sub/main.java': 'class Main{}', 'sub/deep/index.js': '1',
    'package.json': '{"name":"a"}', 'sub/package.json': '{"name":"b"}',
  })
  const files = await analyzeProject(scope, root, { limits: { files: 1 } })
  assert.equal(files.status, 'partial'); assert.ok(files.files.length <= 1); assert.ok(files.truncated.includes('file-count'))
  const visits = await analyzeProject(scope, root, { limits: { visits: 1 } })
  assert.equal(visits.counts.visitedEntries, 1); assert.ok(visits.truncated.includes('visit-count'))
  const depth = await analyzeProject(scope, root, { limits: { depth: 0 } })
  assert.ok(depth.truncated.includes('depth')); assert.equal(depth.files.some(item => item.reference.path.startsWith('sub/')), false)
  const manifest = await analyzeProject(scope, root, { limits: { manifestBytes: 4 } })
  assert.equal(manifest.manifests.length, 0); assert.ok(manifest.truncated.includes('manifest-size'))
  const total = await analyzeProject(scope, root, { limits: { totalManifestBytes: 12 } })
  assert.ok(total.counts.manifestBytesRead <= 12); assert.ok(total.truncated.includes('manifest-budget'))
  await assert.rejects(analyzeProject(scope, root, { limits: { files: 501 } }), /Invalid/)
  await assert.rejects(analyzeProject(scope, root, { limits: { durationMs: Number.POSITIVE_INFINITY } }), /Invalid/)
})

test('cancellation and changing root invalidate work at real asynchronous authority boundaries', async t => {
  const controller = new AbortController()
  class CancellingFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      const inspected = await super.inspect(value, kind)
      controller.abort()
      return inspected
    }
  }
  const cancel = await fixture(t, { 'main.c': '1' }, new CancellingFiles())
  assert.equal((await analyzeProject(cancel.scope, cancel.root, { signal: controller.signal })).status, 'cancelled')
  const pre = await fixture(t, { 'main.c': '1' })
  const precancelled = await analyzeProject(pre.scope, pre.root, { signal: AbortSignal.abort() })
  assert.equal(precancelled.counts.visitedEntries, 0)
  assert.equal(precancelled.status, 'cancelled')
  const other = await mkdtemp(join(tmpdir(), 'ion-lens-new-root-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  class ChangingFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      const inspected = await super.inspect(value, kind)
      await this.grant(other, 'folder')
      return inspected
    }
  }
  const changed = await fixture(t, { 'main.c': '1' }, new ChangingFiles())
  const invalidated = await analyzeProject(changed.scope, changed.root)
  assert.equal(invalidated.status, 'invalidated')
  assert.ok(invalidated.truncated.includes('workspace-changed'))
  assert.equal(invalidated.files.length, 0)
})

test('cooperative deadline is reported rather than silently retried', async t => {
  class SlowFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      const inspected = await super.inspect(value, kind)
      await delay(10)
      return inspected
    }
  }
  const { root, scope } = await fixture(t, { 'main.c': '1' }, new SlowFiles())
  const result = await analyzeProject(scope, root, { limits: { durationMs: 1 } })
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.truncated, ['deadline'])
  assert.equal(result.counts.visitedEntries, 0)
})

test('observed directory replacement invalidates evidence before manifest content is read', async t => {
  let replaced = false
  class ReplacingFiles extends WorkspaceFiles {
    override async inspect(value: unknown, kind?: 'file' | 'folder') {
      const inspected = await super.inspect(value, kind)
      if (!replaced && kind === 'file') {
        replaced = true
        const parent = join(inspected.path, '..')
        await rename(parent, parent + '-old')
        await mkdir(parent)
        await writeFile(join(parent, 'package.json'), '{"dependencies":{"react":"99"}}')
      }
      return inspected
    }
  }
  const { root, scope } = await fixture(t, { 'sub/package.json': '{"dependencies":{"vite":"1"}}' }, new ReplacingFiles())
  const result = await analyzeProject(scope, root)
  assert.equal(result.status, 'invalidated')
  assert.ok(result.truncated.includes('directory-replaced'))
  assert.equal(result.manifests.length, 0)
  assert.equal(result.frameworks.length, 0)
})

test('serialized output quota truncates retained evidence and states the limitation', async t => {
  const entries = Object.fromEntries(Array.from({ length: 50 }, (_, index) => ['long-fixture-file-name-' + index + '.java', 'class Main {}']))
  const { root, scope } = await fixture(t, entries)
  const result = await analyzeProject(scope, root, { limits: { resultBytes: 4096 } })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096)
  assert.ok(result.truncated.includes('result-bytes'))
  assert.equal(result.status, 'partial')
  assert.equal(result.counts.filesInspected, 50)
  assert.equal(result.counts.returnedFiles, result.files.length)
})

test('large manifest/file snapshots fit with bounded serialization while preserving trim priority', async t => {
  const dependencies: Record<string, string> = { react: '^19', vite: '^8' }
  for (let index = 0; index < 98; index++) dependencies['dependency-' + index + '-' + 'a'.repeat(110)] = '^1.0.0-' + 'a'.repeat(80)
  const scripts = Object.fromEntries(Array.from({ length: 30 }, (_, index) => ['task-' + index + '-' + 'a'.repeat(50), 'echo ' + 'a'.repeat(507)]))
  const manifest = { dependencies, scripts, padding: '' }
  manifest.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(manifest)))
  const text = JSON.stringify(manifest)
  const entries: Record<string, string> = { 'package.json': text, 'a/package.json': text, 'b/package.json': text, 'c/package.json': text }
  for (let index = 0; index < 80; index++) entries['a/' + 'source-' + index + '-' + 's'.repeat(160) + '.java'] = 'class Main {}'
  const { root, scope } = await fixture(t, entries)
  const stringify = JSON.stringify
  let serializations = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    serializations++
    return stringify(...args)
  }) as typeof JSON.stringify
  let result
  try { result = await analyzeProject(scope, root) }
  finally { JSON.stringify = stringify }
  assert.equal(result.counts.filesInspected, 84)
  assert.equal(result.counts.manifestBytesRead, 262144)
  assert.equal(result.files.length, 0, 'File evidence is trimmed before manifest evidence.')
  assert.ok(result.manifests.length > 0 && result.manifests.length < 4)
  assert.equal(result.manifests[0].reference.path, 'package.json', 'Keep prefixes rather than dropping the first evidence.')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= projectLensLimits.resultBytes)
  assert.ok(serializations <= 40, `Repeated whole-snapshot serialization: ${serializations} calls.`)
})

test('prototype-shaped manifest names remain inert dependencies and inherited limit keys are rejected', async t => {
  const manifest = '{"dependencies":{"constructor":"^1","toString":"^1","__proto__":"^1","react":"^19"}}'
  const { root, scope } = await fixture(t, { 'package.json': manifest })
  const result = await analyzeProject(scope, root)
  assert.deepEqual(result.frameworks.map(item => item.name).sort(), ['Node.js ecosystem', 'React'])
  assert.equal(result.frameworks.every(item => typeof item.name === 'string'), true)
  assert.equal(result.manifests[0].dependencies.length, 4)
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(analyzeProject(scope, root, { limits: JSON.parse('{"' + key + '":1}') }), /Invalid Project Lens limit/)
  }
})
