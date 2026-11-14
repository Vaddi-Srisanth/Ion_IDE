import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

// Serialized only into the disposable language fixture's main entry. This
// records renderer replies, never changes or fabricates a close decision.
export function installCloseConfirmationProbe(ipcMain, host, now) {
  const original = ipcMain.handle, records = []
  host.ionCloseConfirmations = records
  function handle(channel, handler) {
    if (channel !== 'ion:confirm-window-close') return Reflect.apply(original, this, [channel, handler])
    return Reflect.apply(original, this, [channel, function (...args) {
      if (typeof args[1] === 'boolean') {
        records.push({ allow: args[1], ms: now() })
        if (records.length > 16) records.shift()
      }
      return Reflect.apply(handler, this, args)
    }])
  }
  ipcMain.handle = handle
  return () => { if (ipcMain.handle === handle) ipcMain.handle = original }
}

export async function dismissPreferences(page) {
  const dialog = page.getByRole('dialog', { name: 'Preferences' })
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  // A click can return before React commits removal and updates the quit guard.
  await dialog.waitFor({ state: 'detached' })
}

export function shutdownPids(session) {
  return [...new Set([session.appProcess?.pid, session.pid])]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff)
}

export function appendShutdownTail(tail, bytes) {
  const chunk = Buffer.from(bytes)
  if (chunk.length >= 8192) return Buffer.from(chunk.subarray(-8192))
  return Buffer.concat([tail.subarray(-Math.max(0, 8192 - chunk.length)), chunk])
}

export async function nativeShutdownSnapshot(session) {
  if (process.platform !== 'win32') return { state: 'not-applicable', reason: 'Windows-only known-PID observer' }
  const pids = shutdownPids(session)
  if (!pids.length) return { state: 'unavailable', reason: 'No validated known PIDs' }
  const root = process.env.SystemRoot
  if (!root || !win32.isAbsolute(root)) return { state: 'unavailable', reason: 'No absolute Windows system directory' }
  try {
    const { stdout } = await promisify(execFile)(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'
      [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
      $rows=@(Get-CimInstance -ClassName Win32_Process -Filter $env:ION_DIAG_FILTER -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ForEach-Object {
        $command=[string]$_.CommandLine
        [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;
          created=$_.CreationDate.ToUniversalTime().Ticks.ToString();path=[string]$_.ExecutablePath;
          command=$command.Substring(0,[Math]::Min(1024,$command.Length))}
      })
      ConvertTo-Json -Compress -InputObject $rows
    `], { windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024,
        env: { SystemRoot: root, WINDIR: root, PATH: win32.join(root, 'System32'),
          TEMP: process.env.TEMP, TMP: process.env.TMP,
          ION_DIAG_FILTER: pids.map(pid => 'ProcessId = ' + pid).join(' OR ') } })
    return { state: 'available', pids, rows: JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) }
  } catch (error) {
    return { state: 'error', pids, error: { message: String(error.message).slice(0, 1000), code: error.code,
      killed: error.killed, signal: error.signal } }
  }
}

// Opt-in for this fixture only; normal desktop launches/benchmarks do not
// attach a stderr listener or query the native process table.
export function observeUpdateShutdown(session, save) {
  let tail = Buffer.alloc(0)
  const stderr = session.appProcess?.stderr
  const collect = bytes => { tail = appendShutdownTail(tail, bytes) }
  stderr?.on('data', collect)
  const previous = session.onShutdownFailure
  const observed = async (diagnostic) => save({ ...diagnostic,
    wrapper: { pid: session.appProcess?.pid, exitCode: session.appProcess?.exitCode, signalCode: session.appProcess?.signalCode },
    electron: { pid: session.pid, creationTime: session.mainCreationTime },
    stderrTail: tail.toString('utf8'), native: await nativeShutdownSnapshot(session) })
  session.onShutdownFailure = observed
  return () => {
    stderr?.removeListener('data', collect)
    if (session.onShutdownFailure === observed) {
      if (previous === undefined) delete session.onShutdownFailure
      else session.onShutdownFailure = previous
    }
  }
}

export function disposeUpdateShutdown(session) {
  const dispose = session.disposeShutdownObserver
  delete session.disposeShutdownObserver
  dispose?.()
}
