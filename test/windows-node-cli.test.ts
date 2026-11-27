import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverWindowsNodeCli } from '../src/main/language-tools/windows-node-cli'

interface FixtureOptions {
  command?: 'typescript-language-server' | 'pyright-langserver'
  metadata?: unknown
  entry?: string
}

async function fixture(options: FixtureOptions = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-node-cli-'))
  const workspace = join(scratch, 'workspace')
  const prefix = join(scratch, 'npm-prefix')
  const command = options.command ?? 'typescript-language-server'
  const packageName = command === 'pyright-langserver' ? 'pyright' : 'typescript-language-server'
  const entry = options.entry ?? (command === 'pyright-langserver' ? 'langserver.index.js' : 'lib/cli.mjs')
  const packageRoot = join(prefix, 'node_modules', packageName)
  await mkdir(workspace)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(prefix, 'node.exe'), 'trusted node fixture')
  await chmod(join(prefix, 'node.exe'), 0o755).catch(() => {})
  await writeFile(join(prefix, `${command}.cmd`), '@echo off\r\nREM never executed by Ion\r\n')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  const entryPath = join(packageRoot, entry)
  await mkdir(join(entryPath, '..'), { recursive: true })
  await writeFile(entryPath, 'process.stdin.resume()\n')
  const metadata = options.metadata ?? {
    name: packageName,
    bin: { [command]: entry },
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata))
  return { scratch, workspace, prefix, command, packageRoot, entryPath }
}

test('discovers npm-installed TypeScript and Pyright CLIs through trusted Node without executing cmd shims', async () => {
  for (const command of ['typescript-language-server', 'pyright-langserver'] as const) {
    const value = await fixture({ command })
    try {
      const discovered = await discoverWindowsNodeCli(command, value.workspace, [value.prefix], 'win32')
      assert.ok(discovered)
      assert.equal(discovered.executable, await realpath(join(value.prefix, 'node.exe')))
      assert.deepEqual(discovered.args, [await realpath(value.entryPath)])
      assert.equal(discovered.packageRoot, await realpath(value.packageRoot))
      await discovered.verify()
    } finally { await rm(value.scratch, { recursive: true, force: true }) }
  }
})

test('rejects workspace PATH entries and npm packages controlled by the workspace', async () => {
  const value = await fixture()
  try {
    const workspacePrefix = join(value.workspace, 'npm-prefix')
    await mkdir(workspacePrefix, { recursive: true })
    await writeFile(join(workspacePrefix, 'node.exe'), 'workspace node')
    await chmod(join(workspacePrefix, 'node.exe'), 0o755).catch(() => {})
    await writeFile(join(workspacePrefix, 'typescript-language-server.cmd'), '@echo off\r\n')
    assert.equal(await discoverWindowsNodeCli(value.command, value.workspace, [workspacePrefix], 'win32'), null)
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})

test('rejects malformed, missing, mismatched and invalid package metadata', async () => {
  const cases: Array<{ label: string; metadata: unknown }> = [
    { label: 'missing bin', metadata: { name: 'typescript-language-server' } },
    { label: 'unexpected bin type', metadata: { name: 'typescript-language-server', bin: 42 } },
    { label: 'mismatched package', metadata: { name: 'not-the-server', bin: { 'typescript-language-server': 'lib/cli.mjs' } } },
    { label: 'missing supported bin', metadata: { name: 'typescript-language-server', bin: { other: 'lib/cli.mjs' } } },
  ]
  for (const item of cases) {
    const value = await fixture({ metadata: item.metadata })
    try {
      assert.equal(await discoverWindowsNodeCli(value.command, value.workspace, [value.prefix], 'win32'), null, item.label)
    } finally { await rm(value.scratch, { recursive: true, force: true }) }
  }
  const malformed = await fixture()
  try {
    await writeFile(join(malformed.packageRoot, 'package.json'), '{bad json')
    assert.equal(await discoverWindowsNodeCli(malformed.command, malformed.workspace, [malformed.prefix], 'win32'), null)
  } finally { await rm(malformed.scratch, { recursive: true, force: true }) }
  const oversized = await fixture()
  try {
    await writeFile(join(oversized.packageRoot, 'package.json'), ' '.repeat(64 * 1024 + 1))
    assert.equal(await discoverWindowsNodeCli(oversized.command, oversized.workspace, [oversized.prefix], 'win32'), null)
  } finally { await rm(oversized.scratch, { recursive: true, force: true }) }
})

test('rejects bin traversal and package junction or symlink escapes', async () => {
  const traversal = await fixture({ metadata: {
    name: 'typescript-language-server', bin: { 'typescript-language-server': '../escape.js' },
  } })
  try {
    await writeFile(join(traversal.packageRoot, '..', 'escape.js'), 'outside package')
    assert.equal(await discoverWindowsNodeCli(traversal.command, traversal.workspace, [traversal.prefix], 'win32'), null)
  } finally { await rm(traversal.scratch, { recursive: true, force: true }) }

  const linked = await fixture()
  try {
    const outside = join(linked.scratch, 'outside-package')
    await mkdir(outside)
    await writeFile(join(outside, 'package.json'), JSON.stringify({
      name: 'typescript-language-server', bin: { 'typescript-language-server': 'cli.mjs' },
    }))
    await writeFile(join(outside, 'cli.mjs'), 'outside package')
    await rm(linked.packageRoot, { recursive: true, force: true })
    await symlink(outside, linked.packageRoot, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await discoverWindowsNodeCli(linked.command, linked.workspace, [linked.prefix], 'win32'), null)
  } finally { await rm(linked.scratch, { recursive: true, force: true }) }
})

test('rejects a cmd shim without validated package metadata', async () => {
  const value = await fixture()
  try {
    await rm(value.packageRoot, { recursive: true, force: true })
    assert.equal(await discoverWindowsNodeCli(value.command, value.workspace, [value.prefix], 'win32'), null)
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})

test('detects package entry replacement between discovery and launch review', async () => {
  const value = await fixture()
  try {
    const discovered = await discoverWindowsNodeCli(value.command, value.workspace, [value.prefix], 'win32')
    assert.ok(discovered)
    await writeFile(value.entryPath, 'process.exit(23)\n')
    await assert.rejects(discovered.verify, /changed before launch/)
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})
