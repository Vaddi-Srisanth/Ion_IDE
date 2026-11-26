import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskDefinition } from '../../shared/tasks'
import { commandPaths, envFor, onPath } from '../run-console/plans'

export interface PlannedTask {
  executable: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  timeoutMs: number
  tool: string
}

async function regular(path: string, root: string): Promise<string | null> {
  try {
    const canonical = await realpath(path)
    const fromRoot = canonical === root || canonical.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))
    if (fromRoot || !(await stat(canonical)).isFile()) return null
    await access(canonical, constants.R_OK)
    return canonical
  } catch { return null }
}

async function npmPlan(root: string, paths: string[], selector: string): Promise<{ executable: string; args: string[] } | null> {
  const node = await onPath('node', root, paths)
  if (!node) return null
  for (const candidate of [
    join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(node)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    const cli = await regular(candidate, root)
    if (cli) return { executable: node, args: [cli, 'run', selector] }
  }
  if (process.platform !== 'win32') {
    const npm = await onPath('npm', root, paths)
    if (npm) return { executable: npm, args: ['run', selector] }
  }
  return null
}

export async function planTask(task: TaskDefinition, root: string, scratch: string): Promise<PlannedTask> {
  const paths = await commandPaths(root)
  let executable: string | null = null
  let args: string[] = []
  switch (task.adapter) {
    case 'make': executable = await onPath('make', root, paths); args = task.selector === 'default' ? [] : [task.selector]; break
    case 'cmake-configure':
      executable = await onPath('cmake', root, paths); args = ['-S', root, '-B', join(root, '.ion', 'cmake-build')]; break
    case 'cmake-build':
      executable = await onPath('cmake', root, paths); args = ['--build', join(root, '.ion', 'cmake-build')]; break
    case 'npm': {
      const npm = await npmPlan(root, paths, task.selector)
      executable = npm?.executable ?? null; args = npm?.args ?? []; break
    }
    case 'python':
      executable = await onPath(process.platform === 'win32' ? 'python' : 'python3', root, paths)
        ?? await onPath('python', root, paths); args = ['-I', '-m', 'compileall', '-q', root]; break
    case 'maven': executable = await onPath('mvn', root, paths); args = ['--offline', '--batch-mode', '--no-transfer-progress', task.selector]; break
    case 'gradle': executable = process.platform === 'win32' ? null : await onPath('gradle', root, paths);
      args = ['--offline', '--no-daemon', '--no-build-cache', '--console=plain', '--max-workers=2', task.selector]; break
    case 'cargo': executable = await onPath('cargo', root, paths); args = [task.selector, '--offline']; break
    case 'go': executable = await onPath('go', root, paths); args = [task.selector, './...']; break
  }
  if (!executable) throw new Error(`Install a trusted ${task.adapter} tool outside the workspace before running this task.`)
  const environment = envFor(paths, scratch)
  if (task.adapter === 'go') Object.assign(environment, { GOPROXY: 'off', GOSUMDB: 'off' })
  if (task.adapter === 'python') Object.assign(environment, { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' })
  return { executable, args, cwd: task.cwd, environment, timeoutMs: task.timeoutMs, tool: executable }
}
