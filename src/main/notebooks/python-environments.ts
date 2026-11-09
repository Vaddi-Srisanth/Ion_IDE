import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import type { NotebookKernelEnvironment } from '../../shared/notebook-kernel'
import { execute } from '../runner'
import { windowsEnvironment, windowsToolPaths } from '../windows-process'

const maxCandidates = 16
const interpreterName = /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i
const systemDirectories = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

// Probe local installations with a fixed script. A kernelspec is a label for a
// recognized Python environment. It never supplies a command, argv, or environment.
const inspectPython = `
import importlib.util, json, os, sys
if not all(importlib.util.find_spec(name) for name in ('ipykernel', 'jupyter_client')):
    raise SystemExit(1)
names = []
label = ''
try:
    from jupyter_client.kernelspec import KernelSpecManager
    manager = KernelSpecManager()
    for name, directory in list(manager.find_kernel_specs().items())[:80]:
        spec = manager.get_kernel_spec(name)
        if spec.language.lower() != 'python' or not spec.argv:
            continue
        command = spec.argv[0]
        if os.path.isabs(command):
            matches = os.path.realpath(command) == os.path.realpath(sys.executable) and os.path.realpath(os.path.dirname(command)) == os.path.realpath(os.path.dirname(sys.executable))
        else:
            matches = os.path.dirname(command) == '' and os.path.commonpath((sys.prefix, directory)) == sys.prefix
        if matches:
            names.append(name)
            label = label or spec.display_name
except Exception:
    pass
print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'prefix': sys.prefix, 'names': names[:24], 'label': label}))
`

function directories(): string[] {
  if (process.platform === 'win32') return windowsToolPaths().slice(0, 40)
  return [...new Set([...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', ...systemDirectories])]
    .filter((directory) => isAbsolute(directory) && !/[/\\]WindowsApps(?:[/\\]|$)/i.test(directory)).slice(0, 40)
}

export function notebookPythonEnvironment(scratch: string, interpreter?: string): NodeJS.ProcessEnv {
  const paths = interpreter ? [dirname(interpreter), ...directories()] : directories()
  if (process.platform === 'win32') return windowsEnvironment([...new Set(paths)], scratch)
  return {
    PATH: [...new Set(paths)].join(delimiter),
    HOME: homedir(),
    LANG: 'en_US.UTF-8',
    TMPDIR: scratch,
  }
}

function insideEnvironment(home: string): string {
  return process.platform === 'win32' ? join(home, 'python.exe') : join(home, 'bin', 'python')
}

function candidatePaths(): string[] {
  const configured = [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX].filter((value): value is string => !!value && isAbsolute(value))
  const home = homedir()
  const prefixCandidates = ['/opt/anaconda3', '/opt/miniconda3', '/opt/miniforge3',
    ...['anaconda3', 'miniconda3', 'miniforge3', 'mambaforge', 'opt/anaconda3', 'opt/miniconda3'].map((name) => join(home, name))]
  const commandNames = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']
  return [...new Set([
    ...(process.platform === 'win32' && process.env.VIRTUAL_ENV && isAbsolute(process.env.VIRTUAL_ENV)
      ? [join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')] : []),
    ...configured.map(insideEnvironment),
    ...(process.platform === 'darwin' ? ['/Library/Frameworks/Python.framework/Versions/Current/bin/python3'] : []),
    ...prefixCandidates.map(insideEnvironment),
    ...directories().flatMap((directory) => commandNames.map((command) => join(directory, command))),
    // The macOS /usr/bin/python3 shim can open an Xcode install dialog. Probe the actual interpreter instead.
    ...(process.platform === 'darwin' ? ['/Library/Developer/CommandLineTools/usr/bin/python3'] : []),
  ])].filter((candidate) => !(process.platform === 'darwin' && candidate === '/usr/bin/python3'))
}

async function executable(path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.length > 4096 || path.includes('\0') || !interpreterName.test(basename(path))) return false
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function probe(path: string, signal: AbortSignal): Promise<NotebookKernelEnvironment | undefined> {
  if (!await executable(path)) return
  const scratch = await mkdtemp(join(tmpdir(), 'ion-python-probe-'))
  let result
  try {
    result = await execute(path, ['-E', '-c', inspectPython], {
      cwd: scratch, input: '', signal, timeoutMs: 4000, budget: { remaining: 32 * 1024 },
      splitOutput: true, environment: notebookPythonEnvironment(scratch, path),
    })
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
  if (result.exitCode !== 0 || !result.stdout) return
  try {
    const found: unknown = JSON.parse(result.stdout)
    if (!found || typeof found !== 'object' || !('version' in found) || typeof found.version !== 'string'
      || !/^\d+\.\d+\.\d+$/.test(found.version) || !('prefix' in found) || typeof found.prefix !== 'string'
      || !isAbsolute(found.prefix) || found.prefix.length > 4096) return
    const prefix = await realpath(found.prefix).catch(() => found.prefix as string)
    const names = 'names' in found && Array.isArray(found.names) ? found.names
      .filter((name): name is string => typeof name === 'string' && /^[\w.-]{1,128}$/.test(name)).slice(0, 24) : []
    const label = 'label' in found && typeof found.label === 'string' ? found.label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : ''
    const id = createHash('sha256').update(prefix).digest('hex').slice(0, 24)
    return { id, path, label: label || `Python ${found.version}`, names }
  } catch {
    return undefined
  }
}

export class NotebookPythonEnvironments {
  private readonly controller = new AbortController()
  private readonly discovered = new Map<string, NotebookKernelEnvironment>()
  private readonly selected = new Map<string, NotebookKernelEnvironment>()
  private scanning?: Promise<NotebookKernelEnvironment[]>

  list(): NotebookKernelEnvironment[] {
    return [...new Map([...this.discovered, ...this.selected]).values()]
  }

  discover(): Promise<NotebookKernelEnvironment[]> {
    this.scanning ??= this.scan().finally(() => { this.scanning = undefined })
    return this.scanning
  }

  private async scan(): Promise<NotebookKernelEnvironment[]> {
    const checked = await Promise.all(candidatePaths().map(async (path) => {
      if (!await executable(path)) return
      const [directory, binary] = await Promise.all([realpath(dirname(path)), realpath(path)]).catch(() => [])
      return directory && binary ? { path, identity: `${directory}\0${binary}` } : undefined
    }))
    const unique = new Map<string, string>()
    for (const candidate of checked) if (candidate && !unique.has(candidate.identity)) unique.set(candidate.identity, candidate.path)
    const candidates = [...unique.values()].slice(0, maxCandidates)
    const next = new Map<string, NotebookKernelEnvironment>()
    for (let index = 0; index < candidates.length && !this.controller.signal.aborted; index += 2) {
      const group = await Promise.all(candidates.slice(index, index + 2).map((path) => probe(path, this.controller.signal)))
      for (const result of group) {
        if (result && !next.has(result.id)) next.set(result.id, result)
      }
    }
    if (this.controller.signal.aborted) return []
    this.discovered.clear()
    for (const [id, environment] of next) this.discovered.set(id, environment)
    return this.list()
  }

  async add(path: string): Promise<NotebookKernelEnvironment> {
    const result = await probe(path, this.controller.signal)
    if (!result) throw new Error('Choose a local Python interpreter with ipykernel and jupyter_client installed.')
    this.controller.signal.throwIfAborted()
    if (this.selected.size >= 24 && !this.selected.has(result.id)) {
      throw new Error('Ion can remember 24 explicitly selected Python environments per window.')
    }
    this.selected.set(result.id, result)
    return result
  }

  dispose(): void {
    this.controller.abort()
    this.discovered.clear()
    this.selected.clear()
  }
}
