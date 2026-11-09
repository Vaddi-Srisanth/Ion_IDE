import type { Entry, RecoveryDraft } from './contracts'

export const editorSessionTabLimit = 64
export const editorViewSelectionLimit = 64

export interface EditorSelection {
  selectionStartLineNumber: number
  selectionStartColumn: number
  positionLineNumber: number
  positionColumn: number
}

export interface EditorViewState {
  selections: EditorSelection[]
  scrollTop: number
  scrollLeft: number
}

interface SessionTabView {
  name: string
  view?: EditorViewState
  notebookMode?: 'notebook' | 'json'
}

export interface EditorSessionTab extends SessionTabView {
  path: string | null
  draftId?: string
}

export interface EditorSessionSnapshot {
  rootPath: string | null
  activeIndex: number
  tabs: EditorSessionTab[]
}

export interface ResumedEditorSession {
  root: Entry | null
  tabs: Array<SessionTabView & { index: number; entry?: Entry; draft?: RecoveryDraft }>
  activeIndex: number
  skipped: number
}

export interface EditorSessionBridge {
  available(): Promise<boolean>
  save(snapshot: EditorSessionSnapshot): Promise<void>
  resume(): Promise<ResumedEditorSession>
}
