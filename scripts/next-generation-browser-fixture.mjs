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
  const manifestEntry = { kind: 'file', name: 'package.json', path: root + '/package.json' };
  const manifestText = '{\n  "name": "fixture-project",\n  "dependencies": { "react": "19.3.1" },\n  "scripts": { "test": "echo TEXT ONLY, NEVER EXECUTED" }\n}\n';
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
  let imported = false, previewSequence = 0, deferPreview = false, pendingPreview;
  const previewTokens = new Set();
  const importedSummary = { ...summary, id: 'fixture-import', name: 'Fixture Java Notes', topicCount: 1, source: 'local', diagnostics: false };
  const library = (catalog = false) => ({ installed: [...(materialized ? [summary] : []), ...(imported ? [importedSummary] : [])], catalog: catalog ? [summary] : [], selected });
  const checkedPack = id => { if (id !== 'java') throw new Error('Unknown fixture pack.'); };
  const draftMap = new Map();
  const exerciseEntry = { kind: 'file', name: 'Main.java', path: '/ion-browser-fixture/practice/learning-java-flow/Main.java' };
  const flow = pack.lessons.find(item => item.id === 'flow');
  let exercise, exerciseText = flow?.starter ?? '', exerciseRevision = 'exercise-r1', deferredPractice, practicePending, cancelCount = 0;
  const checkExercise = (id, attempt) => {
    if (!exercise || id !== exercise.id || attempt !== undefined && attempt !== 'fixture-attempt') throw new Error('Unknown exercise fixture.');
  };
  const practiceReply = async (method, value) => {
    const response = record(method, value);
    if (deferredPractice === method) {
      deferredPractice = undefined;
      return new Promise((resolvePending, rejectPending) => { practicePending = { method, resolve: () => { practicePending = undefined; resolvePending(response); },
        reject: () => { practicePending = undefined; rejectPending(new Error('Fixture sample run cancelled.')); } }; });
    }
    return response;
  };
  // UI transport evidence only: activity is in-memory, not native persistence.
  const activity = new Map();
  const lessonActivity = (id, topic) => {
    checkedPack(id);
    if (!pack.lessons.some(item => item.id === topic)) throw new Error('Unknown fixture lesson activity.');
    return activity.get(topic) ?? { packId: id, lessonId: topic, opened: 0, hintsRevealed: 0, lastAt: null };
  };
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
      install: forbidden('learningPacks.install'), startExercise: async (id, topic) => {
        checkedPack(id); if (topic !== 'flow' || !flow?.exercise) throw new Error('Only the reviewed flow UI fixture is available.');
        exercise ??= { id: 'fixture-problem', revision: 1, language: 'java', title: flow.title, difficulty: 'Easy', topic: flow.section,
          sourceUrl: '', statement: flow.practice, notes: '', completion: 'Not started',
          samples: flow.exercise.samples.map((sample, index) => ({ id: 'fixture-sample-' + index, label: 'Sample ' + (index + 1), ...sample })),
          attempts: [{ id: 'fixture-attempt', label: 'First attempt', createdAt: 1 }] };
        return record('learningPacks.startExercise', { problemId: exercise.id, entry: exerciseEntry });
      },
      remove: async id => {
        if (id === 'java' && materialized) materialized = false;
        else if (id === 'fixture-import' && imported) imported = false;
        else throw new Error('Unknown fixture saved content.');
        if (selected === id) selected = null;
        return record('learningPacks.remove', library(true));
      },
      // These methods exercise the real content-management component only.
      // No native chooser, validation, disk export or pack import is simulated.
      previewImport: async () => {
        if (previewTokens.size || pendingPreview) throw new Error('Fixture preview already pending.');
        const token = 'fixture-preview-' + (++previewSequence);
        previewTokens.add(token);
        const preview = record('learningPacks.previewImport', { token, update: imported,
          details: { pack: importedSummary, topics: topics.slice(0, 1), prerequisites: [], references: [] } });
        if (deferPreview) {
          deferPreview = false;
          return new Promise(resolvePreview => { pendingPreview = () => { pendingPreview = undefined; resolvePreview(preview); }; });
        }
        return preview;
      },
      confirmImport: async token => {
        if (!previewTokens.delete(token)) throw new Error('Unknown fixture preview token.');
        imported = true; return record('learningPacks.confirmImport', library(true));
      },
      discardImport: async token => {
        if (!previewTokens.delete(token)) throw new Error('Unknown fixture preview token.');
        record('learningPacks.discardImport', null);
      },
      exportPack: async id => {
        if (!(id === 'java' && materialized) && !(id === 'fixture-import' && imported)) throw new Error('Unknown fixture export.');
        return record('learningPacks.exportPack', true);
      },
    },
    learning: { getTopics: reply('learning.getTopics', []), getHistory: reply('learning.getHistory', { categories: [], topics: [] }),
      getLearningActivity: async (id, topic) => record('learning.getLearningActivity', lessonActivity(id, topic)),
      recordLearningActivity: async (id, topic, action) => {
        if (!['lesson-opened', 'hint-revealed'].includes(action)) throw new Error('Unexpected activity.');
        const previous = lessonActivity(id, topic);
        const next = { ...previous, opened: previous.opened + Number(action === 'lesson-opened'),
          hintsRevealed: previous.hintsRevealed + Number(action === 'hint-revealed'), lastAt: 1 };
        activity.set(topic, next); return record('learning.recordLearningActivity', next);
      },
      getLearningTaskEvidence: async (id, topic) => {
        lessonActivity(id, topic);
        const report = topic === 'flow' && exercise?.attempts[0].lastRun;
        return record('learning.getLearningTaskEvidence', { problemId: topic === 'flow' ? exercise?.id ?? null : null,
          attemptCount: topic === 'flow' && exercise ? 1 : 0, manualStatus: topic === 'flow' ? exercise?.completion ?? null : null,
          samples: report ? { attemptId: 'fixture-attempt', testedAt: report.testedAt, current: report.current,
            total: report.results.length, ...Object.fromEntries(['passed', 'failed', 'unavailable', 'skipped'].map(status =>
              [status, report.results.filter(item => item.status === status).length])) } : null });
      },
      getConcept: forbidden('learning.getConcept'), clearHistory: forbidden('learning.clearHistory'), recordTopic: forbidden('learning.recordTopic') },
    setOptionalPanel: async mode => { if (![null, 'learn', 'practice', 'projects'].includes(mode)) throw new Error('Unexpected fixture panel.'); record('setOptionalPanel:' + mode, null); },
    openFolder: reply('openFolder', folder), openFile: reply('openFile', entry),
    openRecent: async path => { if (path === root) return record('openRecent', folder); if (path === entry.path) return record('openRecent', entry); throw new Error('Unknown fixture recent.'); },
    listDirectory: async path => { if (path !== root) throw new Error('Unknown fixture directory.'); return record('listDirectory', [entry, manifestEntry]); },
    readFile: async path => {
      if (path === manifestEntry.path) return record('readFile', { text: manifestText, revision: 'manifest-r1' });
      if (path === exerciseEntry.path && exercise) return record('readFile', { text: exerciseText, revision: exerciseRevision });
      if (path !== entry.path) throw new Error('Unknown fixture file.'); return record('readFile', { text, revision: 'fixture-r1' });
    },
    quickOpen: { search: async query => record('quickOpen.search', { entries: query && !'main.java'.includes(query.toLowerCase()) ? [] : [entry], truncated: false }),
      open: async path => { if (path !== entry.path) throw new Error('Unknown Quick Open fixture.'); return record('quickOpen.open', entry); } },
    saveFile: async (path, source, revision) => {
      if (path !== exerciseEntry.path || revision !== exerciseRevision || typeof source !== 'string') throw new Error('Unexpected fixture save.');
      exerciseText = source; exerciseRevision += '-next';
      return practiceReply('saveFile', { revision: exerciseRevision });
    }, saveFileAs: forbidden('saveFileAs'), createEntry: forbidden('createEntry'), renameEntry: forbidden('renameEntry'), trashEntry: forbidden('trashEntry'),
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
      get: async id => { checkExercise(id); return record('practice.get', exercise); }, save: forbidden('practice.save'),
      openAttempt: async (id, attempt) => { checkExercise(id, attempt); return practiceReply('practice.openAttempt', exerciseEntry); },
      createAttempt: forbidden('practice.createAttempt'),
      runSamples: async (id, attempt) => {
        checkExercise(id, attempt);
        // Deliberately fixed UI fixture statuses, never evidence of real execution.
        exercise.attempts[0].lastRun = { current: true, testedAt: 1, results: exercise.samples.map((sample, index) =>
          ({ id: sample.id, label: sample.label, status: index === 0 ? 'passed' : 'failed', message: 'TEST FIXTURE: no program executed.',
            expected: sample.expectedOutput, stdout: index === 0 ? sample.expectedOutput : 'fixture mismatch', stderr: '' })) };
        return practiceReply('practice.runSamples', exercise);
      }, cancelSamples: async () => {
        cancelCount++; record('practice.cancelSamples', null);
        if (practicePending?.method === 'practice.runSamples') practicePending.reject();
      } },
    projects: { open: async path => { if (path !== root) throw new Error('Unknown project fixture.'); return record('projects.open', null); },
      onSourceSaved: subscribe('projectSourceSaved'), save: forbidden('projects.save'), approve: forbidden('projects.approve'),
      run: forbidden('projects.run'), runSuite: forbidden('projects.runSuite'), cancelSuite: forbidden('projects.cancelSuite'),
      setAutomatic: forbidden('projects.setAutomatic'), provider: forbidden('projects.provider'), configure: forbidden('projects.configure'),
      propose: forbidden('projects.propose') },
    projectLens: {
      analyze: async path => {
        if (path !== root) throw new Error('Unknown Lens fixture root.');
        return record('projectLens.analyze', { version: 1, root, status: 'complete', durationMs: 2,
          limits: { depth: 6, visits: 2500, files: 500, manifestBytes: 65536, totalManifestBytes: 262144, durationMs: 5000, resultBytes: 131072 },
          counts: { visitedEntries: 2, directoriesInspected: 1, regularFilesSeen: 2, filesInspected: 2, returnedFiles: 2, manifestBytesRead: manifestText.length },
          languages: [{ id: 'java', label: 'Java', files: 1 }, { id: 'json', label: 'JSON', files: 1 }],
          files: [{ reference: { path: 'Main.java', revision: 'fixture-r1' }, language: 'java', bytes: text.length },
            { reference: { path: 'package.json', revision: 'manifest-r1' }, language: 'json', bytes: manifestText.length }],
          manifests: [{ kind: 'npm', reference: { path: 'package.json', revision: 'manifest-r1' }, status: 'parsed',
            dependencies: [{ name: 'react', version: '19.3.1', group: 'dependencies' }], scripts: [{ name: 'test', command: 'echo TEXT ONLY, NEVER EXECUTED' }] }],
          frameworks: [{ name: 'React', confidence: 'declared', reason: 'Declared dependency; working behavior unverified.', reference: { path: 'package.json', revision: 'manifest-r1' } }],
          entryPoints: [{ kind: 'existing-candidate', path: 'Main.java', reference: { path: 'Main.java', revision: 'fixture-r1' }, reason: 'Filename candidate only.' }],
          documentation: [], tests: [], exclusions: {}, truncated: [], limitations: ['TEST FIXTURE: no filesystem analyzed in this browser transport.'] });
      },
      cancel: reply('projectLens.cancel', null),
      openReference: async (path, reference) => {
        if (path !== root || !['Main.java', 'package.json'].includes(reference.path)) throw new Error('Unknown Lens fixture reference.');
        return record('projectLens.openReference', { entry: reference.path === 'Main.java' ? entry : manifestEntry });
      },
    },
    viewers: {}, workspaceSearch: { search: forbidden('workspaceSearch.search'), cancel: forbidden('workspaceSearch.cancel') },
    onCommand: subscribe('command'), onOpenEntry: subscribe('openEntry'), onCloseRequest: subscribe('closeRequest'),
    confirmWindowClose: forbidden('confirmWindowClose'),
  };
  window.__ionBrowserFixture = {
    description: 'TEST ONLY: real React/Monaco rendering with deterministic in-memory transport; no native runtime verification.',
    inspect: () => ({ calls: [...calls], failures: [...failures], subscribers: Object.fromEntries([...subscribers].map(([name, callbacks]) => [name, callbacks.size])), draftCount: draftMap.size,
      previewTokens: previewTokens.size, pendingPreview: Boolean(pendingPreview), selected, materialized,
      pendingPractice: practicePending?.method ?? null, cancelCount }),
    deferPractice: method => {
      if (practicePending || deferredPractice || !['practice.openAttempt', 'practice.runSamples', 'saveFile'].includes(method)) throw new Error('Unexpected practice defer.');
      deferredPractice = method;
    },
    resolvePractice: () => { if (!practicePending) throw new Error('No pending fixture operation.'); practicePending.resolve(); },
    command: name => { for (const callback of subscribers.get('command') ?? []) callback(name); },
    deferNextPreview: () => { if (pendingPreview || previewTokens.size) throw new Error('Preview already pending.'); deferPreview = true; },
    resolvePreview: () => { if (!pendingPreview) throw new Error('No deferred fixture preview.'); pendingPreview(); },
  };
}
