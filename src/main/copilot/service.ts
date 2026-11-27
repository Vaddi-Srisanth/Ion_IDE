import { mkdir, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { isWithin } from '../files'
import { LspProcess } from '../language-tools/lsp-process'
import { CopilotLanguageClient, type CopilotStatus } from './client'

export interface CopilotServiceOptions {
  executable: string
  profile: string
  root: string | null
  workspaceRoots?: readonly string[]
  applicationVersion: string
  onStatus?(status: CopilotStatus): void
  start?: typeof LspProcess.start
}

/** Launch only an executable resolved from Ion's verified, pinned Copilot runtime. */
export async function startCopilotService(options: CopilotServiceOptions, signal: AbortSignal) {
  await mkdir(options.profile, { recursive: true, mode: 0o700 })
  const profile = await realpath(options.profile)
  const home = join(profile, 'home'), scratch = join(profile, 'scratch')
  const config = join(home, 'config'), cache = join(home, 'cache'), state = join(home, 'state'), temp = join(scratch, 'tmp')
  const roaming = join(home, 'roaming'), local = join(home, 'local'), ghConfig = join(config, 'gh')
  for (const directory of [home, config, cache, state, scratch, temp, roaming, local, ghConfig]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  const root = options.root === null ? null : await realpath(options.root)
  const workspaceRoots = await Promise.all((options.workspaceRoots ?? (root ? [root] : [])).map(path => realpath(path)))
  if (!isAbsolute(options.executable) || !isAbsolute(profile)
    || workspaceRoots.some(path => isWithin(path, profile) || isWithin(profile, path))
    || root && !isAbsolute(root)) throw new Error('GitHub Copilot requires a private application profile and trusted runtime.')
  const environment: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state,
    APPDATA: roaming, LOCALAPPDATA: local,
    TMP: temp, TEMP: temp, TMPDIR: temp,
    GH_CONFIG_DIR: ghConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', LANG: 'C', LC_ALL: 'C',
  }
  if (process.platform === 'win32') {
    const systemRoot = await realpath(process.env.SystemRoot ?? 'C:\\Windows')
    Object.assign(environment, { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') })
    const drive = home.slice(0, 2), tail = home.slice(2)
    Object.assign(environment, { HOMEDRIVE: drive, HOMEPATH: tail })
  } else environment.PATH = ['/usr/bin', '/bin'].join(delimiter)
  signal.throwIfAborted()
  const server = await (options.start ?? LspProcess.start)({
    executable: options.executable, args: ['--stdio'], cwd: scratch, env: environment, root,
    capabilities: { general: { positionEncodings: ['utf-16'] },
      textDocument: { inlineCompletion: { dynamicRegistration: false } } },
    initializationOptions: {
      editorInfo: { name: 'Ion IDE', version: options.applicationVersion },
      editorPluginInfo: { name: 'Ion Copilot Integration', version: options.applicationVersion },
    },
    configuration: { telemetry: { telemetryLevel: 'off' }, http: { proxyStrictSSL: true } },
    deadlines: { startupMs: 6000, initializationMs: 12_000, requestMs: 5000 },
  }, signal)
  const sync = typeof server.capabilities.textDocumentSync === 'number'
    ? server.capabilities.textDocumentSync : object(server.capabilities.textDocumentSync)?.change
  const inline = server.capabilities.inlineCompletionProvider === true
    || Boolean(object(server.capabilities.inlineCompletionProvider))
  if (sync !== 2 || !inline) {
    await server.stop()
    throw new Error('The installed GitHub Copilot server does not advertise incremental document sync and inline completion.')
  }
  const client = new CopilotLanguageClient(server, options.onStatus)
  return {
    client,
    version: server.version,
    async close() { await client.close() },
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
