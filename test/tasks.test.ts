import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TaskDefinition } from '../src/shared/tasks'
import { WorkspaceFiles } from '../src/main/files'
import { discoverTasks, taskSourcesCurrent } from '../src/main/tasks/discovery'
import { runTaskGraph } from '../src/main/tasks/graph'
import { taskOrder, validateTaskGraph } from '../src/main/tasks/model'
import { TaskRepository } from '../src/main/tasks/repository'
import { TaskService } from '../src/main/tasks/service'
import type { PlannedTask } from '../src/main/tasks/planner'

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-tasks-')))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  const scope = new WorkspaceFiles()
  await scope.grant(root, 'folder', true)
  return { root, scope }
}

function task(root: string, id: string, dependsOn: string[] = []): TaskDefinition {
  return { id, label: id, adapter: 'make', cwd: root, selector: 'default', dependsOn, timeoutMs: 30_000,
    source: { path: join(root, 'Makefile'), revision: 'revision' } }
}

test('task validation rejects cycles, escapes, executable metadata and oversized graphs', async (t) => {
  const { root } = await fixture(t)
  assert.throws(() => validateTaskGraph([task(root, 'a', ['b']), task(root, 'b', ['a'])], root), /cyclic/)
  assert.throws(() => validateTaskGraph([{ ...task(root, 'a'), cwd: tmpdir() }], root), /inside/)
  assert.throws(() => validateTaskGraph([{ ...task(root, 'a'), executable: '/bin/sh' }], root), /definition/)
  assert.throws(() => validateTaskGraph(Array.from({ length: 129 }, (_, index) => task(root, 't' + index)), root), /list/)
})

test('task order is deterministic, dependency-first and de-duplicated', async (t) => {
  const { root } = await fixture(t)
  const tasks = validateTaskGraph([task(root, 'prepare'), task(root, 'compile', ['prepare']), task(root, 'all', ['prepare', 'compile'])], root)
  assert.deepEqual(taskOrder(tasks, 'all').map(item => item.id), ['prepare', 'compile', 'all'])
})

test('static discovery reads bounded manifests without preserving npm command strings', async (t) => {
  const { root, scope } = await fixture(t)
  await Promise.all([
    writeFile(join(root, 'Makefile'), 'all:\n\t@echo safe\n'),
    writeFile(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n'),
    writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node dangerous.js', 'test:unit': 'vitest' } })),
    writeFile(join(root, 'pyproject.toml'), '[project]\nname="demo"\n'),
    writeFile(join(root, 'Cargo.toml'), '[package]\nname="demo"\nversion="0.1.0"\n'),
  ])
  const tasks = await discoverTasks(scope, root)
  assert.deepEqual(tasks.map(item => item.id), [
    'make:default', 'cmake:configure', 'cmake:build', 'python:compileall', 'cargo:build', 'cargo:check', 'npm:build', 'npm:test:unit',
  ])
  assert.equal(JSON.stringify(tasks).includes('dangerous.js'), false)
  assert.equal(await taskSourcesCurrent(scope, root, tasks), true)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'changed' } }))
  assert.equal(await taskSourcesCurrent(scope, root, tasks), false)
})

test('task repository uses optimistic revisions and preserves no approval authority', async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'Makefile'), '')
  const repository = new TaskRepository(join(root, '.profile', 'tasks-v1'))
  const saved = await repository.save(root, [task(root, 'build')], null)
  assert.equal((await repository.read(root))?.tasks[0].id, 'build')
  await assert.rejects(repository.save(root, [task(root, 'other')], null), /changed/)
  const updated = await repository.save(root, [task(root, 'other')], saved.revision)
  assert.notEqual(updated.revision, saved.revision)
  assert.deepEqual(Object.keys(updated).sort(), ['revision', 'root', 'tasks'])
})

test('task graph stops dependents on failure and propagates cancellation', async (t) => {
  const { root } = await fixture(t)
  const tasks = validateTaskGraph([task(root, 'prepare'), task(root, 'build', ['prepare']), task(root, 'package', ['build'])], root)
  const visited: string[] = []
  const failed = await runTaskGraph(root, tasks, 'package', async (item) => {
    visited.push(item.id)
    return { status: item.id === 'build' ? 'compile-error' : 'success', compiler: null, compileOutput: '', programOutput: '',
      exitCode: item.id === 'build' ? 1 : 0, durationMs: 1, message: item.id }
  }, new AbortController().signal)
  assert.deepEqual(visited, ['prepare', 'build'])
  assert.equal(failed.completed.length, 2)
  const controller = new AbortController(); controller.abort()
  const cancelled = await runTaskGraph(root, tasks, 'package', async () => assert.fail('must not execute'), controller.signal)
  assert.equal(cancelled.cancelled, true)
})

test('task service requires a current reviewed graph and owns cancellation', async (t) => {
  const { root, scope } = await fixture(t)
  const profile = join(root, '.profile')
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname="demo"\n')
  const reviewed: string[][] = []
  const executed: string[] = []
  const plan: PlannedTask = { executable: join(tmpdir(), 'trusted-python'), args: ['-I'], cwd: root,
    environment: {}, timeoutMs: 30_000, tool: 'test-python' }
  const service = new TaskService({ profile: () => profile, files: () => scope,
    plan: async () => plan,
    approve: async (_path, items) => { reviewed.push(items.map(item => item.task.id)); return true },
    execute: async (item) => {
      executed.push(item.id)
      return { status: 'success', compiler: null, compileOutput: '', programOutput: '', exitCode: 0, durationMs: 1, message: 'done' }
    },
  })
  const record = await service.discover(root)
  const result = await service.run(root, 'python:compileall', record.revision)
  assert.deepEqual(reviewed, [['python:compileall']])
  assert.deepEqual(executed, ['python:compileall'])
  assert.equal(result.completed[0].result.status, 'success')

  await writeFile(join(root, 'pyproject.toml'), '[project]\nname="changed"\n')
  await assert.rejects(service.run(root, 'python:compileall', record.revision), /manifest changed/)
  assert.equal(reviewed.length, 1)

  const current = await service.discover(root)
  const waiting = new TaskService({ profile: () => join(root, '.waiting'), files: () => scope,
    plan: async () => plan,
    approve: (_path, _items, signal) => signal.aborted ? Promise.resolve(false)
      : new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })),
    execute: async () => assert.fail('cancelled review must not execute'),
  })
  const waitingRecord = await waiting.discover(root)
  const pending = waiting.run(root, current.tasks[0].id, waitingRecord.revision)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(waiting.cancel(), true)
  assert.equal((await pending).cancelled, true)
  await waiting.close()
  await service.close()
})
