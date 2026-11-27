import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileMutations, type FileMutations } from '../file-mutations'
import { isWithin } from '../files'
import { envFor, executable } from '../run-console/plans'
import { execute } from '../runner'
import { windowsSystemDirectory } from '../windows-process'
import { checkRepository } from './github-repository'
import { resolveGit } from './repository'

type Dependencies = { run?: typeof execute; findGit?: typeof resolveGit; mutations?: Pick<FileMutations, 'move'> }
const cloneMs = 120_000, outputLimit = 64 * 1024

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

export async function clonePublicGitHub(ownerRepo: unknown, parent: string, root: string, workspaceRoots: readonly string[], signal: AbortSignal,
  deps: Dependencies = {}): Promise<string> {
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
    if (!tool) throw new Error('Install Git to clone a public GitHub repository.')
    const git = await externalGitTool(tool.executable, workspaceRoots)
    const environment: NodeJS.ProcessEnv = await anonymousGitEnvironment(git, workspaceRoots, neutral, scratch, template)
    async function run(args: string[], timeoutMs: number, limit: number) {
      signal.throwIfAborted()
      if (await externalGitTool(git, workspaceRoots) !== git) throw new Error('The installed Git changed.')
      const result = await (deps.run ?? execute)(git, args, { input: '', cwd: neutral, signal, timeoutMs, budget: { remaining: limit },
        environment, splitOutput: true, collectOutput: false })
      if (result.outputComplete === false) {
        unresolved = true
        throw new Error('Git output or process cleanup could not be verified.')
      }
      signal.throwIfAborted()
      if (result.state === 'timeout') throw new Error('The public clone timed out.')
      if (result.state !== 'exited' || result.exitCode !== 0 || Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') > limit) {
        throw new Error('Public clone failed. Check the repository name, connectivity and installed Git.')
      }
      return result.stdout ?? ''
    }
    const execPath = (await run(['--exec-path'], 5000, 4096)).trim()
    environment.GIT_EXEC_PATH = await anonymousGitHelper(execPath, workspaceRoots)
    await run([...anonymousHttpsOptions(template),
      'clone', '--depth=1', '--single-branch', '--no-tags', '--no-local', '--no-recurse-submodules',
      '--template=' + template, '--', 'https://github.com/' + repository + '.git', checkout], cloneMs, outputLimit)

    await directory(output, outputId)
    await directory(checkout, checkoutId)
    await directory(join(checkout, '.git'))
    const head = join(checkout, '.git', 'HEAD')
    if (await realpath(head) !== head || !(await lstat(head)).isFile()) throw new Error('Git did not produce a checkout with a regular HEAD.')
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
