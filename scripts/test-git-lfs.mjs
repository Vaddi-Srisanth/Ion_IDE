import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { build } from 'esbuild'
import { buildWindowsPty } from './windows/build-pty.mjs'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const processes = require('node:child_process')
const { values } = parseArgs({ options: {
  toolpath: { type: 'string' },
  out: { type: 'string', default: 'performance-results/stabilization/git-lfs.json' },
} })
const windows = process.platform === 'win32'
const nullPath = windows ? 'NUL' : '/dev/null'
const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const environment = { ...baseEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullPath,
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
const gitOptions = ['-c', 'core.hooksPath=' + nullPath, '-c', 'commit.gpgSign=false', '-c', 'protocol.allow=never']
const report = { complete: false, platform: process.platform, arch: process.arch, cases: [] }
const quote = (value) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
const shellQuote = (value) => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"

async function git(root, args, extraEnvironment = {}) {
  const result = await execute('git', ['-C', root, ...gitOptions, ...args], {
    env: { ...environment, ...extraEnvironment }, windowsHide: true, timeout: 12_000, maxBuffer: 2 * 1024 * 1024,
  })
  return result.stdout
}

async function absent(path) {
  return readFile(path).then(() => false, (error) => {
    if (error.code === 'ENOENT') return true
    throw error
  })
}

async function main() {
  const tool = values.toolpath ? resolve(values.toolpath) : undefined
  const preflightStarted = performance.now()
  try {
    const result = tool
      ? await execute(tool, ['version'], { env: environment, windowsHide: true, timeout: 5000 })
      : await execute('git', ['lfs', 'version'], { env: environment, windowsHide: true, timeout: 5000 })
    report.preflight = { elapsedMs: performance.now() - preflightStarted, state: 'success', directTool: !!tool }
    report.toolVersion = result.stdout.trim()
    assert.match(report.toolVersion, /^git-lfs\//, 'The executable must be genuine Git LFS.')
    report.toolSha256 = tool ? createHash('sha256').update(await readFile(tool)).digest('hex') : undefined
  } catch (error) {
    report.preflight = { elapsedMs: performance.now() - preflightStarted, state: 'failed', directTool: !!tool,
      code: typeof error.code === 'number' ? error.code : ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(error.code) ? error.code : null,
      killed: error.killed === true, signal: ['SIGTERM', 'SIGKILL'].includes(error.signal) ? error.signal : null }
    report.unavailable = 'Git LFS preflight failed or its executable is unavailable. Review the structured preflight result; --toolpath can select an installed executable.'
    console.error('UNAVAILABLE genuine Git LFS integration test. ' + report.unavailable)
    process.exitCode = 2
    return
  }

  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-real-lfs-')))
  const spawn = processes.spawn
  let service
  try {
    const entry = join(scratch, 'source-control.cjs')
    const modulePath = path => JSON.stringify(resolve(path).replaceAll('\\', '/'))
    await build({ stdin: { contents: `export { SourceControlService } from ${modulePath('src/main/source-control/index.ts')};
      export { configureWindowsProcessHelper } from ${modulePath('src/main/windows-process.ts')};`,
      resolveDir: resolve('.'), loader: 'ts' }, outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const { SourceControlService, configureWindowsProcessHelper } = require(entry)
    if (windows) {
      const helper = join(scratch, 'ion-pty.exe')
      await buildWindowsPty(helper, process.arch)
      configureWindowsProcessHelper(helper)
    }
    service = new SourceControlService()
    const root = join(scratch, 'source résumé')
    const linked = join(scratch, 'linked 資料')
    await mkdir(root)
    await git(root, ['init', '-q', '-b', 'main'])
    await git(root, ['config', 'user.name', 'Ion Git LFS Fixture'])
    await git(root, ['config', 'user.email', 'fixture@ion.invalid'])
    await git(root, ['config', 'core.autocrlf', 'false'])
    await writeFile(join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    await git(root, ['add', '--', '.gitattributes'])
    await git(root, ['commit', '-qm', 'Offline LFS fixture'])

    const common = join(root, '.git')
    const approved = join(scratch, 'approved-global-lfs.cfg')
    const globalConfig = join(scratch, 'disposable-global.cfg')
    const command = tool ? shellQuote(tool) : 'git-lfs'
    await writeFile(approved, '[filter "lfs"]\n'
      + '\tprocess = ' + quote(command + ' filter-process') + '\n'
      + '\tclean = ' + quote(command + ' clean -- %f') + '\n'
      + '\tsmudge = ' + quote(command + ' smudge -- %f') + '\n'
      + '\trequired = true\n')
    const match = common.replace(/\\/g, '/')
    await writeFile(globalConfig,
      '[includeIf ' + quote('gitdir:' + match) + ']\n\tpath = ' + quote(approved) + '\n'
      + '[includeIf ' + quote('gitdir:' + match + '/worktrees/') + ']\n\tpath = ' + quote(approved) + '\n')

    // Only the capture sees this disposable user config. The actual projected
    // Git/filter process must obtain its settings from the checked snapshot.
    let beforeProjectedAdd
    processes.spawn = (command, args, options) => {
      if ((options?.cwd === root || options?.cwd === linked) && args.includes('config') && args.includes('--show-scope')) {
        options = { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' } }
      }
      if (options?.cwd === root && args.includes('add') && beforeProjectedAdd) {
        const inject = beforeProjectedAdd
        beforeProjectedAdd = undefined
        inject()
      }
      return spawn(command, args, options)
    }

    async function stageAndVerify(workspace, name, content, storage) {
      await writeFile(join(workspace, name), content)
      assert.equal((await service.status(workspace)).kind, 'repository')
      await service.change(workspace, { path: name, action: 'stage' })
      const oid = createHash('sha256').update(content).digest('hex')
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`
      assert.equal(await git(workspace, ['show', ':' + name]), pointer, 'The staged bytes must be the real LFS pointer.')
      const object = join(storage, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)
      assert.deepEqual(await readFile(object), content, 'The durable LFS object must survive projection disposal.')
      assert.deepEqual(await readFile(join(workspace, name)), content, 'Staging must preserve the source bytes.')
      return oid
    }

    const first = Buffer.from('Ion offline real LFS source\r\n\0'.repeat(1800))
    await stageAndVerify(root, 'résumé 資料.bin', first, join(common, 'lfs'))
    report.cases.push('conditional global streaming filter creates a real pointer and durable original-common object')
    console.log('PASS genuine Git LFS streaming filter preserves source and durable original-common storage')

    await git(root, ['commit', '-qm', 'Preserve source through LFS'], { GIT_CONFIG_GLOBAL: globalConfig })
    await git(root, ['worktree', 'add', '-q', '-b', 'linked', linked], { GIT_CONFIG_GLOBAL: globalConfig, GIT_LFS_SKIP_SMUDGE: '1' })
    const originalIndex = await readFile(join(common, 'index'))
    const linkedData = Buffer.from('Linked source bytes\n\0'.repeat(1300))
    await stageAndVerify(linked, 'linked 資料.bin', linkedData, join(common, 'lfs'))
    assert.deepEqual(await readFile(join(common, 'index')), originalIndex, 'A linked stage must preserve the other index.')
    report.cases.push('linked worktree stages through common durable LFS storage and preserves the other index')
    console.log('PASS genuine linked-worktree LFS shares durable objects and keeps separate indices')

    await git(root, ['config', 'lfs.storage', 'custom-lfs'])
    await stageAndVerify(root, 'relative-store.bin', Buffer.from('relative storage\n'), join(common, 'custom-lfs'))
    report.cases.push('relative configured LFS storage remains relative to the original common Git directory')
    console.log('PASS genuine LFS relative storage remains anchored to the original repository')

    const absoluteStorage = join(scratch, 'explicit absolute LFS storage')
    await git(root, ['config', 'lfs.storage', absoluteStorage])
    await stageAndVerify(root, 'absolute-store.bin', Buffer.from('absolute storage\n'), absoluteStorage)
    report.cases.push('explicit absolute LFS storage is preserved')
    console.log('PASS genuine LFS explicit absolute storage is preserved')

    const marker = join(scratch, 'unapproved-extension-ran')
    const extension = join(scratch, 'unapproved-extension.cjs')
    await writeFile(extension, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout)`)
    const extensionCommand = shellQuote(process.execPath) + ' ' + shellQuote(extension)
    let injected = false
    beforeProjectedAdd = () => {
      appendFileSync(join(common, 'config'), '\n[lfs "extension.unapproved"]\n\tclean = '
        + quote(extensionCommand) + '\n\tpriority = 0\n')
      injected = true
    }
    await stageAndVerify(root, 'late-extension.bin', Buffer.from('late local configuration stays outside the snapshot\n'), absoluteStorage)
    assert.equal(injected, true, 'The malicious config must arrive immediately before the actual projected add.')
    assert.equal(await absent(marker), true, 'Nested genuine Git LFS must also use the frozen configuration.')
    await git(root, ['config', '--remove-section', 'lfs.extension.unapproved'])
    report.cases.push('LFS ignores an executable local extension injected after capture and before real add')
    console.log('PASS genuine Git LFS ignores a local extension injected at the projected launch boundary')

    await writeFile(join(root, 'blocked.bin'), 'unapproved extension source\n')
    assert.equal((await service.status(root)).kind, 'repository')
    const before = await readFile(join(common, 'index'))
    await git(root, ['config', 'lfs.extension.unapproved.clean', extensionCommand])
    await git(root, ['config', 'lfs.extension.unapproved.priority', '0'])
    await assert.rejects(service.change(root, { path: 'blocked.bin', action: 'stage' }), /local.*(?:filter|LFS)|extension/i)
    assert.equal(await absent(marker), true, 'The repository-defined executable must never run.')
    assert.deepEqual(await readFile(join(common, 'index')), before, 'Rejected extension execution must preserve the index.')
    assert.equal(await readFile(join(root, 'blocked.bin'), 'utf8'), 'unapproved extension source\n')
    report.cases.push('local executable LFS extension is refused before command execution and preserves all bytes')
    console.log('PASS local executable LFS extension is rejected before a marker can run')
    report.complete = true
  } finally {
    processes.spawn = spawn
    service?.close()
    await service?.drain()
    await rm(scratch, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  const output = resolve(values.out)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
