import type { CompilerProblem, LearningBridge, LearningFeedback } from './learning'
import type { LearningPacksBridge } from './learning-packs'
import type { PracticeBridge } from './practice'
import type { ProjectsBridge } from './projects'
import type { ThemeData, ThemeDefinition, ThemeSummary } from './themes'
import type { ViewerBridge } from './viewers'
import type { RunConsoleBridge } from './run-console'
import type { TerminalBridge } from './terminal'
import type { NotebookKernelBridge, NotebookKernelLifetime } from './notebook-kernel'
import type { TextPage } from './large-text'
import type { UpdatesBridge } from './updates'
import type { MenuCommand, ShortcutOverrides } from './shortcuts'
import type { WorkspaceSearchResult } from './workspace-search'
import type { EditorSessionBridge } from './editor-session'
import type { LanguageToolsBridge } from './language-tools'
import type { SourceControlBridge } from './source-control'
import type { FormatBridge, JavaFormatter, PythonFormatter } from './format-code'
export type { MenuCommand } from './shortcuts'

export type EntryKind = 'file' | 'folder'
export type ResourceProfile = 'minimal' | 'full'
export type OptionalPanel = 'learn' | 'projects' | 'practice'
export type WorkspaceMode = 'free' | 'learn' | 'projects' | 'practice'
export type Accent = 'cyan' | 'violet' | 'lime' | 'amber'

export interface Entry {
  path: string
  name: string
  kind: EntryKind
}

export interface RecentEntry extends Entry {
  lastOpened: number
}

export interface FileRevision {
  revision: string
  /** SHA-256 of the exact saved bytes, including any BOM or CRLF line endings. */
  contentHash?: string
}

export interface FileContents extends FileRevision {
  text: string
}

export interface MarkdownImage {
  bytes: ArrayBuffer
  mime: string
}

export interface RecoveryDraft {
  id: string
  name: string
  originalPath?: string
}

export interface Settings {
  resourceProfile: ResourceProfile
  openFullScreen: boolean
  checkUpdatesOnLaunch: boolean
  theme: string
  themeFavorites: string[]
  recentThemes: string[]
  accent: Accent
  fontSize: number
  tabSize: number
  wordWrap: boolean
  lineNumbers: boolean
  smartLanguages: string[]
  automaticSuggestions: boolean
  javaFormatter: JavaFormatter
  pythonFormatter: PythonFormatter
  autoSave: boolean
  autoSaveDelay: number
  saveBeforeRun: boolean
  keepRunOutput: boolean
  learningLens: boolean
  notebookKernelLifetime: NotebookKernelLifetime
  auxiliaryWidth: number
  explorerWidth: number
  outputHeight: number
  showExplorer: boolean
  showOutput: boolean
  shortcuts: ShortcutOverrides
}

export const defaultSettings: Readonly<Settings> = {
  resourceProfile: 'minimal',
  openFullScreen: false,
  checkUpdatesOnLaunch: false,
  theme: 'dark',
  themeFavorites: [],
  recentThemes: [],
  accent: 'cyan',
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  lineNumbers: true,
  smartLanguages: [],
  automaticSuggestions: true,
  javaFormatter: 'auto',
  pythonFormatter: 'auto',
  autoSave: true,
  autoSaveDelay: 900,
  saveBeforeRun: true,
  keepRunOutput: false,
  learningLens: true,
  notebookKernelLifetime: 'tab',
  auxiliaryWidth: 325,
  explorerWidth: 240,
  outputHeight: 216,
  showExplorer: true,
  showOutput: false,
  shortcuts: {},
}

export interface Preferences {
  settings: Settings
  recents: RecentEntry[]
}

export interface QuickOpenResult {
  entries: Entry[]
  truncated: boolean
}

export type RunStatus =
  | 'success'
  | 'compile-error'
  | 'runtime-error'
  | 'missing-toolchain'
  | 'timeout'
  | 'output-limit'
  | 'cancelled'
  | 'rejected'

export interface RunResult {
  status: RunStatus
  compiler: string | null
  compileOutput: string
  programOutput: string
  exitCode: number | null
  durationMs: number
  message: string
  programStdout?: string
  programStderr?: string
  programSignal?: string
  outputComplete?: boolean
  compileMs?: number
  compileVerified?: true
  programMs?: number
  sourceChanged?: true
  sourceRevision?: string
  problems?: CompilerProblem[]
  learning?: LearningFeedback
}

export interface IonBridge {
  readonly firstLaunch: boolean
  languageTools: LanguageToolsBridge
  formatting: FormatBridge
  editorSession: EditorSessionBridge
  recovery: {
    list(): Promise<RecoveryDraft[]>
    read(id: string): Promise<string>
    write(draft: RecoveryDraft & { text: string }): Promise<void>
    remove(ids: string[]): Promise<void>
  }
  runConsole: RunConsoleBridge
  terminal: TerminalBridge
  notebooks: NotebookKernelBridge
  viewers: ViewerBridge
  markdown: {
    readImage(sourcePath: string, href: string): Promise<MarkdownImage>
    openLink(sourcePath: string | null, href: string): Promise<Entry | null>
  }
  themes: {
    list(): Promise<ThemeSummary[]>
    load(id: string): Promise<ThemeData>
    import(): Promise<ThemeSummary | null>
    export(id: string): Promise<boolean>
    create(theme: ThemeDefinition): Promise<ThemeSummary>
  }
  learning: LearningBridge
  learningPacks: LearningPacksBridge
  practice: PracticeBridge
  projects: ProjectsBridge
  sourceControl: {
    status(root: string): ReturnType<SourceControlBridge['status']>
    trust(root: string): Promise<boolean>
    diff(root: string, request: Parameters<SourceControlBridge['diff']>[0]): ReturnType<SourceControlBridge['diff']>
    change(root: string, request: Parameters<SourceControlBridge['change']>[0]): ReturnType<SourceControlBridge['change']>
    commit(root: string, request: Parameters<SourceControlBridge['commit']>[0]): ReturnType<SourceControlBridge['commit']>
    close(root: string): ReturnType<SourceControlBridge['close']>
  }
  platform: 'darwin' | 'win32' | 'linux'
  setOptionalPanel(panel: OptionalPanel | null, projectPath?: string): Promise<void>
  getPreferences(): Promise<Preferences>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  updates: UpdatesBridge
  exportLocalProfile(): Promise<string | null>
  openFolder(): Promise<Entry | null>
  openFile(): Promise<Entry | null>
  saveFileAs(name: string, text: string, mode?: 'notebook'): Promise<(Entry & FileRevision) | null>
  openRecent(path: string): Promise<Entry>
  quickOpen: {
    search(query: string): Promise<QuickOpenResult>
    open(path: string): Promise<Entry>
  }
  workspaceSearch: {
    search(id: string, query: string): Promise<WorkspaceSearchResult>
    cancel(id: string): Promise<void>
  }
  listDirectory(path: string): Promise<Entry[]>
  readFile(path: string, mode?: 'notebook'): Promise<FileContents>
  readTextPage(path: string, page: number, revision?: string): Promise<TextPage>
  saveFile(path: string, text: string, revision: string, baseHash?: string): Promise<FileRevision>
  createEntry(parent: string, name: string, kind: EntryKind, initialText?: string): Promise<Entry>
  renameEntry(path: string, name: string): Promise<Entry>
  trashEntry(path: string): Promise<boolean>
  stopRun(): Promise<void>
  onCommand(callback: (command: MenuCommand) => void): () => void
  onOpenEntry(callback: (entry: Entry) => void): () => void
  onCloseRequest(callback: () => void): () => void
  confirmWindowClose(allow: boolean): Promise<void>
}
