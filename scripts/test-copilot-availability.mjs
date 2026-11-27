// Signed-out protocol probe. Native runs use a pinned official package and an isolated profile.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const repo = resolve(dirname(script), '..')
const require = createRequire(import.meta.url)
const proxy = 'http://127.0.0.1:1'
const packageVersion = '1.575.0'
const macArm64PackageHash = 'tL34Jav+uY4jYGNjX+9BuD8c8+3fhinMtSYaGIXZZcUasTNAZvMEN4XDQJbPit0Ad896sbuUOEbnMii69+IhZg=='
const maxArchiveBytes = 256 * 1024 * 1024
const isWindows = process.platform === 'win32'
const fixture = join(repo, 'test', 'fixtures', 'copilot-availability.cjs')
const localMacSandbox = `(version 1) (allow default)
(deny network*) (deny mach-lookup)
(deny file-read*
  (subpath "/Users") (subpath "/System/Volumes/Data/Users")
  (subpath "/Library") (subpath "/System/Volumes/Data/Library")
  (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/var/tmp")
  (require-all (subpath "/private/tmp") (require-not (subpath (param "ION_PROBE_ROOT")))))
(deny file-write* (require-not (subpath (param "ION_PROBE_ROOT"))))
(deny process-exec (require-not (literal (param "ION_PROBE_BINARY"))))`

function under(parent, path) {
  const name = relative(parent, path)
  return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep)
}

async function environment(scratch) {
  const home = join(scratch, 'home'), cwd = join(scratch, 'cwd'), temp = join(scratch, 'tmp')
  const config = join(home, 'config'), data = join(home, 'data'), cache = join(home, 'cache')
  const state = join(home, 'state'), runtime = join(home, 'runtime'), roaming = join(home, 'roaming'), local = join(home, 'local')
  for (const path of [home, cwd, temp, config, data, cache, state, runtime, roaming, local]) await mkdir(path, { mode: 0o700 })
  const env = {
    HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home, APPDATA: roaming, LOCALAPPDATA: local,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime,
    GH_CONFIG_DIR: join(config, 'gh'), TMP: temp, TEMP: temp, TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy,
    NO_PROXY: '', no_proxy: '', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', LANG: 'C', LC_ALL: 'C',
  }
  if (isWindows) {
    const system = await realpath(process.env.SystemRoot ?? 'C:\\Windows')
    Object.assign(env, { SystemRoot: system, WINDIR: system, PATH: join(system, 'System32'),
      HOMEDRIVE: parse(home).root.slice(0, 2), HOMEPATH: home.slice(2) })
  } else env.PATH = '/usr/bin:/bin'
  return { cwd, env }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function groupDrained(pid) {
  const limit = Date.now() + 750
  while (groupAlive(pid) && Date.now() < limit) await delay(20)
  if (!groupAlive(pid)) return true
  process.kill(-pid, 'SIGKILL')
  const recovery = Date.now() + 1500
  while (groupAlive(pid) && Date.now() < recovery) await delay(20)
  // A survivor after graceful exit is a failed acceptance even if forced recovery succeeded.
  return false
}

// The Windows Job owns this Node host, the official stdio process and its descendants.
export async function runSession(LspProcess, target, args, cwd, env, version, localMacScratch) {
  const stages = new Set(), seenStatus = new Set()
  let phase = 'initialize', failure, result, service, listener
  try {
    const isolated = process.platform === 'darwin'
    const host = isolated ? '/usr/bin/sandbox-exec' : target
    const sandbox = localMacScratch
      ? ['-D', 'ION_PROBE_ROOT=' + localMacScratch, '-D', 'ION_PROBE_BINARY=' + target, '-p', localMacSandbox]
      : ['-p', '(version 1) (allow default) (deny network*)']
    const hostArgs = isolated ? [...sandbox, target, ...args] : args
    service = await LspProcess.start({
      executable: host, args: hostArgs, cwd, env, root: null,
      capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: { inlineCompletion: { dynamicRegistration: false } } },
      initializationOptions: { editorInfo: { name: 'Ion IDE', version }, editorPluginInfo: { name: 'Ion Copilot availability probe', version } },
      configuration: { telemetry: { telemetryLevel: 'off' }, http: { proxy, proxyStrictSSL: true } },
      deadlines: { startupMs: 6_000, initializationMs: 12_000, requestMs: 5_000 }, trace: stage => stages.add(stage),
    }, new AbortController().signal)
    listener = service.onNotification('didChangeStatus', value => {
      if (['Normal', 'Error', 'Warning', 'Inactive'].includes(value?.kind)) seenStatus.add(value.kind)
    })
    phase = 'capabilities'
    const caps = service.capabilities
    const sync = typeof caps.textDocumentSync === 'number' ? caps.textDocumentSync : caps.textDocumentSync?.change
    const completion = caps.inlineCompletionProvider === true
      || Boolean(caps.inlineCompletionProvider && typeof caps.inlineCompletionProvider === 'object')
    if (sync !== 2 || !completion) throw new Error()
    phase = 'signed-out-status'
    // GitHub's official copilot.vim uses this exact local-only status request. It cannot start a sign-in flow.
    const status = await service.request('checkStatus', { options: { localChecksOnly: true } })
    if (status?.status !== 'NotSignedIn' || (status.user != null && status.user !== '')) throw new Error()
    result = {
      incrementalDocumentSync: true,
      inlineCompletionAdvertised: true,
      executeCommandCount: Array.isArray(caps.executeCommandProvider?.commands) ? caps.executeCommandProvider.commands.length : 0,
      reportedVersion: /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(service.version ?? '') ? service.version : null,
      accountStatus: 'NotSignedIn',
    }
  } catch { failure = phase }
  finally {
    if (service) {
      try {
        await service.stop()
        const needed = ['initialize-response', 'initialized-notification', 'workspace-configuration',
          'shutdown-response', 'exit-notification', 'process-exit', 'cleanup-complete']
        if (!isWindows && !await groupDrained(service.pid)) failure = 'process-group-cleanup'
        if (needed.some(stage => !stages.has(stage))) failure ??= 'graceful-shutdown'
      } catch { failure = 'process-cleanup' }
    }
    listener?.dispose()
  }
  if (failure) return { passed: false, stage: failure }
  return { passed: true, ...result, statusNotifications: [...seenStatus].sort(), gracefulShutdown: true }
}

async function bundle(scratch) {
  const { build, stop } = await import('esbuild')
  const output = join(scratch, 'transport.cjs')
  try {
    await build({ stdin: { contents: `export { LspProcess } from './src/main/language-tools/lsp-process.ts'
      export { execute } from './src/main/runner.ts'
      export { configureWindowsProcessHelper } from './src/main/windows-process.ts'`, resolveDir: repo, loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  } finally { stop() }
  return require(output)
}

async function windowsSession(tools, target, args, cwd, env, version, scratch) {
  const { buildWindowsPty } = await import('./windows/build-pty.mjs')
  const helper = join(scratch, 'ion-pty.exe')
  await buildWindowsPty(helper, process.arch)
  tools.configureWindowsProcessHelper(helper)
  const host = join(scratch, 'session.cjs')
  await writeFile(host, [
    "const { LspProcess } = require('./transport.cjs')",
    'import(' + JSON.stringify(import.meta.url) + ').then(async ({runSession}) => {',
    ' const [target, version, ...args] = process.argv.slice(2)',
    ' const result = await runSession(LspProcess, target, args, process.cwd(), process.env, version)',
    ' process.stdout.write(JSON.stringify(result))',
    '}).catch(() => { process.exitCode = 1 })',
  ].join('\n'), { mode: 0o600 })
  let clean = false, closed = false
  const observed = await tools.execute(process.execPath, [host, target, version, ...args], {
    cwd, environment: env, input: '', timeoutMs: 27_000, signal: new AbortController().signal,
    budget: { remaining: 16 * 1024 }, splitOutput: true, collectOutput: false,
    trace(stage, event) {
      if (stage === 'compiler-job' && event === 'clean-observed') clean = true
      if (stage === 'compiler-process' && event === 'close') closed = true
    },
  })
  if (observed.state !== 'exited' || observed.exitCode !== 0 || !clean || !closed || observed.outputComplete !== true) {
    return { passed: false, stage: 'windows-job-cleanup' }
  }
  return JSON.parse(observed.stdout)
}

async function macPackage(archive, scratch) {
  const localArchive = await realpath(archive)
  // Extract the exact private bytes that were hashed. Keep the original package outside the probe.
  const snapshot = join(scratch, 'server.tgz')
  const hash = createHash('sha512')
  const source = await open(localArchive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await source.stat()
    if (!stat.isFile() || stat.size > maxArchiveBytes) throw new Error()
    let copied = 0
    await pipeline(source.createReadStream({ autoClose: false }), new Transform({
      transform(block, _encoding, callback) {
        copied += block.length
        if (copied > maxArchiveBytes) return callback(new Error('Copilot package exceeds its size limit.'))
        hash.update(block)
        callback(null, block)
      },
    }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }))
  } finally { await source.close() }
  if (hash.digest('base64') !== macArm64PackageHash) throw new Error()
  execFileSync('/usr/bin/tar', ['-xzf', snapshot, 'package/copilot-language-server', 'package/package.json'], { cwd: scratch })
  const manifest = JSON.parse(await readFile(join(scratch, 'package/package.json'), 'utf8'))
  if (manifest.name !== '@github/copilot-language-server-darwin-arm64' || manifest.version !== packageVersion
    || manifest.license !== 'MIT') throw new Error()
  return join(scratch, 'package/copilot-language-server')
}

async function main(argv) {
  let phase = 'arguments', scratch
  const selfTest = argv.length === 1 && argv[0] === '--self-test'
  const localMac = argv.length === 2 && argv[0] === '--local-macos' && isAbsolute(argv[1])
  let report = { passed: false, stage: phase }
  try {
    if (localMac && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error()
    if (!selfTest && !localMac && (argv.length !== 1 || !isAbsolute(argv[0]) || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !['darwin', 'win32'].includes(process.platform))) throw new Error()
    phase = 'isolated-host'
    scratch = await realpath(await mkdtemp(join(localMac ? '/private/tmp' : tmpdir(), 'ion-copilot-probe-')))
    phase = 'verified-package'
    const executable = localMac ? await macPackage(argv[1], scratch) : selfTest ? process.execPath : argv[0]
    phase = 'binary'
    const target = await realpath(executable)
    if (!(await lstat(executable)).isFile() || (localMac && !under(scratch, target))
      || (!selfTest && under(await realpath(repo), target))) throw new Error()
    await access(target, constants.X_OK)
    phase = 'isolated-host'
    const { cwd, env } = await environment(scratch)
    const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
    const args = selfTest ? [fixture, '--stdio'] : ['--stdio']
    const tools = await bundle(scratch)
    report = isWindows ? await windowsSession(tools, target, args, cwd, env, version, scratch)
      : await runSession(tools.LspProcess, target, args, cwd, env, version, localMac ? scratch : undefined)
  } catch { report = { passed: false, stage: phase } }
  finally {
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }) }
      catch { report = { passed: false, stage: 'temporary-files' } }
    }
  }
  const output = { protocol: 'ion-copilot-availability-v1', platform: process.platform, arch: process.arch,
    binary: selfTest ? 'synthetic-fixture' : localMac ? 'locally-verified-native-package' : 'workflow-supplied-native-package',
    ...(selfTest ? {} : { packageVersion }), ...report,
    ...(report.passed && { cleanup: isWindows ? 'windows-job-clean-and-closed' : 'posix-process-group-drained' }) }
  console.log(JSON.stringify(output))
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main(process.argv.slice(2))
