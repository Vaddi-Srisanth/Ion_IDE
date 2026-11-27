import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { git as realGit, resolveGit } from '../src/main/source-control/repository'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-conflict-git-')))
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const git = (args: string[], input?: string | Buffer) => execFileSync(tool.executable, [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: root, input, encoding: 'utf8', windowsHide: true, timeout: 8000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Ion Fixture']); git(['config', 'user.email', 'fixture@ion.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  const commands: string[][] = []
  let afterRead: ((args: string[]) => void) | undefined
  const service = new SourceControlService(async (...request) => {
    const result = await realGit(...request)
    commands.push(request[2])
    afterRead?.(request[2])
    return result
  })
  t.after(async () => {
    service.close(); await service.drain()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { root, service, git, commands, changeAfterRead: (action: typeof afterRead) => { afterRead = action } }
}

test('real merge review reads literal path stages, distinguishes empty from deleted, and preserves the index and worktree', async t => {
  const { root, service, git, commands, changeAfterRead } = await fixture(t)
  const path = '-guide Ω.txt', absolutePath = join(root, path), deleted = 'removed.txt'
  await writeFile(absolutePath, 'base \uFFFD\n'); await writeFile(join(root, deleted), 'before deletion\n')
  git(['add', '-A']); git(['commit', '-qm', 'Base'])
  git(['branch', 'side'])
  await writeFile(absolutePath, 'ours\r\n'); await writeFile(join(root, deleted), '')
  git(['add', '-A']); git(['commit', '-qm', 'Ours'])
  git(['checkout', '-q', 'side'])
  await writeFile(absolutePath, 'theirs\n'); git(['rm', '-q', '--', deleted])
  git(['add', '-A']); git(['commit', '-qm', 'Theirs'])
  git(['checkout', '-q', 'main'])
  assert.throws(() => git(['merge', '--no-edit', 'side']), { status: 1 })
  await assert.rejects(service.conflict(root, { path }), /Refresh/)
  const status = await service.status(root)
  assert.equal(status.kind, 'repository')
  assert.ok(status.entries.filter(entry => entry.unmerged).length === 2)
  const index = await readFile(join(root, '.git', 'index')), working = await readFile(absolutePath)
  assert.deepEqual(await service.conflict(root, { path }), { path, absolutePath, base: 'base \uFFFD\n', ours: 'ours\r\n', theirs: 'theirs\n' })
  assert.deepEqual(commands.map(cmd => cmd[0]), ['ls-files', 'cat-file', 'cat-file', 'cat-file', 'ls-files'])
  assert.deepEqual(await service.conflict(root, { path: deleted }), {
    path: deleted, absolutePath: join(root, deleted), base: 'before deletion\n', ours: '', theirs: null,
  })
  assert.deepEqual(await readFile(absolutePath), working)
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)

  await assert.rejects(service.conflict(root, { path: '../sibling' }), /Invalid Git path/)
  await assert.rejects(service.conflict(root, { path: 'other.txt' }), /Refresh/)
  await assert.rejects(service.conflict(join(root, 'other'), { path }), /Refresh/)
  changeAfterRead(args => {
    if (args[0] === 'cat-file') { changeAfterRead(undefined); git(['add', '--', path]) }
  })
  await assert.rejects(service.conflict(root, { path }), /conflict stages changed/)
  await assert.rejects(service.conflict(root, { path }), /conflict stages changed/)
})

test('binary, invalid UTF-8, oversized, overlong and symlink stages fail without presenting a partial text conflict', async t => {
  const { root, service, git } = await fixture(t)
  git(['commit', '-q', '--allow-empty', '-m', 'Base'])
  const hash = (value: string | Buffer) => git(['hash-object', '-w', '--stdin'], value)
  const base = hash('base'), ours = hash('ours')
  const cases = [
    { name: 'binary', value: Buffer.from([1, 0, 3]), error: /binary/ },
    { name: 'invalid', value: Buffer.from([255, 254]), error: /UTF-8/ },
    { name: 'large', value: 'x'.repeat(256 * 1024 + 1), error: /preview limit/ },
    { name: 'lines', value: 'x\n'.repeat(12_000), error: /12,000-line/ },
    { name: 'symlink', value: 'relative-target', error: /regular files/ },
  ]
  for (const { name, value } of cases) {
    const mode = name === 'symlink' ? '120000' : '100644'
    git(['update-index', '--index-info'], `100644 ${base} 1\t${name}\n100644 ${ours} 2\t${name}\n${mode} ${hash(value)} 3\t${name}\n`)
  }
  assert.equal((await service.status(root)).kind, 'repository')
  const index = await readFile(join(root, '.git', 'index'))
  for (const { name, error } of cases) await assert.rejects(service.conflict(root, { path: name }), error)
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
})
