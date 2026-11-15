// TEST ONLY: deterministic data transport for real compiled renderer screenshots.
// This cannot execute, persist, install, recover, or verify native Ion features.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repository = fileURLToPath(new URL('../', import.meta.url));
export async function browserFixtureData(theme = 'dark', { freshCatalog = false } = {}) {
  if (!['dark', 'light'].includes(theme)) throw new Error('Unsupported fixture theme.');
  const palette = JSON.parse(await readFile(join(repository, 'src/main/themes/palettes', theme + '.json'), 'utf8'));
  const pack = JSON.parse(await readFile(join(repository, 'src/main/learning/catalog/java.json'), 'utf8'));
  return { theme, palette: { ...palette, id: theme, source: 'builtin' }, pack, freshCatalog };
}

// Playwright serializes this function and its explicit argument into a fresh page.
export function installBrowserFixture({ theme, palette, pack, freshCatalog = false }) {
  const root = '/ion-browser-fixture/study-space';
  const folder = { kind: 'folder', name: 'study-space', path: root };
  const entry = { kind: 'file', name: 'Main.java', path: root + '/Main.java' };
  const text = 'import java.util.List;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<String> topics = List.of("Syntax", "Collections", "Testing");\n        for (String topic : topics) {\n            System.out.println(topic);\n        }\n    }\n}\n';
  const calls = [], failures = [], subscribers = new Map();
  const clone = value => structuredClone(value);
  const record = (method, value) => { if (calls.length >= 500) throw new Error('Fixture bridge call limit.'); calls.push(method); return clone(value); };
  const reply = (method, value) => async () => record(method, value);
  const forbidden = method => async () => { failures.push(method); throw new Error('Unsupported UI fixture bridge method: ' + method); };
  const subscribe = name => callback => {
    if (typeof callback !== 'function') throw new Error('Invalid fixture subscriber.');
    const callbacks = subscribers.get(name) ?? new Set();
    subscribers.set(name, callbacks); callbacks.add(callback);
    return () => callbacks.delete(callback);
  };
  let settings = {
    resourceProfile: 'minimal', openFullScreen: false, checkUpdatesOnLaunch: false,
    theme, themeFavorites: [], recentThemes: [], accent: 'cyan', fontSize: 14,
    tabSize: 4, wordWrap: false, lineNumbers: true, smartLanguages: [], automaticSuggestions: false,
    javaFormatter: 'auto', pythonFormatter: 'auto', autoSave: false, autoSaveDelay: 900,
    saveBeforeRun: true, keepRunOutput: false, learningLens: true, notebookKernelLifetime: 'tab',
    auxiliaryWidth: 325, explorerWidth: 240, outputHeight: 216, showExplorer: true,
    showOutput: false, shortcuts: {},
  };
  const summary = { id: pack.id, name: pack.name, summary: pack.summary, version: pack.version,
    topicCount: pack.lessons.length, ...pack.metadata, source: 'catalog', offline: true, diagnostics: true };
  const topics = pack.lessons.map(({ id, title, section, difficulty, prerequisites, related, keywords }) =>
    ({ id, title, section, difficulty, prerequisites, related, keywords }));
  let selected = freshCatalog ? null : 'java';
  let materialized = !freshCatalog;
  const library = (catalog = false) => ({ installed: materialized ? [summary] : [], catalog: catalog ? [summary] : [], selected });
  const checkedPack = id => { if (id !== 'java') throw new Error('Unknown fixture pack.'); };
  const draftMap = new Map();
  window.ion = {
    firstLaunch: false, platform: 'darwin',
    getPreferences: async () => record('getPreferences', { settings, recents: [
      { ...folder, lastOpened: 1 }, { ...entry, lastOpened: 1 },
    ] }),
    updateSettings: async patch => {
      for (const key of Object.keys(patch)) if (!(key in settings)) throw new Error('Unknown fixture setting: ' + key);
      settings = { ...settings, ...clone(patch) }; return record('updateSettings', settings);
    },
    editorSession: { available: reply('editorSession.available', false),
      save: async snapshot => { if (!snapshot || !Array.isArray(snapshot.tabs)) throw new Error('Invalid session fixture.'); record('editorSession.save', null); },
      resume: forbidden('editorSession.resume') },
    recovery: { list: reply('recovery.list', []),
      read: async id => { if (!draftMap.has(id)) throw new Error('Unknown fixture draft.'); return draftMap.get(id); },
      write: async draft => { if (typeof draft.text !== 'string' || draft.text.length > 65536) throw new Error('Invalid fixture draft.'); draftMap.set(draft.id, draft.text); record('recovery.write', null); },
      remove: async ids => { ids.forEach(id => draftMap.delete(id)); record('recovery.remove', null); } },
    themes: { load: async id => { if (id !== theme) throw new Error('Unexpected theme request: ' + id); return record('themes.load', palette); },
      list: reply('themes.list', [{ id: theme, name: palette.name, appearance: theme, source: 'builtin' }]),
      import: forbidden('themes.import'), export: forbidden('themes.export'), create: forbidden('themes.create') },
    learningPacks: {
      getLibrary: async includeCatalog => record('learningPacks.getLibrary', library(includeCatalog)),
      getDetails: async id => { checkedPack(id); return record('learningPacks.getDetails', { pack: summary, topics,
        prerequisites: pack.metadata?.prerequisites ?? [], references: pack.metadata?.references ?? [], miniProject: pack.metadata?.miniProject }); },
      getTopics: async id => { checkedPack(id); return record('learningPacks.getTopics', topics); },
      getLesson: async (id, topic) => { checkedPack(id); const lesson = pack.lessons.find(item => item.id === topic);
        if (!lesson) throw new Error('Unknown fixture lesson.'); return record('learningPacks.getLesson', lesson); },
      select: async (id, includeCatalog) => {
        if (id !== null) { checkedPack(id); materialized = true; }
        selected = id; return record('learningPacks.select', library(includeCatalog));
      },
      install: forbidden('learningPacks.install'), remove: forbidden('learningPacks.remove'), startExercise: forbidden('learningPacks.startExercise'),
      previewImport: forbidden('learningPacks.previewImport'), confirmImport: forbidden('learningPacks.confirmImport'),
      discardImport: forbidden('learningPacks.discardImport'), exportPack: forbidden('learningPacks.exportPack'),
    },
    learning: { getTopics: reply('learning.getTopics', []), getHistory: reply('learning.getHistory', { categories: [], topics: [] }),
      getConcept: forbidden('learning.getConcept'), clearHistory: forbidden('learning.clearHistory'), recordTopic: forbidden('learning.recordTopic') },
    setOptionalPanel: async mode => { if (![null, 'learn', 'practice', 'projects'].includes(mode)) throw new Error('Unexpected fixture panel.'); record('setOptionalPanel:' + mode, null); },
    openFolder: reply('openFolder', folder), openFile: reply('openFile', entry),
    openRecent: async path => { if (path === root) return record('openRecent', folder); if (path === entry.path) return record('openRecent', entry); throw new Error('Unknown fixture recent.'); },
    listDirectory: async path => { if (path !== root) throw new Error('Unknown fixture directory.'); return record('listDirectory', [entry]); },
    readFile: async path => { if (path !== entry.path) throw new Error('Unknown fixture file.'); return record('readFile', { text, revision: 'fixture-r1' }); },
    quickOpen: { search: async query => record('quickOpen.search', { entries: query && !'main.java'.includes(query.toLowerCase()) ? [] : [entry], truncated: false }),
      open: async path => { if (path !== entry.path) throw new Error('Unknown Quick Open fixture.'); return record('quickOpen.open', entry); } },
    saveFile: forbidden('saveFile'), saveFileAs: forbidden('saveFileAs'), createEntry: forbidden('createEntry'), renameEntry: forbidden('renameEntry'), trashEntry: forbidden('trashEntry'),
    readTextPage: forbidden('readTextPage'), exportLocalProfile: forbidden('exportLocalProfile'), clearRunTrust: forbidden('clearRunTrust'),
    runConsole: { onUpdate: subscribe('runUpdate'), start: forbidden('runConsole.start'), cancel: forbidden('runConsole.cancel'), input: forbidden('runConsole.input'), resize: forbidden('runConsole.resize'), projectInputs: forbidden('runConsole.projectInputs'), preview: forbidden('runConsole.preview') },
    stopRun: forbidden('stopRun'),
    terminal: { onEvent: subscribe('terminalEvent'), create: forbidden('terminal.create'), close: forbidden('terminal.close'), attach: forbidden('terminal.attach'), input: forbidden('terminal.input'), resize: forbidden('terminal.resize'), ack: forbidden('terminal.ack'), setFocus: forbidden('terminal.setFocus'), copy: forbidden('terminal.copy'), paste: forbidden('terminal.paste') },
    notebooks: { onEvent: subscribe('notebookEvent'), release: forbidden('notebooks.release') },
    languageTools: { query: forbidden('languageTools.query'), release: async (immediate, language) => {
      if (typeof immediate !== 'boolean' || (language !== undefined && !['java', 'c', 'cpp'].includes(language))) throw new Error('Invalid language-tools release fixture.');
      // Production sends lifecycle release even with smart services disabled.
      // No fixture query or server was started, so there is nothing to terminate.
      record('languageTools.release', null);
    } },
    formatting: { run: forbidden('formatting.run'), cancel: forbidden('formatting.cancel') },
    updates: { status: reply('updates.status', { state: 'unchecked', current: 'test-fixture' }), check: forbidden('updates.check'), download: forbidden('updates.download'), install: forbidden('updates.install'), cancel: forbidden('updates.cancel') },
    markdown: { readImage: forbidden('markdown.readImage'), openLink: forbidden('markdown.openLink') },
    sourceControl: { status: forbidden('sourceControl.status'), trust: forbidden('sourceControl.trust'), diff: forbidden('sourceControl.diff'), change: forbidden('sourceControl.change'), commit: forbidden('sourceControl.commit'), close: forbidden('sourceControl.close') },
    practice: { list: reply('practice.list', { problems: [], unavailable: 0 }),
      browse: forbidden('practice.browse'), getChallenge: forbidden('practice.getChallenge'), start: forbidden('practice.start'),
      get: forbidden('practice.get'), save: forbidden('practice.save'), openAttempt: forbidden('practice.openAttempt'),
      createAttempt: forbidden('practice.createAttempt'), runSamples: forbidden('practice.runSamples') },
    projects: { open: async path => { if (path !== root) throw new Error('Unknown project fixture.'); return record('projects.open', null); },
      onSourceSaved: subscribe('projectSourceSaved'), save: forbidden('projects.save'), approve: forbidden('projects.approve'),
      run: forbidden('projects.run'), runSuite: forbidden('projects.runSuite'), cancelSuite: forbidden('projects.cancelSuite'),
      setAutomatic: forbidden('projects.setAutomatic'), provider: forbidden('projects.provider'), configure: forbidden('projects.configure'),
      propose: forbidden('projects.propose') },
    viewers: {}, workspaceSearch: { search: forbidden('workspaceSearch.search'), cancel: forbidden('workspaceSearch.cancel') },
    onCommand: subscribe('command'), onOpenEntry: subscribe('openEntry'), onCloseRequest: subscribe('closeRequest'),
    confirmWindowClose: forbidden('confirmWindowClose'),
  };
  window.__ionBrowserFixture = {
    description: 'TEST ONLY: real React/Monaco rendering with deterministic in-memory transport; no native runtime verification.',
    inspect: () => ({ calls: [...calls], failures: [...failures], subscribers: Object.fromEntries([...subscribers].map(([name, callbacks]) => [name, callbacks.size])), draftCount: draftMap.size }),
    command: name => { for (const callback of subscribers.get('command') ?? []) callback(name); },
  };
}
