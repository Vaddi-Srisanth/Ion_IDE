// Test/benchmark setup only. Nothing in this module is loaded by Ion.
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const maxOutputBytes = 2_000_000
export const fixtureCommandDeadlineMs = process.platform === 'win32' ? 30_000 : 10_000
export const fixtureRunnerProtocol = 'ion-fixture-process-v2-owned'
let runtime

async function loadRuntime() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-fixture-runner-')))
  const entry = join(scratch, 'runner.cjs')
  try {
    const { build, stop } = await import('esbuild')
    try {
      await build({ stdin: { contents: `export { execute } from './src/main/runner.ts';
        export { configureWindowsProcessHelper } from './src/main/windows-process.ts';`, resolveDir: repository, loader: 'ts' },
      outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    } finally { stop() }
    const tools = require(entry)
    delete require.cache[require.resolve(entry)]
    if (process.platform === 'win32') {
      const helper = await realpath(process.env.ION_WINDOWS_PROCESS_TEST_HELPER ?? join(repository, 'dist/native/ion-pty.exe'))
      if (!(await lstat(helper)).isFile()) throw new Error('Fixture process ownership requires the built Windows pipe helper.')
      tools.configureWindowsProcessHelper(helper)
    }
    return tools
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Resolve without invoking a shell, searching cwd, or executing a candidate. */
export async function resolveFixtureExecutable(name, scopeRoot, environment = process.env) {
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new Error('Invalid fixture tool name.')
  const key = Object.keys(environment).find(key => key.toLowerCase() === 'path')
  const paths = (environment[key] ?? '').split(delimiter).slice(0, 80)
  for (const entry of paths) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    if (!isAbsolute(directory)) continue
    const path = await realpath(join(directory, name + (process.platform === 'win32' ? '.exe' : ''))).catch(() => null)
    if (!path) continue
    const within = relative(scopeRoot, path)
    if (within === '' || within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)) continue
    if (!(await lstat(path)).isFile()) continue
    if (process.platform !== 'win32' && !await access(path, constants.X_OK).then(() => true, () => false)) continue
    return path
  }
  throw new Error('The installed ' + name + ' executable is unavailable outside the disposable fixture.')
}

/** Returns only after the existing runner has finalized streams and owned process cleanup. */
export async function runFixtureCommand(executable, args, { cwd, environment = process.env,
  timeoutMs = fixtureCommandDeadlineMs, outputBytes = maxOutputBytes, signal = new AbortController().signal } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof cwd !== 'string' || !isAbsolute(cwd) || !Array.isArray(args)
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > fixtureCommandDeadlineMs
    || !Number.isInteger(outputBytes) || outputBytes < 1 || outputBytes > maxOutputBytes) {
    throw new Error('Invalid bounded fixture command.')
  }
  const tools = await (runtime ??= loadRuntime())
  const began = performance.now()
  const events = []
  let eventOverflow = 0, cleanObserved = false, closeObserved = false
  const result = await tools.execute(executable, args, { cwd, environment, input: '', signal, timeoutMs,
    budget: { remaining: outputBytes }, splitOutput: true, collectOutput: false,
    trace(stage, event, detail) {
      if (stage === 'compiler-job' && event === 'clean-observed') cleanObserved = true
      if (stage === 'compiler-process' && event === 'close') closeObserved = true
      if (events.length < 128) events.push({ ms: performance.now() - began, stage, event, ...(detail === undefined ? {} : { detail }) })
      else eventOverflow++
    } })
  const cleanupVerified = process.platform === 'win32'
    ? cleanObserved && closeObserved && !/unverified|without verified/i.test(result.detail ?? '')
    : closeObserved
  const evidence = { protocol: fixtureRunnerProtocol, command: { executable, args, cwd }, timeoutMs, elapsedMs: performance.now() - began,
    state: result.state, exitCode: result.exitCode, cleanupVerified, outputComplete: result.outputComplete,
    cleanupBoundary: process.platform === 'win32' ? 'native Job CLEAN and helper close' : 'owned process-group termination and stdio close',
    events, eventOverflow }
  if (result.state !== 'exited' || result.exitCode !== 0 || result.outputComplete === false || !cleanupVerified) {
    throw Object.assign(new Error('Fixture command ' + result.state + ': ' + (result.detail
      ?? (result.exitCode === null ? 'no exit code' : 'exit code ' + result.exitCode))), {
      code: result.state, stdout: result.stdout ?? '', stderr: result.stderr ?? '', fixtureCommand: evidence,
    })
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', evidence }
}
