import assert from 'node:assert/strict'
import { execFile, execFileSync, type SpawnOptions } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { SourceControlService } from '../src/main/source-control'
import { git as runGit, resolveGit } from '../src/main/source-control/repository'
import { withFrozenConfiguration } from '../src/main/source-control/configuration'

const execute = promisify(execFile)
type FixtureGit = (...args: string[]) => Promise<string>

async function interceptGit(root: string, action: () => Promise<void>, before: (args: string[], options: SpawnOptions) => void) {
  // The real child still launches. Insert a real competing write exactly at its
  // launch boundary so the test does not depend on scheduler luck.
  const processes = require('node:child_process') as typeof import('node:child_process')
  const spawn = processes.spawn
  processes.spawn = ((command: string, args: string[], options: SpawnOptions) => {
    if (options?.cwd === root) before(args, options)
    return spawn(command, args, options)
  }) as typeof spawn
  try { await action() } finally { processes.spawn = spawn }
}

async function fixture(body: (context: {
  root: string; parent: string; service: SourceControlService; git: FixtureGit
}) => Promise<void>, beforeGit?: (args: readonly string[], git: FixtureGit) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ion-git-')))
  const root = join(parent, 'code repo')
  let service: SourceControlService | undefined
  try {
    await mkdir(root)
    const tool = await resolveGit(root, new AbortController().signal)
    assert.ok(tool, 'The Source Control integration tests require system Git')
    const git = async (...args: string[]) => (await execute(tool.executable, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: root, timeout: 8000, windowsHide: true })).stdout
    service = new SourceControlService(async (...request) => {
      await beforeGit?.(request[2], git)
      return runGit(...request)
    })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.name', 'Ion Fixture')
    await git('config', 'user.email', 'fixture@ion.invalid')
    await git('config', 'core.autocrlf', 'false')
    await body({ root, parent, service, git })
  } finally {
    service?.close()
    await service?.drain()
    await rm(parent, { recursive: true, force: true })
  }
}

async function status(service: SourceControlService, root: string) {
  const result = await service.status(root)
  assert.equal(result.kind, 'repository')
  return result
}

test('Source Control reports saved and staged content, stages literal paths and commits only the index', async () => {
  await fixture(async ({ root, service, git }) => {
    const path = '-資料 notes.c'
    const disk = join(root, path)
    const oldText = 'int value = 1;\r\n'
    const stagedText = 'int value = 2;\r\n'
    const workingText = 'int value = 3;\r\n'
    await writeFile(disk, oldText)
    await writeFile(join(root, '.gitignore'), 'local-secret\n')
    await git('add', '--', path, '.gitignore')
    await git('commit', '-qm', 'Initial source')
    await writeFile(disk, stagedText)
    await writeFile(join(root, 'local-secret'), 'ignored fixture\n')
    await writeFile(join(root, 'untouched.txt'), 'keep this untracked\n')
    let current = await status(service, root)
    assert.equal(current.branch, 'main')
    assert.equal(current.unborn, false)
    assert.deepEqual(current.entries.map(({ path, index, worktree }) => [path, index, worktree]),
      [[path, '', 'M'], ['untouched.txt', '', '?']])
    assert.deepEqual(await service.diff(root, { path, side: 'working' }), {
      path, absolutePath: disk, previousPath: undefined, side: 'working', kind: 'text', original: oldText, modified: stagedText,
    })
    await assert.rejects(async () => service.change(root, { path: 'local-secret', action: 'stage' }), /Refresh/)
    await assert.rejects(async () => service.change(root, { path: '../outside', action: 'stage' }), /Invalid Git path/)
    await service.change(root, { path, action: 'stage' })
    assert.equal(await git('show', ':' + path), stagedText)
    await writeFile(disk, workingText)
    current = await status(service, root)
    assert.deepEqual(current.entries.map(({ path, index, worktree }) => [path, index, worktree]),
      [[path, 'M', 'M'], ['untouched.txt', '', '?']])
    const index = await service.diff(root, { path, side: 'staged' })
    assert.equal(index.kind, 'text')
    assert.equal(index.original, oldText)
    assert.equal(index.modified, stagedText)
    const working = await service.diff(root, { path, side: 'working' })
    assert.equal(working.kind, 'text')
    assert.equal(working.original, stagedText)
    assert.equal(working.modified, workingText)
    await service.change(root, { path, action: 'unstage' })
    assert.equal(await git('show', ':' + path), oldText)
    assert.equal(await readFile(disk, 'utf8'), workingText)
    await status(service, root)
    await service.change(root, { path, action: 'stage' })
    await status(service, root)
    await service.commit(root, { message: 'Update value' })
    assert.equal(await git('show', 'HEAD:' + path), workingText)
    assert.equal((await git('log', '-1', '--format=%s')).trim(), 'Update value')
    assert.deepEqual((await status(service, root)).entries.map(({ path }) => path), ['untouched.txt'])
  })
})

test('Source Control preserves racy-index detection when staging same-size timestamp-preserving changes', async () => {
  await fixture(async ({ root, service, git }) => {
    await git('config', 'core.trustctime', 'false')
    await git('config', 'core.checkStat', 'minimal')
    const path = 'same-second.txt'
    const disk = join(root, path)
    const timestamp = Math.floor(Date.now() / 1000) - 10
    await writeFile(disk, 'before\n')
    await utimes(disk, timestamp, timestamp)
    await git('add', '--', path)
    await git('commit', '-qm', 'Original content')
    // Reproduce a coarse filesystem clock without sleeps. Git must rehash a
    // same-size entry whose timestamp meets its index's racy boundary.
    await utimes(join(root, '.git', 'index'), timestamp, timestamp)
    await writeFile(disk, 'after!\n')
    await utimes(disk, timestamp, timestamp)
    assert.equal((await status(service, root)).entries.find(entry => entry.path === path)?.worktree, 'M')
    await service.change(root, { path, action: 'stage' })
    assert.equal(await git('show', ':' + path), 'after!\n')
    assert.equal(await readFile(disk, 'utf8'), 'after!\n')
  })
})

test('Source Control handles first commits, renames, deletion, detached HEAD and bounded diffs', async () => {
  await fixture(async ({ root, service, git }) => {
    const first = 'notes.txt'
    const next = 'renamed notes.txt'
    await writeFile(join(root, first), 'an original line\n')
    assert.equal((await status(service, root)).unborn, true)
    await service.change(root, { path: first, action: 'stage' })
    await status(service, root)
    await service.change(root, { path: first, action: 'unstage' })
    assert.deepEqual((await status(service, root)).entries.map(({ worktree }) => worktree), ['?'])
    await service.change(root, { path: first, action: 'stage' })
    await status(service, root)
    await service.commit(root, { message: 'First commit' })
    await git('mv', '--', first, next)
    const renamed = (await status(service, root)).entries[0]
    assert.equal(renamed.index, 'R')
    assert.equal(renamed.previousPath, first)
    const diff = await service.diff(root, { path: next, side: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'an original line\n')
    assert.equal(diff.modified, diff.original)
    await service.change(root, { path: next, action: 'unstage' })
    assert.equal(await readFile(join(root, next), 'utf8'), diff.modified)
    const deleted = (await status(service, root)).entries.find(({ path }) => path === first)
    assert.equal(deleted?.worktree, 'D')
    const deletion = await service.diff(root, { path: first, side: 'working' })
    assert.equal(deletion.kind, 'text')
    assert.equal(deletion.modified, '')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'large.txt'), 'x'.repeat(256 * 1024 + 1))
    await writeFile(join(root, 'long.txt'), 'x\n'.repeat(12_001))
    await git('checkout', '--detach', '-q')
    assert.equal((await status(service, root)).detached, true)
    for (const path of ['binary.dat', 'large.txt', 'long.txt']) {
      assert.equal((await service.diff(root, { path, side: 'working' })).kind, 'unavailable')
    }
  })
})

test('Source Control scopes nested folders and supports only linked worktrees with matching metadata', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    const folder = join(root, 'child')
    const worktree = join(parent, 'linked project')
    await mkdir(folder)
    assert.equal((await service.status(folder)).kind, 'none')
    await git('worktree', 'add', '-q', '-b', 'linked', worktree)
    await writeFile(join(worktree, 'linked.txt'), 'owned by the linked worktree')
    assert.equal((await status(service, worktree)).branch, 'linked')
    await assert.rejects(async () => service.change(root, { path: 'linked.txt', action: 'stage' }), /Refresh/)
    await service.change(worktree, { path: 'linked.txt', action: 'stage' })
    assert.equal((await status(service, worktree)).entries[0].index, 'A')
    assert.equal(await git('diff', '--cached', '--name-only'), '')
    const forged = join(parent, 'forged workspace')
    await mkdir(forged)
    await writeFile(join(forged, '.git'), await readFile(join(worktree, '.git')))
    await assert.rejects(service.status(forged), /does not match this workspace/)
    const outstanding = service.status(root)
    service.close()
    await assert.rejects(outstanding, { name: 'AbortError' })
  })
})

test('Source Control avoids hooks and local filters and detects an externally changed index before committing', async () => {
  await fixture(async ({ root, service, git }) => {
    const hook = join(root, '.git', 'hooks', 'post-commit')
    await writeFile(hook, '#!/bin/sh\ntouch ion-hook-ran\n')
    await chmod(hook, 0o755)
    await git('config', 'core.hooksPath', '.git/hooks')
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    await status(service, root)
    await service.change(root, { path: 'one.txt', action: 'stage' })
    await status(service, root)
    await git('add', '--', 'two.txt')
    await assert.rejects(async () => service.commit(root, { message: 'Stale' }), /Staged changes.*changed/)
    await status(service, root)
    await service.commit(root, { message: 'Explicit commit' })
    await assert.rejects(readFile(join(root, 'ion-hook-ran')), { code: 'ENOENT' })
    await git('config', 'filter.untrusted.clean', 'touch ion-filter-ran')
    await writeFile(join(root, '.gitattributes'), '*.txt filter=untrusted\n')
    await writeFile(join(root, 'one.txt'), 'modified\n')
    await assert.rejects(service.status(root), /configures a local Git filter/)
    await assert.rejects(readFile(join(root, 'ion-filter-ran')), { code: 'ENOENT' })
  })
})

test('a late external stage stays in the real index and outside the reviewed commit', async () => {
  let realIndexAfterStage: Buffer | undefined
  let workingRoot = ''
  let injected = false
  await fixture(async ({ root, service, git }) => {
    workingRoot = root
    await writeFile(join(root, 'reviewed.txt'), 'before\n')
    await writeFile(join(root, 'old name.txt'), 'rename this\n')
    await writeFile(join(root, 'removed.txt'), 'remove this\n')
    await git('add', '--', 'reviewed.txt', 'old name.txt', 'removed.txt')
    await git('commit', '-qm', 'Initial commit')
    await writeFile(join(root, 'reviewed.txt'), 'reviewed\n')
    await writeFile(join(root, 'not-reviewed.txt'), 'outside the reviewed tree\n')
    await git('add', '--', 'reviewed.txt')
    await git('mv', '--', 'old name.txt', 'new name.txt')
    await git('rm', '--', 'removed.txt')
    const current = await status(service, root)
    assert.deepEqual(current.entries.filter(entry => entry.index).map(({ path, index }) => [path, index]),
      [['new name.txt', 'R'], ['removed.txt', 'D'], ['reviewed.txt', 'M']])
    await service.commit(root, { message: 'Publish reviewed changes locally' })
    assert.equal(injected, true)
    assert.equal(await git('ls-tree', '--name-only', 'HEAD'), 'new name.txt\nreviewed.txt\n')
    assert.equal(await git('show', 'HEAD:reviewed.txt'), 'reviewed\n')
    assert.equal(await git('show', ':reviewed.txt'), 'staged during commit\n')
    assert.equal(await git('show', ':not-reviewed.txt'), 'outside the reviewed tree\n')
    assert.deepEqual(await readFile(join(root, '.git', 'index')), realIndexAfterStage)
  }, async (args, git) => {
    if (args[0] !== 'update-ref') return
    injected = true
    await writeFile(join(workingRoot, 'reviewed.txt'), 'staged during commit\n')
    await git('add', '--', 'not-reviewed.txt', 'reviewed.txt')
    realIndexAfterStage = await readFile(join(workingRoot, '.git', 'index'))
  })
})

test('a concurrent branch advance fails the ref compare-and-swap without modifying the index', async () => {
  let externalCommit = ''
  await fixture(async ({ root, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    await writeFile(join(root, 'reviewed.txt'), 'will remain staged\n')
    await git('add', '--', 'reviewed.txt')
    await status(service, root)
    const index = await readFile(join(root, '.git', 'index'))
    await assert.rejects(async () => service.commit(root, { message: 'Stale parent' }), /cannot lock ref/)
    assert.ok(externalCommit)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), externalCommit)
    assert.equal(await git('diff', '--cached', '--name-only'), 'reviewed.txt\n')
    assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
  }, async (args, git) => {
    if (args[0] !== 'update-ref') return
    const old = (await git('rev-parse', 'HEAD')).trim()
    const tree = (await git('rev-parse', 'HEAD^{tree}')).trim()
    externalCommit = (await git('commit-tree', tree, '-p', old, '-m', 'External commit')).trim()
    await git('update-ref', 'refs/heads/main', externalCommit, old)
  })
})

test('committing a linked worktree keeps its real index and blocks detached and sequencer state', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    const head = (await git('rev-parse', 'HEAD')).trim()
    const worktree = join(parent, 'second workspace')
    await git('worktree', 'add', '-q', '-b', 'linked', worktree)
    await writeFile(join(worktree, 'linked.txt'), 'linked commit\n')
    await status(service, worktree)
    await service.change(worktree, { path: 'linked.txt', action: 'stage' })
    await status(service, worktree)
    await service.commit(worktree, { message: 'Commit from linked worktree' })
    assert.equal(await git('show', 'linked:linked.txt'), 'linked commit\n')
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    await writeFile(join(root, 'staged.txt'), 'remain staged')
    await git('add', '--', 'staged.txt')
    await writeFile(join(root, '.git', 'MERGE_HEAD'), head + '\n')
    await status(service, root)
    await assert.rejects(async () => service.commit(root, { message: 'Pending merge' }), /Finish the active Git operation/)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    await rm(join(root, '.git', 'MERGE_HEAD'))
    await git('checkout', '--detach', '-q')
    await status(service, root)
    await assert.rejects(async () => service.commit(root, { message: 'Detached' }), /Switch to a branch/)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), head)
    assert.equal(await git('diff', '--cached', '--name-only'), 'staged.txt\n')
  })
})

test('a clean filter added at the real Stage launch cannot escape the captured configuration', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await writeFile(join(root, '.gitattributes'), '*.txt filter=late\n')
    await writeFile(join(root, 'data.txt'), 'exact staged text\r\n')
    const marker = join(root, 'filter-ran')
    const script = join(parent, 'filter.cjs')
    await writeFile(script, 'require("node:fs").writeFileSync("filter-ran", "executed"); process.stdin.pipe(process.stdout)')
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    await status(service, root)
    let injected = false
    let projection = ''
    await interceptGit(root, async () => service.change(root, { path: 'data.txt', action: 'stage' }), args => {
      if (!args.includes('add')) return
      injected = true
      projection = args.find(value => value.startsWith('--git-dir='))!.slice('--git-dir='.length)
      execFileSync('git', ['-C', root, 'config', 'filter.late.clean', command], { windowsHide: true })
    })
    assert.equal(injected, true)
    assert.equal(existsSync(marker), false, 'The raced clean filter executed.')
    assert.equal(await git('show', ':data.txt'), 'exact staged text\r\n')
    assert.notEqual(projection, join(root, '.git'))
    assert.equal(existsSync(projection), false, 'The private configuration survived the operation.')
    await assert.rejects(service.status(root), /local Git filter/)
  })
})

test('a replaced included configuration cannot introduce a filter after capture', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    const included = join(parent, 'included.cfg')
    const marker = join(root, 'included-filter-ran')
    const script = join(parent, 'included-filter.cjs')
    await writeFile(script, 'require("node:fs").writeFileSync("included-filter-ran", "executed"); process.stdin.pipe(process.stdout)')
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    await writeFile(included, '[core]\n\tautocrlf = false\n')
    await git('config', 'include.path', included)
    await writeFile(join(root, '.gitattributes'), '*.txt filter=included text eol=lf\n')
    await writeFile(join(root, 'data.txt'), 'normalize this\r\n')
    await status(service, root)
    await interceptGit(root, async () => service.change(root, { path: 'data.txt', action: 'stage' }), args => {
      if (!args.includes('add')) return
      const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      writeFileSync(included, `[filter "included"]\n\tclean = "${escaped}"\n`)
    })
    assert.equal(existsSync(marker), false)
    assert.equal(await git('show', ':data.txt'), 'normalize this\n')
    await assert.rejects(service.status(root), /local Git filter/)
  })
})

test('linked-worktree process filters introduced at launch cannot affect the original worktree index', async () => {
  await fixture(async ({ parent, service, git }) => {
    await git('commit', '--allow-empty', '-qm', 'Initial commit')
    await git('config', 'extensions.worktreeConfig', 'true')
    const worktree = join(parent, 'linked café')
    await git('worktree', 'add', '-q', '-b', 'linked-race', worktree)
    const marker = join(worktree, 'process-filter-ran')
    const script = join(parent, 'process-filter.cjs')
    await writeFile(script, 'require("node:fs").writeFileSync("process-filter-ran","executed");setInterval(()=>{},1000)')
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    await writeFile(join(worktree, '.gitattributes'), '*.txt filter=process-race\n')
    await writeFile(join(worktree, 'data.txt'), 'only the linked index\n')
    await status(service, worktree)
    await interceptGit(worktree, async () => service.change(worktree, { path: 'data.txt', action: 'stage' }), args => {
      if (args.includes('add')) execFileSync('git', ['-C', worktree, 'config', '--worktree', 'filter.process-race.process', command],
        { windowsHide: true })
    })
    assert.equal(existsSync(marker), false)
    assert.equal(await git('-C', worktree, 'show', ':data.txt'), 'only the linked index\n')
    assert.equal(await git('diff', '--cached', '--name-only'), '')
    await assert.rejects(service.status(worktree), /local Git filter/)
  })
})

test('split indices, common excludes, and CRLF conversion survive private configuration cleanup', async () => {
  await fixture(async ({ root, service, git }) => {
    await writeFile(join(root, '.gitattributes'), '*.txt text eol=lf\n')
    await writeFile(join(root, '.git', 'info', 'exclude'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'do not stage\n')
    await writeFile(join(root, 'data.txt'), 'first\r\n')
    await git('add', '--', '.gitattributes', 'data.txt')
    await git('commit', '-qm', 'Initial commit')
    await git('update-index', '--split-index')
    await writeFile(join(root, 'data.txt'), 'changed\r\n')
    assert.deepEqual((await status(service, root)).entries.map(entry => entry.path), ['data.txt'])
    await service.change(root, { path: 'data.txt', action: 'stage' })
    assert.equal(await git('show', ':data.txt'), 'changed\n')
    assert.equal(await git('diff', '--cached', '--name-only'), 'data.txt\n')
    await status(service, root)
    await service.commit(root, { message: 'Commit normalized split index' })
    assert.equal(await git('show', 'HEAD:data.txt'), 'changed\n')
  })
})

test('native reftable repositories retain staging, linked-worktree status, and reviewed commits', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await git('refs', 'migrate', '--ref-format=reftable')
    await writeFile(join(root, 'data.txt'), 'reftable data\n')
    await status(service, root)
    await service.change(root, { path: 'data.txt', action: 'stage' })
    await status(service, root)
    await service.commit(root, { message: 'First reftable commit' })
    assert.equal(await git('show', 'HEAD:data.txt'), 'reftable data\n')
    const linked = join(parent, 'reftable linked')
    await git('worktree', 'add', '-q', '-b', 'reftable-linked', linked)
    await writeFile(join(linked, 'another.txt'), 'linked reftable\n')
    assert.equal((await status(service, linked)).branch, 'reftable-linked')
    await service.change(linked, { path: 'another.txt', action: 'stage' })
    await status(service, linked)
    await service.commit(linked, { message: 'Linked reftable commit' })
    assert.equal(await git('show', 'reftable-linked:another.txt'), 'linked reftable\n')
    assert.equal(await git('diff', '--cached', '--name-only'), '')
  })
})

test('frozen configuration preserves booleans and escaped values without retaining include directives', async () => {
  await fixture(async ({ root, git }) => {
    const tool = await resolveGit(root, new AbortController().signal)
    assert.ok(tool)
    const repository = { root, directory: join(root, '.git'), ...tool }
    const name = 'filter.quoted"\\\tsubsection.clean'
    const value = 'quoted "value" \\ path\tand\nnext line'
    const records = `global\0${name}\n${value}\0global\0core.ignorecase\0local\0core.autocrlf\nfalse\0`
    await withFrozenConfiguration(repository, records, new AbortController().signal, async directory => {
      const config = join(directory, 'config')
      const read = (...args: string[]) => execute(tool.executable, ['config', '--file', config, ...args])
      assert.equal((await read('--get', name)).stdout, value + '\n')
      assert.equal((await read('--bool', '--get', 'core.ignorecase')).stdout.trim(), 'true')
      assert.equal((await read('--bool', '--get', 'core.autocrlf')).stdout.trim(), 'false')
    })
    assert.equal(await git('status', '--porcelain'), '')
  })
})

test('a captured conditional global filter still runs with its normalization semantics', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    const script = join(parent, 'approved-filter.cjs')
    const included = join(parent, 'approved.cfg')
    const globalConfig = join(parent, 'global.cfg')
    await writeFile(script, 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>text+=s);process.stdin.on("end",()=>{require("node:fs").writeFileSync("approved-filter-ran","yes");process.stdout.write(text.toUpperCase())})')
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await writeFile(included, `[filter "approved"]\n\tclean = "${escape(command)}"\n`)
    await writeFile(globalConfig, `[includeIf "gitdir:${escape(join(root, '.git').replace(/\\/g, '/'))}"]\n\tpath = "${escape(included)}"\n`)
    await writeFile(join(root, '.gitattributes'), '*.txt filter=approved text eol=lf\n')
    await writeFile(join(root, 'data.txt'), 'approved global text\r\n')
    await interceptGit(root, async () => {
      await status(service, root)
      await service.change(root, { path: 'data.txt', action: 'stage' })
    }, (args, options) => {
      if (args.includes('config') && args.includes('--show-scope')) {
        options.env = { ...options.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
      }
    })
    assert.equal(await readFile(join(root, 'approved-filter-ran'), 'utf8'), 'yes')
    assert.equal(await git('show', ':data.txt'), 'APPROVED GLOBAL TEXT\n')
    assert.equal(await readFile(join(root, 'data.txt'), 'utf8'), 'approved global text\r\n')
  })
})

test('unknown filter metadata is retained and cannot publish an index that depends on disposable data', async () => {
  await fixture(async ({ root, parent, service }) => {
    const script = join(parent, 'metadata-filter.cjs')
    const config = join(parent, 'metadata-global.cfg')
    await writeFile(script, `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
      const dir=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();
      fs.mkdirSync(p.join(dir,'custom-storage'),{recursive:true});fs.writeFileSync(p.join(dir,'custom-storage','object'),'durable filter data');process.stdin.pipe(process.stdout);`)
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    await writeFile(config, `[filter "metadata"]\n\tclean = "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`)
    await writeFile(join(root, '.gitattributes'), '*.txt filter=metadata\n')
    await writeFile(join(root, 'data.txt'), 'source stays local\n')
    await status(service, root)
    let recovery = ''
    try {
      await interceptGit(root, async () => {
        await assert.rejects(async () => service.change(root, { path: 'data.txt', action: 'stage' }), (error: Error) => {
          const match = /Ion preserved the metadata at (.+)$/.exec(error.message)
          assert.ok(match, error.message)
          recovery = match[1]
          return true
        })
      }, (args, options) => {
        if (args.includes('config') && args.includes('--show-scope')) {
          options.env = { ...options.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
        }
      })
      assert.equal(await readFile(join(recovery, 'common', 'custom-storage', 'object'), 'utf8'), 'durable filter data')
      assert.equal(existsSync(join(root, '.git', 'index')), false)
      assert.equal(existsSync(join(root, '.git', 'index.lock')), false)
      assert.equal(await readFile(join(root, 'data.txt'), 'utf8'), 'source stays local\n')
    } finally {
      if (recovery) {
        assert.ok(recovery.includes('ion-git-config-'))
        await rm(recovery, { recursive: true, force: true })
      }
    }
  })
})

test('repository-controlled executable LFS settings are refused before running a global filter', async () => {
  await fixture(async ({ root, service, git }) => {
    for (const key of ['lfs.extension.fixture.clean', 'lfs.extension.fixture.smudge',
      'lfs.customtransfer.fixture.path', 'lfs.customtransfer.fixture.args', 'lfs.standalonetransferagent']) {
      await git('config', key, 'unreviewed fixture command')
      await assert.rejects(service.status(root), /local Git filter/)
      await git('config', '--unset', key)
    }
    assert.equal((await status(service, root)).entries.length, 0)
  })
})

test('closing during final commit publication waits for the reviewed ref update', async () => {
  let current: SourceControlService | undefined
  let closing: Promise<void> | undefined
  await fixture(async ({ root, service, git }) => {
    current = service
    await writeFile(join(root, 'reviewed.txt'), 'reviewed tree\n')
    await git('add', '--', 'reviewed.txt')
    await status(service, root)
    await service.commit(root, { message: 'Finish publication safely' })
    await closing
    assert.equal(await git('show', 'HEAD:reviewed.txt'), 'reviewed tree\n')
    assert.equal((await git('log', '-1', '--format=%s')).trim(), 'Finish publication safely')
    assert.equal(existsSync(join(root, '.git', 'refs', 'heads', 'main.lock')), false)
  }, async args => {
    if (args[0] === 'update-ref') {
      current!.close()
      closing = current!.drain()
    }
  })
})

test('closing Source Control cancels an in-flight native Git write and drains its child', async () => {
  await fixture(async ({ root, parent, service }) => {
    await writeFile(join(root, 'data.txt'), 'stage this')
    await status(service, root)
    const marker = join(parent, 'git-writer.pid')
    const script = join(parent, 'slow-git.cjs')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const processes = require('node:child_process') as typeof import('node:child_process')
    const spawn = processes.spawn
    processes.spawn = ((command: string, args: string[], options: SpawnOptions) =>
      spawn(options.cwd === root && args.includes('add') ? process.execPath : command,
        options.cwd === root && args.includes('add') ? [script] : args, options)) as typeof spawn
    try {
      const work = service.change(root, { path: 'data.txt', action: 'stage' })
      const settled = assert.rejects(work, { name: 'AbortError' })
      const deadline = performance.now() + 4000
      while (!existsSync(marker) && performance.now() < deadline) await sleep(10)
      assert.ok(existsSync(marker), 'The real native write process did not start.')
      const pid = Number(await readFile(marker, 'utf8'))
      const started = performance.now()
      service.close()
      await service.drain()
      await settled
      assert.ok(performance.now() - started < 3000, 'Close waited for the normal Git timeout.')
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    } finally { processes.spawn = spawn }
  })
})

test('canceling genuine Git with a running global filter preserves the index and removes only owned locks', async () => {
  await fixture(async ({ root, parent, service, git }) => {
    await writeFile(join(root, 'data.txt'), 'original index bytes\n')
    await git('add', '--', 'data.txt')
    const original = await readFile(join(root, '.git', 'index'))
    const marker = join(parent, 'real-filter.pid')
    const script = join(parent, 'slow-filter.cjs')
    const config = join(parent, 'slow-global.cfg')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`)
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    await writeFile(config, `[filter "slow"]\n\tclean = "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`)
    await writeFile(join(root, '.gitattributes'), '*.txt filter=slow\n')
    await writeFile(join(root, 'data.txt'), 'unsaved by stage\n')
    await status(service, root)
    await interceptGit(root, async () => {
      const work = service.change(root, { path: 'data.txt', action: 'stage' })
      const rejected = assert.rejects(work, { name: 'AbortError' })
      const deadline = performance.now() + 4000
      while (!existsSync(marker) && performance.now() < deadline) await sleep(10)
      assert.ok(existsSync(marker), 'The genuine Git clean filter never started.')
      assert.equal(existsSync(join(root, '.git', 'index.lock')), true)
      const pid = Number(await readFile(marker, 'utf8'))
      service.close()
      await service.drain()
      await rejected
      const exitDeadline = performance.now() + 2000
      while (performance.now() < exitDeadline) {
        try { process.kill(pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          throw error
        }
        await sleep(10)
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }, (args, options) => {
      if (args.includes('config') && args.includes('--show-scope')) {
        options.env = { ...options.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
      }
    })
    assert.equal(existsSync(join(root, '.git', 'index.lock')), false)
    assert.deepEqual(await readFile(join(root, '.git', 'index')), original)
    assert.equal(await readFile(join(root, 'data.txt'), 'utf8'), 'unsaved by stage\n')
    assert.equal((await readdir(join(root, '.git'))).some(name => name.startsWith('.ion-index-')), false)
    await status(service, root)
    await service.change(root, { path: 'data.txt', action: 'stage' })
    assert.equal(await git('show', ':data.txt'), 'unsaved by stage\n')
    const lock = join(root, '.git', 'index.lock')
    await writeFile(lock, 'foreign lock', { flag: 'wx' })
    await status(service, root)
    await assert.rejects(async () => service.change(root, { path: '.gitattributes', action: 'stage' }), /index lock/)
    assert.equal(await readFile(lock, 'utf8'), 'foreign lock')
  })
})
