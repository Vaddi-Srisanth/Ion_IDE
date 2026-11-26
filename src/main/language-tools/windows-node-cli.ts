import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const maxPackageMetadataBytes = 64 * 1024
const maxCliEntryBytes = 16 * 1024 * 1024

const supported = {
  'typescript-language-server': { packageName: 'typescript-language-server', binName: 'typescript-language-server' },
  'pyright-langserver': { packageName: 'pyright', binName: 'pyright-langserver' },
} as const

type SupportedCommand = keyof typeof supported

interface FileRevision {
  canonical: string
  device: number
  inode: number
  size: number
  modified: number
  changed: number
  digest?: string
}

interface PackageInspection {
  packageRoot: string
  packageJson: FileRevision
  entry: FileRevision
}

export interface TrustedNodeCli {
  executable: string
  args: string[]
  packageRoot: string
  entry: string
  verify(): Promise<void>
}

function inside(root: string, path: string) {
  const relation = relative(root, path)
  return relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation)
}

function sameRevision(left: FileRevision, right: FileRevision) {
  return left.canonical === right.canonical && left.device === right.device && left.inode === right.inode
    && left.size === right.size && left.modified === right.modified && left.changed === right.changed
    && left.digest === right.digest
}

async function boundedFile(path: string, limit: number, content = false): Promise<{ revision: FileRevision; text?: string }> {
  const link = await lstat(path)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('The Node CLI package contains an invalid file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 0 || before.size > limit) {
      throw new Error('The Node CLI package file exceeds its safety limit.')
    }
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)))
    let offset = 0
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (content) chunks.push(Buffer.from(chunk))
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('The Node CLI package changed while Ion inspected it.')
    }
    return {
      revision: {
        canonical: await realpath(path), device: before.dev, inode: before.ino, size: before.size,
        modified: before.mtimeMs, changed: before.ctimeMs, digest: hash.digest('hex'),
      },
      text: content ? Buffer.concat(chunks).toString('utf8') : undefined,
    }
  } finally {
    await handle.close()
  }
}

async function executableRevision(path: string, workspace: string): Promise<FileRevision> {
  if (!isAbsolute(path) || inside(workspace, path)) throw new Error('The Node runtime is not trusted.')
  const link = await lstat(path)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('The Node runtime is not a regular file.')
  const canonical = await realpath(path)
  if (inside(workspace, canonical)) throw new Error('The Node runtime resolves inside the workspace.')
  await access(path, constants.X_OK)
  const value = await stat(path)
  return { canonical, device: value.dev, inode: value.ino, size: value.size,
    modified: value.mtimeMs, changed: value.ctimeMs }
}

async function inspectPackage(directory: string, workspace: string, command: SupportedCommand): Promise<PackageInspection> {
  const definition = supported[command]
  const shim = join(directory, `${command}.cmd`)
  const shimLink = await lstat(shim)
  if (shimLink.isSymbolicLink() || !shimLink.isFile()) throw new Error('The npm command shim is invalid.')
  const shimCanonical = await realpath(shim)
  if (inside(workspace, shim) || inside(workspace, shimCanonical)) throw new Error('The npm command shim is workspace-controlled.')

  const nodeModules = join(directory, 'node_modules')
  const canonicalModules = await realpath(nodeModules)
  if (inside(workspace, nodeModules) || inside(workspace, canonicalModules)) throw new Error('The npm package store is workspace-controlled.')
  const packagePath = join(nodeModules, definition.packageName)
  const packageLink = await lstat(packagePath)
  if (packageLink.isSymbolicLink() || !packageLink.isDirectory()) throw new Error('The npm package root is not a real directory.')
  const packageRoot = await realpath(packagePath)
  if (!inside(canonicalModules, packageRoot) || inside(workspace, packagePath) || inside(workspace, packageRoot)) {
    throw new Error('The npm package root escaped its trusted package store.')
  }

  const packageJsonPath = join(packagePath, 'package.json')
  const packageMetadata = await boundedFile(packageJsonPath, maxPackageMetadataBytes, true)
  let metadata: unknown
  try { metadata = JSON.parse(packageMetadata.text ?? '') }
  catch { throw new Error('The npm package metadata is malformed.') }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('The npm package metadata is invalid.')
  const record = metadata as { name?: unknown; bin?: unknown }
  if (record.name !== definition.packageName) throw new Error('The npm package identity does not match the supported tool.')
  const bin = typeof record.bin === 'string' && definition.binName === definition.packageName
    ? record.bin
    : record.bin && typeof record.bin === 'object' && !Array.isArray(record.bin)
      ? (record.bin as Record<string, unknown>)[definition.binName]
      : undefined
  if (typeof bin !== 'string' || !bin || bin.length > 1024 || bin.includes('\0') || isAbsolute(bin)) {
    throw new Error('The npm package declares an invalid CLI entry.')
  }
  const entryPath = resolve(packagePath, bin)
  if (!inside(packagePath, entryPath)) throw new Error('The npm CLI entry escapes its package root.')
  const entry = await boundedFile(entryPath, maxCliEntryBytes)
  if (!inside(packageRoot, entry.revision.canonical) || inside(workspace, entryPath)
    || inside(workspace, entry.revision.canonical)) {
    throw new Error('The npm CLI entry escaped its trusted package root.')
  }
  return { packageRoot, packageJson: packageMetadata.revision, entry: entry.revision }
}

async function findNode(paths: string[], workspace: string, platform: NodeJS.Platform) {
  const name = platform === 'win32' ? 'node.exe' : 'node'
  for (const directory of paths) {
    try { return await executableRevision(join(directory, name), workspace) } catch { /* Try the next trusted PATH directory. */ }
  }
  return null
}

/** Resolves only known npm-installed language servers. The `.cmd` shim proves
 * the CLI is exposed by that trusted PATH prefix but is never read or run.
 * Ion launches the package-declared entry with a separately trusted Node. */
export async function discoverWindowsNodeCli(command: string, root: string, paths: string[],
  platform: NodeJS.Platform = process.platform): Promise<TrustedNodeCli | null> {
  if (platform !== 'win32' || !(command in supported)) return null
  const workspace = await realpath(root).catch(() => resolve(root))
  const node = await findNode(paths, workspace, platform)
  if (!node) return null
  for (const supplied of paths.slice(0, 80)) {
    try {
      if (!isAbsolute(supplied) || inside(workspace, supplied)) continue
      const directory = await realpath(supplied)
      if (inside(workspace, directory)) continue
      const inspected = await inspectPackage(directory, workspace, command as SupportedCommand)
      return {
        executable: node.canonical,
        args: [inspected.entry.canonical],
        packageRoot: inspected.packageRoot,
        entry: inspected.entry.canonical,
        async verify() {
          const currentNode = await executableRevision(node.canonical, workspace)
          const current = await inspectPackage(directory, workspace, command as SupportedCommand)
          if (!sameRevision(node, currentNode) || current.packageRoot !== inspected.packageRoot
            || !sameRevision(inspected.packageJson, current.packageJson) || !sameRevision(inspected.entry, current.entry)) {
            throw new Error('The installed Node language server changed before launch. Try again after installation completes.')
          }
        },
      }
    } catch { /* Invalid or untrusted npm layouts are not executable candidates. */ }
  }
  return null
}
