import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { NotebookKernelEnvironment } from '../../shared/notebook-kernel'
import { execute } from '../runner'
import { windowsEnvironment, windowsToolPaths } from '../windows-process'
import { commandPaths } from '../run-console/plans'

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

async function candidatePaths(root: string): Promise<string[]> {
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
    ...(await commandPaths(root)).flatMap((directory) => commandNames.map((command) => join(directory, command))),
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

async function probe(path: string, signal: AbortSignal): Promise<Omit<NotebookKernelEnvironment, 'id'> | undefined> {
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
    const names = 'names' in found && Array.isArray(found.names) ? found.names
      .filter((name): name is string => typeof name === 'string' && /^[\w.-]{1,128}$/.test(name)).slice(0, 24) : []
    const label = 'label' in found && typeof found.label === 'string' ? found.label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : ''
    return { path, label: label || `Python ${found.version}`, names }
  } catch {
    return undefined
  }
}

interface Candidate {
  environment: NotebookKernelEnvironment
  stamp: string
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}

// Discovery is metadata-only. In particular, neither PATH nor a selected venv
// is evidence that its executable is safe to run before the Run confirmation.
async function candidate(path: string): Promise<Candidate | undefined> {
  if (!await executable(path)) return
  const [directory, binary, alias, file] = await Promise.all([
    realpath(dirname(path)), realpath(path), lstat(path, { bigint: true }), stat(path, { bigint: true }),
  ])
  const identity = `${directory}\0${binary}`
  const stamp = [identity, alias.dev, alias.ino, alias.size, alias.mtimeNs, alias.ctimeNs, alias.mode,
    file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.mode].join(':')
  return { environment: { id: createHash('sha256').update(identity).digest('hex').slice(0, 24), path,
    label: `Python · ${dirname(path)} (not checked)`, names: [] }, stamp }
}

export class NotebookPythonEnvironments {
  private readonly controller = new AbortController()
  private readonly discovered = new Map<string, Candidate>()
  private readonly selected = new Map<string, Candidate>()
  private readonly stamps = new WeakMap<NotebookKernelEnvironment, string>()
  private root?: string
  private scanning?: { root: string; promise: Promise<NotebookKernelEnvironment[]> }
  private generation = 0

  list(root?: string): NotebookKernelEnvironment[] {
    return [...new Map([...(root && this.root !== resolve(root) ? [] : this.discovered), ...this.selected]).values()]
      .map(({ environment }) => environment)
  }

  discover(root = process.cwd()): Promise<NotebookKernelEnvironment[]> {
    root = resolve(root)
    if (this.scanning?.root === root) return this.scanning.promise
    const generation = ++this.generation
    const promise = this.scan(root, generation).finally(() => {
      if (this.scanning?.promise === promise) this.scanning = undefined
    })
    this.scanning = { root, promise }
    return promise
  }

  private async scan(root: string, generation: number): Promise<NotebookKernelEnvironment[]> {
    const canonicalRoot = await realpath(root).catch(() => root)
    const checked = await Promise.all((await candidatePaths(root)).map(async (path) => {
      if (inside(root, path)) return
      try {
        const [binary, directory] = await Promise.all([realpath(path), realpath(dirname(path))])
        if (inside(canonicalRoot, binary) || inside(canonicalRoot, directory)) return
        return await candidate(path)
      } catch { return undefined }
    }))
    if (this.controller.signal.aborted || this.generation !== generation) return []
    this.discovered.clear()
    this.root = root
    for (const entry of checked) {
      if (entry && this.discovered.size < maxCandidates && !this.discovered.has(entry.environment.id)) {
        this.discovered.set(entry.environment.id, entry)
        this.stamps.set(entry.environment, entry.stamp)
      }
    }
    return this.list(root)
  }

  async add(path: string): Promise<NotebookKernelEnvironment> {
    const result = await candidate(path)
    if (!result) throw new Error('Choose a local Python interpreter executable.')
    this.controller.signal.throwIfAborted()
    if (this.selected.size >= 24 && !this.selected.has(result.environment.id)) {
      throw new Error('Ion can remember 24 explicitly selected Python environments per window.')
    }
    this.selected.set(result.environment.id, result)
    this.stamps.set(result.environment, result.stamp)
    return result.environment
  }

  async assertCurrent(environment: NotebookKernelEnvironment): Promise<void> {
    this.controller.signal.throwIfAborted()
    // Bind to the exact snapshot shown for approval, not a mutable registry ID.
    // Concurrent discovery/selection must not bless a replacement executable.
    const expected = this.stamps.get(environment)
    const current = await candidate(environment.path).catch(() => undefined)
    if (!expected || !current || expected !== current.stamp) {
      throw new Error('The Python interpreter changed. Select it again and approve a new Run.')
    }
  }

  // The only interpreter probe. Callers must obtain execution approval first.
  async verify(environment: NotebookKernelEnvironment): Promise<NotebookKernelEnvironment> {
    await this.assertCurrent(environment)
    const result = await probe(environment.path, this.controller.signal)
    await this.assertCurrent(environment)
    if (!result) throw new Error('This Python needs ipykernel and jupyter_client installed to run notebooks.')
    const verified = { ...result, id: environment.id }
    this.stamps.set(verified, this.stamps.get(environment)!)
    const entry = this.selected.get(environment.id) ?? this.discovered.get(environment.id)
    if (entry?.environment === environment) entry.environment = verified
    return verified
  }

  dispose(): void {
    this.controller.abort()
    this.discovered.clear()
    this.selected.clear()
  }
}
