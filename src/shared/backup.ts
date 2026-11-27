export const backupCategories = ['preferences', 'themes', 'learning', 'content', 'practice', 'projects', 'tests', 'session', 'recovery'] as const
export type BackupCategory = typeof backupCategories[number]
export const backupLabels: Record<BackupCategory, string> = { preferences: 'Preferences and recent locations', themes: 'Custom themes',
  learning: 'Learning history and activity', content: 'Saved learning content', practice: 'Practice, notes, source and results',
  projects: 'Roadmaps, tests and historical evidence', tests: 'Test Explorer history', session: 'Editor session references', recovery: 'Recoverable unsaved drafts' }
export interface BackupFolder { id: string; name: string; mode: 'reference' | 'copy' | 'exclude' }
export interface BackupScope { categories: BackupCategory[]; folders: BackupFolder[] }
export interface BackupReview {
  token: string; kind: 'backup' | 'restore'; expiresAt: number; name: string; bytes: number; files: number
  categories: Array<{ id: BackupCategory; files: number; bytes: number; present: boolean; conflict: boolean }>
  folders: BackupFolder[]; exclusions: Array<{ name: string; reason: string }>; exclusionsOmitted: number
  legacy: boolean; warnings: string[]
  entries: Array<{ path: string; bytes: number }>
  projects: Array<{ id: string; title: string; category: 'projects' | 'tests'; originalPath?: string }>
}
export interface RestoreChoices { replace: BackupCategory[]; mappings: Array<{ id: string; folderId: string }>; copyFolders: string[] }
export interface BackupProgress { phase: 'reviewing' | 'copying' | 'validating' | 'writing' | 'preparing' | 'finished'; files: number; bytes: number }
export interface BackupBridge {
  folders(): Promise<BackupFolder[]>
  chooseFolder(): Promise<BackupFolder | null>
  review(scope: BackupScope): Promise<BackupReview>
  create(token: string): Promise<string | null>
  openRestore(legacy?: boolean): Promise<BackupReview | null>
  prepareRestore(token: string, choices: RestoreChoices): Promise<{ token: string; rollback: string }>
  applyRestore(token: string): Promise<void>
  cancel(): Promise<void>
  onProgress(callback: (progress: BackupProgress) => void): () => void
}
