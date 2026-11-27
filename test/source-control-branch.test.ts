import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalRef } from '../src/main/source-control/branches'
import { gitDirectory, resolveGit } from '../src/main/source-control/repository'

test('create a reviewed local branch without switching, overwriting a ref, or changing staged and working files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-create-branch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Ion Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim()
  command('init', '-q', '-b', 'main')
  const path = join(root, 'assignment.txt')
  await writeFile(path, 'first\n')
  command('add', '.')
  command('commit', '-qm', 'Baseline')
  const head = command('rev-parse', 'HEAD')
  await writeFile(path, 'staged\n')
  command('add', '.')
  await writeFile(path, 'uncommitted work\n')
  const signal = new AbortController().signal
  const tools = await resolveGit(root, signal)
  const directory = await gitDirectory(root)
  assert.ok(tools && directory)
  const repository = { root, directory, ...tools }
  const tag = (name: string, from = head) => createLocalRef(repository, signal, { name, from }, head, 'tag')
  await tag('submission-1')
  assert.equal(command('cat-file', '-t', 'refs/tags/submission-1'), 'commit')
  assert.equal(command('rev-parse', 'refs/tags/submission-1'), head)
  await assert.rejects(tag('submission-1'))
  await assert.rejects(tag('refs/heads/main'), /tag name/)
  await assert.rejects(tag('stale', '1'.repeat(head.length)), /review the starting commit/)
  const create = (name: string, from = head) => createLocalRef(repository, signal, { name, from }, head, 'branch')
  await create('course/assignment-1')
  assert.equal(command('rev-parse', 'refs/heads/course/assignment-1'), head)
  await assert.rejects(create('course/assignment-1'))
  for (const name of ['../outside', 'course/HEAD.lock', '--help', 'one//two', 'stuff/AUX.txt', 'bad@{0}']) {
    await assert.rejects(create(name), /branch name/)
  }
  await assert.rejects(create('changed', '1'.repeat(head.length)), /review the starting commit/)
  assert.equal(command('branch', '--show-current'), 'main')
  assert.equal(command('show', ':assignment.txt'), 'staged')
  assert.equal(await readFile(path, 'utf8'), 'uncommitted work\n')
  assert.equal(command('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').length, 2)
})
