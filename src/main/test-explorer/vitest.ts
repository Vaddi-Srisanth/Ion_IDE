import { constants } from 'node:fs'
import { lstat, open, realpath, writeFile } from 'node:fs/promises'
import { delimiter, join, relative, sep } from 'node:path'
import { isWithin } from '../files'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { testLimits, text, validateSelector } from './model'
import { readFrameworkReport, safeTool, type TestPlan } from './pytest'
import { vitestHelper } from './vitest-helper'

/** Discovery here reads metadata only. Importing project JavaScript requires the service's native review. */
export async function trustedNode(roots: readonly string[]): Promise<string> {
  if (!roots.length) throw new Error('Open a workspace first.')
  const allowed = new Set((await commandPaths(roots[0])).filter(path => roots.every(root => !isWithin(root, path))))
  const paths = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...allowed])].filter(path => allowed.has(path))
  const tool = await onPath('node', roots[0], paths)
  if (tool && await safeTool(tool, roots)) return tool
  throw new Error('Install Node.js outside every workspace and add it to PATH. Ion does not download tools automatically.')
}

async function packageFile(path: string, root: string, limit: number): Promise<{ path: string; data: string }> {
  const canonical = await realpath(path)
  if (!isWithin(root, path) || !isWithin(root, canonical)) throw new Error('Vitest package/configuration must remain inside the selected root.')
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Invalid or oversized Vitest package/configuration file.')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset !== info.size) throw new Error('Vitest package/configuration changed while reading.')
    return { path: canonical, data: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)) }
  } finally { await handle.close() }
}

export function vitestSelector(value: unknown): string {
  const selector = validateSelector(value), boundary = selector.indexOf('::')
  if (boundary < 0) throw new Error('Invalid Vitest test identity. Discover the tests again.')
  const encoded = selector.slice(boundary + 2)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid Vitest test identity.')
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) throw new Error('Invalid Vitest test identity encoding.')
  const identity: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!Array.isArray(identity) || identity.length !== 3 || !text(identity[1], 256) || !text(identity[2], 1024)) throw new Error('Invalid Vitest test identity.')
  text(identity[0], 256)
  return selector
}

export async function prepareVitest(root: string, roots: readonly string[], scratch: string, operation: 'discover' | 'run', selectors: string[],
  resolveNode: (roots: readonly string[]) => Promise<string> = trustedNode): Promise<TestPlan> {
  const executable = await resolveNode(roots)
  if (!await safeTool(executable, roots)) throw new Error('Node.js must be a trusted executable outside every workspace root.')
  const packageRoot = join(root, 'node_modules', 'vitest')
  let metadata: Awaited<ReturnType<typeof packageFile>>
  try { metadata = await packageFile(join(packageRoot, 'package.json'), root, 256 * 1024) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Install Vitest 4.1.x in this project first. Ion does not download packages automatically.')
    throw error
  }
  const manifest = JSON.parse(metadata.data) as { name?: unknown; version?: unknown }
  if (manifest.name !== 'vitest' || typeof manifest.version !== 'string' || !/^4\.1\.\d+$/.test(manifest.version)) {
    throw new Error('This adapter supports project-local Vitest 4.1.x. Other versions require separate compatibility verification.')
  }
  const entry = await packageFile(join(packageRoot, 'dist', 'node.js'), root, 16 * 1024 * 1024)
  if (!isWithin(await realpath(packageRoot), entry.path)) throw new Error('Vitest entry escapes its package.')
  const trackedFiles = [metadata.path, entry.path]
  let config: string | false = false
  // Never inherit an ancestor's executable configuration. The selected root is the approval boundary.
  for (const name of ['vitest.config', 'vite.config']) {
    for (const extension of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']) {
      const candidate = join(root, name + '.' + extension)
      const info = await lstat(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!info) continue
      const checked = await packageFile(candidate, root, 16 * 1024 * 1024)
      config = checked.path; trackedFiles.push(config); break
    }
    if (config) break
  }
  if (!Array.isArray(selectors) || selectors.length > testLimits.cases || (operation === 'run' && !selectors.length)) throw new Error('Choose discovered Vitest tests to run.')
  const checkedSelectors = selectors.map(vitestSelector)
  if (new Set(checkedSelectors).size !== checkedSelectors.length) throw new Error('Duplicate Vitest selection.')
  const helper = join(scratch, 'ion-vitest.mjs'), request = join(scratch, 'request.json'), report = join(scratch, 'report.json')
  await writeFile(helper, vitestHelper, { mode: 0o600, flag: 'wx' })
  await writeFile(request, JSON.stringify({ root, entry: entry.path, config, operation, selectors: checkedSelectors }), { mode: 0o600, flag: 'wx' })
  const paths = (await commandPaths(root)).filter(path => roots.every(other => !isWithin(other, path)))
  return { executable, args: [helper, request, report], cwd: root, environment: { ...envFor(paths, scratch), CI: '1', NO_COLOR: '1' },
    timeoutMs: operation === 'discover' ? testLimits.discoveryMs : testLimits.runMs, report, operation, trackedFiles,
    warning: 'This executes project-local ' + relative(root, entry.path).split(sep).join('/') + ' (Vitest ' + manifest.version
      + '), project configuration, plugins and test modules with your account permissions. Discovery executes collection code too. No packages are downloaded.' }
}

export const readVitestReport = readFrameworkReport
