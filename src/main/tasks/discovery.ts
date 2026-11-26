import { join } from 'node:path'
import type { TaskAdapter, TaskDefinition } from '../../shared/tasks'
import { revision, type WorkspaceFiles } from '../files'
import { validateTaskGraph } from './model'

const maxManifestBytes = 512 * 1024
const npmName = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,79}$/
type Candidate = { name: string; adapter: TaskAdapter; selector: string; id: string; label: string; dependsOn?: string[] }

const candidates: Candidate[] = [
  { name: 'Makefile', adapter: 'make', selector: 'default', id: 'make:default', label: 'Make: default target' },
  { name: 'CMakeLists.txt', adapter: 'cmake-configure', selector: 'configure', id: 'cmake:configure', label: 'CMake: configure' },
  { name: 'CMakeLists.txt', adapter: 'cmake-build', selector: 'build', id: 'cmake:build', label: 'CMake: build', dependsOn: ['cmake:configure'] },
  { name: 'pyproject.toml', adapter: 'python', selector: 'compileall', id: 'python:compileall', label: 'Python: compile workspace' },
  { name: 'pom.xml', adapter: 'maven', selector: 'package', id: 'maven:package', label: 'Maven: package (offline)' },
  { name: 'build.gradle', adapter: 'gradle', selector: 'build', id: 'gradle:build', label: 'Gradle: build (offline)' },
  { name: 'build.gradle.kts', adapter: 'gradle', selector: 'build', id: 'gradle:build', label: 'Gradle: build (offline)' },
  { name: 'Cargo.toml', adapter: 'cargo', selector: 'build', id: 'cargo:build', label: 'Cargo: build (offline)' },
  { name: 'Cargo.toml', adapter: 'cargo', selector: 'check', id: 'cargo:check', label: 'Cargo: check (offline)' },
  { name: 'go.mod', adapter: 'go', selector: 'build', id: 'go:build', label: 'Go: build workspace' },
]

function task(candidate: Candidate, root: string, path: string, token: string): TaskDefinition {
  return { id: candidate.id, label: candidate.label, adapter: candidate.adapter, cwd: root,
    selector: candidate.selector, dependsOn: candidate.dependsOn ?? [], timeoutMs: 120_000,
    source: { path, revision: token } }
}

function packageScripts(text: string, root: string, path: string, token: string): TaskDefinition[] {
  if (Buffer.byteLength(text) > maxManifestBytes) throw new Error('package.json exceeds the task discovery limit.')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json must contain an object.')
  const scripts = (value as Record<string, unknown>).scripts
  if (scripts === undefined) return []
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error('package.json scripts must contain an object.')
  const entries = Object.entries(scripts as Record<string, unknown>)
  if (entries.length > 64) throw new Error('package.json has too many scripts for task discovery.')
  return entries.flatMap(([name, command]) => npmName.test(name) && typeof command === 'string' && Buffer.byteLength(command) <= 4096
    ? [{ id: 'npm:' + name, label: 'npm: ' + name, adapter: 'npm' as const, cwd: root, selector: name,
      dependsOn: [], timeoutMs: 120_000, source: { path, revision: token } }] : [])
}

/** Static manifest inspection only. No command, package script, wrapper or project file is executed. */
export async function discoverTasks(scope: WorkspaceFiles, requestedRoot: unknown): Promise<TaskDefinition[]> {
  const { path: root } = await scope.inspect(requestedRoot, 'folder')
  if (!scope.rootPaths.includes(root)) throw new Error('Choose an open workspace root to discover tasks.')
  const entries = new Map((await scope.list(root)).filter(entry => entry.kind === 'file').map(entry => [entry.name, entry.path]))
  const tasks: TaskDefinition[] = []
  for (const candidate of candidates) {
    const path = entries.get(candidate.name)
    if (!path || tasks.some(item => item.id === candidate.id)) continue
    const opened = await scope.read(path)
    if (Buffer.byteLength(opened.text) > maxManifestBytes) throw new Error(candidate.name + ' exceeds the task discovery limit.')
    tasks.push(task(candidate, root, path, opened.revision))
  }
  const packagePath = entries.get('package.json')
  if (packagePath) {
    const opened = await scope.read(packagePath)
    tasks.push(...packageScripts(opened.text, root, packagePath, opened.revision))
  }
  return validateTaskGraph(tasks, root)
}

export async function taskSourcesCurrent(scope: WorkspaceFiles, root: string, tasks: readonly TaskDefinition[]): Promise<boolean> {
  if (!scope.rootPaths.includes(root)) return false
  const unique = new Map(tasks.map(task => [task.source.path, task.source.revision]))
  for (const [path, expected] of unique) {
    try {
      const current = await scope.inspect(path, 'file')
      if (revision(current.stats) !== expected) return false
    } catch { return false }
  }
  return true
}

export const taskManifestPath = (root: string, name: string) => join(root, name)
