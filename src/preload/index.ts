import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Entry, IonBridge, MenuCommand } from '../shared/contracts'

if (process.platform === 'win32') {
  document.addEventListener('dragover', (event) => {
    if (event.isTrusted && event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }, true)
  document.addEventListener('drop', (event) => {
    if (!event.isTrusted || !event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files).slice(0, 16)
      .map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    if (paths.length) void ipcRenderer.invoke('ion:open-dropped-files', paths).catch(() => {})
  }, true)
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function buffered<T>(channel: string): (callback: (value: T) => void) => () => void {
  const pending: T[] = []
  const callbacks = new Set<(value: T) => void>()
  subscribe<T>(channel, (value) => {
    if (callbacks.size) {
      for (const callback of callbacks) callback(value)
    } else if (pending.length < 16) {
      pending.push(value)
    }
  })
  return (callback) => {
    callbacks.add(callback)
    for (const item of pending.splice(0)) callback(item)
    return () => { callbacks.delete(callback) }
  }
}

const bridge: IonBridge = {
  backup: {
    folders: () => ipcRenderer.invoke('ion:backup-folders'),
    chooseFolder: () => ipcRenderer.invoke('ion:backup-choose-folder'),
    review: scope => ipcRenderer.invoke('ion:backup-review', scope),
    create: token => ipcRenderer.invoke('ion:backup-create', token),
    openRestore: legacy => ipcRenderer.invoke('ion:backup-open-restore', legacy),
    prepareRestore: (token, choices) => ipcRenderer.invoke('ion:backup-prepare-restore', token, choices),
    applyRestore: token => ipcRenderer.invoke('ion:backup-apply-restore', token),
    cancel: () => ipcRenderer.invoke('ion:backup-cancel'),
    onProgress: callback => subscribe('ion:backup-progress', callback),
  },
  platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
  firstLaunch: process.argv.includes('--ion-first-launch'),
  languageTools: {
    query: (snapshot) => ipcRenderer.invoke('ion:language-query', snapshot),
    cancel: (requestId) => ipcRenderer.invoke('ion:language-cancel', requestId),
    saved: (value) => ipcRenderer.invoke('ion:language-saved', value),
    release: (immediate, language, path) => ipcRenderer.invoke('ion:language-release', immediate, language, path),
    status: () => ipcRenderer.invoke('ion:language-status'),
    restart: (language) => ipcRenderer.invoke('ion:language-restart', language),
    reviewRename: (snapshot, replacement, dirtyPaths) => ipcRenderer.invoke('ion:language-rename-review', snapshot, replacement, dirtyPaths),
    applyEdit: (token) => ipcRenderer.invoke('ion:language-edit-apply', token),
  },
  debug: {
    start: (request) => ipcRenderer.invoke('ion:debug-start', request),
    stop: (sessionId) => ipcRenderer.invoke('ion:debug-stop', sessionId),
    action: (sessionId, action, threadId) => ipcRenderer.invoke('ion:debug-action', sessionId, action, threadId),
    stack: (sessionId, threadId) => ipcRenderer.invoke('ion:debug-stack', sessionId, threadId),
    scopes: (sessionId, frameId) => ipcRenderer.invoke('ion:debug-scopes', sessionId, frameId),
    variables: (sessionId, variablesReference) => ipcRenderer.invoke('ion:debug-variables', sessionId, variablesReference),
    evaluate: (sessionId, expression, frameId) => ipcRenderer.invoke('ion:debug-evaluate', sessionId, expression, frameId),
    status: () => ipcRenderer.invoke('ion:debug-status'),
    onEvent: callback => subscribe('ion:debug-event', callback),
  },
  formatting: {
    run: (request) => ipcRenderer.invoke('ion:format-source', request),
    cancel: (id) => ipcRenderer.invoke('ion:format-cancel', id),
  },
  projectLens: {
    analyze: root => ipcRenderer.invoke('ion:project-lens-analyze', root),
    cancel: () => ipcRenderer.invoke('ion:project-lens-cancel'),
    openReference: (root, reference) => ipcRenderer.invoke('ion:project-lens-open', root, reference),
  },
  explanations: {
    provider: purpose => ipcRenderer.invoke('ion:explanations-provider', purpose),
    configure: value => ipcRenderer.invoke('ion:explanations-configure', value),
    review: request => ipcRenderer.invoke('ion:explanations-review', request),
    send: token => ipcRenderer.invoke('ion:explanations-send', token),
    cancel: () => ipcRenderer.invoke('ion:explanations-cancel'),
    openCitation: (token, sourceId, range) => ipcRenderer.invoke('ion:explanations-open-citation', token, sourceId, range),
  },
  setOptionalPanel: (panel, path) => ipcRenderer.invoke('ion:set-optional-panel', panel, path),
  getPreferences: () => ipcRenderer.invoke('ion:get-preferences'),
  updateSettings: (patch) => ipcRenderer.invoke('ion:update-settings', patch),
  clearRunTrust: () => ipcRenderer.invoke('ion:clear-run-trust'),
  updates: {
    status: () => ipcRenderer.invoke('ion:updates-status'),
    check: () => ipcRenderer.invoke('ion:updates-check'),
    download: () => ipcRenderer.invoke('ion:updates-download'),
    install: () => ipcRenderer.invoke('ion:updates-install'),
    cancel: () => ipcRenderer.invoke('ion:updates-cancel'),
  },
  exportLocalProfile: () => ipcRenderer.invoke('ion:export-local-profile'),
  editorSession: {
    available: () => ipcRenderer.invoke('ion:editor-session-available'),
    save: (snapshot) => ipcRenderer.invoke('ion:editor-session-save', snapshot),
    resume: () => ipcRenderer.invoke('ion:editor-session-resume'),
  },
  recovery: {
    list: () => ipcRenderer.invoke('ion:recovery-list'),
    read: (id) => ipcRenderer.invoke('ion:recovery-read', id),
    write: (draft) => ipcRenderer.invoke('ion:recovery-write', draft),
    remove: (ids) => ipcRenderer.invoke('ion:recovery-remove', ids),
  },
  runConsole: {
    projectInputs: (path) => ipcRenderer.invoke('ion:live-run-project-inputs', path),
    start: (id, path, learn, expectedRevision) => ipcRenderer.invoke('ion:live-run-start', id, path, learn, expectedRevision),
    input: (id, data) => ipcRenderer.invoke('ion:live-run-input', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('ion:live-run-resize', id, cols, rows),
    cancel: (id) => ipcRenderer.invoke('ion:live-run-cancel', id),
    onUpdate: (callback) => subscribe('ion:live-run-update', callback),
    preview: (path) => ipcRenderer.invoke('ion:web-preview', path),
  },
  tasks: {
    discover: (root) => ipcRenderer.invoke('ion:tasks-discover', root),
    list: (root) => ipcRenderer.invoke('ion:tasks-list', root),
    run: (root, taskId, revision, runId) => ipcRenderer.invoke('ion:tasks-run', root, taskId, revision, runId),
    cancel: () => ipcRenderer.invoke('ion:tasks-cancel'),
  },
  testExplorer: {
    list: (root) => ipcRenderer.invoke('ion:test-explorer-list', root),
    discover: (root, adapter) => ipcRenderer.invoke('ion:test-explorer-discover', root, adapter),
    run: (root, revision, ids) => ipcRenderer.invoke('ion:test-explorer-run', root, revision, ids),
    cancel: () => ipcRenderer.invoke('ion:test-explorer-cancel'),
  },
  terminal: {
    create: (columns, rows, root) => ipcRenderer.invoke('ion:terminal-create', columns, rows, root),
    attach: (id) => ipcRenderer.invoke('ion:terminal-attach', id),
    ack: (id, sequence) => ipcRenderer.invoke('ion:terminal-ack', id, sequence),
    input: (id, text) => ipcRenderer.invoke('ion:terminal-input', id, text),
    resize: (id, columns, rows) => ipcRenderer.invoke('ion:terminal-resize', id, columns, rows),
    close: (id) => ipcRenderer.invoke('ion:terminal-close', id),
    setFocus: (focused) => ipcRenderer.invoke('ion:terminal-focus', focused),
    copy: (text) => ipcRenderer.invoke('ion:terminal-copy', text),
    paste: () => ipcRenderer.invoke('ion:terminal-paste'),
    onEvent: (callback) => subscribe('ion:terminal-event', callback),
  },
  notebooks: {
    discover: (path) => ipcRenderer.invoke('ion:notebook-kernel-discover', path),
    choose: (path) => ipcRenderer.invoke('ion:notebook-kernel-choose', path),
    status: (path) => ipcRenderer.invoke('ion:notebook-kernel-status', path),
    run: (path, request) => ipcRenderer.invoke('ion:notebook-kernel-run', path, request),
    restart: (path) => ipcRenderer.invoke('ion:notebook-kernel-restart', path),
    interrupt: (path) => ipcRenderer.invoke('ion:notebook-kernel-interrupt', path),
    stop: (path) => ipcRenderer.invoke('ion:notebook-kernel-stop', path),
    release: (path, keep) => ipcRenderer.invoke('ion:notebook-kernel-release', path, keep),
    onOutput: (listener) => subscribe('ion:notebook-kernel-output', listener),
  },
  viewers: {
    open: (path, request) => ipcRenderer.invoke('ion:viewer-open', path, request),
    close: (id) => ipcRenderer.invoke('ion:viewer-close', id),
    cancel: (request) => ipcRenderer.invoke('ion:viewer-cancel', request),
    openExternal: (path) => ipcRenderer.invoke('ion:viewer-external', path),
    readPdf: (id, offset, length) => ipcRenderer.invoke('ion:viewer-pdf-read', id, offset, length),
    tablePage: (id, sheet, row, column, rows, columns) => ipcRenderer.invoke('ion:viewer-table-page', id, sheet, row, column, rows, columns),
    tableSearch: (id, sheet, query, after) => ipcRenderer.invoke('ion:viewer-table-search', id, sheet, query, after),
    wordPage: (id, page) => ipcRenderer.invoke('ion:viewer-word-page', id, page),
    wordImage: (id, image) => ipcRenderer.invoke('ion:viewer-word-image', id, image),
  },
  markdown: {
    readImage: (path, href) => ipcRenderer.invoke('ion:markdown-read-image', path, href),
    openLink: (path, href) => ipcRenderer.invoke('ion:markdown-open-link', path, href),
  },
  themes: {
    list: () => ipcRenderer.invoke('ion:themes-list'),
    load: (id) => ipcRenderer.invoke('ion:themes-load', id),
    import: () => ipcRenderer.invoke('ion:themes-import'),
    export: (id) => ipcRenderer.invoke('ion:themes-export', id),
    create: (theme) => ipcRenderer.invoke('ion:themes-create', theme),
  },
  openFolder: () => ipcRenderer.invoke('ion:open-folder'),
  addFolder: () => ipcRenderer.invoke('ion:add-folder'),
  removeFolder: (path) => ipcRenderer.invoke('ion:remove-folder', path),
  reorderFolder: (path, offset) => ipcRenderer.invoke('ion:reorder-folder', path, offset),
  saveWorkspace: (roots, settings) => ipcRenderer.invoke('ion:workspace-save', roots, settings),
  openWorkspace: () => ipcRenderer.invoke('ion:workspace-open'),
  openFile: () => ipcRenderer.invoke('ion:open-file'),
  saveFileAs: (name, text, mode) => ipcRenderer.invoke('ion:save-file-as', name, text, mode),
  openRecent: (path) => ipcRenderer.invoke('ion:open-recent', path),
  quickOpen: {
    search: (query) => ipcRenderer.invoke('ion:quick-open-search', query),
    open: (path) => ipcRenderer.invoke('ion:quick-open-file', path),
  },
  workspaceSearch: {
    search: (id, query) => ipcRenderer.invoke('ion:workspace-search', id, query),
    cancel: (id) => ipcRenderer.invoke('ion:workspace-search-cancel', id),
    review: (query, replacement) => ipcRenderer.invoke('ion:workspace-replace-review', query, replacement),
    apply: (token, paths) => ipcRenderer.invoke('ion:workspace-replace-apply', token, paths),
  },
  sourceControl: {
    status: (root) => ipcRenderer.invoke('ion:source-control-status', root),
    trust: (root) => ipcRenderer.invoke('ion:source-control-trust', root),
    createTag: (root, request) => ipcRenderer.invoke('ion:source-control-create-tag', root, request),
    createBranch: (root, request) => ipcRenderer.invoke('ion:source-control-create-branch', root, request),
    switchBranch: (root, request) => ipcRenderer.invoke('ion:source-control-switch-branch', root, request),
    fetchGitHub: (root, request) => ipcRenderer.invoke('ion:source-control-fetch-github', root, request),
    saveStashSnapshot: (root) => ipcRenderer.invoke('ion:source-control-stash-snapshot', root),
    conflict: (root, request) => ipcRenderer.invoke('ion:source-control-conflict', root, request),
    cancelBlame: (root, path) => ipcRenderer.invoke('ion:source-control-cancel-blame', root, path),
    blame: (root, request) => ipcRenderer.invoke('ion:source-control-blame', root, request),
    previewComparison: (root, request) => ipcRenderer.invoke('ion:source-control-compare', root, request),
    browse: (root) => ipcRenderer.invoke('ion:source-control-browse', root),
    github: (root, repository) => ipcRenderer.invoke('ion:source-control-github', root, repository),
    githubSignIn: (root) => ipcRenderer.invoke('ion:source-control-github-sign-in', root),
    githubSignOut: (root) => ipcRenderer.invoke('ion:source-control-github-sign-out', root),
    onGitHubAuthEvent: callback => subscribe('ion:source-control-github-auth-event', callback),
    githubPullRequest: (root, request) => ipcRenderer.invoke('ion:source-control-github-pull-request', root, request),
    githubIssue: (root, request) => ipcRenderer.invoke('ion:source-control-github-issue', root, request),
    createGitHubPullRequest: (root, request) => ipcRenderer.invoke('ion:source-control-github-create-pull-request', root, request),
    cloneGitHub: (root, repository, access) => ipcRenderer.invoke('ion:source-control-github-clone', root, repository, access),
    closeGitHub: (root) => ipcRenderer.invoke('ion:source-control-github-close', root),
    openGitHubPage: (root, url) => ipcRenderer.invoke('ion:source-control-github-open', root, url),
    diff: (root, request) => ipcRenderer.invoke('ion:source-control-diff', root, request),
    change: (root, request) => ipcRenderer.invoke('ion:source-control-change', root, request),
    commit: (root, request) => ipcRenderer.invoke('ion:source-control-commit', root, request),
    close: (root) => ipcRenderer.invoke('ion:source-control-close', root),
  },
  listDirectory: (path) => ipcRenderer.invoke('ion:list-directory', path),
  readFile: (path, mode) => ipcRenderer.invoke('ion:read-file', path, mode),
  readTextPage: (path, page, revision) => ipcRenderer.invoke('ion:read-text-page', path, page, revision),
  saveFile: (path, text, revision, baseHash) => ipcRenderer.invoke('ion:save-file', path, text, revision, baseHash),
  createEntry: (parent, name, kind, initialText) => ipcRenderer.invoke('ion:create-entry', parent, name, kind, initialText),
  renameEntry: (path, name) => ipcRenderer.invoke('ion:rename-entry', path, name),
  trashEntry: (path) => ipcRenderer.invoke('ion:trash-entry', path),
  copyPath: (path) => ipcRenderer.invoke('ion:copy-path', path),
  revealInFolder: (path) => ipcRenderer.invoke('ion:reveal-in-folder', path),
  learning: {
    getTopics: () => ipcRenderer.invoke('ion:learning-topics'),
    getConcept: (id) => ipcRenderer.invoke('ion:learning-concept', id),
    getHistory: () => ipcRenderer.invoke('ion:learning-history'),
    clearHistory: () => ipcRenderer.invoke('ion:learning-clear'),
    recordTopic: (id, action) => ipcRenderer.invoke('ion:learning-topic', id, action),
    getLearningActivity: (pack, lesson) => ipcRenderer.invoke('ion:learning-lesson-activity', pack, lesson),
    recordLearningActivity: (pack, lesson, action) => ipcRenderer.invoke('ion:learning-lesson-record', pack, lesson, action),
    getLearningTaskEvidence: (pack, lesson) => ipcRenderer.invoke('ion:learning-task-evidence', pack, lesson),
  },
  learningPacks: {
    getLibrary: (includeCatalog) => ipcRenderer.invoke('ion:learning-packs-library', includeCatalog),
    install: (id) => ipcRenderer.invoke('ion:learning-packs-install', id),
    remove: (id) => ipcRenderer.invoke('ion:learning-packs-remove', id),
    select: (id, includeCatalog) => ipcRenderer.invoke('ion:learning-packs-select', id, includeCatalog),
    previewImport: () => ipcRenderer.invoke('ion:learning-packs-import-preview'),
    confirmImport: (token) => ipcRenderer.invoke('ion:learning-packs-import-confirm', token),
    discardImport: (token) => ipcRenderer.invoke('ion:learning-packs-import-discard', token),
    exportPack: (id) => ipcRenderer.invoke('ion:learning-packs-export', id),
    getDetails: (id) => ipcRenderer.invoke('ion:learning-packs-details', id),
    getTopics: (id) => ipcRenderer.invoke('ion:learning-packs-topics', id),
    getLesson: (id, topic) => ipcRenderer.invoke('ion:learning-packs-lesson', id, topic),
    startExercise: (id, topic) => ipcRenderer.invoke('ion:learning-packs-exercise', id, topic),
  },
  projects: {
    open: (path) => ipcRenderer.invoke('ion:projects-open', path),
    save: (path, spec, revision) => ipcRenderer.invoke('ion:projects-save', path, spec, revision),
    approve: (path, testId, revision) => ipcRenderer.invoke('ion:projects-approve', path, testId, revision),
    setAutomatic: (path, testId, revision, enabled) => ipcRenderer.invoke('ion:projects-automatic', path, testId, revision, enabled),
    run: (path, testId, revision) => ipcRenderer.invoke('ion:projects-run', path, testId, revision),
    runSuite: (path, testIds, revision) => ipcRenderer.invoke('ion:projects-run-suite', path, testIds, revision),
    cancelSuite: (path) => ipcRenderer.invoke('ion:projects-cancel-suite', path),
    provider: () => ipcRenderer.invoke('ion:projects-provider'),
    configure: (value) => ipcRenderer.invoke('ion:projects-configure', value),
    propose: (goal) => ipcRenderer.invoke('ion:projects-propose', goal),
    onSourceSaved: (callback) => subscribe('ion:projects-source-saved', callback),
  },
  practice: {
    progress: () => ipcRenderer.invoke('ion:practice-progress'),
    cancelProgress: () => ipcRenderer.invoke('ion:practice-cancel-progress'),
    browse: (filters) => ipcRenderer.invoke('ion:practice-browse', filters),
    getChallenge: (id) => ipcRenderer.invoke('ion:practice-challenge', id),
    start: (id, language) => ipcRenderer.invoke('ion:practice-start', id, language),
    list: () => ipcRenderer.invoke('ion:practice-list'),
    get: (id) => ipcRenderer.invoke('ion:practice-get', id),
    save: (draft) => ipcRenderer.invoke('ion:practice-save', draft),
    createAttempt: (id, label) => ipcRenderer.invoke('ion:practice-create-attempt', id, label),
    openAttempt: (id, attempt) => ipcRenderer.invoke('ion:practice-open-attempt', id, attempt),
    runSamples: (id, attempt) => ipcRenderer.invoke('ion:practice-run-samples', id, attempt),
    submit: (id, attempt) => ipcRenderer.invoke('ion:practice-submit', id, attempt),
    cancelSamples: () => ipcRenderer.invoke('ion:practice-cancel-samples'),
  },
  stopRun: () => ipcRenderer.invoke('ion:stop-run'),
  onCommand: buffered<MenuCommand>('ion:command'),
  onOpenEntry: buffered<Entry>('ion:open-entry'),
  onCloseRequest: buffered<undefined>('ion:close-request'),
  confirmWindowClose: (allow) => ipcRenderer.invoke('ion:confirm-window-close', allow),
}

contextBridge.exposeInMainWorld('ion', bridge)
