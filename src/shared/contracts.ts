import type { LearningBridge, LearningFeedback } from './learning'
import type { LearningPacksBridge } from './learning-packs'
import type { PracticeBridge } from './practice'
import type { ProjectsBridge } from './projects'
import type { ThemeData, ThemeDefinition, ThemeSummary } from './themes'
import type { ViewerBridge } from './viewers'
import type { RunConsoleBridge } from './run-console'
import type { NotebookKernelBridge, NotebookKernelLifetime } from './notebook-kernel'
import type { TextPage } from './large-text'
import type { UpdatesBridge } from './updates'
import type { MenuCommand, ShortcutOverrides } from './shortcuts'
import type { WorkspaceSearchResult } from './workspace-search'
import type { EditorSessionBridge } from './editor-session'
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
  accent: Accent
  fontSize: number
  tabSize: number
  wordWrap: boolean
  lineNumbers: boolean
  autoSave: boolean
  autoSaveDelay: number
  saveBeforeRun: boolean
  keepRunOutput: boolean
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
  accent: 'cyan',
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  lineNumbers: true,
  autoSave: true,
  autoSaveDelay: 900,
  saveBeforeRun: true,
  keepRunOutput: false,
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
  programMs?: number
  sourceChanged?: true
  learning?: LearningFeedback
}

export interface IonBridge {
  editorSession: EditorSessionBridge
  recovery: {
    list(): Promise<RecoveryDraft[]>
    read(id: string): Promise<string>
    write(draft: RecoveryDraft & { text: string }): Promise<void>
    remove(ids: string[]): Promise<void>
  }
  runConsole: RunConsoleBridge
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
