import { hasPendingRestore } from './backup/pending'
import type { BackupScope, RestoreChoices } from '../shared/backup'
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultSettings, type Entry, type MenuCommand, type OptionalPanel, type RunResult } from '../shared/contracts'
import { isThemeId } from '../shared/themes'
import { documentFormat } from '../shared/viewers'
import { isNotebookName, maxNotebookBytes } from '../shared/notebook-path'
import { maxEditableTextBytes, maxTextCopyBytes } from '../shared/large-text'
import type { FormatRequest, FormatResult } from '../shared/format-code'
import { debugLimits, validDebugDocumentVersion, type DebugAction, type DebugSession, type DebugStartRequest } from '../shared/debug'
import type { NotebookKernelStatus } from '../shared/notebook-kernel'
import { runLanguage, type RunLanguage, type RunUpdate } from '../shared/run-console'
import { diagnosticPackIds } from '../shared/learning-packs'
import { entryName, fileText, isWithin, maxFileBytes, revision, workspaceRootLabel, WorkspaceFiles } from './files'
import { fileMutations } from './file-mutations'
import { readMarkdownImage, resolveMarkdownLink } from './markdown-assets'
import { installMenu } from './menu'
import { PreferenceStore } from './preferences'
import { quickOpenQuery, searchWorkspace } from './quick-open'
import { RecoveryStore } from './recovery'
import { EditorSessionStore } from './editor-session'
import { CRunner, rejectedRun, validStdin } from './runner'
import { configureWindowsProcessHelper } from './windows-process'
import type { InteractiveRunner, NativeProject } from './run-console'
import { createRunTrace, type RunTrace } from './run-console/trace'
import type { TerminalService } from './terminal/service'
import type { SourceControlService } from './source-control'
import type { SourceControlStatus } from '../shared/source-control'
import { fileLanguage, languageCapability } from '../shared/languages'
import { toolTextLimit, type ToolSnapshot } from '../shared/language-tools'
import { LanguageServiceManager, type LanguageServiceDescriptor } from './language-tools/manager'
import { workspaceSearchResultLimit } from '../shared/workspace-search'
import { ThemeStore } from './themes'
import type { ViewerService } from './viewers'
import type { ProjectLensSession } from './project-lens/session'
import type { ExplanationSession } from './explanations/session'
import type { ExplanationReview } from '../shared/explanations'
import type { ProviderVault } from './projects/provider'
import type { NotebookKernels } from './notebooks/kernel-service'
import type { DebugService } from './debug/service'
import { inputShortcut, resolveShortcuts, shortcutPlatform, type ShortcutOverrides } from '../shared/shortcuts'
import { copyAuthorizedPath, revealAuthorizedPath } from './path-actions'

app.setName('Ion IDE')
if (process.platform === 'win32') app.setAppUserModelId('dev.ionide.desktop')
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

const rendererRoot = resolve(__dirname, '../renderer')
const rendererURL = 'app://workbench/index.html'
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
}, {
  scheme: 'ion-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

function devServer(): URL | undefined {
  if (app.isPackaged || !process.env.ION_DEV_URL) return
  const url = new URL(process.env.ION_DEV_URL)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username
    || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ION_DEV_URL must be the root of a 127.0.0.1 HTTP development server.')
  }
  return url
}

const development = devServer()
const expectedURL = development?.href ?? rendererURL
const runner = new CRunner()
if (process.platform === 'win32') configureWindowsProcessHelper(nativeTool('ion-pty'))
const safeMutations = fileMutations(nativeTool('ion-file-ops'))
const workspaceFiles = () => new WorkspaceFiles(safeMutations, () => join(app.getPath('userData'), 'trash-staging'))
let files = workspaceFiles()
let preferences: PreferenceStore
let recovery: RecoveryStore
let editorSession: EditorSessionStore
let themeStore: ThemeStore
let initialized = false
let window: BrowserWindow | null = null
let openFullScreen = defaultSettings.openFullScreen
let smartLanguages = defaultSettings.smartLanguages
const languageServices = new LanguageServiceManager(async (descriptor: LanguageServiceDescriptor, signal: AbortSignal) => {
  if (descriptor.adapter === 'java') {
    const { JavaService } = await import('./java/service')
    return JavaService.start(descriptor.root, descriptor.path, signal)
  }
  if (descriptor.adapter === 'clangd') {
    const { ClangdService } = await import('./language-tools/clangd')
    return ClangdService.start(descriptor.root, descriptor.path, signal)
  }
  if (descriptor.adapter === 'python-lsp' || descriptor.adapter === 'typescript-lsp') {
    const { ExternalLspService } = await import('./language-tools/lsp-adapter')
    return ExternalLspService.start(descriptor.adapter, descriptor.root, descriptor.path, signal)
  }
  throw new Error('No language service adapter is available for this language.')
})
let formatJob: { id: string; controller: AbortController; done: Promise<FormatResult> } | undefined
let closeApproved = false
let closePending = false
let quitRequested = false
let updatePreparation: Promise<import('./update-install').PreparedUpdate> | undefined
let pendingUpdate: { prepared: import('./update-install').PreparedUpdate; complete(value: boolean): void } | undefined
let lastRendererRestart = -Infinity
interface ActiveRun {
  id: string
  owner: BrowserWindow
  controller: AbortController
  job: Promise<RunResult>
  engine?: InteractiveRunner
  size?: [number, number]
  trace?: RunTrace
}
let activeRun: ActiveRun | null = null
let interactiveRunner: InteractiveRunner | undefined
let terminalService: Promise<TerminalService> | undefined
let terminalFocused = false
let ignoreTerminalAccelerators = false
let webPreview: BrowserWindow | undefined
let webPreviewOpening = false
let practiceRun: { controller: AbortController; job?: Promise<unknown>; panel: OptionalPanel | null } | null = null
let resourceProfile = defaultSettings.resourceProfile
let panel: OptionalPanel | null = null
let projectPath: string | undefined
let panelGeneration = 0
let viewerService: Promise<ViewerService> | undefined
let notebookKernels: Promise<NotebookKernels> | undefined
let debugService: Promise<DebugService> | undefined
let debugCleanup = Promise.resolve()
let quickSearch: AbortController | undefined
let workspaceSearch: { id: string; controller: AbortController } | undefined
let workspaceReplace: { scope: WorkspaceFiles; service: import('./workspace-search').WorkspaceReplaceReview } | undefined
let languageEditReview: { scope: WorkspaceFiles; service: import('./language-tools/workspace-edit-review').LanguageWorkspaceEditReview } | undefined
const keyboardPlatform = shortcutPlatform(process.platform)
let shortcutOverrides: ShortcutOverrides = defaultSettings.shortcuts
let shortcutBindings = resolveShortcuts(shortcutOverrides, keyboardPlatform)
const trustedSources = new Map<string, string>()
let runTrust: Promise<import('./run-trust').RunTrustStore> | undefined
const getRunTrust = () => runTrust ??= import('./run-trust').then(({ RunTrustStore }) =>
  new RunTrustStore(join(app.getPath('userData'), 'run-trust.json')))
const earlyFiles: string[] = []

function nativeTool(name: string): string {
  const executable = process.platform === 'win32' ? name + '.exe' : name
  return app.isPackaged ? join(process.resourcesPath, executable) : resolve(__dirname, '../native', executable)
}

const ptyHelper = () => nativeTool('ion-pty')

function terminals(target: BrowserWindow): Promise<TerminalService> {
  return terminalService ??= import('./terminal/service').then(({ TerminalService }) => {
    if (target !== window) throw new Error('The terminal window has closed.')
    return new TerminalService(ptyHelper(), (event) => {
      if (target === window && !target.isDestroyed()) target.webContents.send('ion:terminal-event', event)
    })
  }).catch((error: unknown) => {
    if (target === window) terminalService = undefined
    throw error
  })
}

function terminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 512
}

function viewers(target: BrowserWindow): Promise<ViewerService> {
  return viewerService ??= import('./viewers').then(({ ViewerService }) => {
    if (target !== window) throw new Error('The document window has closed.')
    return new ViewerService(files)
  })
}

function kernelPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !isAbsolute(value)
    || value !== resolve(value) || !isNotebookName(value)) throw new Error('Open a local .ipynb notebook first.')
  return value
}

function kernels(target: BrowserWindow): Promise<NotebookKernels> {
  return notebookKernels ??= import('./notebooks/kernel-service').then(({ NotebookKernels }) => {
    if (target !== window) throw new Error('The notebook window has closed.')
    return new NotebookKernels((event) => {
      if (target === window && !target.isDestroyed()) target.webContents.send('ion:notebook-kernel-output', event)
    })
  })
}

function debuggerFor(target: BrowserWindow): Promise<DebugService> {
  return debugService ??= Promise.all([debugCleanup, import('./debug/service')]).then(([, { DebugService }]) => {
    if (target !== window) throw new Error('The debug window has closed.')
    return new DebugService((event) => {
      if (target === window && !target.isDestroyed()) target.webContents.send('ion:debug-event', event)
    })
  }).catch((error: unknown) => {
    if (target === window) debugService = undefined
    throw error
  })
}

function stopDebugTools(): Promise<void> {
  const active = debugService
  debugService = undefined
  if (!active) return debugCleanup
  const closing = active.then(service => service.dispose(), () => undefined)
  debugCleanup = Promise.all([debugCleanup, closing]).then(() => undefined, () => undefined)
  return closing
}

let projectHandlers: ReturnType<typeof import('./projects/ipc').createProjectHandlers> | undefined
let sharedProviderVault: Promise<ProviderVault> | undefined
function providerVault(): Promise<ProviderVault> {
  return sharedProviderVault ??= import('./provider-vault').then(({ createProviderVault }) => createProviderVault(app.getPath('userData')))
}
const projects = () => import('./projects/ipc').then(({ createProjectHandlers }) => projectHandlers ??= createProjectHandlers({
  profile: () => app.getPath('userData'),
  provider: providerVault,
  files: () => files,
  runner,
  isCurrent: (target) => target === window,
  isBusy: () => restoreClosing || activeRun !== null || practiceRun !== null,
  isFull: () => resourceProfile === 'full',
}))

async function activeProjects(target: BrowserWindow) {
  const handlers = await projects()
  if (target !== window) throw new Error('The project window has closed.')
  return handlers
}

let sourceControl: { root: string; service: Promise<SourceControlService>; operations: Set<Promise<unknown>> } | undefined
let sourceControlCleanup = Promise.resolve()
let trustedGitRoot: string | undefined

function sourceControlRoot(target: BrowserWindow, root: unknown): string {
  if (target !== window || typeof root !== 'string' || !files.rootPaths.includes(root)) throw new Error('Open the repository folder first.')
  return root
}

function closeSourceControl(): Promise<void> {
  const session = sourceControl
  sourceControl = undefined
  if (session) {
    const closing = session.service.then(async (service) => {
      service.close()
      await Promise.allSettled([...session.operations, service.drain()])
    }, () => {})
    sourceControlCleanup = Promise.all([sourceControlCleanup, closing]).then(() => {}, () => {})
  }
  return sourceControlCleanup
}

async function useSourceControl<T>(target: BrowserWindow, root: unknown,
  operation: (service: SourceControlService, path: string) => Promise<T>): Promise<T> {
  const path = sourceControlRoot(target, root)
  if (path !== trustedGitRoot) throw new Error('Review and trust the repository before using Git in Ion.')
  if (sourceControl && sourceControl.root !== path) void closeSourceControl()
  const session = sourceControl ??= {
    root: path, service: import('./source-control').then(({ SourceControlService }) => new SourceControlService()),
    operations: new Set(),
  }
  const [service] = await Promise.all([session.service, sourceControlCleanup])
  if (target !== window || sourceControl !== session || !files.rootPaths.includes(path)) throw new Error('The workspace changed.')
  const pending = operation(service, path)
  session.operations.add(pending)
  try {
    const result = await pending
    if (target !== window || sourceControl !== session || !files.rootPaths.includes(path)) throw new Error('The workspace changed.')
    return result
  } finally {
    session.operations.delete(pending)
  }
}

let learningService: InstanceType<typeof import('./learning').LearningService> | undefined
const learning = () => import('./learning').then(({ LearningService }) => learningService ??= new LearningService(
  join(app.getPath('userData'), 'learning.json'), join(__dirname, 'learning-packs'),
))

let packStore: InstanceType<typeof import('./learning/catalog-store').LearningPackStore> | undefined
let learningSelectionGeneration = 0
let learningLensEnabled: boolean = defaultSettings.learningLens
const learningPacks = () => import('./learning/catalog-store').then(({ LearningPackStore }) => packStore ??= new LearningPackStore(
  app.getPath('userData'), join(__dirname, 'learning-catalog'), app.getVersion(),
))

async function observesLearning(language: RunLanguage, generation: number, selection: number): Promise<boolean> {
  if ((language === 'c' && !learningLensEnabled) || panel !== 'learn'
    || generation !== panelGeneration || selection !== learningSelectionGeneration) return false
  const selected = await learningPacks().then((store) => store.isSelected(language)).catch(() => false)
  return selected && generation === panelGeneration && selection === learningSelectionGeneration
}

let practiceStore: InstanceType<typeof import('./practice').PracticeStore> | undefined
const practice = () => import('./practice').then(({ PracticeStore }) => practiceStore ??= new PracticeStore(
  join(app.getPath('userData'), 'practice'),
))

let projectLensService: Promise<ProjectLensSession> | undefined
async function projectLens(target: BrowserWindow) {
  const generation = panelGeneration
  if (target !== window || panel !== 'projects') throw new Error('Open Project Lens in Projects first.')
  const pending = projectLensService ??= import('./project-lens/session').then(({ ProjectLensSession }) => new ProjectLensSession(() => files))
  const service = await pending
  if (target !== window || panel !== 'projects' || generation !== panelGeneration) throw new Error('The Projects panel changed.')
  return service
}

interface ExplanationPaneLease {
  target: BrowserWindow
  scope: WorkspaceFiles
  root: string | null
  panel: 'learn' | 'projects'
  generation: number
  selection: number
}
let explanationPane: ExplanationPaneLease | undefined
let explanationService: { target: BrowserWindow; pending: Promise<ExplanationSession>; instance?: ExplanationSession } | undefined

function explanationBoundary(lease: ExplanationPaneLease): boolean {
  return lease.target === window && !lease.target.isDestroyed() && resourceProfile === 'full'
    && panel === lease.panel && panelGeneration === lease.generation && files === lease.scope
    && files.rootPath === lease.root && learningSelectionGeneration === lease.selection
}
function currentExplanationPane(lease: ExplanationPaneLease): boolean {
  return explanationPane === lease && explanationBoundary(lease)
}
function cancelExplanations(): void {
  explanationPane = undefined
  const service = explanationService
  if (service?.instance) service.instance.cancel()
  else void service?.pending.then(instance => instance.cancel(), () => undefined)
}
function requireExplanationPane(target: BrowserWindow): ExplanationPaneLease {
  const lease = explanationPane
  if (!lease || target !== lease.target || !currentExplanationPane(lease)) {
    cancelExplanations()
    throw new Error('Open the optional AI explanation pane in Full mode first.')
  }
  return lease
}
async function activateExplanationPane(target: BrowserWindow) {
  if (target !== window || resourceProfile !== 'full' || (panel !== 'learn' && panel !== 'projects')) {
    throw new Error('Online explanations are optional in Learn or Projects, in Full mode.')
  }
  if (!explanationPane || !currentExplanationPane(explanationPane)) {
    cancelExplanations()
    explanationPane = { target, scope: files, root: files.rootPath, panel, generation: panelGeneration, selection: learningSelectionGeneration }
  }
  const lease = explanationPane
  const vault = await providerVault()
  if (!currentExplanationPane(lease)) throw new Error('The AI explanation pane changed.')
  const settings = await vault.get()
  if (!currentExplanationPane(lease)) throw new Error('The AI explanation pane changed.')
  return settings
}
async function approveExplanation(target: BrowserWindow, review: ExplanationReview, signal: AbortSignal): Promise<boolean> {
  const lease = requireExplanationPane(target)
  const answer = await dialog.showMessageBox(target, {
    signal, type: 'question', buttons: ['Cancel', 'Send Reviewed Context'], cancelId: 0, defaultId: 0,
    message: 'Send this reviewed explanation request online?',
    detail: `Provider: ${review.provider.endpoint}\nModel: ${review.provider.model}\nPayload: ${review.bodyBytes} UTF-8 bytes\n\nReviewed sources:\n${review.sources.length
      ? review.sources.map(source => `${source.label} · lines ${source.startLine}–${source.endLine}`).join('\n') : '(question only)'}\n\nThe exact reviewed context and explanation instructions will be sent to this provider.`,
  })
  return answer.response === 1 && !signal.aborted && currentExplanationPane(lease)
}
async function explanations(target: BrowserWindow): Promise<ExplanationSession> {
  const lease = requireExplanationPane(target)
  let service = explanationService
  if (!service || service.target !== target) {
    const pending: Promise<ExplanationSession> = Promise.all([import('./explanations/session'), import('./explanations/context')]).then(([{ ExplanationSession }, { prepareContext }]) => {
      const instance = new ExplanationSession({ vault: providerVault,
        isCurrent: () => Boolean(explanationPane && explanationPane.target === target && currentExplanationPane(explanationPane)),
        approve: (review, signal) => approveExplanation(target, review, signal),
        context: async (request, signal) => {
          const lease = requireExplanationPane(target)
          if (!request || typeof request !== 'object' || !('purpose' in request)
            || request.purpose !== (lease.panel === 'learn' ? 'tutor' : 'project-lens')) throw new Error('Choose the current explanation context.')
          return prepareContext(request, signal, {
            scope: () => files, isCurrent: () => currentExplanationPane(lease),
            lesson: async (pack, topic) => {
              const store = await learningPacks()
              const selected = await store.getLibrary(false)
              if (!currentExplanationPane(lease) || selected.selected !== pack) throw new Error('Choose the currently selected lesson.')
              const lesson = await learningLesson(target, pack, topic)
              if (!currentExplanationPane(lease)) throw new Error('The lesson changed.')
              return lesson
            },
            lens: async root => (await projectLens(target)).lease(root),
          })
        },
      })
      if (explanationService?.pending === pending) explanationService.instance = instance
      return instance
    })
    service = { target, pending }
    explanationService = service
  }
  const instance = await service.pending
  if (!currentExplanationPane(lease)) throw new Error('The AI explanation pane changed.')
  return instance
}


async function withLearning<T>(operation: (service: NonNullable<typeof learningService>) => T | Promise<T>) {
  const service = await learning()
  try {
    return await operation(service)
  } finally {
    if (panel !== 'learn') void service.release().catch(() => undefined)
  }
}

async function learningLesson(target: BrowserWindow, id: unknown, topic: unknown) {
  const generation = panelGeneration
  if (target !== window || panel !== 'learn') throw new Error('Open the lesson in Learn first.')
  const lesson = await (await learningPacks()).getLesson(id, topic)
  if (target !== window || panel !== 'learn' || generation !== panelGeneration) throw new Error('The Learn panel changed.')
  return lesson
}

function releasePanel() {
  cancelExplanations()
  if (panel === 'projects') void projectLensService?.then(service => service.close(), () => undefined)
  if (practiceRun?.panel === panel) practiceRun.controller.abort()
  if (panel === 'learn') void learningService?.release().catch(() => undefined)
  if (panel === 'projects') projectHandlers?.close()
  if (panel === 'practice') {
    practiceRun?.controller.abort()
    practiceStore?.release()
  }
}

async function setOptionalPanel(target: BrowserWindow, mode: unknown, root: unknown) {
  if (mode !== null && mode !== 'learn' && mode !== 'projects' && mode !== 'practice') {
    throw new Error('Unknown workspace panel.')
  }
  if (root !== undefined && (mode !== 'projects' || typeof root !== 'string')) {
    throw new Error('Invalid project folder.')
  }
  if (panel !== mode || projectPath !== root) releasePanel()
  else cancelExplanations()
  const generation = ++panelGeneration
  panel = mode
  projectPath = root
  if (mode === 'projects' && root) {
    const handlers = await activeProjects(target)
    if (generation === panelGeneration) await handlers.setActive(target, root)
  }
}

function applyProfile(profile: typeof resourceProfile) {
  if (resourceProfile === profile) return
  resourceProfile = profile
  if (profile !== 'full') cancelExplanations()
  projectHandlers?.profileChanged()
}

async function onlineProjects(target: BrowserWindow) {
  if (resourceProfile !== 'full' || panel !== 'projects') {
    throw new Error('Open Projects in Full Mode to use the online planner.')
  }
  const handlers = await activeProjects(target)
  if (resourceProfile !== 'full' || panel !== 'projects') {
    throw new Error('The online planner has been deactivated.')
  }
  return handlers
}

function startupFailure(error: unknown): void {
  console.error('Unable to start Ion IDE.', error)
  const detail = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('Unable to start Ion IDE', detail)
  app.exit(1)
}

async function registerSession(): Promise<void> {
  const appSession = session.defaultSession
  // Presentation uses the gesture-gated HTML fullscreen API. Restrict it to
  // the same top-level workbench that owns the document preview.
  const fullscreenOrigin = development?.origin ?? 'app://workbench'
  appSession.setPermissionRequestHandler((contents, permission, approve, details) => {
    approve(permission === 'fullscreen' && contents === window?.webContents
      && details.isMainFrame && details.requestingUrl === expectedURL)
  })
  appSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    permission === 'fullscreen' && contents === window?.webContents && details.isMainFrame
      && (details.requestingUrl === expectedURL || (details.requestingUrl === undefined && origin === fullscreenOrigin)))
  appSession.webRequest.onBeforeRequest((details, callback) => {
    const target = new URL(details.url)
    const network = ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)
    const devAsset = development && target.host === development.host
      && (target.protocol === 'http:' || target.protocol === 'ws:')
    callback({ cancel: network && !devAsset })
  })

  if (development) return
  const root = await realpath(rendererRoot)
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'workbench' || url.username || url.password || request.method !== 'GET') {
        return new Response(null, { status: 403 })
      }
      const pathname = decodeURIComponent(url.pathname)
      const path = resolve(root, '.' + pathname)
      if (path === root || !isWithin(root, path) || await realpath(path) !== path) {
        return new Response(null, { status: 403 })
      }
      const response = await net.fetch(pathToFileURL(path).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', csp)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

function sendCommand(command: MenuCommand): void {
  const target = window ?? createWindow()
  const send = () => {
    if (!target.isDestroyed()) target.webContents.send('ion:command', command)
  }
  if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', send)
  else send()
}

function applyShortcuts(overrides: ShortcutOverrides) {
  if (shortcutOverrides === overrides) return
  if (JSON.stringify(shortcutOverrides) !== JSON.stringify(overrides)) {
    shortcutBindings = resolveShortcuts(overrides, keyboardPlatform)
    installMenu(sendCommand, overrides)
  }
  shortcutOverrides = overrides
}

let systemFileRequested = false

function formatDocument(target: BrowserWindow, value: unknown): Promise<FormatResult> {
  const request = value as Partial<FormatRequest> | null
  if (!request || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id)
    || typeof request.name !== 'string' || request.name.length > 255 || basename(request.name) !== request.name
    || request.name.includes('\0') || typeof request.text !== 'string'
    || (request.eol !== '\n' && request.eol !== '\r\n') || typeof request.insertSpaces !== 'boolean'
    || typeof request.tabSize !== 'number' || !Number.isInteger(request.tabSize) || request.tabSize < 1 || request.tabSize > 32
    || (request.path !== null && (typeof request.path !== 'string' || typeof request.revision !== 'string' || request.revision.length > 256))) {
    return Promise.resolve({ kind: 'error', message: 'Invalid document formatting request.' })
  }
  try { fileText(request.text, maxEditableTextBytes) }
  catch { return Promise.resolve({ kind: 'error', message: 'Formatting requires valid UTF-8 source up to 2 MiB.' }) }
  if (formatJob) return Promise.resolve({ kind: 'error', message: 'Formatting is already in progress.' })
  const snapshot = request as FormatRequest
  const controller = new AbortController()
  const { signal } = controller
  const scope = files
  let root: string | null = null
  const current = () => target === window && scope === files && (!root || scope.rootPaths.includes(root)) && !signal.aborted
  const cancelled: FormatResult = { kind: 'cancelled', message: 'Formatting cancelled.' }
  const conflict: FormatResult = { kind: 'conflict', message: 'File changed on disk. Review the conflict before formatting.' }
  const done = (async (): Promise<FormatResult> => {
    if (snapshot.path !== null) {
      const { path, stats } = await scope.inspect(snapshot.path, 'file')
      if (revision(stats) !== snapshot.revision) return conflict
      if (stats.size > BigInt(maxEditableTextBytes)) return { kind: 'error', message: 'This file is read only in Ion.' }
      root = scope.rootFor(path)
      snapshot.path = path
      snapshot.name = basename(path)
    }
    if (!current()) return cancelled
    if (documentFormat(snapshot.name) || isNotebookName(snapshot.name)) {
      return { kind: 'error', message: 'Format is available for editable source files.' }
    }
    const [{ formatSource }, { settings }] = await Promise.all([import('./format/service'), preferences.get()])
    const result = await formatSource(snapshot, root, settings, signal)
    if (!current()) return cancelled
    if (snapshot.path && (result.kind === 'formatted' || result.kind === 'unchanged')) {
      const latest = await scope.inspect(snapshot.path, 'file').catch(() => undefined)
      if (!current()) return cancelled
      if (!latest || revision(latest.stats) !== snapshot.revision) return conflict
    }
    return result
  })().catch((error: unknown): FormatResult => signal.aborted ? cancelled : ({
    kind: 'error', message: error instanceof Error ? error.message.slice(0, 300) : 'Could not format the document.',
  })).finally(() => { if (formatJob?.controller === controller) formatJob = undefined })
  formatJob = { id: snapshot.id, controller, done }
  return done
}

async function stopLanguageTools() {
  await languageServices.stopAll()
}

async function queryLanguage(target: BrowserWindow, value: unknown) {
  const snapshot = value as Partial<ToolSnapshot> | null
  const language = typeof snapshot?.language === 'string' ? languageCapability(snapshot.language) : undefined
  const semantic = language?.semantic
  if (!snapshot || !language || !semantic || !smartLanguages.includes(language.id)) return null
  if (typeof snapshot.path !== 'string' || fileLanguage(snapshot.path).id !== language.id
    || typeof snapshot.text !== 'string' || Buffer.byteLength(snapshot.text) > toolTextLimit || snapshot.text.includes('\0')
    || typeof snapshot.version !== 'number' || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1
    || (snapshot.requestId !== undefined && (typeof snapshot.requestId !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(snapshot.requestId)))
    || typeof snapshot.offset !== 'number' || !Number.isSafeInteger(snapshot.offset)
    || snapshot.offset < 0 || snapshot.offset > snapshot.text.length
    || (snapshot.operation === 'rename' && (typeof snapshot.replacement !== 'string' || snapshot.replacement.length > 200
      || !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(snapshot.replacement)))
    || (snapshot.operation === 'workspaceSymbols' && (typeof snapshot.search !== 'string' || snapshot.search.length > 200
      || /[\0\r\n]/.test(snapshot.search)))
    || !snapshot.operation || !semantic.operations.includes(snapshot.operation)) {
    throw new Error('Invalid language analysis request.')
  }
  const scope = files
  const { path } = await scope.inspect(snapshot.path, 'file')
  const root = scope.rootFor(path)
  if (target !== window || files !== scope || (root ? !scope.rootPaths.includes(root) : !scope.authorizes(path)) || !smartLanguages.includes(language.id)
    ) return null
  try {
    const reply = await languageServices.query({ adapter: semantic.adapter, language: language.id, root, path }, { ...snapshot, path } as ToolSnapshot)
    if ((root ? !scope.rootPaths.includes(root) : !scope.authorizes(path)) || target !== window || files !== scope) return null
    if (reply && (snapshot.operation === 'definition' || snapshot.operation === 'declaration' || snapshot.operation === 'references')) {
      const locations = await Promise.all(reply.rows.map(async ([file, line, column]) => {
        if (file === path) return [file, line, column]
        if (!root || !isWithin(root, file)) return null
        return scope.inspect(file, 'file').then(({ path }) => [path, line, column], () => null)
      }))
      reply.rows = locations.filter((location) => location !== null)
    }
    if (reply && (snapshot.operation === 'documentSymbols' || snapshot.operation === 'workspaceSymbols')) {
      const symbols = await Promise.all(reply.rows.map(async row => {
        const file = row[3]
        if (file === path) return row
        if (!root || !isWithin(root, file)) return null
        return scope.inspect(file, 'file').then(({ path }) => [...row.slice(0, 3), path, ...row.slice(4)], () => null)
      }))
      reply.rows = symbols.filter((row) => row !== null)
    }
    return reply
  } catch (error) {
    throw error
  }
}

async function reviewLanguageRename(target: BrowserWindow, value: unknown, replacement: unknown, dirtyPaths: unknown) {
  if (typeof replacement !== 'string' || !Array.isArray(dirtyPaths) || dirtyPaths.length > 64
    || dirtyPaths.some(path => typeof path !== 'string')) throw new Error('Invalid language-server rename review.')
  const snapshot = { ...(value as object), operation: 'rename', replacement }
  const scope = files
  const reply = await queryLanguage(target, snapshot)
  if (!reply || target !== window || scope !== files) throw new Error('The workspace changed during rename review.')
  const { LanguageWorkspaceEditReview } = await import('./language-tools/workspace-edit-review')
  const service = new LanguageWorkspaceEditReview(scope)
  const review = await service.review(reply.rows, dirtyPaths)
  if (target !== window || scope !== files) throw new Error('The workspace changed during rename review.')
  languageEditReview?.service.clear()
  languageEditReview = { scope, service }
  return review
}

function createWindow(): BrowserWindow {
  closeApproved = false
  closePending = false
  let restartAfterCrash = false
  const firstLaunch = preferences.takeFirstLaunch() && !systemFileRequested
  const target = new BrowserWindow({
    width: 1260,
    height: 790,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101117',
    show: false,
    ...(openFullScreen ? { fullscreen: true } : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.cjs'),
      ...(firstLaunch ? { additionalArguments: ['--ion-first-launch'] } : {}),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  })
  window = target
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  target.webContents.on('will-navigate', (event) => event.preventDefault())
  target.webContents.on('will-attach-webview', (event) => event.preventDefault())
  target.webContents.on('before-input-event', (event, input) => {
    const shellControl = terminalFocused && input.control && !input.meta && !input.alt && !input.shift
    const terminalEdit = terminalFocused && keyboardPlatform === 'darwin' && input.meta
      && !input.control && !input.alt && !input.shift && /^[cfv]$/i.test(input.key)
    const ignoreMenu = terminalEdit || (shellControl && keyboardPlatform !== 'darwin')
    if (ignoreTerminalAccelerators !== ignoreMenu) {
      ignoreTerminalAccelerators = ignoreMenu
      target.webContents.setIgnoreMenuShortcuts(ignoreMenu)
    }
    if (input.isComposing || shellControl || terminalEdit) return
    const command = shortcutBindings.get(inputShortcut(input, keyboardPlatform))
    if (!command) return
    event.preventDefault()
    if (input.type === 'keyDown' && !input.isAutoRepeat) sendCommand(command)
  })
  target.once('ready-to-show', () => target.show())
  target.webContents.on('render-process-gone', (_event, { reason }) => {
    if (target !== window || target.isDestroyed() || reason === 'clean-exit') return
    // Release this renderer's capabilities and resources through the normal
    // close path. Limit automatic replacement if a crash immediately recurs.
    if (!quitRequested && performance.now() - lastRendererRestart >= 30_000) {
      lastRendererRestart = performance.now()
      restartAfterCrash = true
    }
    target.destroy()
  })
  target.on('close', (event) => {
    if (closeApproved || target.webContents.isCrashed() || target.webContents.isLoadingMainFrame()) return
    event.preventDefault()
    if (closePending) return
    closePending = true
    target.webContents.send('ion:close-request')
  })
  target.on('closed', () => {
    const closingBackup = backupService
    backupService = undefined
    quickSearch?.abort()
    quickSearch = undefined
    workspaceSearch?.controller.abort()
    workspaceSearch = undefined
    if (webPreview && !webPreview.isDestroyed()) webPreview.destroy()
    webPreview = undefined
    const interactive = activeRun?.owner === target ? activeRun : null
    interactive?.controller.abort()
    const formatting = formatJob
    formatting?.controller.abort()
    const fileCleanup = files.drain()
    window = null
    files = workspaceFiles()
    trustedSources.clear()
    trustedGitRoot = undefined
    releasePanel()
    const explanationCleanup = explanationService?.target === target
      ? explanationService.pending.then(service => service.drain()) : undefined
    if (panel !== 'projects') projectHandlers?.close()
    if (panel !== 'practice') practiceRun?.controller.abort()
    panel = null
    projectPath = undefined
    panelGeneration++
    const previewCleanup = viewerService?.then((service) => service.dispose(), () => undefined)
    viewerService = undefined
    const kernelCleanup = notebookKernels?.then((service) => service.dispose(), () => undefined)
    notebookKernels = undefined
    const terminalCleanup = terminalService?.then((service) => service.closeAll())
    terminalService = undefined
    terminalFocused = false
    ignoreTerminalAccelerators = false
    // A failed process cleanup must not skip another owner's pending file or
    // recovery publication. Wait for every owner before choosing what follows.
    const cleanup = Promise.allSettled([runner.drain(), fileCleanup, drainAcceptedRequests().then(drainProfileWrites), previewCleanup, kernelCleanup, terminalCleanup, stopLanguageTools(), stopDebugTools(),
      closeSourceControl(), projectHandlers?.stopSuite(), interactive?.job,
      practiceRun?.job?.catch(() => undefined), formatting?.done,
      updatePreparation?.catch(() => undefined), runTrust?.then((store) => store.drain()), explanationCleanup, pendingRestore ? undefined : closingBackup?.then(s => s.cancel())])
    void cleanup.then(async (results) => {
      await drainProfileWrites()
      const failed = results.some((result) => result.status === 'rejected')
      if (failed) {
        console.warn('Ion IDE cleanup could not be fully verified. Automatic restart and update installation were canceled.')
        const update = pendingUpdate
        pendingUpdate = undefined
        if (update) {
          try { await update.prepared.dispose() }
          catch { console.warn('Could not remove unused update staging. The installed app is unchanged.') }
          update.complete(false)
        }
        // Preserve the explicit failure instead of starting more work on top of
        // unverified resources. All persistence owners have now settled.
        const restore = pendingRestore; pendingRestore = undefined
        if (restore) await restore.service.cancel()
        quitRequested = true
        app.quit()
        return
      }
      if (window) return
      if (pendingRestore) {
        const restore = pendingRestore; pendingRestore = undefined
        try {
          if (!closeApproved || !quitRequested) throw new Error('Restore restart was not confirmed.')
          await restore.service.finalize(restore.token)
          app.relaunch(); app.quit(); return
        } catch (error) {
          if (restore.service.restartRequired) { app.relaunch(); app.quit(); return }
          restoreClosing = false; quitRequested = false; closeApproved = false; await restore.service.cancel()
          createWindow()
          void dialog.showMessageBox(window!, { type: 'error', message: 'Restore was not applied', detail: error instanceof Error ? error.message : 'Your existing profile is unchanged.' })
          return
        }
      }
      if (restartAfterCrash) {
        if (!quitRequested) createWindow()
      } else if (quitRequested || resourceProfile === 'minimal' || process.platform !== 'darwin') {
        const update = pendingUpdate
        pendingUpdate = undefined
        if (update) {
          try {
            if (!closeApproved || !quitRequested) throw new Error('Update installation was canceled.')
            await update.prepared.start()
            update.complete(true)
          } catch (reason) {
            await update.prepared.dispose().catch(() => console.warn('Could not remove unused update staging. The installed app is unchanged.'))
            update.complete(false)
            quitRequested = false
            createWindow()
            // An explicit failed install is actionable, not a background popup.
            void dialog.showMessageBox(window!, { type: 'error', message: 'Ion IDE was not updated',
              detail: reason instanceof Error ? reason.message : 'The original installation is unchanged.' })
            return
          }
        }
        app.quit()
      }
    }).catch(() => {
      console.warn('Ion IDE could not finish its shutdown continuation. Automatic restart was canceled.')
      quitRequested = true
      app.quit()
    })
  })
  void target.loadURL(expectedURL).catch((error: unknown) => {
    if (!target.isDestroyed()) startupFailure(error)
  })
  return target
}

function owner(event: IpcMainInvokeEvent): BrowserWindow {
  const frame = event.senderFrame
  if (!window || event.sender !== window.webContents || !frame || frame !== event.sender.mainFrame || frame.url !== expectedURL) {
    throw new Error('Invalid desktop request origin.')
  }
  return window
}

function cancelledRun(): RunResult {
  return { ...rejectedRun('Run stopped.'), status: 'cancelled' }
}

async function approveRunSource(
  target: BrowserWindow, scope: WorkspaceFiles, path: string, token: string, build?: 'maven' | 'gradle',
  signal?: AbortSignal, nativeProject?: NativeProject,
): Promise<string | undefined> {
  if (signal?.aborted || target !== window || target.isDestroyed()) return 'Run was not approved.'
  const root = scope.rootFor(path)
  const folder = !nativeProject && !build && root
    ? await (await getRunTrust()).snapshot(root) : undefined
  const remembered = folder && await (await getRunTrust()).trusted(folder)
  if (signal?.aborted || target !== window || target.isDestroyed() || scope !== files || root && !scope.rootPaths.includes(root)) return 'Run was not approved.'
  if (nativeProject || build || (!remembered && trustedSources.get(path) !== token)) {
    const tool = build === 'maven' ? 'Maven' : 'Gradle'
    const nativeSources = nativeProject?.sources.slice(0, 8).map((source) => relative(root ?? dirname(path), source))
    const nativeDetail = nativeProject && nativeSources
      ? `Ion will compile the saved files listed in .ion/build.json and run the result with your permissions. Review the source before continuing.\n\n${nativeSources.join('\n')}${
        nativeProject.sources.length > nativeSources.length ? `\n…and ${nativeProject.sources.length - nativeSources.length} more.` : ''}`
      : undefined
    const choice = await dialog.showMessageBox(target, {
      signal,
      type: 'warning', buttons: ['Cancel', nativeProject ? 'Run C/C++ Build' : build ? `Run ${tool} Build` : 'Run Program'],
      defaultId: 0, cancelId: 0,
      ...(folder ? { checkboxLabel: 'Trust this folder for future single-file Runs', checkboxChecked: false } : {}),
      message: nativeProject ? 'Compile and run this C/C++ project?'
        : build ? `Run this project’s ${tool} build?` : 'Run ' + basename(path) + '?',
      detail: (nativeDetail ?? (build
        ? `${tool} will use its local cache. Project build scripts, plugins, and the program can run code with your user account’s permissions. Review this project before continuing.`
        : 'Only run code you trust. Programs run with your user account’s permissions and can access files and the network. Time and output limits apply. Programs run outside a security sandbox.'))
        + '\n\n' + path + (folder ? '\n\nOptional folder trust: ' + folder.path
          + '\nRemembering this folder permits future single-file Runs after edits and restarts. Builds and tests keep their separate approval. Revoke it in Preferences → Run Console.' : ''),
    })
    if (choice.response !== 1 || signal?.aborted || target.isDestroyed() || target !== window) return 'Run was not approved.'
    if (revision((await scope.inspect(path, 'file')).stats) !== token) {
      return 'The source changed while awaiting approval. Review it and run again.'
    }
    if (folder && choice.checkboxChecked) {
      if (scope !== files || !root || !scope.rootPaths.includes(root)) return 'The workspace changed while awaiting approval.'
      await (await getRunTrust()).remember(folder)
    }
  }
  if (signal?.aborted || target !== window || target.isDestroyed()) return 'Run was not approved.'
  if (nativeProject) return
  trustedSources.delete(path)
  trustedSources.set(path, token)
  if (trustedSources.size > 64) {
    const oldest = trustedSources.keys().next().value
    if (oldest) trustedSources.delete(oldest)
  }
}

function startInteractive(target: BrowserWindow, id: string, value: unknown, learn: boolean, expectedRevision: unknown): Promise<RunResult> {
  const trace = createRunTrace(id)
  trace?.('request', 'received')
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !expectedRevision.length || expectedRevision.length > 256)) {
    trace?.('request', 'rejected-before-engine', 'revision')
    return Promise.resolve(rejectedRun('Invalid source revision.'))
  }
  if (runner.busy || practiceRun || activeRun || projectHandlers?.busy) {
    trace?.('request', 'rejected-before-engine', 'busy')
    return Promise.resolve(rejectedRun('A program or test is already running.'))
  }
  const controller = new AbortController()
  const record: ActiveRun = {
    id, owner: target, controller, job: Promise.resolve(cancelledRun()), trace,
  }
  activeRun = record
  record.job = runInteractive(record, value, learn, expectedRevision).finally(() => {
    if (activeRun === record) activeRun = null
  })
  return record.job
}

async function runInteractive(record: ActiveRun, value: unknown, learn: boolean, expectedRevision?: string): Promise<RunResult> {
  const { owner: target, id, controller: { signal } } = record
  // Reuse the request's original clock and correlation ID through execution.
  const trace = record.trace
  trace?.('request', 'begin')
  const onAbort = trace ? () => trace('cancellation', 'requested') : undefined
  if (onAbort) signal.addEventListener('abort', onAbort, { once: true })
  const scope = files
  const workspaceRoots = [...scope.rootPaths]
  let scratch: string | undefined
  let sourceHash: string | undefined
  let nativeProject: NativeProject | undefined
  let runtimeExcerpt = ''
  const emit = (update: RunUpdate) => {
    if (update.kind === 'phase') trace?.('renderer-phase', update.phase)
    else if (update.kind === 'data') trace?.('forward-output', update.stream, update.text.length)
    if (sourceHash && update.kind === 'data' && update.stream === 'terminal') {
      runtimeExcerpt = (runtimeExcerpt + update.text).slice(-8192)
    }
    if (target === window && !target.isDestroyed()) {
      // This timestamps enqueueing in main, not delivery or terminal paint.
      // The disposable renderer observer supplies those separate boundaries.
      trace?.('run-console-ipc', 'send-start', update.kind)
      target.webContents.send('ion:live-run-update', { id, update })
      trace?.('run-console-ipc', 'send-return', update.kind)
    }
  }
  try {
    trace?.('source-inspection', 'begin')
    const { path, stats } = await scope.inspect(value, 'file')
    const workspaceRoot = scope.rootFor(path)
    trace?.('source-inspection', 'end')
    if (!runLanguage(path)) return rejectedRun('Open a saved C, C++, Java, Python, or JavaScript file to run.')
    if (stats.size > BigInt(maxFileBytes)) return rejectedRun('The source exceeds the 2 MiB file limit.')
    const token = revision(stats)
    if (expectedRevision !== undefined && expectedRevision !== token) {
      return { ...rejectedRun('The source changed on disk. Reload it before running.'), sourceChanged: true }
    }
    const stillCurrent = async () => {
      trace?.('source-validation', 'begin')
      try {
        const current = await scope.inspect(path, 'file').catch(() => undefined)
        if (target !== window || signal.aborted || workspaceRoots.length !== scope.rootPaths.length
          || workspaceRoots.some((root, index) => scope.rootPaths[index] !== root) || !current || revision(current.stats) !== token) return false
        if (!nativeProject) return true
        const checks = await Promise.all([
          ...nativeProject.inputs.filter((input) => input.path !== path).map(async (input) => {
            const file = await scope.inspect(input.path, 'file').catch(() => undefined)
            return !!file && revision(file.stats) === input.revision
          }),
          ...nativeProject.includeDirectories.map((directory) => scope.inspect(directory, 'folder').then(() => true, () => false)),
        ])
        return target === window && !signal.aborted && workspaceRoots.length === scope.rootPaths.length
          && workspaceRoots.every((root, index) => scope.rootPaths[index] === root) && checks.every(Boolean)
      } finally { trace?.('source-validation', 'end') }
    }
    emit({ kind: 'phase', phase: 'preparing' })
    signal.throwIfAborted()
    trace?.('run-module', 'begin')
    const module = await import('./run-console')
    trace?.('run-module', 'end')
    trace?.('scratch-create', 'begin')
    scratch = await mkdtemp(join(await realpath(tmpdir()), 'ion-live-run-'))
    trace?.('scratch-create', 'end')
    const root = workspaceRoot
    let plan: Awaited<ReturnType<typeof module.prepareRun>>
    try {
      trace?.('project-discovery', 'begin')
      if (root) nativeProject = await module.readNativeProject(scope, root, path)
      trace?.('project-discovery', 'end')
      plan = await module.prepareRun({ path, root, scratch, signal, nativeProject, trace })
    } catch (error) {
      if (error instanceof module.MissingToolchainError) return { ...rejectedRun(error.message), status: 'missing-toolchain' }
      throw error
    }
    if (!await stillCurrent()) return signal.aborted ? cancelledRun() : rejectedRun('The source or workspace changed before the run.')
    trace?.('authorization', 'begin')
    const denied = await approveRunSource(target, scope, path, token, plan.build, signal, nativeProject)
    trace?.('authorization', 'end', !denied)
    if (signal.aborted) return cancelledRun()
    if (denied) return rejectedRun(denied)
    if (!await stillCurrent()) return rejectedRun('The source or workspace changed before the run.')
    const generation = panelGeneration
    const selection = learningSelectionGeneration
    if (!nativeProject && learn && await observesLearning(plan.language, generation, selection)) {
      const source = await scope.read(path).catch(() => undefined)
      if (source?.revision === token) sourceHash = createHash('sha256').update(source.text).digest('hex')
    }
    const engine = interactiveRunner ??= new module.InteractiveRunner(ptyHelper())
    record.engine = engine
    const job = engine.run(plan, emit, signal, stillCurrent, trace)
    if (record.size) engine.resize(...record.size)
    const result = await job
    trace?.('engine-result', 'received', result.status)
    const hasCompilerReport = Boolean(result.compileOutput || result.status === 'compile-error')
    const current = (sourceHash || hasCompilerReport) && await stillCurrent()
    if (sourceHash && current && await observesLearning(plan.language, generation, selection)) {
      try {
        const service = await learning()
        if (generation === panelGeneration && selection === learningSelectionGeneration) {
          result.learning = await service.observe({
            path, sourceHash, language: plan.language, result: { ...result, programOutput: runtimeExcerpt },
            readSource: async () => {
              const source = await scope.read(path).catch(() => undefined)
              return source?.revision === token ? source.text : undefined
            },
          })
        }
      } catch { /* Compiler output remains available if learning storage fails. */ }
    }
    const problems = hasCompilerReport ? result.learning?.diagnostics.filter(({ phase }) => phase === 'compile')
      ?? (await import('./learning')).compilerProblems(result, plan.language) : undefined
    trace?.('request', 'result', result.status)
    return { ...result, compileOutput: '', problems, sourceRevision: current ? token : undefined }
  } catch (error) {
    trace?.('request', 'error', signal.aborted ? 'cancelled' : 'rejected')
    return signal.aborted ? cancelledRun() : rejectedRun(error instanceof Error ? error.message : 'Unable to start the run.')
  } finally {
    trace?.('scratch-cleanup', 'begin')
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    trace?.('scratch-cleanup', 'end')
    if (onAbort) signal.removeEventListener('abort', onAbort)
    trace?.('request', 'end')
  }
}

async function runPracticeSamples(
  target: BrowserWindow, value: string, inputs: readonly string[], expectedRevision: string, signal: AbortSignal,
): Promise<RunResult[]> {
  if (signal.aborted) return [cancelledRun()]
  try {
    const scope = files
    const { path, stats } = await scope.inspect(value, 'file')
    const language = runLanguage(path)
    if (!language) return [rejectedRun('Open a saved C, C++, Java, Python, or JavaScript file to run samples.')]
    if (stats.size > BigInt(maxFileBytes)) return [rejectedRun('The source exceeds the 2 MiB file limit.')]
    if (target !== window) return [rejectedRun('The window closed before the run could start.')]
    const sourceRevision = revision(stats)
    if (sourceRevision !== expectedRevision) return [rejectedRun('The source changed during the sample run.')]
    const denied = await approveRunSource(target, scope, path, sourceRevision, undefined, signal)
    if (signal.aborted) return [cancelledRun()]
    if (denied) return [rejectedRun(denied)]
    const source = await scope.read(path)
    if (source.revision !== sourceRevision) return [rejectedRun('The source changed before the sample run.')]
    const stillCurrent = async () => {
      const current = await scope.inspect(path, 'file').catch(() => undefined)
      return target === window && !target.isDestroyed() && current !== undefined && revision(current.stats) === sourceRevision
    }
    if (language === 'c') return await runner.runSamples(path, inputs, stillCurrent, signal, source.text)
    const { runPracticeBatch } = await import('./run-console')
    return await runPracticeBatch(path, source.text, inputs, stillCurrent, signal)
  } catch (error) {
    return [signal.aborted ? cancelledRun() : rejectedRun(error instanceof Error ? error.message : 'Unable to start the run.')]
  }
}

let backupService: Promise<import('./backup/service').BackupService> | undefined
let pendingRestore: { token: string; service: import('./backup/service').BackupService } | undefined
let restoreClosing = false
const acceptedRequests = new Set<Promise<unknown>>()
async function drainAcceptedRequests() {
  while (acceptedRequests.size) await Promise.allSettled([...acceptedRequests])
}
function backup(target: BrowserWindow) {
  return backupService ??= import('./backup/service').then(async ({ BackupService }) => new BackupService({
    profile: await realpath(app.getPath('userData')), appVersion: app.getVersion(),
    progress: value => { if (window === target && !target.isDestroyed()) target.webContents.send('ion:backup-progress', value) },
  }))
}
async function drainProfileWrites() {
  await Promise.all([preferences.drain(), recovery.drain(), editorSession.drain(), themeStore.drain(),
    learningService?.drain(), packStore?.drain(), practiceStore?.drain(), projectHandlers?.drain()])
}
async function requireStoppedTools() {
  const debugging = await debugService?.then(service => service.status(), () => null)
  if (runner.busy || practiceRun || activeRun || projectHandlers?.busy || formatJob || updatePreparation || pendingUpdate
    || debugging || await terminalService?.then(s => s.hasSessions) || await notebookKernels?.then(s => s.hasSessions)) {
    throw new Error('Stop running programs, tests, debugger sessions, notebook kernels and terminal sessions before restoring. Your work is unchanged.')
  }
}

function validDebugSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
}

async function startDebugSession(target: BrowserWindow, value: unknown): Promise<DebugSession> {
  const request = value as Partial<DebugStartRequest> | null
  if (!request || typeof request.sourcePath !== 'string' || !isAbsolute(request.sourcePath)
    || (request.language !== 'c' && request.language !== 'cpp')
    || !validDebugDocumentVersion(request.version)
    || typeof request.expectedRevision !== 'string' || request.expectedRevision.length < 1 || request.expectedRevision.length > 256
    || typeof request.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedContentHash)
    || !Array.isArray(request.breakpoints) || request.breakpoints.length > debugLimits.breakpoints) {
    throw new Error('Invalid debug request.')
  }
  for (const breakpoint of request.breakpoints) {
    if (!breakpoint || typeof breakpoint.path !== 'string' || breakpoint.path !== request.sourcePath
      || !Number.isSafeInteger(breakpoint.line) || breakpoint.line < 1 || breakpoint.line > 10_000_000
      || breakpoint.column !== undefined && (!Number.isSafeInteger(breakpoint.column) || breakpoint.column < 1 || breakpoint.column > 10_000)
      || breakpoint.condition !== undefined && (typeof breakpoint.condition !== 'string' || Buffer.byteLength(breakpoint.condition) > debugLimits.expressionBytes)
      || breakpoint.hitCondition !== undefined && (typeof breakpoint.hitCondition !== 'string' || Buffer.byteLength(breakpoint.hitCondition) > 256)
      || breakpoint.logMessage !== undefined && (typeof breakpoint.logMessage !== 'string' || Buffer.byteLength(breakpoint.logMessage) > debugLimits.expressionBytes)) {
      throw new Error('Invalid debug breakpoint.')
    }
  }
  if (runner.busy || practiceRun || activeRun || projectHandlers?.busy) {
    throw new Error('Stop the current program or test before starting the debugger.')
  }
  if (await debugService?.then(service => service.status(), () => null)) throw new Error('A debugger session is already active.')
  const scope = files
  const roots = [...scope.rootPaths]
  const inspected = await scope.inspect(request.sourcePath, 'file')
  const path = inspected.path
  const language = fileLanguage(path).id
  if (language !== request.language || language !== 'c' && language !== 'cpp') throw new Error('Open a saved C or C++ source file to debug it.')
  if (inspected.stats.size > BigInt(maxFileBytes)) throw new Error('The source exceeds the 2 MiB file limit.')
  if (revision(inspected.stats) !== request.expectedRevision) throw new Error('The source changed on disk. Save or reload it before debugging.')
  const root = scope.rootFor(path) ?? dirname(path)
  const controller = new AbortController()
  const abort = () => controller.abort()
  target.once('closed', abort)
  try {
    const choice = await dialog.showMessageBox(target, {
      signal: controller.signal, type: 'warning', buttons: ['Cancel', 'Start Debugging'], defaultId: 0, cancelId: 0,
      message: `Debug ${basename(path)}?`,
      detail: `Ion will compile this saved ${request.language === 'cpp' ? 'C++' : 'C'} file with debug symbols, then launch the Ion-created executable through a trusted local debugger. The program runs with your user account permissions and can access files and the network.\n\n${path}`,
    })
    if (choice.response !== 1 || controller.signal.aborted || target !== window || scope !== files) throw new Error('Debugging was not approved.')
    const current = await scope.inspect(path, 'file')
    if (revision(current.stats) !== request.expectedRevision || roots.length !== scope.rootPaths.length
      || roots.some((entry, index) => entry !== scope.rootPaths[index])) {
      throw new Error('The source or workspace changed while awaiting approval. Review it and start again.')
    }
    const service = await debuggerFor(target)
    if (controller.signal.aborted || target !== window || scope !== files) throw new Error('The debug window closed.')
    return await service.start({ ...request as DebugStartRequest, sourcePath: path,
      breakpoints: request.breakpoints.map(breakpoint => ({ ...breakpoint, path })) }, root, controller.signal)
  } finally {
    target.removeListener('closed', abort)
  }
}

function registerIpc(): void {
  const handle = <T>(channel: string, operation: (target: BrowserWindow, ...args: unknown[]) => T) => {
    ipcMain.handle('ion:' + channel, (event, ...args: unknown[]) => {
      const target = owner(event)
      if (restoreClosing && !['confirm-window-close', 'recovery-write', 'recovery-remove', 'editor-session-save', 'save-file', 'save-file-as', 'get-preferences'].includes(channel)) {
        throw new Error('Restore is waiting for the save, keep-drafts or cancel decision.')
      }
      const request = Promise.resolve(operation(target, ...args))
      const writesProfile = /^(?:update-settings|editor-session-save|recovery-(?:write|remove)|themes-(?:import|create)|open-|workspace-|quick-open-file|markdown-open-link|save-file|rename-entry|trash-entry|learning-|practice-|projects-(?:save|approve|run|automatic)|set-optional-panel)/.test(channel)
      if (!writesProfile) return request
      acceptedRequests.add(request)
      void request.then(() => acceptedRequests.delete(request), () => acceptedRequests.delete(request))
      return request
    })
  }

  async function remember<T extends Entry>(entry: T): Promise<T> {
    await preferences.remember(entry).catch(() => console.warn('Unable to save the Ion IDE recent-items list.'))
    return entry
  }

  function workspaceChanged(previous: string | null, force = false) {
    if (!force && previous === files.rootPath) return
    cancelExplanations()
    languageEditReview?.service.clear()
    languageEditReview = undefined
    // Workspace grants define every language-service filesystem boundary.
    // Stop existing sessions before any request can reuse stale root state.
    void languageServices.release(true)
    void stopDebugTools()
    void projectLensService?.then(service => service.close(), () => undefined)
    trustedGitRoot = undefined
    void closeSourceControl()
    void projectHandlers?.stopSuite()
  }

  async function grantFolder(target: BrowserWindow, path: string, requireCanonical = false) {
    const scope = files
    const previous = scope.rootPath
    const entry = await scope.grant(path, 'folder', requireCanonical)
    if (target !== window || scope !== files) throw new Error('The workspace window has closed.')
    workspaceChanged(previous)
    return remember(entry)
  }

  function revokeTrust(path: string): void {
    for (const trusted of trustedSources.keys()) {
      if (isWithin(path, trusted)) trustedSources.delete(trusted)
    }
  }

  handle('set-optional-panel', setOptionalPanel)
  handle('editor-session-available', () => editorSession.available())
  handle('editor-session-save', (_target, snapshot) => editorSession.save(snapshot, files))
  handle('editor-session-resume', async (target) => {
    const scope = files
    const previous = scope.rootPath
    const resumed = await editorSession.resume(scope, recovery, () => target === window && scope === files)
    if (scope === files) workspaceChanged(previous)
    return resumed
  })
  handle('recovery-list', () => recovery.list())
  handle('recovery-read', (_target, id) => recovery.read(id))
  handle('recovery-write', (_target, draft) => recovery.write(draft))
  handle('recovery-remove', (_target, ids) => recovery.remove(ids))
  handle('get-preferences', async () => {
    const result = await preferences.get()
    applyProfile(result.settings.resourceProfile)
    applyShortcuts(result.settings.shortcuts)
    return result
  })
  handle('update-settings', async (_target, patch) => {
    const result = await preferences.updateSettings(patch)
    if (learningLensEnabled !== result.learningLens) learningSelectionGeneration++
    learningLensEnabled = result.learningLens
    openFullScreen = result.openFullScreen
    smartLanguages = result.smartLanguages
    for (const status of languageServices.statuses()) {
      if (!smartLanguages.includes(status.language)) void languageServices.release(true,
        languageCapability(status.language)?.semantic?.adapter ?? status.language)
    }
    applyProfile(result.resourceProfile)
    applyShortcuts(result.shortcuts)
    return result
  })
  handle('language-query', queryLanguage)
  handle('language-rename-review', reviewLanguageRename)
  handle('language-edit-apply', async (target, token) => {
    const pending = languageEditReview
    languageEditReview = undefined
    if (!pending || target !== window || pending.scope !== files) throw new Error('Review the current language-server edits again.')
    return pending.service.apply(token)
  })
  handle('language-cancel', (_target, requestId) => {
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(requestId)) throw new Error('Invalid language cancellation request.')
    languageServices.cancel(requestId)
  })
  handle('language-saved', async (_target, value) => {
    const saved = value as { language?: unknown; path?: unknown } | null
    if (!saved || typeof saved.language !== 'string' || typeof saved.path !== 'string') throw new Error('Invalid language save notification.')
    const capability = languageCapability(saved.language)
    if (!capability?.semantic || fileLanguage(saved.path).id !== saved.language) throw new Error('Invalid language save notification.')
    const scope = files
    const { path } = await scope.inspect(saved.path, 'file')
    const root = scope.rootFor(path)
    if (files !== scope || (root ? !scope.rootPaths.includes(root) : !scope.authorizes(path))) return
    await languageServices.saved({ adapter: capability.semantic.adapter, language: capability.id, root, path })
  })
  handle('language-status', () => languageServices.statuses())
  handle('language-restart', (_target, language) => {
    if (language !== undefined && typeof language !== 'string') throw new Error('Invalid language service restart request.')
    return languageServices.release(true, language === undefined ? undefined
      : languageCapability(language)?.semantic?.adapter ?? language)
  })
  handle('format-source', formatDocument)
  handle('format-cancel', (_target, id) => {
    if (typeof id === 'string' && formatJob?.id === id) formatJob.controller.abort()
  })
  handle('language-release', (_target, immediate, language, requestedPath) => {
    if (typeof immediate !== 'boolean' || (language !== undefined && typeof language !== 'string')
      || (requestedPath !== undefined && typeof requestedPath !== 'string')) return
    if (requestedPath !== undefined && (!language || fileLanguage(requestedPath).id !== language)) return
    return languageServices.release(immediate, language === undefined ? undefined
      : languageCapability(language)?.semantic?.adapter ?? language, requestedPath)
  })
  handle('debug-start', startDebugSession)
  handle('debug-stop', async (_target, sessionId) => {
    if (!validDebugSessionId(sessionId)) throw new Error('Invalid debugger session.')
    const service = await debugService
    if (service) await service.stop(sessionId)
  })
  handle('debug-action', async (_target, sessionId, action, threadId) => {
    if (!validDebugSessionId(sessionId) || !['continue', 'pause', 'next', 'stepIn', 'stepOut', 'restart'].includes(action as string)
      || threadId !== undefined && (!Number.isSafeInteger(threadId) || (threadId as number) < 1)) {
      throw new Error('Invalid debugger action.')
    }
    const service = await debugService
    if (!service) throw new Error('No debugger session is active.')
    return service.action(sessionId, action as DebugAction, threadId as number | undefined)
  })
  handle('debug-stack', async (_target, sessionId, threadId) => {
    if (!validDebugSessionId(sessionId) || !Number.isSafeInteger(threadId) || (threadId as number) < 1) throw new Error('Invalid debugger stack request.')
    const service = await debugService
    if (!service) throw new Error('No debugger session is active.')
    return service.stack(sessionId, threadId as number)
  })
  handle('debug-scopes', async (_target, sessionId, frameId) => {
    if (!validDebugSessionId(sessionId) || !Number.isSafeInteger(frameId) || (frameId as number) < 1) throw new Error('Invalid debugger scope request.')
    const service = await debugService
    if (!service) throw new Error('No debugger session is active.')
    return service.scopes(sessionId, frameId as number)
  })
  handle('debug-variables', async (_target, sessionId, reference) => {
    if (!validDebugSessionId(sessionId) || !Number.isSafeInteger(reference) || (reference as number) < 1) throw new Error('Invalid debugger variable request.')
    const service = await debugService
    if (!service) throw new Error('No debugger session is active.')
    return service.variables(sessionId, reference as number)
  })
  handle('debug-evaluate', async (_target, sessionId, expression, frameId) => {
    if (!validDebugSessionId(sessionId) || typeof expression !== 'string' || expression.length < 1
      || Buffer.byteLength(expression) > debugLimits.expressionBytes
      || frameId !== undefined && (!Number.isSafeInteger(frameId) || (frameId as number) < 1)) {
      throw new Error('Invalid debugger evaluation request.')
    }
    const service = await debugService
    if (!service) throw new Error('No debugger session is active.')
    return service.evaluate(sessionId, expression, frameId as number | undefined)
  })
  handle('debug-status', () => debugService?.then(service => service.status(), () => null) ?? null)
  let updates: Promise<import('./updates').GitHubUpdates> | undefined
  const updateCache = join(app.getPath('userData'), 'updates')
  const getUpdates = () => updates ??= import('./updates').then(async ({ GitHubUpdates }) => {
    const service = new GitHubUpdates(app.getVersion(), process.platform, process.arch)
    await service.restore(updateCache)
    return service
  })
  handle('updates-status', async () => (await getUpdates()).status())
  handle('updates-check', async () => (await getUpdates()).check())
  handle('updates-download', async (target) => {
    const service = await getUpdates()
    if (target !== window) throw new Error('The Ion window closed before downloading.')
    const cancel = () => service.cancel()
    target.once('closed', cancel)
    try {
      const { name } = await service.download(updateCache, true)
      return { name }
    } finally {
      target.removeListener('closed', cancel)
    }
  })
  handle('updates-cancel', async () => (await updates)?.cancel())
  handle('clear-run-trust', async () => {
    await (await getRunTrust()).clear()
    trustedSources.clear()
  })
  handle('updates-install', async (target) => {
    if (updatePreparation || pendingUpdate) throw new Error('An update installation is already being prepared.')
    const service = await getUpdates()
    if (updatePreparation || pendingUpdate) throw new Error('An update installation is already being prepared.')
    if (target !== window || closePending || quitRequested) throw new Error('Finish the current close request before installing.')
    updatePreparation = import('./update-install').then(({ prepareUpdate }) => prepareUpdate({
      update: service.ready(), currentVersion: app.getVersion(), executable: process.execPath,
      helper: nativeTool('ion-update'), profile: app.getPath('userData'), arch: process.arch,
      platform: process.platform, packaged: app.isPackaged,
    })).then(async (prepared) => {
      if (target !== window || target.isDestroyed() || closePending || quitRequested) {
        await prepared.dispose()
        throw new Error('Update preparation was canceled because the Ion window closed.')
      }
      return prepared
    })
    try {
      const prepared = await updatePreparation
      if (target !== window || target.isDestroyed() || closePending || quitRequested) {
        await prepared.dispose()
        return false
      }
      const completion = new Promise<boolean>((complete) => { pendingUpdate = { prepared, complete } })
      // Normal renderer save/keep-drafts/cancel flow; no bypass or forced exit.
      app.quit()
      return completion
    } finally { updatePreparation = undefined }
  })
  handle('backup-folders', async target => {
    const service = await backup(target)
    if (files.rootPath) await service.addFolder(files.rootPath)
    const saved = await preferences.get()
    for (const entry of saved.recents.filter(e => e.kind === 'folder').slice(0, 15)) {
      await service.addFolder(entry.path).catch(() => {})
    }
    return service.listFolders()
  })
  handle('backup-choose-folder', async target => {
    const answer = await dialog.showOpenDialog(target, { title: 'Choose a folder for backup or explicit relinking', properties: ['openDirectory'] })
    if (target !== window || answer.canceled || !answer.filePaths[0]) return null
    return (await backup(target)).addFolder(answer.filePaths[0])
  })
  handle('backup-review', async (target, scope) => { await drainAcceptedRequests(); await drainProfileWrites(); return (await backup(target)).review(scope as BackupScope) })
  handle('backup-create', async (target, token) => {
    if (typeof token !== 'string') throw new Error('Invalid backup token.')
    const answer = await dialog.showSaveDialog(target, { title: 'Back Up My Ion Data', defaultPath: 'Ion Data ' + new Date().toISOString().slice(0, 10) + '.ionbackup', filters: [{ name: 'Ion backup', extensions: ['ionbackup'] }] })
    if (target !== window || answer.canceled || !answer.filePath) return null
    return (await backup(target)).create(token, answer.filePath)
  })
  handle('backup-open-restore', async (target, legacy) => {
    if (legacy !== undefined && typeof legacy !== 'boolean') throw new Error('Invalid backup input.')
    const answer = await dialog.showOpenDialog(target, { title: legacy ? 'Open Legacy Ion Profile Export' : 'Restore From Backup', properties: legacy ? ['openDirectory'] : ['openFile'],
      ...(legacy ? {} : { filters: [{ name: 'Ion backup', extensions: ['ionbackup'] }] }) })
    if (target !== window || answer.canceled || !answer.filePaths[0]) return null
    await drainAcceptedRequests(); await drainProfileWrites()
    return (await backup(target)).openRestore(answer.filePaths[0], legacy === true)
  })
  handle('backup-prepare-restore', async (target, token, choices) => {
    if (typeof token !== 'string') throw new Error('Invalid restore token.')
    await requireStoppedTools(); await drainAcceptedRequests(); await drainProfileWrites()
    // This is only a chooser decision, not an extraction path supplied by the renderer.
    const copied = choices && typeof choices === 'object' && 'copyFolders' in choices && Array.isArray(choices.copyFolders) && choices.copyFolders.length > 0
    let parent: string | undefined
    if (copied) {
      const answer = await dialog.showOpenDialog(target, { title: 'Choose parent for NEW restored workspace folders', properties: ['openDirectory', 'createDirectory'] })
      if (target !== window || answer.canceled || !answer.filePaths[0]) throw new Error('Workspace destination selection cancelled.')
      parent = answer.filePaths[0]
    }
    return (await backup(target)).prepareRestore(token, choices as RestoreChoices, parent)
  })
  handle('backup-apply-restore', async (target, token) => {
    if (restoreClosing || pendingUpdate) throw new Error('Another restart operation is pending.')
    restoreClosing = true // Freeze new tool launches before awaiting availability checks.
    try {
      await requireStoppedTools()
      const service = await backup(target); service.assertPrepared(token)
      if (target !== window || pendingUpdate) throw new Error('Another restart operation is pending.')
      await requireStoppedTools()
      projectHandlers?.stopAutomatic()
      pendingRestore = { token: token as string, service }
      app.quit() // Existing Save / Keep Drafts / Cancel flow owns this decision.
    } catch (error) { restoreClosing = false; throw error }
  })
  handle('backup-cancel', async () => { if (!restoreClosing) await backupService?.then(s => s.cancel()) })
  let profileExportPending = false
  handle('export-local-profile', async (target) => {
    if (profileExportPending) throw new Error('A local profile export is already in progress.')
    profileExportPending = true
    try {
      const selection = await dialog.showOpenDialog(target, {
        title: 'Export Local Profile',
        buttonLabel: 'Export Here',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (target !== window || selection.canceled || !selection.filePaths[0]) return null
      const { exportLocalProfile } = await import('./profile-export')
      if (target !== window) return null
      return await exportLocalProfile(app.getPath('userData'), selection.filePaths[0], preferences)
    } finally {
      profileExportPending = false
    }
  })
  handle('themes-list', () => themeStore.list())
  handle('themes-load', (_target, id) => {
    if (!isThemeId(id)) throw new Error('Unknown theme.')
    return themeStore.load(id)
  })
  handle('themes-import', async (target) => {
    const selection = await dialog.showOpenDialog(target, {
      title: 'Import Theme', properties: ['openFile'], filters: [{ name: 'Ion Theme', extensions: ['json'] }],
    })
    if (target !== window || selection.canceled || !selection.filePaths[0]) return null
    return themeStore.importFile(selection.filePaths[0])
  })
  handle('themes-export', async (target, id) => {
    if (!isThemeId(id)) throw new Error('Unknown theme.')
    const selection = await dialog.showSaveDialog(target, {
      title: 'Export Theme', defaultPath: 'Ion Theme.json', filters: [{ name: 'Ion Theme', extensions: ['json'] }],
    })
    if (target !== window || selection.canceled || !selection.filePath) return false
    await themeStore.exportFile(id, selection.filePath)
    return true
  })
  handle('themes-create', (_target, theme) => themeStore.create(theme))
  handle('open-folder', async (target) => {
    const selection = await dialog.showOpenDialog(target, { title: 'Open Folder', properties: ['openDirectory'] })
    if (target !== window || selection.canceled || !selection.filePaths[0]) return null
    workspaceSearch?.controller.abort()
    return grantFolder(target, selection.filePaths[0])
  })
  handle('add-folder', async (target) => {
    const selection = await dialog.showOpenDialog(target, { title: 'Add Folder to Workspace', properties: ['openDirectory'] })
    if (target !== window || selection.canceled || !selection.filePaths[0]) return null
    workspaceSearch?.controller.abort()
    return remember(await files.addRoot(selection.filePaths[0]))
  })
  handle('remove-folder', async (target, path) => {
    if (target !== window) return false
    workspaceSearch?.controller.abort()
    const removed = files.removeRoot(path)
    if (removed && typeof path === 'string') {
      revokeTrust(path)
      if (trustedGitRoot && isWithin(path, trustedGitRoot)) {
        trustedGitRoot = undefined
        await closeSourceControl()
      }
      workspaceReplace?.service.clear()
      languageEditReview?.service.clear()
      // Root removal is a trust-boundary change. Retire every semantic
      // session immediately so a removed root cannot retain a process,
      // document state, or diagnostics until the ordinary idle deadline.
      await languageServices.release(true)
    }
    return removed
  })
  handle('reorder-folder', (target, path, offset) => target === window && (offset === -1 || offset === 1)
    ? files.reorderRoot(path, offset) : false)
  handle('workspace-save', async (target, roots, settings) => {
    const scope = files
    if (!Array.isArray(roots) || roots.length !== scope.rootPaths.length
      || roots.some((root, index) => root !== scope.rootPaths[index])) throw new Error('The workspace changed before it could be saved.')
    const selection = await dialog.showSaveDialog(target, {
      title: 'Save Ion Workspace', defaultPath: 'Ion Workspace.ion-workspace',
      filters: [{ name: 'Ion Workspace', extensions: ['ion-workspace'] }],
    })
    if (target !== window || scope !== files || selection.canceled || !selection.filePath) return false
    const { writeWorkspaceConfiguration } = await import('./workspace-configuration')
    await writeWorkspaceConfiguration(selection.filePath, roots, settings)
    return true
  })
  handle('workspace-open', async (target) => {
    const selection = await dialog.showOpenDialog(target, {
      title: 'Open Ion Workspace', properties: ['openFile'], filters: [{ name: 'Ion Workspace', extensions: ['ion-workspace'] }],
    })
    if (target !== window || selection.canceled || !selection.filePaths[0]) return null
    const { readWorkspaceConfiguration } = await import('./workspace-configuration')
    const configuration = await readWorkspaceConfiguration(selection.filePaths[0])
    const candidate = workspaceFiles()
    const roots: Entry[] = []
    for (const [index, path] of configuration.roots.entries()) {
      roots.push(index === 0 ? await candidate.grant(path, 'folder', true) : await candidate.addRoot(path, true))
    }
    const review = await dialog.showMessageBox(target, { type: 'warning', buttons: ['Cancel', 'Open Workspace'],
      defaultId: 0, cancelId: 0, message: `Open ${roots.length} workspace ${roots.length === 1 ? 'folder' : 'folders'}?`,
      detail: 'Ion will grant file access to these folders. Execution, repository, test, and terminal trust are not imported.\n\n'
        + roots.map(({ path }) => path).join('\n') })
    if (target !== window || review.response !== 1) return null
    const previous = files.rootPath
    quickSearch?.abort()
    workspaceSearch?.controller.abort()
    workspaceReplace?.service.clear()
    languageEditReview?.service.clear()
    trustedSources.clear()
    files = candidate
    workspaceChanged(previous, true)
    for (const root of roots) await remember(root)
    return { roots, settings: configuration.settings }
  })
  handle('open-file', async (target) => {
    const selection = await dialog.showOpenDialog(target, { title: 'Open File', properties: ['openFile'] })
    if (target !== window || selection.canceled || !selection.filePaths[0]) return null
    return remember(await files.grant(selection.filePaths[0], 'file'))
  })
  handle('copy-path', async (target, value) => {
    const scope = files
    await copyAuthorizedPath(scope, value, path => {
      if (target !== window || scope !== files) throw new Error('The workspace changed before the path could be copied.')
      clipboard.writeText(path)
    })
  })
  handle('reveal-in-folder', async (target, value) => {
    const scope = files
    await revealAuthorizedPath(scope, value, path => {
      if (target !== window || scope !== files) throw new Error('The workspace changed before the item could be revealed.')
      shell.showItemInFolder(path)
    })
  })
  // Only the isolated preload can send this request, after a trusted OS file drop.
  handle('open-dropped-files', async (target, paths) => {
    if (process.platform !== 'win32' || !Array.isArray(paths) || paths.length > 16
      || !paths.every((path) => typeof path === 'string' && isAbsolute(path) && path.length <= 4096)) return
    for (const path of new Set<string>(paths)) {
      if (target !== window || target.isDestroyed()) break
      await openFromSystem(path)
    }
  })
  handle('open-recent', async (target, path) => {
    const previous = (await preferences.get()).recents.find((item) => item.path === path)
    if (target !== window || !previous) throw new Error('This item is no longer in Recent.')
    if (previous.kind === 'folder') {
      workspaceSearch?.controller.abort()
      return grantFolder(target, previous.path, true)
    }
    return remember(await files.grant(previous.path, 'file', true))
  })
  handle('source-control-status', async (target, root): Promise<SourceControlStatus> => {
    const path = sourceControlRoot(target, root)
    if (path === trustedGitRoot) return useSourceControl(target, path, (service) => service.status(path))
    const { gitDirectory } = await import('./source-control/repository')
    if (!await gitDirectory(path)) return { kind: 'none', message: 'Open the root folder of a Git repository to see its changes.' }
    sourceControlRoot(target, path)
    return { kind: 'untrusted', message: 'Review this repository before Ion runs its local Git configuration.' }
  })
  handle('source-control-trust', async (target, root) => {
    const path = sourceControlRoot(target, root)
    if (path === trustedGitRoot) return true
    const { gitDirectory } = await import('./source-control/repository')
    if (!await gitDirectory(path)) return false
    sourceControlRoot(target, path)
    const answer = await dialog.showMessageBox(target, {
      type: 'warning', buttons: ['Cancel', 'Trust Repository'], defaultId: 0, cancelId: 0,
      message: 'Trust this Git repository for this workspace?',
      detail: 'Git may use local filters and tools configured for the checkout. Continue only if you trust its contents and configuration. Ion does not run Git before you approve.\n\n' + path,
    })
    if (answer.response !== 1) return false
    trustedGitRoot = sourceControlRoot(target, path)
    return true
  })
  handle('source-control-diff', (target, root, request) => useSourceControl(target, root, (service, path) => service.diff(path, request)))
  handle('source-control-change', (target, root, request) => useSourceControl(target, root, (service, path) => service.change(path, request)))
  handle('source-control-commit', (target, root, request) => useSourceControl(target, root, (service, path) => service.commit(path, request)))
  handle('source-control-close', (_target, root) => {
    if (sourceControl?.root === root) return closeSourceControl()
  })
  handle('quick-open-search', async (_target, value) => {
    const query = quickOpenQuery(value)
    quickSearch?.abort()
    const scope = files
    const roots = [...scope.rootPaths]
    if (!roots.length || !query) return { entries: [], truncated: false }
    const controller = new AbortController()
    quickSearch = controller
    try {
      const results = await Promise.all(roots.map((root) => searchWorkspace(scope, root, query, controller.signal)))
      if (roots.length !== scope.rootPaths.length || roots.some((root, index) => scope.rootPaths[index] !== root)) {
        throw new Error('The workspace changed during Quick Open.')
      }
      const entries = results.flatMap(({ entries }) => entries).slice(0, 40)
      return { entries, truncated: results.some(({ truncated }) => truncated) || results.reduce((sum, result) => sum + result.entries.length, 0) > 40 }
    } finally {
      if (quickSearch === controller) quickSearch = undefined
    }
  })
  handle('quick-open-file', async (target, value) => {
    const scope = files
    const roots = [...scope.rootPaths]
    if (!roots.length) throw new Error('Open a workspace folder before using Quick Open.')
    const { path } = await scope.inspect(value, 'file')
    if (target !== window || roots.length !== scope.rootPaths.length || roots.some((root, index) => scope.rootPaths[index] !== root)
      || !roots.some((root) => isWithin(root, path))) {
      throw new Error('This file is outside the current workspace.')
    }
    return remember({ kind: 'file' as const, name: basename(path), path })
  })
  handle('workspace-search', async (target, id, value) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid search request.')
    const scope = files
    const roots = [...scope.rootPaths]
    if (!roots.length) throw new Error('Open a workspace folder before searching files.')
    workspaceSearch?.controller.abort()
    const controller = new AbortController()
    workspaceSearch = { id, controller }
    try {
      const { workspaceSearchQuery, searchWorkspaceText } = await import('./workspace-search')
      const query = workspaceSearchQuery(value)
      if (!query) return { files: [] }
      const executable = 'ion-rg' + (process.platform === 'win32' ? '.exe' : '')
      const tool = app.isPackaged ? join(process.resourcesPath, executable) : resolve(__dirname, '../native', executable)
      const results = await Promise.all(roots.map((root) => searchWorkspaceText(tool, scope, root, query, controller.signal)))
      if (target !== window || scope !== files || roots.length !== scope.rootPaths.length
        || roots.some((root, index) => scope.rootPaths[index] !== root)) throw new Error('The workspace changed during search.')
      const foundFiles = results.flatMap((result, index) => result.files.map((file) => ({ ...file,
        relativePath: roots.length > 1 ? `${workspaceRootLabel(roots, index)}/${file.relativePath}` : file.relativePath })))
      return { files: foundFiles.slice(0, workspaceSearchResultLimit), limit: results.find(({ limit }) => limit)?.limit
        ?? (foundFiles.length > workspaceSearchResultLimit ? 'matches' : undefined),
        skipped: results.some(({ skipped }) => skipped) || undefined }
    } finally {
      if (workspaceSearch?.controller === controller) workspaceSearch = undefined
    }
  })
  handle('workspace-search-cancel', (_target, id) => {
    if (workspaceSearch && workspaceSearch.id === id) workspaceSearch.controller.abort()
  })
  handle('workspace-replace-review', async (target, query, replacement) => {
    const scope = files
    if (!scope.rootPath) throw new Error('Open a workspace folder before replacing text.')
    const executable = 'ion-rg' + (process.platform === 'win32' ? '.exe' : '')
    const tool = app.isPackaged ? join(process.resourcesPath, executable) : resolve(__dirname, '../native', executable)
    const { WorkspaceReplaceReview } = await import('./workspace-search')
    const service = new WorkspaceReplaceReview(tool, scope)
    const review = await service.review(query, replacement)
    if (target !== window || scope !== files) throw new Error('The workspace changed during replace review.')
    workspaceReplace?.service.clear()
    workspaceReplace = { scope, service }
    return review
  })
  handle('workspace-replace-apply', async (target, token, paths) => {
    const pending = workspaceReplace
    workspaceReplace = undefined
    if (!pending || target !== window || pending.scope !== files) throw new Error('Review the current workspace again.')
    return pending.service.apply(token, paths)
  })
  handle('list-directory', (_target, path) => files.list(path))
  handle('read-file', (_target, path, mode) => files.read(path, mode))
  handle('read-text-page', (_target, path, page, revision) => files.readTextPage(path, page, revision))
  handle('markdown-read-image', async (target, sourcePath, href) => {
    const scope = files
    const root = typeof sourcePath === 'string' ? scope.rootFor(sourcePath) : null
    const image = await readMarkdownImage(scope, sourcePath, href)
    if (target !== window || scope !== files || !root || !scope.rootPaths.includes(root)) {
      throw new Error('The workspace changed while opening the Markdown image.')
    }
    return image
  })
  handle('markdown-open-link', async (target, sourcePath, href) => {
    const scope = files
    const root = typeof sourcePath === 'string' ? scope.rootFor(sourcePath) : null
    const link = await resolveMarkdownLink(scope, sourcePath, href)
    const assertCurrent = () => {
      if (target !== window || scope !== files || !root || !scope.rootPaths.includes(root)) {
        throw new Error('The workspace changed while opening the Markdown link.')
      }
    }
    assertCurrent()
    if (link.kind === 'external') {
      await shell.openExternal(link.href)
      return null
    }
    const entry = await remember(link.entry)
    assertCurrent()
    return entry
  })
  handle('notebook-kernel-discover', async (target, value) => {
    const scope = files
    const { path } = await scope.inspect(kernelPath(value), 'file')
    const root = scope.rootFor(path)
    const result = await (await kernels(target)).discover(root ?? dirname(path))
    if (target !== window || scope !== files || (root ? !scope.rootPaths.includes(root) : !scope.authorizes(path))) throw new Error('The notebook workspace changed.')
    return result
  })
  handle('notebook-kernel-choose', async (target, value) => {
    const scope = files
    const { path } = await scope.inspect(kernelPath(value), 'file')
    const root = scope.rootFor(path)
    const current = () => target === window && scope === files && (root ? scope.rootPaths.includes(root) : scope.authorizes(path))
    const selection = await dialog.showOpenDialog(target, { title: 'Choose a Python Interpreter', properties: ['openFile', 'showHiddenFiles'] })
    if (!current() || selection.canceled || !selection.filePaths[0]) return null
    const result = await (await kernels(target)).addInterpreter(selection.filePaths[0])
    if (!current()) throw new Error('The notebook workspace changed.')
    return result
  })
  handle('notebook-kernel-status', async (_target, value): Promise<NotebookKernelStatus> => {
    const path = kernelPath(value)
    return (await notebookKernels)?.status(path) ?? { state: 'stopped' }
  })
  handle('notebook-kernel-run', async (target, value, request) => {
    const scope = files
    const { path } = await scope.inspect(kernelPath(value), 'file')
    const root = scope.rootFor(path)
    const current = () => target === window && !target.isDestroyed() && scope === files
      && (root ? scope.rootPaths.includes(root) : scope.authorizes(path))
    return (await kernels(target)).run(path, request, async (environment) => {
      if (!current()) return false
      const choice = await dialog.showMessageBox(target, {
        type: 'warning', buttons: ['Cancel', 'Trust and Run'], cancelId: 0, defaultId: 0,
        message: `Run Python from ${basename(path)}?`,
        detail: `Ion will first run the interpreter at ${environment.path} to check notebook support, then run your notebook. Both the interpreter and notebook can access resources available to your user account. Approve only an interpreter and code you trust.`,
      })
      if (choice.response !== 1 || !current()) return false
      await scope.inspect(path, 'file')
      return current()
    }, root ?? dirname(path), current)
  })
  handle('notebook-kernel-restart', async (target, value): Promise<NotebookKernelStatus> => {
    const scope = files
    const path = kernelPath(value)
    await scope.inspect(path, 'file')
    const root = scope.rootFor(path)
    return (await notebookKernels)?.restart(path,
      () => target === window && !target.isDestroyed() && scope === files
        && (root ? scope.rootPaths.includes(root) : scope.authorizes(path))) ?? { state: 'stopped' }
  })
  handle('notebook-kernel-interrupt', async (_target, value) => {
    const path = kernelPath(value)
    return (await notebookKernels)?.interrupt(path)
  })
  handle('notebook-kernel-stop', async (_target, value) => {
    const path = kernelPath(value)
    return (await notebookKernels)?.stop(path)
  })
  handle('notebook-kernel-release', async (_target, value, keep) => {
    const path = kernelPath(value)
    if (typeof keep !== 'boolean') throw new Error('Invalid kernel lifetime setting.')
    return (await notebookKernels)?.release(path, keep)
  })
  handle('viewer-open', async (target, path, request) => (await viewers(target)).open(path, request))
  handle('viewer-close', async (_target, id) => (await viewerService)?.close(id))
  handle('viewer-cancel', async (_target, request) => (await viewerService)?.cancel(request))
  handle('viewer-external', async (target, value) => {
    const { path } = await files.inspect(value, 'file')
    if (!documentFormat(path) || target !== window) throw new Error('Open a supported local document first.')
    const error = await shell.openPath(path)
    if (error) throw new Error('No default application could open this document.')
  })
  handle('viewer-pdf-read', async (target, id, offset, length) => (await viewers(target)).readPdf(id, offset, length))
  handle('viewer-table-page', async (target, id, sheet, row, column, rows, columns) =>
    (await viewers(target)).tablePage(id, sheet, row, column, rows, columns))
  handle('viewer-table-search', async (target, id, sheet, query, after) => (await viewers(target)).tableSearch(id, sheet, query, after))
  handle('viewer-word-page', async (target, id, page) => (await viewers(target)).wordPage(id, page))
  handle('viewer-word-image', async (target, id, image) => (await viewers(target)).wordImage(id, image))
  handle('save-file', async (target, path, text, token, baseHash) => {
    if (typeof path === 'string' && documentFormat(path)) throw new Error('This document is read-only in Ion.')
    const { baseRevision, ...saved } = await files.save(path, text, token, baseHash)
    if (target === window && typeof path === 'string' && baseRevision === token && trustedSources.get(path) === token) {
      trustedSources.set(path, saved.revision)
    }
    if (target === window && typeof path === 'string') projectHandlers?.sourceSaved(path, saved.revision, text)
    return saved
  })
  handle('save-file-as', async (target, name, value, mode) => {
    const defaultPath = entryName(name)
    if (mode !== undefined && (mode !== 'notebook' || !isNotebookName(defaultPath))) throw new Error('Choose an .ipynb name for the notebook.')
    const text = fileText(value, isNotebookName(defaultPath) ? maxNotebookBytes : maxTextCopyBytes)
    const selection = await dialog.showSaveDialog(target, { title: 'Save File', defaultPath })
    if (target !== window || selection.canceled || !selection.filePath) return null
    if (mode === 'notebook' && !isNotebookName(selection.filePath)) throw new Error('Choose an .ipynb name for the notebook.')
    if (documentFormat(selection.filePath)) throw new Error('Ion cannot save source text over a read-only document format.')
    const saved = await files.saveAs(selection.filePath, text, async (path) => {
      // The native picker may have selected an unused path that another app
      // has since created. Confirm replacement of the revision just inspected.
      const choice = await dialog.showMessageBox(target, {
        type: 'warning', buttons: ['Cancel', 'Replace File'], cancelId: 0, defaultId: 0,
        message: 'Replace ' + basename(path) + '?',
        detail: 'The destination already contains a file. Replacing it saves the current editor text at this location.\n\n' + path,
      })
      return choice.response === 1 && target === window && !target.isDestroyed()
    })
    if (!saved) return null
    if (target === window) {
      trustedSources.delete(saved.path)
      projectHandlers?.sourceSaved(saved.path)
    }
    return remember(saved)
  })
  handle('create-entry', (_target, parent, name, kind, initialText) => files.create(parent, name, kind, initialText))
  handle('rename-entry', async (target, path, name) => {
    const entry = await files.rename(path, name)
    if (target === window) {
      revokeTrust(path as string)
      projectHandlers?.sourceSaved(path as string)
    }
    await preferences.moveRecents(path as string, entry.path).catch(() => console.warn('Unable to update Ion IDE recents.'))
    return entry
  })
  handle('trash-entry', async (target, path) => {
    const moved = await files.trash(path, async (selected) => {
      const choice = await dialog.showMessageBox(target, {
        type: 'warning', buttons: ['Cancel', 'Move to Trash'], defaultId: 0, cancelId: 0,
        message: 'Move ' + basename(selected) + ' to Trash?',
        detail: 'This removes the selected item from its current location.',
      })
      return choice.response === 1 && target === window
    }, (selected) => shell.trashItem(selected))
    if (moved) {
      if (target === window) {
        revokeTrust(path as string)
        projectHandlers?.sourceSaved(path as string)
      }
      await preferences.moveRecents(path as string).catch(() => console.warn('Unable to update Ion IDE recents.'))
    }
    return moved
  })
  handle('live-run-start', async (target, id, path, learn, expectedRevision) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return rejectedRun('Invalid run request.')
    const result = await startInteractive(target, id, path, learn === true, expectedRevision)
    // The invoke reply and the streamed updates are delivered separately. The
    // renderer uses an ordered marker on the update channel to finish the run.
    if (target === window && !target.isDestroyed()) {
      target.webContents.send('ion:live-run-update', { id, update: { kind: 'complete' } })
    }
    return result
  })
  handle('live-run-project-inputs', async (target, value) => {
    const scope = files
    const { path } = await scope.inspect(value, 'file')
    const root = scope.rootFor(path)
    if (!root) return null
    const language = runLanguage(path)
    if (!isWithin(root, path) || (language !== 'c' && language !== 'cpp')) return null
    const { readNativeProject } = await import('./run-console')
    const project = await readNativeProject(scope, root, path)
    if (target !== window || scope !== files || !scope.rootPaths.includes(root)) throw new Error('The workspace changed before the build.')
    return project ? { manifest: project.manifest, paths: project.inputs.map(({ path }) => path) } : null
  })
  handle('live-run-input', (target, id, input) => {
    if (!activeRun || activeRun.owner !== target || activeRun.id !== id || activeRun.controller.signal.aborted) {
      throw new Error('The requested run is no longer accepting input.')
    }
    const text = validStdin(input)
    if (Buffer.byteLength(text) > 16 * 1024) throw new Error('Send at most 16 KiB per terminal input chunk.')
    if (!activeRun.engine?.input(text)) throw new Error('The program is not ready to accept input yet.')
  })
  handle('live-run-resize', (target, id, cols, rows) => {
    if (!activeRun || activeRun.owner !== target || activeRun.id !== id || typeof cols !== 'number' || typeof rows !== 'number'
      || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 512 || rows < 2 || rows > 512) return
    activeRun.size = [cols, rows]
    activeRun.engine?.resize(cols, rows)
  })
  handle('live-run-cancel', (target, id) => {
    if (activeRun && activeRun.owner === target && activeRun.id === id) activeRun.controller.abort()
  })
  handle('terminal-create', async (target, columns, rows, requestedRoot) => {
    if (!terminalDimension(columns) || !terminalDimension(rows)) throw new Error('Invalid terminal dimensions.')
    const scope = files
    const root = typeof requestedRoot === 'string' && scope.rootPaths.includes(requestedRoot) ? requestedRoot : scope.rootPath
    const cwd = root ? (await scope.inspect(root, 'folder')).path : app.getPath('home')
    if (target !== window || scope !== files) throw new Error('The terminal window has closed.')
    const service = await terminals(target)
    if (target !== window) throw new Error('The terminal window has closed.')
    return service.create(cwd, columns, rows)
  })
  handle('terminal-attach', async (_target, id) => (await terminalService)?.attach(id))
  handle('terminal-ack', async (_target, id, sequence) => (await terminalService)?.ack(id, sequence))
  handle('terminal-input', async (_target, id, text) => (await terminalService)?.input(id, text))
  handle('terminal-resize', async (_target, id, columns, rows) => (await terminalService)?.resize(id, columns, rows))
  handle('terminal-close', async (_target, id) => (await terminalService)?.close(id))
  handle('terminal-focus', (target, focused) => {
    terminalFocused = focused === true && terminalService !== undefined
    if (!terminalFocused && ignoreTerminalAccelerators) {
      ignoreTerminalAccelerators = false
      target.webContents.setIgnoreMenuShortcuts(false)
    }
  })
  handle('terminal-copy', (_target, text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Terminal selection is too large to copy.')
    if (text && terminalService) clipboard.writeText(text)
  })
  handle('terminal-paste', (target) => {
    if (terminalFocused) target.webContents.paste()
  })
  handle('web-preview', async (target, value) => {
    if (webPreviewOpening) return
    webPreviewOpening = true
    try {
      const scope = files
      const { path } = await scope.inspect(value, 'file')
      const root = scope.rootFor(path) ?? dirname(path)
      const { openWebPreview } = await import('./web-preview')
      if (target !== window) throw new Error('The workbench closed before preview could open.')
      if (webPreview && !webPreview.isDestroyed()) webPreview.destroy()
      webPreview = await openWebPreview(target, root, path)
      if (target !== window && !webPreview.isDestroyed()) webPreview.destroy()
    } finally {
      webPreviewOpening = false
    }
  })
  handle('learning-topics', () => withLearning((service) => service.getTopics()))
  handle('learning-concept', (_target, id) => withLearning((service) => service.getConcept(id)))
  handle('learning-history', () => withLearning((service) => service.getHistory()))
  handle('learning-clear', () => withLearning((service) => service.clearHistory()))
  handle('learning-topic', (_target, id, action) => withLearning((service) => service.recordTopic(id, action)))
  handle('learning-lesson-activity', async (target, id, topic) => {
    await learningLesson(target, id, topic)
    return withLearning(service => service.getLearningActivity(id, topic))
  })
  handle('learning-lesson-record', async (target, id, topic, action) => {
    const lesson = await learningLesson(target, id, topic)
    if (action === 'hint-revealed' && !lesson.hints?.length) throw new Error('This lesson has no graduated hints.')
    return withLearning(service => service.recordLearningActivity(id, topic, action))
  })
  handle('learning-task-evidence', async (target, id, topic) => {
    await learningLesson(target, id, topic)
    if (!diagnosticPackIds.some(pack => pack === id)) return { problemId: null, attemptCount: 0, manualStatus: null, samples: null }
    return (await practice()).learningTaskEvidence(id, topic)
  })

  handle('learning-packs-library', async (_target, includeCatalog) => (await learningPacks()).getLibrary(includeCatalog !== false))
  handle('learning-packs-install', async (_target, id) => (await learningPacks()).install(id))
  handle('learning-packs-remove', async (_target, id) => {
    cancelExplanations()
    const library = await (await learningPacks()).remove(id)
    if (diagnosticPackIds.some((pack) => pack === id)) learningSelectionGeneration++
    return library
  })
  handle('learning-packs-select', async (_target, id, includeCatalog) => {
    cancelExplanations()
    const library = await (await learningPacks()).select(id, includeCatalog !== false)
    learningSelectionGeneration++
    return library
  })
  handle('learning-packs-topics', async (_target, id) => (await learningPacks()).getTopics(id))
  handle('learning-packs-lesson', async (_target, id, topic) => (await learningPacks()).getLesson(id, topic))
  handle('learning-packs-details', async (_target, id) => (await learningPacks()).getDetails(id))
  let packImportPending = false
  handle('learning-packs-import-preview', async (target) => {
    if (packImportPending) throw new Error('A learning pack import is already open.')
    packImportPending = true
    try {
      const selection = await dialog.showOpenDialog(target, {
        title: 'Import Learning Pack', properties: ['openFile'], filters: [{ name: 'Ion Learning Pack', extensions: ['json'] }],
      })
      if (target !== window || selection.canceled || !selection.filePaths[0]) return null
      const store = await learningPacks()
      if (target !== window) return null
      return await store.previewFile(selection.filePaths[0])
    } finally {
      packImportPending = false
    }
  })
  handle('learning-packs-import-confirm', async (_target, token) => (await learningPacks()).confirmImport(token))
  handle('learning-packs-import-discard', async (_target, token) => (await learningPacks()).discardImport(token))
  let packExportPending = false
  handle('learning-packs-export', async (target, id) => {
    if (packExportPending) throw new Error('A learning pack export is already open.')
    packExportPending = true
    try {
      const store = await learningPacks()
      const { pack } = await store.getDetails(id)
      if (target !== window) return false
      const selection = await dialog.showSaveDialog(target, {
        title: 'Export Learning Pack', defaultPath: pack.id + '.json', filters: [{ name: 'Ion Learning Pack', extensions: ['json'] }],
      })
      if (target !== window || selection.canceled || !selection.filePath) return false
      const folder = await realpath(dirname(selection.filePath))
      if (isWithin(await realpath(app.getPath('userData')), folder)) throw new Error('Export learning packs outside the active Ion profile.')
      await store.exportFile(pack.id, join(folder, basename(selection.filePath)))
      return true
    } finally {
      packExportPending = false
    }
  })
  handle('learning-packs-exercise', async (target, id, topic) => {
    const language = diagnosticPackIds.find((item) => item === id)
    if (!language || panel !== 'learn') throw new Error('Open a runnable lesson in Learn to start this exercise.')
    const lesson = await (await learningPacks()).getLesson(id, topic)
    if (!lesson.exercise) throw new Error('This lesson does not have a Practice exercise.')
    if (target !== window || panel !== 'learn') throw new Error('The Learn panel closed.')
    const library = await practice()
    const started = await library.startLearningExercise(language, lesson.id, language, {
      title: lesson.title, topic: lesson.section,
      difficulty: lesson.difficulty === 'advanced' ? 'Hard' : lesson.difficulty === 'intermediate' ? 'Medium' : 'Easy',
      statement: [lesson.practice, 'Expected behavior', lesson.exercise.expected, 'Completion', lesson.exercise.completion].join('\n\n'),
      samples: (lesson.exercise.samples ?? []).map((sample, index) => ({ ...sample, label: 'Sample ' + (index + 1) })),
    }, lesson.starter)
    if (target !== window) throw new Error('The Learn window closed.')
    const path = await library.openAttempt(started.problem.id, started.attempt.id)
    return { problemId: started.problem.id, entry: await files.grant(path, 'file', true) }
  })

  handle('projects-open', async (target, root) => (await activeProjects(target)).open(target, root))
  handle('projects-save', async (target, root, spec, token) => (await activeProjects(target)).save(target, root, spec, token))
  handle('projects-approve', async (target, root, id, token) => (await activeProjects(target)).approve(target, root, id, token))
  handle('projects-run', async (target, root, id, token) => (await activeProjects(target)).run(target, root, id, token))
  handle('projects-run-suite', async (target, root, ids, token) => (await activeProjects(target)).runSuite(target, root, ids, token))
  handle('projects-cancel-suite', (target, root) => projectHandlers?.cancelSuite(target, root) ?? false)
  handle('projects-automatic', async (target, root, id, token, enabled) =>
    (await activeProjects(target)).setAutomatic(target, root, id, token, enabled))
  handle('projects-provider', async (target) => (await onlineProjects(target)).provider(target))
  handle('projects-configure', async (target, value) => {
    const handlers = await onlineProjects(target)
    cancelExplanations()
    handlers.cancelOnline()
    return handlers.configure(target, value)
  })
  handle('projects-propose', async (target, goal) => (await onlineProjects(target)).propose(target, goal))
  handle('explanations-provider', activateExplanationPane)
  handle('explanations-configure', async (target, value) => {
    const lease = requireExplanationPane(target)
    const vault = await providerVault()
    if (!currentExplanationPane(lease)) throw new Error('The AI explanation pane changed.')
    cancelExplanations()
    projectHandlers?.cancelOnline()
    const settings = await vault.update(value)
    if (!explanationBoundary(lease)) throw new Error('The AI explanation pane changed.')
    return settings
  })
  handle('explanations-review', async (target, request) => (await explanations(target)).review(request))
  handle('explanations-send', async (target, token) => (await explanations(target)).send(token))
  handle('explanations-open-citation', async (target, token, sourceId, range) =>
    (await explanations(target)).openCitation(token, sourceId, range))
  handle('explanations-cancel', async target => {
    if (target !== window) return
    const service = explanationService
    cancelExplanations()
    // Report completion only after the existing owner has released its files,
    // native consent and response stream; do not admit a replacement operation.
    if (service?.instance) await service.instance.drain()
    else await service?.pending.then(instance => instance.drain())
  })
  handle('project-lens-analyze', async (target, root) => {
    if (typeof root !== 'string') throw new Error('Choose an open project folder.')
    return (await projectLens(target)).analyze(root)
  })
  handle('project-lens-open', async (target, root, reference) => {
    if (typeof root !== 'string') throw new Error('Choose an open project folder.')
    return (await projectLens(target)).openReference(root, reference)
  })
  handle('project-lens-cancel', (target) => {
    if (target === window) return projectLensService?.then(service => service.cancel(), () => undefined)
  })

  handle('practice-browse', async (_target, filters) => (await practice()).browse(filters))
  handle('practice-challenge', async (_target, id) => (await practice()).getChallenge(id))
  handle('practice-start', async (target, challengeId, language) => {
    const library = await practice()
    const started = await library.start(challengeId, language)
    const path = await library.openAttempt(started.problem.id, started.attempt.id)
    if (target !== window) throw new Error('The practice window has closed.')
    return { ...started, entry: await files.grant(path, 'file', true) }
  })
  handle('practice-list', async () => (await practice()).list())
  handle('practice-get', async (_target, id) => (await practice()).get(id))
  handle('practice-save', async (_target, draft) => (await practice()).save(draft))
  handle('practice-create-attempt', async (_target, id, label) => (await practice()).createAttempt(id, label))
  handle('practice-open-attempt', async (target, id, attempt) => {
    const path = await (await practice()).openAttempt(id, attempt)
    if (target !== window) throw new Error('The practice window has closed.')
    return files.grant(path, 'file', true)
  })
  handle('practice-run-samples', async (target, id, attempt) => {
    if (target !== window || panel !== 'learn' && panel !== 'practice') throw new Error('Open Learn or Practice before running samples.')
    if (practiceRun || runner.busy || activeRun || projectHandlers?.busy) throw new Error('A program or test is already running.')
    const generation = panelGeneration
    const controller = new AbortController()
    const job = practice().then((library) => library.runSamples(id, attempt, async (path, inputs, sourceRevision) => {
      if (controller.signal.aborted || target !== window || generation !== panelGeneration) return [cancelledRun()]
      const entry = await files.grant(path, 'file', true)
      if (controller.signal.aborted || target !== window || generation !== panelGeneration) return [cancelledRun()]
      return runPracticeSamples(target, entry.path, inputs, sourceRevision, controller.signal)
    }))
    practiceRun = { controller, job, panel }
    try {
      return await job
    } finally {
      practiceRun = null
    }
  })
  handle('practice-cancel-samples', (target) => {
    if (target === window) practiceRun?.controller.abort()
  })
  handle('stop-run', () => {
    projectHandlers?.stopAutomatic()
    void projectHandlers?.stopSuite()
    practiceRun?.controller.abort()
    activeRun?.controller.abort()
    runner.stop()
  })
  handle('confirm-window-close', (target, allow) => {
    if (!closePending || typeof allow !== 'boolean') return
    closePending = false
    if (!allow) {
      quitRequested = false
      restoreClosing = false
      const restore = pendingRestore; pendingRestore = undefined
      if (restore) void restore.service.cancel()
      const update = pendingUpdate
      pendingUpdate = undefined
      if (update) void update.prepared.dispose()
        .catch(() => console.warn('Could not remove canceled update staging. The installed app is unchanged.'))
        .finally(() => update.complete(false))
      return
    }
    closeApproved = true
    target.close()
  })
}

async function openFromSystem(path: string): Promise<void> {
  try {
    const entry = await files.grant(path, 'file')
    await preferences.remember(entry).catch(() => console.warn('Unable to save the Ion IDE recent-items list.'))
    const target = window ?? createWindow()
    const send = () => {
      if (!target.isDestroyed()) target.webContents.send('ion:open-entry', entry)
    }
    if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', send)
    else send()
  } catch {
    if (window) {
      void dialog.showMessageBox(window, {
        type: 'error', message: 'Unable to open ' + basename(path), detail: 'Choose a regular local file.',
      })
    }
  }
}

function queueSystemFile(path: string) {
  if (!isAbsolute(path)) return
  systemFileRequested = true
  if (restoreClosing) return
  if (initialized) void openFromSystem(path)
  else if (earlyFiles.length < 20) earlyFiles.push(path)
}

function openWindowsArguments(argv: string[]) {
  if (process.platform !== 'win32' || !app.isPackaged) return
  // Windows sends Explorer file opens as arguments, including on a second launch.
  for (const path of argv.slice(1, 21)) queueSystemFile(path)
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  queueSystemFile(path)
})

app.on('before-quit', (event) => {
  if (!window || closeApproved) return
  event.preventDefault()
  quitRequested = true
  window.close()
})

app.on('second-instance', (_event, argv) => {
  if ((pendingUpdate || pendingRestore || restoreClosing) && quitRequested) return
  openWindowsArguments(argv)
  if (!initialized) return
  const target = window ?? createWindow()
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
})

app.on('activate', () => {
  if (!window && initialized && !quitRequested) createWindow()
})

// The window's close handler drains owned processes and applies the selected profile.
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  if (!primaryInstance) return
  if (await hasPendingRestore(app.getPath('userData'))) {
    const { finishPendingRestore } = await import('./backup/transaction')
    try { await finishPendingRestore(app.getPath('userData')) }
    catch (error) {
      throw new Error('Ion stopped before opening your editor because restore repair could not finish. Quit Ion and keep both versions. Copy the entire profile before manual repair. Restore journals and original files are in .ion-restores; verified rollback archives are in .ion-backups. Profile: ' + app.getPath('userData') + '\n\n' + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
  }
  preferences = new PreferenceStore(join(app.getPath('userData'), 'preferences.json'))
  recovery = new RecoveryStore(join(app.getPath('userData'), 'recovery'))
  editorSession = new EditorSessionStore(join(app.getPath('userData'), 'editor-session.json'))
  themeStore = new ThemeStore(app.getPath('userData'), join(__dirname, 'themes'))
  const [startupPreferences] = await Promise.all([
    preferences.get().catch(() => undefined),
    registerSession(),
  ])
  openFullScreen = startupPreferences?.settings.openFullScreen ?? defaultSettings.openFullScreen
  smartLanguages = startupPreferences?.settings.smartLanguages ?? defaultSettings.smartLanguages
  learningLensEnabled = startupPreferences?.settings.learningLens ?? defaultSettings.learningLens
  registerIpc()
  installMenu(sendCommand, shortcutOverrides)
  openWindowsArguments(process.argv)
  initialized = true
  if (!window) createWindow()
  for (const path of earlyFiles.splice(0)) void openFromSystem(path)
}).catch(startupFailure)
