import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'

export interface DebugTools { adapter: string; compiler: string; compilerArgs: string[]; environment: NodeJS.ProcessEnv }

function inside(root: string, path: string) {
  const relation = relative(root, path)
  return relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation)
}

async function xcrun(name: string, root: string, signal: AbortSignal): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const value = await new Promise<string | null>((resolve, reject) => {
    const child = execFile('/usr/bin/xcrun', ['--find', name], { timeout: 2_000, maxBuffer: 4_096, windowsHide: true }, (error, stdout) => {
      if (error) resolve(null)
      else resolve(stdout.trim())
    })
    const abort = () => { child.kill('SIGKILL'); reject(signal.reason ?? new Error('Debugger discovery was cancelled.')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
  })
  if (!value || !isAbsolute(value) || inside(root, value) || !await executable(value, root)) return null
  return realpath(value)
}

async function macSdk(root: string, signal: AbortSignal): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const value = await new Promise<string | null>((resolve, reject) => {
    const child = execFile('/usr/bin/xcrun', ['--show-sdk-path'], { timeout: 2_000, maxBuffer: 4_096, windowsHide: true }, (error, stdout) => {
      if (error) resolve(null); else resolve(stdout.trim())
    })
    const abort = () => { child.kill('SIGKILL'); reject(signal.reason ?? new Error('Debugger discovery was cancelled.')) }
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
  })
  if (!value || !isAbsolute(value) || inside(root, value)) return null
  return realpath(value).catch(() => null)
}

/** Finds only installation/system tools after workspace paths have been removed. */
export async function discoverDebugTools(root: string, scratch: string, language: 'c' | 'cpp', signal: AbortSignal): Promise<DebugTools> {
  const canonicalRoot = await realpath(root)
  const paths = await commandPaths(canonicalRoot)
  signal.throwIfAborted()
  const adapter = await onPath('lldb-dap', canonicalRoot, paths) ?? await xcrun('lldb-dap', canonicalRoot, signal)
  const compilerName = language === 'cpp' ? 'clang++' : 'clang'
  const compiler = await onPath(compilerName, canonicalRoot, paths) ?? await xcrun(compilerName, canonicalRoot, signal)
  if (!adapter) throw new Error('LLVM lldb-dap is required for C/C++ debugging. Install LLVM and reopen Ion.')
  if (!compiler) throw new Error(`LLVM ${compilerName} is required for C/C++ debugging. Install LLVM and reopen Ion.`)
  const sdk = await macSdk(canonicalRoot, signal)
  return { adapter, compiler, compilerArgs: sdk ? ['-isysroot', sdk] : [], environment: envFor(paths, scratch) }
}
