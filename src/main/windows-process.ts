import { execFile, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

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
