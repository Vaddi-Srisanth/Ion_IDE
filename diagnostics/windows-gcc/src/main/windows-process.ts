import { execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { RunTrace } from './run-console/trace'

const systemRoot = process.env.SystemRoot || 'C:\\Windows'
export const windowsSystemDirectory = join(systemRoot, 'System32')

export function windowsToolPaths(): string[] {
  // Store aliases can launch Microsoft Store instead of an installed runtime.
  return [...new Set([...(process.env.PATH ?? '').split(delimiter).map((path) => path.replace(/^"(.*)"$/, '$1')),
    windowsSystemDirectory])]
    .filter((path) => /^[a-z]:[/\\]/i.test(path) && !/[/\\]WindowsApps(?:[/\\]|$)/i.test(path))
}

export async function workspaceSafeWindowsToolPaths(cwd: string): Promise<string[]> {
  const paths = await Promise.all(windowsToolPaths().slice(0, 80).map(async (path) => {
    const canonical = await realpath(path).catch(() => null)
    if (!canonical) return null
    const fromWorkspace = relative(cwd, canonical)
    return fromWorkspace === '..' || fromWorkspace.startsWith('..' + sep) || isAbsolute(fromWorkspace) ? canonical : null
  }))
  return [...new Set(paths.filter((path) => path !== null))]
}

export function processTempEnvironment(scratch: string): NodeJS.ProcessEnv {
  return process.platform === 'win32' ? { TEMP: scratch, TMP: scratch } : { TMPDIR: scratch }
}

export function windowsEnvironment(paths: string[], scratch?: string): NodeJS.ProcessEnv {
  return {
    PATH: paths.join(delimiter), SystemRoot: systemRoot, WINDIR: systemRoot, HOME: homedir(),
    USERPROFILE: homedir(), LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
    ...(scratch ? processTempEnvironment(scratch) : {}),
  }
}

export function stopWindowsProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    execFile(join(windowsSystemDirectory, 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true, timeout: 1500, env: windowsEnvironment([windowsSystemDirectory]),
    }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* The child already exited. */ }
      }
      resolve()
    })
  })
}

// Optional features are separate CJS bundles and each embeds this module.
// Keep the trusted bootstrap capability in their shared MAIN-process realm,
// rather than in one bundle's private variable. Renderer realms cannot read it.
// Resolve the symbol only on use, so ordinary macOS startup adds no state.
const helperKey = () => Symbol.for('ion.ide.trusted-windows-process-helper')
export function configureWindowsProcessHelper(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid Windows process helper path.')
  Object.defineProperty(globalThis, helperKey(), { value: path, writable: true, enumerable: false })
}

export function windowsPipeCommand(executable: string, args: string[]): { executable: string; args: string[] } {
  // Only standalone Node tests use this environment override. Packaged Electron
  // always receives the installation-owned path from main bootstrap.
  const configured: unknown = Reflect.get(globalThis, helperKey())
  const helper = (typeof configured === 'string' ? configured : undefined)
    ?? (!process.versions.electron ? process.env.ION_WINDOWS_PROCESS_TEST_HELPER : undefined)
  if (!helper || !isAbsolute(helper)) throw new Error('The Windows process helper is unavailable. Repair or reinstall Ion.')
  return { executable: helper, args: ['--pipe', String(process.pid), executable, ...args] }
}


/** Observe only the private native status pipe. Never consume program output. */
export function monitorWindowsPipeProcess(child: ChildProcessWithoutNullStreams, onFailure: (detail: string) => void, trace?: RunTrace) {
  const status = child.stdio[3] as Readable | undefined
  if (!status) return {
    finished: Promise.resolve(false), verified: false,
    detail: 'The Windows process supervisor status channel is unavailable.',
    requestStop: () => Promise.resolve(false), markForced() {}, dispose() {},
  }
  const control = child.stdio[4] as Writable | undefined
  let stopRequest: Promise<boolean> | undefined
  let buffered = ''
  let ready = false
  let cleaned = false
  let forced = false
  let closed = false
  let detail: string | undefined
  let complete!: (verified: boolean) => void
  const finished = new Promise<boolean>(resolve => { complete = resolve })
  const verified = () => closed && ready && cleaned && !forced && !detail && !buffered
  function fail(message: string) {
    if (detail) return
    detail = message
    onFailure(message)
  }
  function data(text: string) {
    if (detail || closed) return
    buffered += text
    if (buffered.length > 4096) return fail('The Windows process supervisor returned invalid status.')
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      const line = buffered.slice(0, newline).replace(/\r$/, '')
      buffered = buffered.slice(newline + 1)
      if (!ready && /^READY [1-9][0-9]{0,9}$/.test(line)) {
        ready = true
        // Receipt time in Node, not the native payload creation timestamp.
        // child.pid identifies the supervisor; READY identifies its payload.
        trace?.('compiler-payload', 'ready-observed', Number(line.slice(6)))
      } else if (ready && !cleaned && line === 'CLEAN') {
        cleaned = true
        trace?.('compiler-job', 'clean-observed')
      }
      else return fail(/^ERROR [0-9]{1,10}$/.test(line)
        ? 'The Windows process supervisor failed (' + line.slice(6) + ').'
        : 'The Windows process supervisor returned invalid status.')
    }
  }
  const error = () => fail('The Windows process supervisor status channel stopped.')
  status.setEncoding('utf8')
  status.on('data', data)
  status.on('error', error)
  child.once('close', () => {
    // Node's close event follows stdio closure; checking here avoids treating
    // a child exit event as proof that the final fd3 data has been received.
    closed = true
    if (buffered) detail ??= 'The Windows process supervisor status ended mid-message.'
    status.removeListener('data', data)
    status.removeListener('error', error)
    complete(verified())
  })
  function force() {
    // A control write can race a normal exit while final status is queued.
    // Wait for close in that case rather than invalidating an eventual CLEAN.
    if (closed || child.exitCode !== null || child.signalCode !== null) return
    try {
      if (!child.kill('SIGKILL')) return
    } catch { /* Termination is unverified; only the exact owned helper was addressed. */ }
    forced = true
    detail ??= 'The Windows process supervisor did not acknowledge Stop; cleanup is unverified.'
  }
  function requestStop(): Promise<boolean> {
    if (stopRequest) return stopRequest
    if (closed) return finished
    stopRequest = new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        clearTimeout(bound)
        resolve(value)
      }
      // Native Job drain and synchronous-reader cancellation each have a
      // 1.5s ceiling. Allow their combined grace before an explicit fallback.
      const grace = setTimeout(force, 3500)
      const bound = setTimeout(() => { force(); finish(false) }, 4000)
      grace.unref(); bound.unref()
      void finished.then(finish)
      if (!control || control.destroyed || !control.writable) force()
      else control.write('S\n', error => { if (error) force() })
    })
    return stopRequest
  }
  // Consume write failures even when Stop races natural process completion.
  const controlError = () => { if (!closed) force() }
  control?.on('error', controlError)
  child.once('close', () => control?.removeListener('error', controlError))
  return {
    finished,
    requestStop,
    get verified() { return verified() },
    get detail() { return detail },
    markForced() { forced = true },
    dispose() {
      if (!closed) forced = true
      status.destroy()
      control?.destroy()
    },
  }
}
