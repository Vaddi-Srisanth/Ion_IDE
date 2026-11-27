import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { link, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SourceControlService } from '../src/main/source-control'
import { git as realGit, resolveGit } from '../src/main/source-control/repository'

async function fixture(t: TestContext, beforeGit?: (args: string[], signal: AbortSignal) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-blame-')))
  const tool = await resolveGit(root, new AbortController().signal)
  assert.ok(tool)
  const git = (args: string[], input?: string | Buffer) => execFileSync(tool.executable, [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: root, input, encoding: 'utf8', windowsHide: true, timeout: 8000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'First Author']); git(['config', 'user.email', 'fixture@ion.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  let observed: ((args: string[]) => void) | undefined
  const service = new SourceControlService(async (...request) => {
    await beforeGit?.(request[2], request[1])
    const result = await realGit(...request)
    observed?.(request[2])
    return result
  })
  t.after(async () => {
    service.close(); await service.drain()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { root, service, git, observe: (fn: typeof observed) => { observed = fn } }
}

test('committed blame returns verified attribution for clean and modified tracked files with literal names, without code or email', async t => {
  const { root, service, git } = await fixture(t)
  const path = '-guide Ω.txt', file = join(root, path)
  await writeFile(file, 'source-one\nsource-two\nsource-three')
  await writeFile(join(root, '.gitattributes'), '*.txt diff=disallowed\n')
  git(['add', '-A']); git(['commit', '-qm', 'Initial chapter'])
  const first = git(['rev-parse', 'HEAD'])
  git(['config', 'user.name', 'Second Author'])
  await writeFile(file, 'source-one\nnew-source-two\nsource-three')
  git(['add', '--', path]); git(['commit', '-qm', 'Revise chapter'])
  const second = git(['rev-parse', 'HEAD'])
  git(['config', 'diff.disallowed.textconv', 'unavailable-converter'])
  await assert.rejects(service.blame(root, { path }), /Refresh/)
  const status = await service.status(root)
  assert.equal(status.kind, 'repository'); assert.deepEqual(status.entries, [])
  const index = await readFile(join(root, '.git', 'index'))
  const settings = await realpath(await mkdtemp(join(tmpdir(), 'ion-blame-user-config-')))
  t.after(() => rm(settings, { recursive: true, force: true }))
  const map = join(settings, 'mailmap')
  await writeFile(map, 'User Alias <alias@ion.invalid> First Author <fixture@ion.invalid>\n')
  await writeFile(join(root, '.mailmap'), 'Local Alias <local@ion.invalid> Second Author <fixture@ion.invalid>\n')
  git(['config', 'mailmap.file', map])
  git(['config', 'blame.ignoreRevsFile', join(settings, 'absent-revisions')])
  git(['config', 'core.attributesFile', join(settings, 'attributes')])
  await writeFile(join(settings, 'attributes'), '* diff=disallowed\n')
  await writeFile(join(root, '.git', 'info', 'attributes'), '* diff=disallowed\n')
  const clean = await service.blame(root, { path })
  assert.equal(clean.head, second); assert.equal(clean.path, path); assert.equal(clean.truncated, false)
  assert.deepEqual(clean.ranges.map(({ start, count, oid, author, subject }) => [start, count, oid, author, subject]), [
    [1, 1, first, 'First Author', 'Initial chapter'], [2, 1, second, 'Second Author', 'Revise chapter'], [3, 1, first, 'First Author', 'Initial chapter'],
  ])
  assert.ok(clean.ranges.every(range => Number.isSafeInteger(range.time) && range.time > 0))
  await writeFile(file, 'uncommitted-secret\n')
  assert.deepEqual(await service.blame(root, { path }), clean)
  assert.doesNotMatch(JSON.stringify(clean), /source-one|source-two|source-three|uncommitted-secret|fixture@/)
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  assert.equal(await readFile(file, 'utf8'), 'uncommitted-secret\n')
  for (const request of [{ path: '../outside' }, { path, rev: 'HEAD~' }, [path], null]) await assert.rejects(service.blame(root, request), /Invalid/)
})

test('blame rejects missing, untracked, hardlinked, binary, invalid UTF-8, oversized and unresolved input', async t => {
  const { root, service, git } = await fixture(t)
  const initial = ['base', 'binary', 'invalid', 'large', 'missing']
  for (const name of initial) await writeFile(join(root, name), name)
  await writeFile(join(root, 'binary'), Buffer.from([0, 127]))
  await writeFile(join(root, 'invalid'), Buffer.from([255, 254]))
  await writeFile(join(root, 'large'), 'x'.repeat(256 * 1024 + 1))
  git(['add', '-A']); git(['commit', '-qm', 'Fixture'])
  await rm(join(root, 'missing'))
  await writeFile(join(root, 'untracked'), 'file')
  await link(join(root, 'base'), join(root, 'hardlink'))
  await service.status(root)
  for (const [path, expected] of [['binary', /binary/], ['invalid', /UTF-8/], ['large', /256 KiB/], ['missing', /existing/],
    ['base', /regular saved/], ['untracked', /tracked/]] as const) {
    await assert.rejects(service.blame(root, { path }), expected)
  }
  await rm(join(root, 'hardlink'))
  const original = git(['rev-parse', 'HEAD:base'])
  git(['update-index', '--index-info'], '0 ' + '0'.repeat(original.length) + '\tbase\n100644 ' + original + ' 1\tbase\n100644 ' + original + ' 2\tbase\n')
  await assert.rejects(service.blame(root, { path: 'base' }), /resolved index/)
})

test('blame detects a changed HEAD, respects cancellation and reports intentional range truncation', async t => {
  const { root, service, git, observe } = await fixture(t)
  const path = 'lines.txt', file = join(root, path)
  const content = Array.from({ length: 401 }, (_, i) => 'original ' + i)
  await writeFile(file, content.join('\n'))
  await writeFile(join(root, 'empty.txt'), '')
  git(['add', '-A']); git(['commit', '-qm', 'Before'])
  await writeFile(file, content.map((value, i) => i % 2 ? 'revised ' + i : value).join('\n'))
  git(['add', '-A']); git(['commit', '-qm', 'After'])
  await service.status(root)
  const many = await service.blame(root, { path })
  assert.equal(many.truncated, true); assert.equal(many.ranges.length, 200)
  assert.deepEqual(many.ranges.map(range => range.start), Array.from({ length: 200 }, (_, i) => i + 1))
  const empty = await service.blame(root, { path: 'empty.txt' })
  assert.deepEqual(empty.ranges, []); assert.equal(empty.truncated, false)
  observe(args => { if (args[0] === 'blame') { observe(undefined); git(['commit', '--allow-empty', '-qm', 'Concurrent commit']) } })
  await assert.rejects(service.blame(root, { path }), /HEAD changed/)
  await service.status(root)
  observe(args => { if (args[0] === 'blame') service.close() })
  await assert.rejects(service.blame(root, { path }), { name: 'AbortError' })
})

test('dismissing blame cancels only the matching in-flight request and waits for the read to settle', async t => {
  let started!: () => void, release!: () => void, remoteSignal: AbortSignal | undefined
  const running = new Promise<void>(resolve => { started = resolve }), finish = new Promise<void>(resolve => { release = resolve })
  const { root, service, git } = await fixture(t, async (args, signal) => {
    if (args[0] === 'blame') { remoteSignal = signal; started(); await finish }
  })
  const path = 'review.txt'
  await writeFile(join(root, path), 'line')
  git(['add', '-A']); git(['commit', '-qm', 'Review'])
  await service.status(root)
  const result = service.blame(root, { path })
  await running
  assert.equal(service.cancelBlame('other.txt'), false)
  assert.equal(service.cancelBlame({ path }), false)
  assert.equal(remoteSignal!.aborted, false)
  assert.equal(service.cancelBlame(path), true)
  assert.equal(remoteSignal!.aborted, true)
  assert.equal(service.cancelBlame(path), false)
  release()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(service.cancelBlame(path), false)
  assert.equal((await service.status(root)).kind, 'repository')
})
