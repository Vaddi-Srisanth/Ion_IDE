import type { BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { SourceControlFetchRequest, SourceControlFetchResult } from '../../shared/source-control'
import { fileMutations, type FileMutations } from '../file-mutations'
import { isWithin } from '../files'
import { execute } from '../runner'
import { checkRepository } from './github-repository'
import { commonGitDirectory } from './configuration'
import { git, resolveGit, type Repository } from './repository'
import { gitObjectId } from './commit'
import { anonymousGitEnvironment, anonymousGitHelper, anonymousHttpsOptions, externalGitTool } from './clone'

const fetchMs = 120_000
const outputLimit = 64 * 1024
const packLimit = 256n * 1024n * 1024n

export type RemoteFetchDependencies = { run?: typeof execute; findGit?: typeof resolveGit }

async function checkedDirectory(path: string, prior?: BigIntStats): Promise<BigIntStats> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('The Git staging folder changed or uses a symbolic link.')
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || prior && (info.dev !== prior.dev || info.ino !== prior.ino)) throw new Error('The Git staging folder changed.')
  return info
}

async function stagedPackBytes(directory: string): Promise<bigint> {
  let total = 0n
  for (const name of await readdir(directory)) {
    const info = await lstat(join(directory, name), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) continue
    if (!info.isFile()) throw new Error('Git created an unexpected entry in its private incoming object store.')
    total += info.size
    if (total > packLimit) return total
  }
  return total
}

function branchName(value: string): boolean {
  return value.length <= 1024 && !/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069~^:?*\[\\<>"|]/u.test(value)
    && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function remoteName(value: string): boolean {
  return value.length <= 100 && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      && /^[\p{L}\p{N}_.-]+$/u.test(part))
}

async function updateRef(repository: Repository, signal: AbortSignal, remote: string, branch: string, oid: string, previous: string) {
  const ref = 'refs/remotes/' + remote + '/' + branch
  await git(repository, signal, ['update-ref', '--no-deref', '-m', 'fetch: updated in Ion', ref, oid, previous])
}

/** Download one public GitHub branch into private staging, then publish only its verified pack and fast-forward ref. */
export async function fetchPublicGitHub(repository: Repository, workspaceRoots: readonly string[], selection: SourceControlFetchRequest,
  signal: AbortSignal, validate: () => Promise<void>, mutations: Pick<FileMutations, 'move'> = fileMutations(),
  deps: RemoteFetchDependencies = {}): Promise<SourceControlFetchResult> {
  const slug = checkRepository(selection?.repository)
  const { remote, branch, previous } = selection
  if (typeof remote !== 'string' || !remoteName(remote) || typeof branch !== 'string' || !branchName(branch)
    || typeof previous !== 'string' || !gitObjectId.test(previous)) throw new Error('Choose a reviewed cached GitHub branch.')
  const canonicalSlug = checkRepository(slug)
  const common = commonGitDirectory(repository)
  const objects = join(common, 'objects')
  const packDirectory = join(objects, 'pack')
  const actualObjects = await realpath(objects)
  if (actualObjects !== objects || !(await lstat(objects)).isDirectory() || await realpath(packDirectory) !== packDirectory
    || !(await lstat(packDirectory)).isDirectory() || /[\r\n]/.test(objects)) {
    throw new Error('This repository has a redirected or unsupported Git object folder.')
  }
  const packParent = await checkedDirectory(packDirectory)
  await validate()
  signal.throwIfAborted()

  const temp = await realpath(tmpdir())
  if (workspaceRoots.some(root => isWithin(root, temp))) throw new Error('Public fetch requires private temporary storage outside all workspaces.')
  if ((await lstat(temp, { bigint: true })).dev !== packParent.dev) {
    throw new Error('Public fetch requires temporary storage on the same volume as the Git object folder.')
  }
  const scratch = await mkdtemp(join(temp, 'ion-git-fetch-'))
  const owned = await checkedDirectory(scratch)
  let unresolved = false
  let updated = false
  try {
    const neutral = join(scratch, 'environment'), template = join(scratch, 'empty-template'), stagingRepo = join(scratch, 'fetch.git')
    await mkdir(neutral, { mode: 0o700 }); await mkdir(template, { mode: 0o700 })
    const tool = await (deps.findGit ?? resolveGit)(neutral, signal)
    if (!tool) throw new Error('Install Git to fetch a public GitHub branch.')
    const binary = await externalGitTool(tool.executable, workspaceRoots)
    const environment: NodeJS.ProcessEnv = await anonymousGitEnvironment(binary, workspaceRoots, neutral, scratch, template)
    const run = deps.run ?? execute
    async function invoke(args: string[], timeoutMs = 8000, limit = outputLimit, input = '', operationSignal = signal) {
      operationSignal.throwIfAborted()
      if (await externalGitTool(binary, workspaceRoots) !== binary) throw new Error('The installed Git changed.')
      const result = await run(binary, args, {
        cwd: neutral, input, signal: operationSignal, timeoutMs, budget: { remaining: limit },
        environment, splitOutput: true, collectOutput: false,
      })
      if (result.outputComplete === false) {
        unresolved = true
        throw new Error('Git output or process cleanup could not be verified.')
      }
      operationSignal.throwIfAborted()
      if (result.state === 'timeout') throw new Error('The public fetch timed out.')
      return result
    }
    async function success(args: string[], timeoutMs = 8000, limit = outputLimit, input = '', operationSignal = signal) {
      const result = await invoke(args, timeoutMs, limit, input, operationSignal)
      if (result.state !== 'exited' || result.exitCode !== 0
        || Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') > limit) {
        throw new Error('The public GitHub fetch could not be completed safely.')
      }
      return result.stdout ?? ''
    }

    const execPath = (await success(['--exec-path'], 5000, 4096)).trim()
    environment.GIT_EXEC_PATH = await anonymousGitHelper(execPath, workspaceRoots)
    await success([...anonymousHttpsOptions(template), 'init', '--bare', '--quiet', '--template=' + template, stagingRepo], 10_000)
    await checkedDirectory(stagingRepo)
    const stagedObjects = join(stagingRepo, 'objects')
    await writeFile(join(stagedObjects, 'info', 'alternates'), objects + '\n', { flag: 'wx', mode: 0o600 })

    const namespace = 'refs/ion-fetch/' + randomUUID()
    const url = 'https://github.com/' + canonicalSlug + '.git'
    const refspec = 'refs/heads/' + branch + ':' + namespace
    const fetchArgs = [...anonymousHttpsOptions(template), '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
      '-c', 'fetch.unpackLimit=0', '-c', 'transfer.unpackLimit=0', '-c', 'fetch.writeCommitGraph=false',
      '--git-dir=' + stagingRepo, 'fetch', '--quiet', '--atomic', '--no-tags', '--no-recurse-submodules',
      '--no-auto-gc', '--depth=256', '--', url, refspec]
    // A test may replace only the process runner. Production env permits HTTPS and no credentials.
    if (environment.GIT_ALLOW_PROTOCOL !== 'https' || environment.GIT_TERMINAL_PROMPT !== '0'
      || environment.GIT_CONFIG_NOSYSTEM !== '1' || environment.GIT_CONFIG_GLOBAL !== (process.platform === 'win32' ? 'NUL' : '/dev/null')) {
      throw new Error('Anonymous GitHub transport isolation could not be verified.')
    }
    const receive = new AbortController()
    const cancelReceive = () => receive.abort()
    signal.addEventListener('abort', cancelReceive, { once: true })
    let exceededPackLimit = false
    let monitorFailure = false
    const monitor = (async () => {
      while (!receive.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 25))
        if (receive.signal.aborted) return
        try {
          if (await stagedPackBytes(join(stagedObjects, 'pack')) > packLimit) {
            exceededPackLimit = true
            receive.abort()
            return
          }
        } catch {
          monitorFailure = true
          receive.abort()
          return
        }
      }
    })()
    let fetchFailure: unknown
    try {
      await success(fetchArgs, fetchMs, outputLimit, '', receive.signal)
      if (await stagedPackBytes(join(stagedObjects, 'pack')) > packLimit) exceededPackLimit = true
    } catch (error) { fetchFailure = error }
    finally {
      receive.abort()
      signal.removeEventListener('abort', cancelReceive)
      await monitor
    }
    if (exceededPackLimit) throw new Error('The incoming Git pack exceeded Ion’s 256 MiB limit; the fetch was canceled before publication.')
    if (monitorFailure) throw new Error('Git created an unexpected or unreadable entry in its private incoming object store.')
    if (fetchFailure) throw fetchFailure
    const fetched = (await success([...anonymousHttpsOptions(template), '--git-dir=' + stagingRepo,
      'rev-parse', '--verify', namespace + '^{commit}'], 8000, 256)).trim()
    if (!gitObjectId.test(fetched) || fetched.length !== previous.length) throw new Error('GitHub returned an invalid branch commit.')
    const objectType = (await success([...anonymousHttpsOptions(template), '--git-dir=' + stagingRepo,
      'cat-file', '-t', fetched], 8000, 64)).trim()
    if (objectType !== 'commit') throw new Error('GitHub returned a branch that does not point to a commit.')
    if (fetched === previous) return { oid: fetched, changed: false }
    const ancestry = await invoke([...anonymousHttpsOptions(template), '--git-dir=' + stagingRepo,
      'merge-base', '--is-ancestor', previous, fetched], 8000, 4096)
    if (ancestry.state !== 'exited' || ancestry.exitCode !== 0) {
      if (ancestry.state === 'exited' && ancestry.exitCode === 1) {
        throw new Error('The GitHub branch is not a fast-forward of the cached branch. Review it in your terminal.')
      }
      throw new Error('Git could not verify the fetched branch history.')
    }
    await validate()
    const received = await readdir(join(stagedObjects, 'pack'))
    const packNames = received.filter(name => /^pack-[0-9a-f]{40}(?:[.]pack|[.]idx)$/.test(name)
      || /^pack-[0-9a-f]{64}(?:[.]pack|[.]idx)$/.test(name))
    const packs = new Map<string, { pack?: string; index?: string }>()
    for (const name of packNames) {
      const match = /^(pack-[0-9a-f]{40}|pack-[0-9a-f]{64})[.](pack|idx)$/.exec(name)!
      const pair = packs.get(match[1]) ?? {}
      if (match[2] === 'pack') pair.pack = name
      else pair.index = name
      packs.set(match[1], pair)
    }
    if (received.some(name => !packNames.includes(name) && !/^pack-[0-9a-f]{40}(?:[.]rev|[.]keep)$/.test(name)
      && !/^pack-[0-9a-f]{64}(?:[.]rev|[.]keep)$/.test(name))) {
      throw new Error('Git created unexpected files in its private incoming object store.')
    }
    const verifiedPacks = [...packs.values()]
    if (verifiedPacks.some(pair => !pair.pack || !pair.index) || verifiedPacks.length > 2) {
      throw new Error('Git returned an incomplete or excessive pack set.')
    }
    let total = 0n
    const files: { name: string; stats: BigIntStats }[] = []
    for (const pair of verifiedPacks) for (const name of [pair.pack, pair.index]) {
      if (!name) continue
      const path = join(stagedObjects, 'pack', name)
      const stats = await lstat(path, { bigint: true })
      if (!stats.isFile() || stats.size <= 0n) throw new Error('Git returned an invalid pack file.')
      total += stats.size
      if (total > packLimit) throw new Error('The fetched Git pack exceeds Ion’s 256 MiB limit.')
      files.push({ name, stats })
    }

    await checkedDirectory(packDirectory, packParent)
    await checkedDirectory(scratch, owned)
    await validate()
    signal.throwIfAborted()

    const publicationSignal = new AbortController().signal
    for (const file of files) {
      const source = join(stagedObjects, 'pack', file.name)
      const target = join(packDirectory, file.name)
      const sourceInfo = await lstat(source, { bigint: true })
      if (sourceInfo.dev !== file.stats.dev || sourceInfo.ino !== file.stats.ino || !sourceInfo.isFile()) {
        throw new Error('The incoming Git pack changed before publication.')
      }
      const existing = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (existing) throw new Error('A matching incoming Git pack already exists. Refresh and try again.')
      await mutations.move(source, target, await checkedDirectory(dirname(source)), packParent)
      const published = await lstat(target, { bigint: true })
      if (published.dev !== file.stats.dev || published.ino !== file.stats.ino || !published.isFile()) {
        throw new Error('The incoming Git pack changed during publication.')
      }
    }
    await checkedDirectory(packDirectory, packParent)
    if ((await git(repository, publicationSignal, ['cat-file', '-t', fetched], { limit: 64 })).text.trim() !== 'commit') {
      throw new Error('The published Git pack does not contain the fetched commit.')
    }
    await updateRef(repository, publicationSignal, remote, branch, fetched, previous)
    updated = true
    return { oid: fetched, changed: true }
  } finally {
    if (unresolved) throw new Error('Git process cleanup was unverified. Private staging retained at ' + scratch)
    try {
      await checkedDirectory(scratch, owned)
      await rm(scratch, { recursive: true, force: false })
    } catch {
      throw new Error((updated ? 'The cached branch was updated. ' : '')
        + 'Could not verify or remove private Git fetch staging at ' + scratch)
    }
  }
}
