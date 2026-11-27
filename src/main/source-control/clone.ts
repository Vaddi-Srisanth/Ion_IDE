import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileMutations, type FileMutations } from '../file-mutations'
import { isWithin } from '../files'
import { envFor, executable } from '../run-console/plans'
import { execute } from '../runner'
import { windowsSystemDirectory } from '../windows-process'
import { checkRepository } from './github-repository'
import { resolveGit } from './repository'

type Dependencies = { run?: typeof execute; findGit?: typeof resolveGit
  findGh?: (root: string, roots: readonly string[], signal: AbortSignal) => Promise<string>
  mutations?: Pick<FileMutations, 'move'> }
const cloneMs = 120_000, outputLimit = 64 * 1024, packLimit = 256n * 1024n * 1024n

async function directory(path: string, previous?: BigIntStats) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('The clone directory changed or uses a symbolic link.')
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || previous && (info.dev !== previous.dev || info.ino !== previous.ino)) throw new Error('The clone directory changed.')
  return info
}

export async function externalGitTool(path: string, roots: readonly string[]) {
  if (!isAbsolute(path)) throw new Error('Install Git outside every open workspace.')
  const canonical = await realpath(path)
  if (roots.some(root => isWithin(root, path) || isWithin(root, canonical)) || !await executable(canonical, roots[0])) {
    throw new Error('Install Git outside every open workspace.')
  }
  return canonical
}

export async function anonymousGitEnvironment(git: string, workspaceRoots: readonly string[], neutral: string, scratch: string, template: string) {
  const paths: string[] = []
  for (const item of [dirname(git), ...(process.platform === 'win32' ? [windowsSystemDirectory] : ['/usr/bin', '/bin'])]) {
    const path = await realpath(item)
    if (workspaceRoots.every(other => !isWithin(other, item) && !isWithin(other, path))) paths.push(path)
  }
  return { ...envFor(paths, neutral), HOME: neutral, USERPROFILE: neutral, CURL_HOME: neutral,
    APPDATA: neutral, LOCALAPPDATA: neutral, XDG_CONFIG_HOME: neutral, GIT_CEILING_DIRECTORIES: scratch,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'https', GIT_TEMPLATE_DIR: template }
}

export async function anonymousGitHelper(execPath: string, workspaceRoots: readonly string[]) {
  if (!isAbsolute(execPath) || /[\x00-\x1f]/.test(execPath)) throw new Error('The installed Git HTTPS helper is unavailable.')
  const httpsHelper = join(execPath, process.platform === 'win32' ? 'git-remote-https.exe' : 'git-remote-https')
  await externalGitTool(httpsHelper, workspaceRoots)
  const helperDirectory = await realpath(execPath)
  if (workspaceRoots.some(other => isWithin(other, execPath) || isWithin(other, helperDirectory))) {
    throw new Error('Install Git outside every open workspace.')
  }
  return helperDirectory
}

export function anonymousHttpsOptions(template: string): string[] {
  return ['--no-pager', '-c', 'credential.helper=', '-c', 'credential.interactive=false',
    '-c', 'core.hooksPath=' + template, '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'transfer.bundleURI=false',
    '-c', 'submodule.recurse=false', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true']
}

async function stagedPackBytes(directory: string): Promise<bigint> {
  let total = 0n
  const info = await lstat(directory, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return 0n
  if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error('Git created an unexpected private object directory.')
  for (const name of await readdir(directory)) {
    const file = await lstat(join(directory, name), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!file) continue
    if (!file.isFile()) throw new Error('Git created an unexpected entry in its private object directory.')
    total += file.size
    if (total > packLimit) return total
  }
  return total
}

function privateCloneOptions(template: string): string[] {
  return ['--depth=1', '--single-branch', '--no-tags', '--no-local', '--no-recurse-submodules', '--template=' + template,
    '--config=core.hooksPath=' + template, '--config=http.followRedirects=false', '--config=http.sslVerify=true',
    '--config=protocol.allow=never', '--config=protocol.https.allow=always', '--config=transfer.bundleURI=false',
    '--config=submodule.recurse=false', '--config=core.protectHFS=true', '--config=core.protectNTFS=true']
}

export async function cloneGitHub(ownerRepo: unknown, access: 'public' | 'authenticated', parent: string, root: string,
  workspaceRoots: readonly string[], signal: AbortSignal,
  deps: Dependencies = {}): Promise<string> {
  if (access !== 'public' && access !== 'authenticated') throw new Error('Choose a public or authenticated GitHub clone.')
  const repository = checkRepository(ownerRepo)
  const name = repository.split('/')[1]
  // A remote name is not automatically a portable file name (e.g. CON or AUX.txt).
  const childName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)|[.]$/i.test(name) || name.startsWith('.') ? 'repo-' + name.replace(/\.+$/, '') : name
  signal.throwIfAborted()
  if (!workspaceRoots.includes(root) || !isAbsolute(root)) throw new Error('Choose an open workspace root.')
  const destination = await directory(parent)
  const final = join(parent, childName)
  const occupied = 'Choose another folder; this repository folder already exists.'
  const existing = await lstat(final).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error(occupied)
  const temp = await realpath(tmpdir())
  if (workspaceRoots.some(other => isWithin(other, temp))) throw new Error('Public clone requires private temporary storage outside all workspaces.')
  if (destination.dev !== (await directory(temp)).dev) throw new Error('Choose a destination on the same volume as temporary storage for atomic clone publication.')
  const scratch = await mkdtemp(join(temp, 'ion-git-clone-'))
  const owned = await directory(scratch)
  let unresolved = false
  let payload: { output: string; outputId: BigIntStats; checkout: string; checkoutId: BigIntStats } | undefined
  let published: string | undefined
  try {
    const neutral = join(scratch, 'environment'), template = join(scratch, 'empty-template')
    await mkdir(neutral, { mode: 0o700 }); await mkdir(template, { mode: 0o700 })
    const output = await mkdtemp(join(scratch, 'Ion Clone '))
    const outputId = await directory(output), checkout = join(output, childName)
    await mkdir(checkout, { mode: 0o700 })
    const checkoutId = await directory(checkout)
    payload = { output, outputId, checkout, checkoutId }
    const tool = await (deps.findGit ?? resolveGit)(neutral, signal)
    if (!tool) throw new Error('Install Git to clone a GitHub repository.')
    const git = await externalGitTool(tool.executable, workspaceRoots)
    const ghPath = access === 'authenticated'
      ? await (deps.findGh ?? (await import('./github')).resolveGitHubCli)(neutral, workspaceRoots, signal)
      : undefined
    const gh = ghPath ? await externalGitTool(ghPath, workspaceRoots) : undefined
    const helperPaths = [dirname(git), ...(gh ? [dirname(gh)] : []),
      ...(process.platform === 'win32' ? [windowsSystemDirectory] : ['/usr/bin', '/bin'])]
    const pathDirectories: string[] = []
    for (const item of helperPaths) {
      const path = await realpath(item)
      if (workspaceRoots.every(other => !isWithin(other, item) && !isWithin(other, path))) pathDirectories.push(path)
      else throw new Error('Install Git and GitHub CLI outside every open workspace.')
    }
    let environment: NodeJS.ProcessEnv = access === 'public'
      ? await anonymousGitEnvironment(git, workspaceRoots, neutral, scratch, template)
      : { ...envFor(pathDirectories, scratch), GH_HOST: 'github.com', GH_CONFIG_DIR: join(scratch, 'gh-config'),
        GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_TELEMETRY: '0',
        DO_NOT_TRACK: '1', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'),
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CEILING_DIRECTORIES: scratch,
        GIT_ALLOW_PROTOCOL: 'https', GIT_TEMPLATE_DIR: template, GIT_PAGER: 'cat', PAGER: 'cat' }
    if (access === 'authenticated') {
      await mkdir(environment.GH_CONFIG_DIR!, { mode: 0o700 })
      await writeFile(environment.GIT_CONFIG_GLOBAL!, '', { mode: 0o600 })
    }
    async function run(command: string, args: string[], timeoutMs: number, limit: number, operationSignal = signal) {
      operationSignal.throwIfAborted()
      if (await externalGitTool(git, workspaceRoots) !== git || (gh && await externalGitTool(gh, workspaceRoots) !== gh)) {
        throw new Error('The installed Git or GitHub CLI changed.')
      }
      const result = await (deps.run ?? execute)(command, args, { input: '', cwd: neutral, signal: operationSignal, timeoutMs, budget: { remaining: limit },
        environment, splitOutput: true, collectOutput: false })
      if (result.outputComplete === false) {
        unresolved = true
        throw new Error('Clone process output or cleanup could not be verified.')
      }
      operationSignal.throwIfAborted()
      if (result.state === 'timeout') throw new Error('The GitHub clone timed out.')
      if (result.state !== 'exited' || result.exitCode !== 0 || Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') > limit) {
        throw new Error(access === 'authenticated'
          ? 'Authenticated clone failed. Check the repository access, GitHub CLI sign-in, connectivity and installed tools.'
          : 'Public clone failed. Check the repository name, connectivity and installed Git.')
      }
      return result.stdout ?? ''
    }
    const execPath = (await run(git, ['--exec-path'], 5000, 4096)).trim()
    environment.GIT_EXEC_PATH = await anonymousGitHelper(execPath, workspaceRoots)
    const receive = new AbortController()
    const cancelReceive = () => receive.abort()
    signal.addEventListener('abort', cancelReceive, { once: true })
    let exceededPackLimit = false, monitorFailure = false
    const monitor = (async () => {
      while (!receive.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 25))
        if (receive.signal.aborted) return
        try {
          if (await stagedPackBytes(join(checkout, '.git', 'objects', 'pack')) > packLimit) {
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
    let cloneFailure: unknown
    try {
      if (access === 'public') {
        await run(git, [...anonymousHttpsOptions(template),
          'clone', '--depth=1', '--single-branch', '--no-tags', '--no-local', '--no-recurse-submodules',
          '--template=' + template, '--', 'https://github.com/' + repository + '.git', checkout], cloneMs, outputLimit, receive.signal)
      } else {
        await run(gh!, ['repo', 'clone', '--no-upstream', 'https://github.com/' + repository + '.git', checkout, '--',
          ...privateCloneOptions(template)], cloneMs, outputLimit, receive.signal)
      }
      if (await stagedPackBytes(join(checkout, '.git', 'objects', 'pack')) > packLimit) exceededPackLimit = true
    } catch (error) { cloneFailure = error }
    finally {
      receive.abort()
      signal.removeEventListener('abort', cancelReceive)
      await monitor
    }
    if (exceededPackLimit) throw new Error('The incoming Git pack exceeded Ion’s 256 MiB limit; the clone was canceled before publication.')
    if (monitorFailure) throw new Error('Git created an unexpected or unreadable entry in its private object directory.')
    if (cloneFailure) throw cloneFailure

    await directory(output, outputId)
    await directory(checkout, checkoutId)
    await directory(join(checkout, '.git'))
    const head = join(checkout, '.git', 'HEAD')
    if (await realpath(head) !== head || !(await lstat(head)).isFile()) throw new Error('Git did not produce a checkout with a regular HEAD.')
    if (access === 'authenticated') {
      const configPath = join(checkout, '.git', 'config')
      const configInfo = await lstat(configPath)
      if (!configInfo.isFile() || configInfo.size > 32 * 1024) throw new Error('The authenticated clone returned an invalid repository config.')
      const config = await readFile(configPath, 'utf8')
      const remoteUrl = 'url = https://github.com/' + repository + '.git'
      const lines = config.split(/\r?\n/)
      const urls = lines.filter(line => /^\s*url\s*=/i.test(line))
      const storesCredential = lines.some(line => /^\s*(?:helper|extraheader|authorization|password|token)\s*=/i.test(line)
        || /^\s*\[\s*credential\b/i.test(line))
      if (urls.length !== 1 || urls[0].trim() !== remoteUrl
        || storesCredential
        || /(?:https?:\/\/)[^/\s@]+:[^/\s@]+@/i.test(config)) {
        throw new Error('The authenticated clone remote did not match the reviewed public GitHub URL format.')
      }
    }
    await directory(parent, destination)
    await directory(scratch, owned)
    signal.throwIfAborted()
    // Git only writes in private staging. Publish the checkout to the chosen name in
    // a single, handle-relative native move that refuses competing files/directories.
    try {
      await (deps.mutations ?? fileMutations()).move(checkout, final, outputId, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(occupied)
      throw error
    }
    published = final
    try { await directory(final, checkoutId) }
    catch { throw new Error('The published clone moved before verification. Inspect the new folder at ' + final) }
    // The atomic move has committed even if cancellation arrives during publication.
    return published
  } finally {
    if (unresolved) throw new Error('Git process cleanup was unverified. Private staging retained at ' + scratch)
    try {
      await directory(scratch, owned)
      if (payload) {
        await directory(payload.output, payload.outputId)
        const contents = await readdir(payload.output)
        if (contents.some(entry => published || entry !== childName)) throw new Error('Unknown staging contents.')
        if (contents.length) await directory(payload.checkout, payload.checkoutId)
      }
      await rm(scratch, { recursive: true, force: false })
    } catch {
      throw new Error((published ? 'Clone published at ' + published + '. ' : '') + 'Could not verify or remove the private clone staging directory at ' + scratch)
    }
  }
}

export async function clonePublicGitHub(ownerRepo: unknown, parent: string, root: string, workspaceRoots: readonly string[], signal: AbortSignal,
  deps: Dependencies = {}): Promise<string> {
  return cloneGitHub(ownerRepo, 'public', parent, root, workspaceRoots, signal, deps)
}

export async function cloneAuthenticatedGitHub(ownerRepo: unknown, parent: string, root: string, workspaceRoots: readonly string[], signal: AbortSignal,
  deps: Dependencies = {}): Promise<string> {
  return cloneGitHub(ownerRepo, 'authenticated', parent, root, workspaceRoots, signal, deps)
}
