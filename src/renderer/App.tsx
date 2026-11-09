import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { defaultSettings, type Entry, type EntryKind, type MenuCommand, type OptionalPanel, type RecentEntry, type RecoveryDraft, type Settings, type WorkspaceMode } from '../shared/contracts';
import { ConfirmDialog, EntryDialog, PreferencesDialog, StarterDialog } from './Dialogs';
import { Documents, errorMessage, type InitialDraft, type Tab } from './documents';
import { Icon } from './icons';
import type { EditorActions } from './MonacoSurface';
import { RunConsoleStore } from './run-console/store';
import { isWithin } from './paths';
import { Welcome } from './Welcome';
import type { CompilerProblem, LearningDiagnostic, LearningFeedback } from '../shared/learning';
import type { ProblemMarker, ProblemRow } from './Problems';
import { diagnosticPackIds, type PackLibrary } from '../shared/learning-packs';
import type { ThemeData } from '../shared/themes';
import { documentFormat } from '../shared/viewers';
import { canPreviewWeb, runLanguage } from '../shared/run-console';
import { appearanceFor, systemAppearance, themeForPreference } from './appearance';
import { Workbench, type DocumentSplitActions } from './Workbench';
import { commandEntries, displayShortcut, type ShortcutOverrides } from '../shared/shortcuts';
import { starterCode, starterLanguageFor, starterLanguages, type StarterLanguage } from '../shared/starter-code';
import type { WorkspaceSearchMatch } from '../shared/workspace-search';
import { captureEditorSession, EditorSessionWriter } from './editor-session';
import type { BottomTab } from '../shared/terminal';
import type { TerminalController } from './terminal/controller';

type Dialog =
  | { kind: 'settings' }
  | { kind: 'commands' }
  | { kind: 'files' }
  | { kind: 'workspace-search' }
  | { kind: 'new-starter' }
  | { kind: 'go-to-line'; tabId: string; lines: number }
  | { kind: 'recovery' }
  | { kind: 'create'; entryKind: EntryKind; parent: string }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'close-tab'; id: string; name: string }
  | { kind: 'close-window' }
  | { kind: 'close-workspace-draft' }
  | { kind: 'reload'; id: string; name: string; dirty: boolean };

async function loadPanel(mode: OptionalPanel) {
  switch (mode) {
    case 'learn': return { mode, Component: (await import('./learning/LearningPane')).LearningPane };
    case 'projects': return { mode, Component: (await import('./projects/ProjectsPanel')).default };
    case 'practice': return { mode, Component: (await import('./practice/PracticePane')).PracticePane };
  }
}

type LoadedPanel = Awaited<ReturnType<typeof loadPanel>>;
type PanelContent = { key: string; module: LoadedPanel } | { key: string; error: string };
type MarketplaceContent = { Component: typeof import('./learning/MarketplacePane').MarketplacePane } | { error: string };
const modeNames: Record<WorkspaceMode, string> = { free: 'Free Coding', learn: 'Learn', projects: 'Projects', practice: 'Practice' };
const bridge = window.ion;
const Commands = lazy(async () => ({ default: (await import('./CommandPicker')).Commands }));
const QuickOpen = lazy(async () => ({ default: (await import('./CommandPicker')).QuickOpen }));
const WorkspaceSearch = lazy(() => import('./WorkspaceSearch'));
const GoToLine = lazy(async () => ({ default: (await import('./CommandPicker')).GoToLine }));

interface RunReport {
  tabId: string;
  path: string;
  name: string;
  epoch?: number;
  revision?: string;
  problems: CompilerProblem[];
  feedback?: LearningFeedback;
}

function reportMatchesTab(documents: Documents, report: RunReport, tab: Tab | undefined) {
  return Boolean(report.revision && tab?.path === report.path && tab.epoch === report.epoch
    && !tab.dirty && !tab.conflict && documents.savedRevision(tab.id) === report.revision);
}

function isReportLocation(report: RunReport, problem: CompilerProblem) {
  const file = problem.location?.file;
  if (!file) return false;
  if (bridge.platform !== 'win32') return file === report.path;
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^[a-z]:/i, (drive) => drive.toUpperCase());
  return normalize(file) === normalize(report.path);
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaultSettings, autoSave: false }));
  const settingsRef = useRef(settings);
  const preferencesLoaded = useRef(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [activeTheme, setActiveTheme] = useState<ThemeData | null>(null);
  const activeThemeId = useRef<string>(null);
  const themeChanging = useRef(false);
  const appearance = useMemo(() => appearanceFor(activeTheme, settings.accent), [activeTheme, settings.accent]);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoveryDraft[]>([]);
  const [screen, setScreen] = useState<'welcome' | 'editor'>('welcome');
  const [mode, setMode] = useState<WorkspaceMode>('free');
  const [auxiliaryVisible, setAuxiliaryVisible] = useState(true);
  const [marketplaceVisible, setMarketplaceVisible] = useState(false);
  const [marketplaceContent, setMarketplaceContent] = useState<MarketplaceContent | null>(null);
  const [packLibrary, setPackLibrary] = useState<PackLibrary | null>(null);
  const packVisibility = useRef<'hidden' | 'learn' | 'marketplace'>('hidden');
  const selectedLearningLanguage = useRef<string | null>(null);
  const applyPackLibrary = useCallback((library: PackLibrary) => {
    selectedLearningLanguage.current = library.selected;
    const visibility = packVisibility.current;
    if (visibility === 'hidden') return;
    setPackLibrary((previous) => ({
      ...library,
      catalog: visibility === 'learn' ? [] : library.catalog.length ? library.catalog : previous?.catalog ?? [],
    }));
  }, []);
  const [packLoadError, setPackLoadError] = useState<string>();
  const [packAttempt, setPackAttempt] = useState(0);
  const [runReport, setRunReport] = useState<RunReport | null>(null);
  const [selectedProblem, setSelectedProblem] = useState<number>();
  const [lensSelection, setLensSelection] = useState<{ diagnostic: LearningDiagnostic; request: number }>();
  const lensRequest = useRef(0);
  const [practiceExercise, setPracticeExercise] = useState<string>();
  const practiceDraft = useRef(false);
  const projectDraft = useRef(false);
  const markPracticeDraft = useCallback((dirty: boolean) => { practiceDraft.current = dirty; }, []);
  const markProjectDraft = useCallback((dirty: boolean) => { projectDraft.current = dirty; }, []);
  const closeAuxiliary = useCallback(() => {
    setAuxiliaryVisible(false);
    setLensSelection(undefined);
  }, []);
  const toggleAuxiliary = useCallback(() => {
    setAuxiliaryVisible((visible) => !visible);
    setLensSelection(undefined);
  }, []);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [root, setRoot] = useState<Entry | null>(null);
  const [sessionAvailable, setSessionAvailable] = useState(false);
  const [resumingSession, setResumingSession] = useState(false);
  const sessionStarted = useRef(false);
  const sessionRoot = useRef(root);
  sessionRoot.current = root;
  const [target, setTarget] = useState<string | null>(null);
  const panelMode = screen === 'editor' && auxiliaryVisible && mode !== 'free' ? mode : null;
  const needsPackLibrary = screen === 'editor' && (panelMode === 'learn' || marketplaceVisible);
  const panelRoot = panelMode === 'projects' ? root?.path : undefined;
  const panelKey = panelMode ? panelMode + (panelRoot ? ':' + panelRoot : '') : null;
  const [panelContent, setPanelContent] = useState<PanelContent | null>(null);
  const [panelAttempt, setPanelAttempt] = useState(0);
  const requestedPanel = useRef<string | null>(null);
  const learningPanel = useRef(false);

  const [treeRevision, setTreeRevision] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('run');
  const [terminalFocus, setTerminalFocus] = useState(0);
  const terminalController = useRef<TerminalController | null>(null);
  const [runConsole] = useState(() => new RunConsoleStore());
  const { phase: runPhase } = useSyncExternalStore(runConsole.subscribe, runConsole.getSnapshot);
  const [lastRun, setLastRun] = useState<{ id: string; path: string; name: string } | null>(null);
  const liveRun = useRef<{ id: string; cancelled: boolean; complete?: () => void } | null>(null);
  const consoleSize = useRef<[number, number] | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nativeDialogOpen = useRef(false);
  const running = useRef(false);
  const editor = useRef<EditorActions | null>(null);
  const splitActions = useRef<DocumentSplitActions | null>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const commands = useRef<(value: MenuCommand) => void>(() => {});
  const closeRequest = useRef<() => void>(() => {});

  const notify = useCallback((message: string, error = false) => {
    setNotice({ message, error });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 8500 : 4200);
  }, []);
  const refreshRecents = useCallback(() => {
    void bridge.getPreferences().then(({ recents: entries }) => setRecents(entries)).catch(() => {});
  }, []);
  const refreshTree = useCallback(() => setTreeRevision((version) => version + 1), []);
  const [documents] = useState(() => new Documents(bridge, settings, notify, () => {
    refreshRecents();
    refreshTree();
  }));
  const [sessionWriter] = useState(() => new EditorSessionWriter(
    async () => {
      if (sessionStarted.current) await bridge.editorSession.save(captureEditorSession(documents, sessionRoot.current?.path ?? null));
    },
    (reason) => notify(`Could not checkpoint the editor session. ${errorMessage(reason)}`, true),
  ));
  const { tabs, activeId } = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const active = tabs.find(({ id }) => id === activeId);
  const reportTab = runReport && tabs.find(({ id }) => id === runReport.tabId);
  const sourceCurrent = Boolean(runReport && reportTab && reportMatchesTab(documents, runReport, reportTab));
  const feedback = mode === 'learn' && packLibrary?.selected === runReport?.feedback?.language
    && (settings.learningLens || runReport?.feedback?.language !== 'c')
    ? runReport?.feedback : undefined;
  const problemRows = useMemo<ProblemRow[]>(() => runReport?.problems.map((problem) => ({
    problem,
    lesson: feedback?.language === 'c' ? feedback.diagnostics.find((diagnostic) => diagnostic.phase === 'compile'
      && diagnostic.raw === problem.raw && diagnostic.confidence === 'high'
      && (diagnostic.concepts.length > 0 || diagnostic.packTopic)) : undefined,
    canReveal: sourceCurrent && isReportLocation(runReport, problem),
  })) ?? [], [runReport, feedback, sourceCurrent]);
  const problemMarkers = useMemo<ProblemMarker[] | undefined>(() => {
    if (!runReport || activeId !== runReport.tabId) return undefined;
    const rows = problemRows.flatMap(({ problem, lesson, canReveal }, index) =>
      canReveal && problem.location && problem.severity !== 'note'
        ? [{ line: problem.location.line, lens: Boolean(lesson), selected: selectedProblem === index }] : []);
    return rows.length ? rows : undefined;
  }, [activeId, problemRows, runReport, selectedProblem]);
  const notebookRunning = tabs.some((tab) => tab.notebookRunning);
  const starterTarget = active && !active.viewer && !active.notebookMode && !active.error && !active.conflict
    ? starterLanguageFor(active.name) : undefined;

  useEffect(() => {
    let cancelled = false;
    void bridge.editorSession.available().then((available) => {
      if (!cancelled) setSessionAvailable(available);
    }).catch((reason: unknown) => {
      if (!cancelled) notify(`Could not read the previous editor session. ${errorMessage(reason)}`, true);
    });
    void bridge.recovery.list().then((drafts) => {
      if (!cancelled) setRecoveryDrafts(drafts);
    }).catch((reason: unknown) => {
      if (!cancelled) notify(`Could not check for unsaved drafts. ${errorMessage(reason)}`, true);
    });
    void bridge.getPreferences().then((preferences) => {
      if (cancelled) return;
      preferencesLoaded.current = true;
      settingsRef.current = preferences.settings;
      setSettings(preferences.settings);
      documents.setSettings(preferences.settings);
      setRecents(preferences.recents);
      if (preferences.settings.checkUpdatesOnLaunch) {
        void bridge.updates.check().then((status) => {
          if (!cancelled && status.state === 'available') notify(`Ion ${status.latest} is available in Preferences → Updates.`);
        }).catch(() => {});
      }
    }).catch((reason: unknown) => {
      if (!cancelled) notify(errorMessage(reason), true);
    }).finally(() => {
      if (!cancelled) setPreferencesReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(noticeTimer.current);
    };
  }, [documents, notify]);

  useEffect(() => {
    const schedule = () => { if (sessionStarted.current) sessionWriter.schedule(); };
    const unsubscribe = documents.subscribe(schedule);
    const unsubscribeView = documents.subscribeEditorView(schedule);
    return () => {
      unsubscribe();
      unsubscribeView();
      sessionWriter.cancel();
    };
  }, [documents, sessionWriter]);

  useEffect(() => {
    if (hasWorkspace) sessionWriter.schedule();
  }, [hasWorkspace, root, sessionWriter]);

  const activateTheme = useCallback((palette: ThemeData) => {
    activeThemeId.current = palette.id;
    setActiveTheme(palette);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    const selection = settings.theme;
    const system = selection === 'system' ? window.matchMedia(systemAppearance) : null;
    let generation = 0;
    const sync = async () => {
      const request = ++generation;
      const id = themeForPreference(selection, () => system?.matches ?? false);
      const isCurrent = () => request === generation && settingsRef.current.theme === selection;
      if (id === activeThemeId.current) return;
      try {
        const palette = await bridge.themes.load(id);
        if (isCurrent()) activateTheme(palette);
      } catch (reason) {
        if (!isCurrent()) return;
        notify(`Could not load the selected theme. ${errorMessage(reason)}`, true);
        if (activeThemeId.current === null && id !== 'dark') {
          const fallback = await bridge.themes.load('dark').catch(() => null);
          if (fallback && isCurrent()) activateTheme(fallback);
        }
      }
    };
    const syncAppearance = () => { void sync(); };
    system?.addEventListener('change', syncAppearance);
    syncAppearance();
    return () => {
      generation++;
      system?.removeEventListener('change', syncAppearance);
    };
  }, [activateTheme, notify, preferencesReady, settings.theme]);


  useLayoutEffect(() => {
    if (!panelKey && requestedPanel.current === null) return;
    requestedPanel.current = panelKey;
    if (!panelMode || !panelKey) {
      setPanelContent(null);
      void bridge.setOptionalPanel(null).catch((reason: unknown) => notify(errorMessage(reason), true));
      return;
    }
    let current = true;
    // Start the local module and its desktop lease together. The panel can render
    // as soon as both resolve instead of waiting on the Suspense fallback.
    void Promise.all([loadPanel(panelMode), bridge.setOptionalPanel(panelMode, panelRoot)]).then(([module]) => {
      if (current) setPanelContent({ key: panelKey, module });
    }, (reason: unknown) => {
      if (current) setPanelContent({ key: panelKey, error: errorMessage(reason) });
    });
    return () => { current = false; };
  }, [panelKey, panelMode, panelRoot, panelAttempt, notify]);

  useLayoutEffect(() => {
    packVisibility.current = !needsPackLibrary ? 'hidden' : marketplaceVisible ? 'marketplace' : 'learn';
  }, [needsPackLibrary, marketplaceVisible]);

  useLayoutEffect(() => {
    learningPanel.current = (settings.learningLens || packLibrary?.selected !== 'c')
      && diagnosticPackIds.some((id) => id === packLibrary?.selected) && panelMode === 'learn'
      && panelContent !== null && panelContent.key === panelKey && 'module' in panelContent;
    if (!settings.learningLens) {
      setRunReport((current) => current?.feedback?.language === 'c' ? { ...current, feedback: undefined } : current);
      setLensSelection(undefined);
    }
  }, [packLibrary?.selected, panelMode, panelContent, panelKey, settings.learningLens]);

  useEffect(() => {
    if (!marketplaceVisible || marketplaceContent) return;
    let current = true;
    void import('./learning/MarketplacePane').then(({ MarketplacePane }) => {
      if (current) setMarketplaceContent({ Component: MarketplacePane });
    }, (reason: unknown) => {
      if (current) setMarketplaceContent({ error: errorMessage(reason) });
    });
    return () => { current = false; };
  }, [marketplaceVisible, marketplaceContent]);

  useEffect(() => {
    if (!needsPackLibrary) {
      setPackLibrary(null);
      setPackLoadError(undefined);
      return;
    }
    let current = true;
    setPackLoadError(undefined);
    void bridge.learningPacks.getLibrary(marketplaceVisible).then((library) => {
      if (current) applyPackLibrary(library);
    }, (reason: unknown) => {
      if (current) setPackLoadError(errorMessage(reason));
    });
    return () => { current = false; };
  }, [needsPackLibrary, marketplaceVisible, packAttempt, applyPackLibrary]);

  const applySettings = useCallback((changes: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...changes };
    if (!preferencesLoaded.current) next.autoSave = false;
    settingsRef.current = next;
    documents.setSettings(next);
    setSettings(next);
  }, [documents]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const changesProfile = patch.resourceProfile !== undefined;
    if (!changesProfile) applySettings(patch);
    void bridge.updateSettings(patch).then((saved) => {
      if (changesProfile) applySettings({ resourceProfile: saved.resourceProfile });
    }).catch((reason: unknown) => notify(`Could not save preferences. ${errorMessage(reason)}`, true));
  }, [applySettings, notify]);

  async function changeUpdateLaunch(enabled: boolean) {
    if (!preferencesLoaded.current) throw new Error('Ion could not load your preferences.');
    const saved = await bridge.updateSettings({ checkUpdatesOnLaunch: enabled });
    applySettings({ checkUpdatesOnLaunch: saved.checkUpdatesOnLaunch });
  }

  const changeTheme = useCallback(async (selection: string) => {
    if (!preferencesReady || themeChanging.current) throw new Error('Please wait for the current theme to finish loading.');
    themeChanging.current = true;
    try {
      const id = themeForPreference(selection);
      const palette = id === activeThemeId.current ? null : await bridge.themes.load(id);
      await bridge.updateSettings({ theme: selection });
      applySettings({ theme: selection });
      if (palette) activateTheme(palette);
    } finally {
      themeChanging.current = false;
    }
  }, [activateTheme, applySettings, preferencesReady]);

  async function changeShortcuts(overrides: ShortcutOverrides) {
    if (!preferencesReady) throw new Error('Wait for preferences to load before changing shortcuts.');
    const saved = await bridge.updateSettings({ shortcuts: overrides });
    applySettings({ shortcuts: saved.shortcuts });
  }

  const enterWorkspace = useCallback(() => {
    sessionStarted.current = true;
    setHasWorkspace(true);
    setScreen('editor');
  }, []);
  useEffect(() => () => { terminalController.current?.dispose(); }, []);

  function selectBottomTab(tab: BottomTab) {
    setBottomTab(tab);
    if (tab === 'terminal') setTerminalFocus((value) => value + 1);
  }

  function toggleBottom() {
    const showing = !settingsRef.current.showOutput;
    updateSettings({ showOutput: showing });
    if (showing && bottomTab === 'terminal') setTerminalFocus((value) => value + 1);
  }

  function showTerminal() {
    if (screen === 'welcome') enterWorkspace();
    selectBottomTab('terminal');
    if (!settingsRef.current.showOutput) updateSettings({ showOutput: true });
  }
  async function resumeSession() {
    if (nativeDialogOpen.current || sessionStarted.current) return;
    nativeDialogOpen.current = true;
    setResumingSession(true);
    try {
      const resumed = await bridge.editorSession.resume();
      if (sessionStarted.current) return;
      const recovered = new Set<string>();
      let selected: string | null = null;
      for (const { entry, draft, name, view, index, notebookMode } of resumed.tabs) {
        let id: string | null;
        if (draft) {
          if (!documents.restoreDrafts([draft]).length) continue;
          recovered.add(draft.id);
          id = documents.getSnapshot().activeId;
        } else {
          id = documents.open(entry, entry ? undefined : { name, text: '' });
        }
        if (!id) continue;
        if (notebookMode) documents.setNotebookMode(id, notebookMode);
        if (view) documents.setEditorView(id, view);
        if (index === resumed.activeIndex) selected = id;
      }
      if (selected) documents.select(selected);
      if (recovered.size) setRecoveryDrafts((drafts) => drafts.filter(({ id }) => !recovered.has(id)));
      if (resumed.root) {
        setRoot(resumed.root);
        setTarget(resumed.root.path);
      }
      setSessionAvailable(false);
      enterWorkspace();
      if (resumed.skipped) {
        notify(`Resumed the session. ${resumed.skipped} unavailable ${resumed.skipped === 1 ? 'item was' : 'items were'} skipped.`, true);
      }
    } catch (reason) {
      notify(`Could not resume the editor session. ${errorMessage(reason)}`, true);
    } finally {
      nativeDialogOpen.current = false;
      setResumingSession(false);
    }
  }
  const restoreDrafts = () => {
    const restored = new Set(documents.restoreDrafts(recoveryDrafts));
    if (restored.size < recoveryDrafts.length) notify('Close a tab to make room for the remaining recovery drafts.', true);
    if (restored.size) {
      setRecoveryDrafts((drafts) => drafts.filter(({ id }) => !restored.has(id)));
      enterWorkspace();
    }
    setDialog(null);
  };
  async function discardDrafts() {
    try {
      await bridge.recovery.remove(recoveryDrafts.map(({ id }) => id));
      setRecoveryDrafts([]);
      setDialog(null);
    } catch (reason) {
      notify(errorMessage(reason), true);
    }
  }
  const selectWorkspace = (next: WorkspaceMode) => {
    if (next !== 'practice') setPracticeExercise(undefined);
    setMode(next);
    setLensSelection(undefined);
    setAuxiliaryVisible(true);
    enterWorkspace();
  };
  const showWelcome = () => {
    setMarketplaceVisible(false);
    setLensSelection(undefined);
    setScreen('welcome');
  };
  const toggleMarketplace = () => setMarketplaceVisible((visible) => !visible);
  const toggleExplorer = () => {
    if (marketplaceVisible) {
      setMarketplaceVisible(false);
      if (!settingsRef.current.showExplorer) updateSettings({ showExplorer: true });
    } else updateSettings({ showExplorer: !settingsRef.current.showExplorer });
  };
  const learnFromMarketplace = () => {
    if (mode !== 'learn' && (projectDraft.current || practiceDraft.current)) {
      notify('Pack selected. Save your workspace changes before switching to Learn.');
      return;
    }
    setMarketplaceVisible(false);
    selectWorkspace('learn');
  };
  const openEntry = useCallback((entry: Entry) => {
    if (entry.kind === 'folder') {
      setMarketplaceVisible(false);
      setRoot(entry);
      setTarget(entry.path);
      refreshTree();
      if (!settingsRef.current.showExplorer) updateSettings({ showExplorer: true });
    } else {
      documents.open(entry);
    }
    enterWorkspace();
  }, [documents, enterWorkspace, refreshTree, updateSettings]);

  useEffect(() => {
    const unsubOpen = bridge.onOpenEntry((entry) => {
      openEntry(entry);
      refreshRecents();
    });
    const unsubCommands = bridge.onCommand((value) => commands.current(value));
    const unsubClose = bridge.onCloseRequest(() => closeRequest.current());
    return () => {
      unsubOpen();
      unsubCommands();
      unsubClose();
    };
  }, [openEntry, refreshRecents]);

  useEffect(() => bridge.runConsole.onUpdate(({ id, update }) => {
    const request = liveRun.current;
    if (request?.id !== id) return;
    if (update.kind === 'complete') request.complete?.();
    else runConsole.update(update);
  }), [runConsole]);

  async function openNative(operation: () => Promise<Entry | null>, onOpened?: (entry: Entry) => void) {
    if (nativeDialogOpen.current) return;
    nativeDialogOpen.current = true;
    try {
      const entry = await operation();
      if (entry) {
        openEntry(entry);
        refreshRecents();
        onOpened?.(entry);
      }
    } catch (reason) {
      notify(errorMessage(reason), true);
    } finally {
      nativeDialogOpen.current = false;
    }
  }

  function createDraft(language?: StarterLanguage) {
    let draft: InitialDraft = { name: 'Untitled.txt', text: '' };
    if (language) {
      const { text, line, column } = starterCode(language, language.suggestedName, { portableJava: true });
      draft = { name: language.id === 'c' ? undefined : language.suggestedName, text, cursor: { line, column } };
    }
    if (!documents.open(undefined, draft)) return;
    if (screen === 'welcome') setMode('free');
    setDialog(null);
    enterWorkspace();
  }
  const chooseStarter = () => setDialog({ kind: 'new-starter' });
  const newFile = () => {
    if (screen === 'editor' && mode === 'learn') {
      const language = starterLanguages.find(({ id }) => id === selectedLearningLanguage.current);
      if (language) createDraft(language);
      else chooseStarter();
    } else createDraft(starterLanguages[0]);
  };
  const insertStarter = () => {
    if (!active || !starterTarget
      || !editor.current?.insertStarter(starterCode(starterTarget, active.name, { portableJava: !active.path }))) {
      notify('Starter code can be inserted into an empty source file.', true);
    }
  };
  const openFile = () => void openNative(() => bridge.openFile());
  const openFolder = () => void openNative(() => bridge.openFolder());
  async function openSearchMatch(path: string, { line, column }: WorkspaceSearchMatch) {
    setDialog(null);
    await openNative(() => bridge.quickOpen.open(path), () => {
      splitActions.current?.showSource(path);
      const id = documents.getSnapshot().tabs.find((tab) => tab.path === path)?.id;
      if (!id) return;
      requestAnimationFrame(() => {
        if (documents.getSnapshot().activeId === id && !editor.current?.goToLine(line, column, id)) {
          documents.requestPosition(id, line, column);
        }
      });
    });
  }
  function revealProblem(index: number) {
    const problem = problemRows[index];
    const location = problem?.problem.location;
    if (!runReport || !problem?.canReveal || !location) return;
    const { line, column = 1 } = location;
    const { tabId, path } = runReport;
    const current = () => reportMatchesTab(documents, runReport, documents.getSnapshot().tabs.find(({ id }) => id === tabId));
    if (!current()) return;
    setSelectedProblem(index);
    splitActions.current?.showSource(path);
    if (documents.getSnapshot().activeId !== tabId) {
      documents.requestPosition(tabId, line, column);
      documents.select(tabId);
      return;
    }
    requestAnimationFrame(() => {
      if (current() && documents.getSnapshot().activeId === tabId && !editor.current?.goToLine(line, column, tabId)) {
        documents.requestPosition(tabId, line, column);
      }
    });
  }

  function explainProblem(index: number) {
    const diagnostic = problemRows[index]?.lesson;
    if (!diagnostic) return;
    setSelectedProblem(index);
    setAuxiliaryVisible(true);
    setLensSelection({ diagnostic, request: ++lensRequest.current });
  }
  const openRecent = (entry: RecentEntry) => void openNative(() => bridge.openRecent(entry.path));
  const exportLocalProfile = async () => {
    if (nativeDialogOpen.current) return null;
    nativeDialogOpen.current = true;
    try {
      return await bridge.exportLocalProfile();
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      nativeDialogOpen.current = false;
    }
  };
  const find = (replace = false) => {
    if (active?.notebookMode === 'notebook' || splitActions.current?.markdown?.mode === 'preview') return;
    const viewer = document.activeElement?.closest('.document-pane')
      ?? (active?.viewer ? document.querySelector('.document-pane') : null);
    if (viewer) {
      if (!replace) viewer.querySelector<HTMLElement>('[data-viewer-search]')?.focus();
      return;
    }
    editor.current?.find(replace);
  };
  const setEditor = useCallback((actions: EditorActions | null) => { editor.current = actions; }, []);
  const setSplitActions = useCallback((actions: DocumentSplitActions | null) => { splitActions.current = actions; }, []);
  const updateCursor = useCallback((line: number, column: number) => {
    if (cursorRef.current) cursorRef.current.textContent = `Ln ${line}, Col ${column}`;
  }, []);

  async function saveTab(id: string, mode: 'manual' | 'as' = 'manual') {
    if (nativeDialogOpen.current) return false;
    nativeDialogOpen.current = true;
    try {
      return await documents.save(id, mode);
    } finally {
      nativeDialogOpen.current = false;
    }
  }

  async function closeTab(id: string) {
    if (dialog || nativeDialogOpen.current) return;
    await documents.settle([id]);
    const tab = documents.getSnapshot().tabs.find((entry) => entry.id === id);
    if (tab?.notebookRunning) { notify('Finish or stop the notebook run before closing its tab.', true); return; }
    if (tab?.dirty) {
      setNotice(null);
      setDialog({ kind: 'close-tab', id, name: tab.name });
    }
    else documents.close(id);
  }

  async function confirmClose(allow: boolean, disposition: 'save' | 'discard' | 'keep' = 'save') {
    let resumeAutosave: (() => void) | undefined;
    try {
      if (allow) {
        if (disposition === 'keep') resumeAutosave = await documents.checkpointDrafts();
        else await documents.finishWindowClose(disposition === 'discard');
        if (disposition === 'save' && documents.getSnapshot().tabs.some(({ dirty }) => dirty)) {
          setDialog({ kind: 'close-window' });
          return;
        }
        await sessionWriter.flush(disposition === 'keep');
      }
      await bridge.confirmWindowClose(allow);
      setDialog(null);
    } catch (reason) {
      resumeAutosave?.();
      notify(errorMessage(reason), true);
    }
  }

  function requestWindowClose() {
    if (dialog || nativeDialogOpen.current) {
      void bridge.confirmWindowClose(false);
      return;
    }
    if (practiceDraft.current || projectDraft.current) {
      setDialog({ kind: 'close-workspace-draft' });
      return;
    }
    requestCloseFiles();
  }

  function requestCloseFiles() {
    if (documents.getSnapshot().tabs.some((tab) => tab.dirty)) {
      setNotice(null);
      setDialog({ kind: 'close-window' });
    } else {
      void confirmClose(true);
    }
  }

  async function saveMany(selected: Tab[]) {
    const ids = new Set(selected.map((tab) => tab.id));
    await documents.settle([...ids]);
    for (const tab of documents.getSnapshot().tabs.filter(({ id }) => ids.has(id))) {
      if (tab.dirty && !await saveTab(tab.id)) return false;
    }
    if (documents.getSnapshot().tabs.some((tab) => ids.has(tab.id) && tab.dirty)) {
      notify('New edits arrived while saving. Try again to include them.', true);
      return false;
    }
    return true;
  }

  async function trashEntry(entry: Entry) {
    if (nativeDialogOpen.current) return;
    const affected = documents.affected(entry.path);
    if (affected.some((tab) => tab.notebookRunning)) { notify('Finish or stop the notebook run before moving it to Trash.', true); return; }
    if (!await saveMany(affected)) return;
    nativeDialogOpen.current = true;
    try {
      if (!await bridge.trashEntry(entry.path)) return;
      let keptDraft = false;
      for (const tab of documents.affected(entry.path)) {
        if (tab.dirty) {
          documents.detachPath(tab.id);
          keptDraft = true;
        } else {
          documents.close(tab.id);
        }
      }
      if (target && isWithin(target, entry.path)) setTarget(root?.path ?? null);
      refreshTree();
      refreshRecents();
      notify(keptDraft ? 'Moved to Trash. New edits were kept in an unsaved draft.' : `Moved ${entry.name} to Trash`);
    } catch (reason) {
      notify(errorMessage(reason), true);
    } finally {
      nativeDialogOpen.current = false;
    }
  }

  async function rename(entry: Entry, name: string) {
    const affected = documents.affected(entry.path);
    if (affected.some((tab) => tab.notebookRunning)) throw new Error('Finish or stop the notebook run before renaming it.');
    if (entry.kind === 'file' && documentFormat(name) && affected.some((tab) => tab.dirty)) {
      throw new Error('Save pending edits before renaming this file to a read-only document format.');
    }
    if (!await saveMany(affected)) throw new Error('Resolve unsaved changes before renaming.');
    try {
      const renamed = await bridge.renameEntry(entry.path, name);
      documents.renamed(entry.path, renamed);
      if (target && isWithin(target, entry.path)) setTarget(renamed.path + target.slice(entry.path.length));
      refreshTree();
      refreshRecents();
      setDialog(null);
      notify(`Renamed to ${renamed.name}`);
    } catch (reason) {
      throw new Error(errorMessage(reason));
    }
  }

  async function create(parent: string, name: string, kind: EntryKind, useStarter: boolean) {
    try {
      const language = kind === 'file' && useStarter ? starterLanguageFor(name) : undefined;
      const initialText = language ? starterCode(language, name).text : undefined;
      const entry = await bridge.createEntry(parent, name, kind, initialText);
      refreshTree();
      if (entry.kind === 'file') documents.open(entry);
      setDialog(null);
      notify(`Created ${entry.name}`);
    } catch (reason) {
      throw new Error(errorMessage(reason));
    }
  }

  async function run(previous?: NonNullable<typeof lastRun>) {
    const selected = previous ? documents.getSnapshot().tabs.find((tab) => tab.id === previous.id) : active;
    const requested = selected ?? previous;
    if (screen !== 'editor' || !requested || !runLanguage(requested.name)
      || selected?.error || running.current) return;
    running.current = true;
    const request: NonNullable<typeof liveRun.current> = { id: crypto.randomUUID(), cancelled: false };
    liveRun.current = request;
    try {
      const save = settingsRef.current.saveBeforeRun;
      if (selected && (save || !selected.path) && !await saveTab(selected.id)) return;
      if (request.cancelled) return;
      const tab = selected ? documents.getSnapshot().tabs.find(({ id }) => id === selected.id) : previous;
      if (!tab?.path || !runLanguage(tab.name)) {
        notify('Save as a C, C++, Java, Python, or JavaScript file to run it.', true);
        return;
      }
      if ('dirty' in tab && tab.dirty && save) {
        notify('New edits arrived while saving. Run again to include them.', true);
        return;
      }
      const language = runLanguage(tab.name);
      if (save && root && isWithin(tab.path, root.path) && (language === 'c' || language === 'cpp')) {
        const dirty = documents.affected(root.path).filter((file) => file.dirty);
        if (dirty.length) {
          try {
            const project = await bridge.runConsole.projectInputs(tab.path);
            if (project) {
              const paths = new Set(project.paths);
              const inputs = documents.affected(root.path).filter((file) => file.path && paths.has(file.path));
              if (inputs.some((file) => file.dirty && file.path === project.manifest)) {
                notify('Save .ion/build.json before running the project.', true);
                return;
              }
              if (!await saveMany(inputs)) return;
            }
          } catch (reason) {
            notify(errorMessage(reason), true);
            return;
          }
        }
      }
      if (request.cancelled) return;
      setBottomTab('run');
      if (!settingsRef.current.showOutput) updateSettings({ showOutput: true });
      runConsole.start(tab.name, settingsRef.current.keepRunOutput);
      if ('dirty' in tab && tab.dirty) {
        runConsole.update({ kind: 'data', stream: 'compiler', text: 'Running the last saved version. Editor changes are unsaved.\n' });
      }
      setLastRun({ id: tab.id, path: tab.path, name: tab.name });
      try {
        const expectedRevision = selected && save ? documents.savedRevision(tab.id) : undefined;
        const streamed = new Promise<void>((resolve) => { request.complete = resolve; });
        const launch = bridge.runConsole.start(request.id, tab.path, learningPanel.current, expectedRevision);
        if (consoleSize.current) void bridge.runConsole.resize(request.id, ...consoleSize.current).catch(() => {});
        const [{ learning, problems, sourceRevision, ...result }] = await Promise.all([launch, streamed]);
        if (result.sourceChanged && selected) documents.markConflict(tab.id, tab.path);
        const learned = learningPanel.current ? learning : undefined;
        setRunReport(problems?.length || learned ? {
          tabId: tab.id, path: tab.path, name: tab.name, epoch: 'epoch' in tab ? tab.epoch : undefined,
          revision: sourceRevision, problems: problems ?? [], feedback: learned,
        } : null);
        setSelectedProblem(undefined);
        setLensSelection(undefined);
        runConsole.finish(result);
      } catch (reason) {
        runConsole.fail(errorMessage(reason));
      }
    } finally {
      if (liveRun.current === request) liveRun.current = null;
      running.current = false;
    }
  }

  const stop = () => {
    const request = liveRun.current;
    if (request) request.cancelled = true;
    const pending = request ? bridge.runConsole.cancel(request.id) : bridge.stopRun();
    void pending.catch((reason: unknown) => notify(errorMessage(reason), true));
  };

  const writeRunInput = useCallback((text: string) => {
    const request = liveRun.current;
    if (request && !request.cancelled) void bridge.runConsole.input(request.id, text).catch((reason: unknown) => {
      if (liveRun.current === request) notify(errorMessage(reason), true);
    });
  }, [notify]);

  const resizeConsole = useCallback((cols: number, rows: number) => {
    consoleSize.current = [cols, rows];
    const request = liveRun.current;
    if (request) void bridge.runConsole.resize(request.id, cols, rows).catch(() => {});
  }, []);

  async function previewWeb() {
    if (screen !== 'editor' || !active || active.error || !canPreviewWeb(active.name)) return;
    if ((settingsRef.current.saveBeforeRun || !active.path) && !await saveTab(active.id)) return;
    const tab = documents.getSnapshot().tabs.find(({ id }) => id === active.id);
    if (!tab?.path || !canPreviewWeb(tab.name)) return;
    try { await bridge.runConsole.preview(tab.path); }
    catch (reason) { notify(errorMessage(reason), true); }
  }

  useLayoutEffect(() => {
    closeRequest.current = requestWindowClose;
    commands.current = (value) => {
      if (nativeDialogOpen.current) return;
      if (dialog) {
        if (dialog.kind === 'commands' && value === 'quick-open') setDialog({ kind: 'files' });
        if (dialog.kind === 'commands' && value === 'workspace-search' && root) setDialog({ kind: 'workspace-search' });
        if (dialog.kind === 'files' && value === 'command-palette') setDialog({ kind: 'commands' });
        return;
      }
      const id = activeId;
      switch (value) {
        case 'command-palette': setDialog({ kind: 'commands' }); break;
        case 'quick-open': setDialog({ kind: 'files' }); break;
        case 'workspace-search': if (root) setDialog({ kind: 'workspace-search' }); break;
        case 'welcome': showWelcome(); break;
        case 'new-file': newFile(); break;
        case 'new-starter': chooseStarter(); break;
        case 'insert-starter': if (screen === 'editor') insertStarter(); break;
        case 'open-file': openFile(); break;
        case 'open-folder': openFolder(); break;
        case 'save': if (id && screen === 'editor') void saveTab(id); break;
        case 'save-as': if (id && screen === 'editor') void saveTab(id, 'as'); break;
        case 'close-tab': if (id && screen === 'editor') void closeTab(id); break;
        case 'next-tab':
        case 'previous-tab': {
          if (screen !== 'editor' || tabs.length < 2) break;
          const position = tabs.findIndex((tab) => tab.id === id);
          const step = value === 'next-tab' ? 1 : -1;
          documents.select(tabs[(position + step + tabs.length) % tabs.length].id);
          break;
        }
        case 'find': find(); break;
        case 'replace': find(true); break;
        case 'go-to-line': {
          const lines = editor.current?.lineCount();
          if (id && active && !active.viewer && screen === 'editor' && lines && splitActions.current?.markdown?.mode !== 'preview') {
            setDialog({ kind: 'go-to-line', tabId: id, lines });
          }
          break;
        }
        case 'focus-editor': {
          if (screen !== 'editor') break;
          if (active?.viewer || active?.notebookMode === 'notebook') {
            const code = tabs.find((tab) => !tab.viewer && tab.notebookMode !== 'notebook');
            if (code) documents.select(code.id);
          } else if (splitActions.current?.markdown?.mode === 'preview') splitActions.current.markdown.togglePreview();
          else editor.current?.focus();
          break;
        }
        case 'markdown-preview': if (screen === 'editor') splitActions.current?.markdown?.togglePreview(); break;
        case 'markdown-split': if (screen === 'editor') splitActions.current?.markdown?.toggleSplit(); break;
        case 'toggle-document-split': splitActions.current?.toggle(); break;
        case 'focus-document-split': splitActions.current?.focusDivider(); break;
        case 'run': void run(); break;
        case 'preview-web': void previewWeb(); break;
        case 'stop': stop(); break;
        case 'toggle-explorer': toggleExplorer(); break;
        case 'toggle-marketplace': if (screen === 'editor') toggleMarketplace(); break;
        case 'toggle-output': if (screen === 'editor') toggleBottom(); break;
        case 'toggle-terminal':
          if (screen === 'editor' && settingsRef.current.showOutput && bottomTab === 'terminal') toggleBottom();
          else showTerminal();
          break;
        case 'focus-terminal': showTerminal(); break;
        case 'toggle-auxiliary': if (mode !== 'free' && screen === 'editor') toggleAuxiliary(); break;
        case 'settings': setDialog({ kind: 'settings' }); break;
      }
    };
  });

  const learningPacks = {
    packs: bridge.learningPacks, library: packLibrary, loadError: packLoadError,
    onLibraryChange: applyPackLibrary, onRetry: () => setPackAttempt((attempt) => attempt + 1),
  };

  function renderMarketplace() {
    if (!marketplaceVisible) return undefined;
    if (!marketplaceContent) return <p className="tree-message" role="status">Opening Marketplace…</p>;
    if ('error' in marketplaceContent) {
      return <div className="tree-message" role="alert">
        <p>{marketplaceContent.error}</p>
        <button className="button" onClick={() => setMarketplaceContent(null)}>Retry</button>
      </div>;
    }
    return <marketplaceContent.Component {...learningPacks} library={packLibrary?.catalog.length ? packLibrary : null}
      onClose={() => setMarketplaceVisible(false)} onLearn={learnFromMarketplace}/>;
  }

  function renderAuxiliary() {
    if (!panelMode) return undefined;
    if (!panelContent || panelContent.key !== panelKey) {
      return <p className="tree-message" role="status">Opening {modeNames[mode]}…</p>;
    }
    if ('error' in panelContent) {
      return <div className="tree-message" role="alert">
        <p>{panelContent.error}</p>
        <button className="button" onClick={() => {
          setPanelContent(null);
          setPanelAttempt((attempt) => attempt + 1);
        }}>Retry</button>
      </div>;
    }
    const module = panelContent.module;
    switch (module.mode) {
      case 'learn': return <module.Component {...learningPacks} bridge={bridge.learning} includeCatalog={marketplaceVisible} onMarketplace={() => setMarketplaceVisible(true)}
        feedback={runReport?.tabId === activeId || lensSelection ? feedback : undefined} onClose={closeAuxiliary}
        lensEnabled={settings.learningLens} sourceCurrent={sourceCurrent} lensSelection={feedback ? lensSelection : undefined}
        canRevealDiagnostic={(diagnostic) => problemRows.some(({ problem, canReveal }) => canReveal && problem.raw === diagnostic.raw)}
        onRevealDiagnostic={(diagnostic) => revealProblem(problemRows.findIndex(({ problem, canReveal }) => canReveal && problem.raw === diagnostic.raw))}
        onExercise={({ entry, problemId }) => {
          setPracticeExercise(problemId);
          selectWorkspace('practice');
          openEntry(entry);
        }}/>;
      case 'projects': return <module.Component root={root} onOpenFolder={openFolder} resourceProfile={settings.resourceProfile}
        beforeRun={() => saveMany(root ? documents.affected(root.path) : [])} onDirtyChange={markProjectDraft}/>;
      case 'practice': return <module.Component bridge={bridge.practice} onOpenEntry={openEntry}
        initialProblem={practiceExercise}
        onPrepareRun={(path) => saveMany(documents.affected(path))} onStopRun={stop}
        onClose={closeAuxiliary} onDirtyChange={markPracticeDraft}/>;
    }
  }

  const canRun = Boolean(active && !active.error && runLanguage(active.name));
  const runBusy = runPhase === 'preparing' || runPhase === 'compiling' || runPhase === 'running';
  const shortcut = (id: MenuCommand) => displayShortcut(id, settings.shortcuts, bridge.platform);
  const hint = (id: MenuCommand, label: string) => shortcut(id) ? `${label} (${shortcut(id)})` : label;
  function availableCommand(id: MenuCommand): boolean {
    if (id === 'command-palette') return false;
    if (id === 'workspace-search') return Boolean(root);
    if (['quick-open', 'new-file', 'new-starter', 'open-file', 'open-folder', 'settings', 'toggle-terminal', 'focus-terminal'].includes(id)) return true;
    if (screen !== 'editor') return false;
    switch (id) {
      case 'insert-starter': return Boolean(starterTarget);
      case 'save':
      case 'save-as': return Boolean(active && !active.viewer && !active.error && active.notebookMode !== 'notebook');
      case 'replace':
      case 'go-to-line': return Boolean(active && !active.viewer && !active.error && active.notebookMode !== 'notebook'
        && splitActions.current?.markdown?.mode !== 'preview');
      case 'find': return Boolean(active && splitActions.current?.markdown?.mode !== 'preview');
      case 'close-tab': return Boolean(active);
      case 'markdown-preview':
      case 'markdown-split': return Boolean(splitActions.current?.markdown);
      case 'focus-editor': return tabs.some((tab) => !tab.viewer);
      case 'next-tab':
      case 'previous-tab': return tabs.length > 1;
      case 'run': return canRun && !runBusy;
      case 'stop': return runBusy;
      case 'preview-web': return Boolean(active && !active.error && canPreviewWeb(active.name));
      case 'toggle-document-split': return splitActions.current?.canToggle ?? false;
      case 'focus-document-split': return splitActions.current?.hasDivider ?? false;
      case 'toggle-auxiliary': return mode !== 'free';
      default: return true;
    }
  }
  return (
    <div className="app-shell" style={appearance.style} data-theme={appearance.kind} data-theme-id={activeTheme?.id}
      data-resource-profile={settings.resourceProfile} data-platform={bridge.platform}>
      <header className="titlebar">
        <div className="brand"><Icon name="logo" size={23}/><span>ION</span><i>IDE</i></div>
        {screen === 'editor' && <>
          <div className="title-separator"/>
          <div className="file-actions">
            <button className="icon-button" title={hint('new-file', 'New file')} aria-label="New file" data-testid="new-file" onClick={newFile}><Icon name="filePlus" size={16}/></button>
            <button className="icon-button" title={hint('new-starter', 'New file from starter')} aria-label="New file from starter"
              data-testid="new-starter" onClick={chooseStarter}><Icon name="down" size={14}/></button>
            <button className="icon-button" title={hint('open-file', 'Open file')} aria-label="Open file" data-testid="open-file" onClick={openFile}><Icon name="file" size={16}/></button>
            <button className="icon-button" title="Open folder" aria-label="Open folder" data-testid="open-folder" onClick={openFolder}><Icon name="open" size={16}/></button>
            {root && <button className="icon-button" title={hint('workspace-search', 'Search in Files')} aria-label="Search in Files"
              onClick={() => setDialog({ kind: 'workspace-search' })}><Icon name="search" size={16}/></button>}
            <button className="icon-button" title={hint('save', 'Save file')} aria-label="Save file" data-testid="save-file" disabled={!active || Boolean(active.error || active.viewer)}
              onClick={() => { if (active) void saveTab(active.id); }}><Icon name="save" size={16}/></button>
          </div>
        </>}
        <div className="window-label" title={root?.path}>{screen === 'editor' ? root?.name ?? modeNames[mode] : 'Welcome'}</div>
        <div className="title-actions">
          {recoveryDrafts.length > 0 && <button className="button" data-testid="recover-edits"
            onClick={() => setDialog({ kind: 'recovery' })}>Recover edits ({recoveryDrafts.length})</button>}
          {screen === 'editor' ? <>
            {active && canPreviewWeb(active.name) && <button className="button" data-testid="preview-web" disabled={Boolean(active.error)}
              title="Preview local web project" onClick={() => void previewWeb()}>Preview</button>}
            {runBusy
              ? <button className="button run-button stop-button" data-testid="stop" title={hint('stop', 'Stop')} onClick={stop}><Icon name="stop" size={14}/> Stop</button>
              : <button className="button run-button" data-testid="run" title={canRun ? hint('run', 'Run active file') : 'Open a supported source file to run'}
                disabled={!canRun} onClick={() => void run()}><Icon name="play" size={13}/> Run</button>}
            <button className="icon-button" aria-label="Welcome" title="Welcome" onClick={showWelcome}><Icon name="home" size={17}/></button>
          </> : hasWorkspace ? <button className="button back-to-workspace" onClick={enterWorkspace}><Icon name="code" size={15}/> Return to Workspace</button>
            : sessionAvailable && <button className="button back-to-workspace" data-testid="resume-session"
              disabled={resumingSession} onClick={() => void resumeSession()}><Icon name="code" size={15}/> {resumingSession ? 'Resuming…' : 'Resume Session'}</button>}
          <button className="icon-button" title={hint('command-palette', 'Command Palette')} aria-label="Command Palette" data-testid="command-palette"
            onClick={() => setDialog({ kind: 'commands' })}><Icon name="keyboard" size={17}/></button>
          <button className="icon-button" title={hint('settings', 'Preferences')} aria-label="Preferences" data-testid="settings"
            onClick={() => setDialog({ kind: 'settings' })}><Icon name="settings" size={17}/></button>
        </div>
      </header>
      {screen === 'welcome' && <Welcome recent={recents} onWorkspace={selectWorkspace}
        onNew={newFile} onNewStarter={chooseStarter}
        onFile={() => { setMode('free'); openFile(); }}
        onFolder={() => { setMode('free'); openFolder(); }}
        onRecent={(entry) => { setMode('free'); openRecent(entry); }}/>}
      {(screen === 'editor' || notebookRunning) && <Workbench documents={documents} hidden={screen === 'welcome'} mode={mode}
          auxiliary={renderAuxiliary()} onToggleAuxiliary={toggleAuxiliary}
          marketplace={renderMarketplace()}
          onToggleExplorer={toggleExplorer} onToggleMarketplace={toggleMarketplace}
          active={active} tabs={tabs} root={root} target={target}
          treeRevision={treeRevision} settings={settings} activeTheme={activeTheme} accentColor={appearance.accentColor}
          runConsole={runConsole} canRun={canRun} canRerun={Boolean(lastRun)} cursorRef={cursorRef}
          bottomTab={bottomTab} terminalFocus={terminalFocus} terminalController={terminalController}
          problemRows={problemRows} problemFile={runReport?.name} problemsStale={Boolean(problemRows.length) && !sourceCurrent}
          selectedProblem={selectedProblem} problemMarkers={problemMarkers} onRevealProblem={revealProblem} onExplainProblem={explainProblem}
          onBottomTab={selectBottomTab} onToggleBottom={toggleBottom}
          onSelect={documents.select} onCloseTab={(id) => void closeTab(id)} onOpenEntry={openEntry} onTarget={setTarget}
          onCreate={(kind) => { if (target) setDialog({ kind: 'create', entryKind: kind, parent: target }); }}
          onRename={(entry) => setDialog({ kind: 'rename', entry })} onTrash={(entry) => void trashEntry(entry)}
          onRefresh={refreshTree} onNew={newFile} onOpenFile={openFile} onOpenFolder={openFolder}
          onInsertStarter={starterTarget ? insertStarter : undefined}
          onSettings={updateSettings} onRun={() => void run()} onRerun={() => { if (lastRun) void run(lastRun); }}
          onStop={stop} onRunInput={writeRunInput} onConsoleResize={resizeConsole}
          onEditorActions={setEditor} onSplitActions={setSplitActions} onCursor={updateCursor} onFind={find} onSaveAs={(id) => void saveTab(id, 'as')}
          onReload={(id) => { if (active) setDialog({ kind: 'reload', id, name: active.name, dirty: active.dirty }); }}/>}
      <footer className="status-bar" data-testid="status">
        <span className="local-status"><span className="signal"/>{screen === 'welcome' ? 'Local desktop' : modeNames[mode]}</span>
        <button className="profile-status" type="button" title="Open resource profile settings"
          onClick={() => setDialog({ kind: 'settings' })}>{settings.resourceProfile === 'minimal' ? 'Minimal' : 'Full'}</button>
        <span className={`status-notice ${notice?.error ? 'error' : ''}`} role={notice?.error ? 'alert' : 'status'} title={notice?.message}>
          {notice && <><Icon name={notice.error ? 'warning' : 'check'} size={13}/><span>{notice.message}</span></>}
        </span>
        {screen === 'welcome' && <span className="welcome-status"><Icon name="keyboard" size={14}/> {hint('new-file', 'New File')} <span>·</span> {hint('open-file', 'Open File')}</span>}
      </footer>

      <Suspense fallback={null}>
        {dialog?.kind === 'commands' && <Commands onClose={() => setDialog(null)}
          items={commandEntries.filter(([id]) => availableCommand(id)).map(([id, { label }]) => ({
            id, label, shortcut: shortcut(id), choose: () => {
              setDialog(null);
              requestAnimationFrame(() => commands.current(id));
            },
          }))}/>}
        {dialog?.kind === 'files' && <QuickOpen root={root?.path} tabs={tabs} recents={recents}
          onSelect={(tab) => {
            documents.select(tab.id);
            enterWorkspace();
            setDialog(null);
            if (!tab.viewer) requestAnimationFrame(() => editor.current?.focus());
          }}
          onRecent={(entry) => { setDialog(null); openRecent(entry); }}
          onOpen={(entry) => { setDialog(null); void openNative(() => bridge.quickOpen.open(entry.path)); }}
          onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'workspace-search' && root && <WorkspaceSearch key={root.path} root={root.path}
          onOpen={(path, match) => void openSearchMatch(path, match)} onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'go-to-line' && <GoToLine lines={dialog.lines} onClose={() => setDialog(null)}
          onGo={(line) => {
            const id = dialog.tabId;
            setDialog(null);
            requestAnimationFrame(() => {
              if (documents.getSnapshot().activeId === id) editor.current?.goToLine(line);
            });
          }}/>}
      </Suspense>
      {dialog?.kind === 'new-starter' && <StarterDialog onChoose={createDraft} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'settings' && <PreferencesDialog settings={settings} activeTheme={activeTheme}
        onChange={updateSettings} onUpdateLaunchChange={changeUpdateLaunch} preferencesReady={preferencesReady}
        onThemeChange={changeTheme} onShortcutChange={changeShortcuts} onExportProfile={exportLocalProfile}
        onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'recovery' && <ConfirmDialog title="Recover unsaved edits"
        message={`Ion found ${recoveryDrafts.length} unsaved ${recoveryDrafts.length === 1 ? 'draft' : 'drafts'}. Restore them as separate tabs to review and save.`}
        action="Restore Drafts" alternative="Discard Drafts" onConfirm={restoreDrafts} onAlternative={discardDrafts}
        onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'create' && <EntryDialog title={dialog.entryKind === 'file' ? 'Create file' : 'Create folder'} initial=""
        hasStarter={dialog.entryKind === 'file' ? (name) => Boolean(starterLanguageFor(name)) : undefined}
        onSubmit={(name, useStarter) => create(dialog.parent, name, dialog.entryKind, useStarter)} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'rename' && <EntryDialog title="Rename" initial={dialog.entry.name}
        onSubmit={(name) => rename(dialog.entry, name)} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'close-tab' && <ConfirmDialog title="Unsaved changes"
        message={`Save changes to ${dialog.name} before closing the tab?`} action="Save" alternative="Discard"
        error={notice?.error ? notice.message : undefined}
        onConfirm={async () => { if (await saveMany(documents.getSnapshot().tabs.filter(({ id }) => id === dialog.id))) {
          documents.close(dialog.id);
          setDialog(null);
        } }}
        onAlternative={async () => {
          try {
            await documents.discard(dialog.id);
            setDialog(null);
          } catch (reason) {
            notify(errorMessage(reason), true);
          }
        }}
        onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'close-workspace-draft' && <ConfirmDialog title="Unsaved workspace changes"
        message="Save your project or practice draft in its panel to keep those changes."
        action="Continue Closing" onConfirm={() => { setDialog(null); requestCloseFiles(); }}
        onClose={() => void confirmClose(false)}/>}
      {dialog?.kind === 'close-window' && <ConfirmDialog title="Unsaved changes"
        message="Save your open files or keep your edits as drafts before closing Ion." action="Save All" alternative="Discard"
        extra={{ label: 'Keep Drafts and Quit', action: () => confirmClose(true, 'keep') }}
        error={notice?.error ? notice.message : undefined}
        onConfirm={async () => { if (await saveMany(documents.getSnapshot().tabs)) await confirmClose(true); }}
        onAlternative={() => confirmClose(true, 'discard')} onClose={() => void confirmClose(false)}/>}
      {dialog?.kind === 'reload' && <ConfirmDialog title="Reload from disk"
        message={dialog.dirty ? `Reload ${dialog.name} from disk and discard your unsaved changes?` : `Reload ${dialog.name} from disk?`} action="Reload"
        onConfirm={async () => { if (await documents.reload(dialog.id)) setDialog(null); }} onClose={() => setDialog(null)}/>}
    </div>
  );
}
