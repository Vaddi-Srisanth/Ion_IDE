import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readTextFile, type Repository } from './repository'

function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\x08/g, '\\b') + '"'
}

/** Git emits scope NUL key LF value NUL. A bare boolean has no LF. */
function freezeConfiguration(text: string, originalCommon: string): string {
  const fields = text.split('\0')
  if (fields.pop() !== '' || fields.length % 2) throw new Error('Git returned incomplete configuration.')
  const lines: string[] = []
  let lfsStorage = ''
  for (let offset = 0; offset < fields.length; offset += 2) {
    const scope = fields[offset]
    const record = fields[offset + 1]
    const newline = record.indexOf('\n')
    const key = newline < 0 ? record : record.slice(0, newline)
    const value = newline < 0 ? undefined : record.slice(newline + 1)
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    const section = key.slice(0, first)
    const name = key.slice(last + 1)
    const subsection = last === first ? undefined : key.slice(first + 1, last)
    if (first < 1 || !/^[a-z][a-z0-9-]*$/i.test(section) || !/^[a-z][a-z0-9-]*$/i.test(name)
      || subsection && /[\r\n]/.test(subsection)) throw new Error('Git returned an invalid configuration key.')
    if ((scope === 'local' || scope === 'worktree') && /^(?:filter\..*\.(?:clean|process)|lfs\.extension\..*\.(?:clean|smudge)|lfs\.customtransfer\..*\.(?:path|args)|lfs\.standalonetransferagent)$/i.test(key)) {
      throw new Error('This repository configures a local Git filter. Use your terminal if you trust it.')
    }
    if (section.toLowerCase() === 'include' || section.toLowerCase() === 'includeif') continue
    // Network credentials are irrelevant to these offline operations. Avoid
    // copying them into the short-lived private configuration on disk.
    if (/^(?:credential|http|url|sendemail)$/i.test(section)
      || section.toLowerCase() === 'remote' && /^(?:url|pushurl)$/i.test(name)) continue
    if (key.toLowerCase() === 'extensions.refstorage' && value !== 'files' && value !== 'reftable') {
      throw new Error('This Git reference storage format is unsupported by Ion.')
    }
    if (key.toLowerCase() === 'lfs.storage') lfsStorage = value ?? ''
    const header = subsection === undefined ? '' : ' "' + subsection.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    lines.push(`[${section}${header}]`,
      `\t${name}${value === undefined ? '' : ' = ' + quote(value)}`)
  }
  // All includes were resolved against the original repository by the capture.
  // The projected Git process must never read a fresh worktree config.
  lines.push('[extensions]', '\tworktreeConfig = false')
  lines.push('[lfs]', '\tstorage = ' + quote(isAbsolute(lfsStorage) ? lfsStorage : resolve(originalCommon, lfsStorage || 'lfs')))
  return lines.join('\n') + '\n'
}

async function linkDirectory(source: string, destination: string, required = false): Promise<void> {
  const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) {
    if (required) throw new Error('Git repository metadata is incomplete. Repair the repository in your terminal.')
    return mkdir(destination)
  }
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

async function copyMetadata(source: string, destination: string, limit: number): Promise<void> {
  const text = await readTextFile(source, limit).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (text !== undefined) await writeFile(destination, text, { flag: 'wx', mode: 0o600 })
}

/** Only status/add use this view. Ref-changing plumbing uses the original refs. */
export async function withFrozenConfiguration<T>(repository: Repository, text: string, signal: AbortSignal,
  run: (directory: string, environment: NodeJS.ProcessEnv, verifyMetadata: () => Promise<void>) => Promise<T>): Promise<T> {
  const linked = relative(join(repository.root, '.git'), repository.directory) !== ''
  const originalCommon = linked ? dirname(dirname(repository.directory)) : repository.directory
  const config = freezeConfiguration(text, originalCommon)
  signal.throwIfAborted()
  const scratch = await mkdtemp(join(tmpdir(), 'ion-git-config-'))
  let retained = false
  try {
    const common = join(scratch, 'common')
    const selected = linked ? join(common, 'worktrees', basename(repository.directory)) : common
    await mkdir(common)
    if (linked) await mkdir(selected, { recursive: true })
    await writeFile(join(common, 'config'), config, { flag: 'wx', mode: 0o600 })
    await linkDirectory(join(originalCommon, 'objects'), join(common, 'objects'), true)
    await linkDirectory(join(originalCommon, 'refs'), join(common, 'refs'), true)
    await linkDirectory(join(originalCommon, 'info'), join(common, 'info'))
    const reftable = await lstat(join(originalCommon, 'reftable')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (reftable) await linkDirectory(join(originalCommon, 'reftable'), join(common, 'reftable'), true)
    await copyMetadata(join(originalCommon, 'packed-refs'), join(common, 'packed-refs'), 32 * 1024 * 1024)
    await copyMetadata(join(originalCommon, 'shallow'), join(common, 'shallow'), 1024 * 1024)
    await copyMetadata(join(originalCommon, 'HEAD'), join(common, 'HEAD'), 8192)
    if (linked) {
      await copyMetadata(join(repository.directory, 'HEAD'), join(selected, 'HEAD'), 8192)
      await writeFile(join(selected, 'commondir'), '../..\n', { flag: 'wx', mode: 0o600 })
      await linkDirectory(join(repository.directory, 'refs'), join(selected, 'refs'))
      await linkDirectory(join(repository.directory, 'info'), join(selected, 'info'))
      const tables = await lstat(join(repository.directory, 'reftable')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (tables) await linkDirectory(join(repository.directory, 'reftable'), join(selected, 'reftable'), true)
    }
    const views = await Promise.all([...new Set([common, selected])].map(async directory =>
      ({ directory, names: new Set(await readdir(directory)) })))
    const verifyMetadata = async () => {
      for (const view of views) {
        if ((await readdir(view.directory)).some(name => !view.names.has(name))) {
          retained = true
          throw new Error('A Git filter created additional metadata. Configure its permanent storage before staging. '
            + 'Ion preserved the metadata at ' + scratch)
        }
      }
    }
    signal.throwIfAborted()
    let result: T | undefined
    let failure: unknown
    try {
      result = await run(selected, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_INDEX_FILE: join(repository.directory, 'index') }, verifyMetadata)
    } catch (error) { failure = error }
    try { await verifyMetadata() } catch (error) {
      if (failure) throw new AggregateError([failure, error], String(error))
      throw error
    }
    if (failure) throw failure
    return result as T
  } finally {
    // This directory contains junctions/symlinks, never copies of user objects.
    // fs.rm removes their entries without traversing their targets.
    if (!retained) await rm(scratch, { recursive: true, force: true })
  }
}
