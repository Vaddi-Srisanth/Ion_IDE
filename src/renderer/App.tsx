import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { defaultSettings, type Entry, type EntryKind, type MenuCommand, type OptionalPanel, type RecentEntry, type RecoveryDraft, type RunResult, type Settings, type WorkspaceMode } from '../shared/contracts';
import { ConfirmDialog, EntryDialog, Modal, PreferencesDialog, StarterDialog } from './Dialogs';
import { Documents, errorMessage, type InitialDraft, type Tab } from './documents';
import { Icon } from './icons';
import type { EditorActions } from './MonacoSurface';
import { RunConsoleStore } from './run-console/store';
import { isWithin, sourceControlPathKey } from './paths';
import { Welcome } from './Welcome';
import { Onboarding } from './onboarding/Onboarding';
import type { CompilerProblem, LearningDiagnostic, LearningFeedback } from '../shared/learning';
import type { ProblemMarker, ProblemRow } from './Problems';
import { diagnosticPackIds, type PackLibrary } from '../shared/learning-packs';
import type { ThemeData } from '../shared/themes';
import { documentFormat } from '../shared/viewers';
import { canPreviewWeb, runLanguage } from '../shared/run-console';
import { appearanceFor, systemAppearance, themeForPreference } from './appearance';
import { Workbench, type DocumentSplitActions, type ExplorerContextAction, type TabContextAction } from './Workbench';
import { commandEntries, displayShortcut, effectiveShortcut, type ShortcutOverrides } from '../shared/shortcuts';
import { starterCode, starterLanguageFor, starterLanguages, type StarterLanguage } from '../shared/starter-code';
import type { WorkspaceSearchMatch } from '../shared/workspace-search';
import { captureEditorSession, EditorSessionWriter } from './editor-session';
import type { BottomTab } from '../shared/terminal';
import type { TerminalController } from './terminal/controller';
import { useUpdates } from './useUpdates';
import { fileLanguage } from '../shared/languages';
import type { LanguageEditPreview, SourceReference } from '../shared/language-tools';
import type { SourceControlBridge, SourceControlDiff, SourceControlEntry } from '../shared/source-control';
import type { EditorGroupsSnapshot } from './editor-groups';
import type { ExplanationAction, ExplanationOpenResult, ExplanationReply, ExplanationRequest, ExplanationReview } from '../shared/explanations';
import type { DebugBreakpointResult, DebugStartRequest } from '../shared/debug';
import type { DebugController } from './debug/controller';
import type { DebugUiBreakpoint, DebugUiFrame, DebugUiState } from './debug/types';
import type { TaskDefinition, TaskRecord } from '../shared/tasks';

type Dialog =
  | { kind: 'settings'; browseThemes?: boolean }
  | { kind: 'backup'; mode: 'backup' | 'restore' }
  | { kind: 'language-support' }
  | { kind: 'learning-content' }
  | { kind: 'explanation'; request: ExplanationRequest; tabId: string | null; root: string | null; mode: WorkspaceMode; epoch?: number; learningPack: string | null }
  | { kind: 'explanation-excerpt'; label: string; text: string }
  | { kind: 'recommendations'; reply: ExplanationReply; review: ExplanationReview; root: Entry }
  | { kind: 'source-references'; locations?: SourceReference[] }
  | { kind: 'symbol-rename'; initial: string }
  | { kind: 'symbol-rename-review'; preview: LanguageEditPreview }
  | { kind: 'project-tests'; root?: Entry }
  | { kind: 'test-explorer' }
  | { kind: 'tasks' }
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
const modeNames: Record<WorkspaceMode, string> = { free: 'Code', learn: 'Learn', projects: 'Projects', practice: 'Practice Lab' };
const bridge = window.ion;
const Commands = lazy(async () => ({ default: (await import('./CommandPicker')).Commands }));
const QuickOpen = lazy(async () => ({ default: (await import('./CommandPicker')).QuickOpen }));
const WorkspaceSearch = lazy(() => import('./WorkspaceSearch'));
const LanguageSupport = lazy(() => import('./LanguageSupport'));
const BackupDialog = lazy(async () => ({ default: (await import('./backup/BackupDialog')).BackupDialog }));
const LearningContentSettings = lazy(async () => ({ default: (await import('./learning/LearningContentSettings')).LearningContentSettings }));
const ExplanationDialog = lazy(async () => ({ default: (await import('./explanations/ExplanationDialog')).ExplanationDialog }));
const ReviewRecommendations = lazy(async () => ({ default: (await import('./projects/ReviewRecommendations')).ReviewRecommendations }));
const SourceControlPanel = lazy(() => import('./source-control/SourceControlPanel'));
const SourceControlDiffView = lazy(() => import('./source-control/SourceControlDiffView'));
const ProjectTestsDialog = lazy(() => import('./projects/ProjectTestsDialog'));
const TaskPicker = lazy(() => import('./tasks/TaskPicker'));
const TestExplorer = lazy(() => import('./test-explorer/TestExplorer'));
const GoToLine = lazy(async () => ({ default: (await import('./CommandPicker')).GoToLine }));
type DebugModule = typeof import('./debug');
const idleDebugState: DebugUiState = {
  phase: 'idle', status: 'Ready', frames: [], scopes: [], breakpoints: [], watches: [], output: [],
};

interface SourceLocation {
  path?: string;
  tabId?: string;
  line: number;
  column: number;
}

function pushLocation(stack: SourceLocation[], position: SourceLocation) {
  const previous = stack.at(-1);
  if ((position.path ? previous?.path === position.path : previous?.tabId === position.tabId)
    && previous?.line === position.line && previous.column === position.column) return;
  stack.push(position);
  if (stack.length > 64) stack.shift();
}

interface RunReport {
  tabId: string;
  path: string;
  name: string;
  epoch?: number;
  revision?: string;
  problems: CompilerProblem[];
  feedback?: LearningFeedback;
}

interface ClosedTab {
  path: string | null;
  name: string;
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
  const [restoreRequest, setRestoreRequest] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaultSettings, autoSave: false }));
  const settingsRef = useRef(settings);
  const preferencesLoaded = useRef(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const updates = useUpdates();
  const checkUpdates = updates.check;
  const [activeTheme, setActiveTheme] = useState<ThemeData | null>(null);
  const activeThemeId = useRef<string>(null);
  const [previewTheme, setPreviewTheme] = useState<ThemeData | null>(null);
  const displayTheme = previewTheme ?? activeTheme;
  const themeChanging = useRef(false);
  const appearance = useMemo(() => appearanceFor(displayTheme, settings.accent), [displayTheme, settings.accent]);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoveryDraft[]>([]);
  const [screen, setScreen] = useState<'welcome' | 'editor'>('welcome');
  const [onboarding, setOnboarding] = useState<'first' | 'replay' | null>(bridge.firstLaunch ? 'first' : null);
  const dismissOnboarding = useCallback(() => setOnboarding(null), []);
  const [mode, setMode] = useState<WorkspaceMode>('free');
  const [auxiliaryVisible, setAuxiliaryVisible] = useState(true);
  const [packLibrary, setPackLibrary] = useState<PackLibrary | null>(null);
  const packVisibility = useRef<'hidden' | 'learn'>('hidden');
  const selectedLearningLanguage = useRef<string | null>(null);
  const applyPackLibrary = useCallback((library: PackLibrary) => {
    selectedLearningLanguage.current = library.selected;
    const visibility = packVisibility.current;
    if (visibility === 'hidden') return;
    setPackLibrary(library);
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
  const [roots, setRoots] = useState<Entry[]>([]);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const [sourceControlVisible, setSourceControlVisible] = useState(false);
  const [debugVisible, setDebugVisible] = useState(false);
  const [debugModule, setDebugModule] = useState<DebugModule | null>(null);
  const debugController = useRef<DebugController | null>(null);
  const debugLoad = useRef<Promise<{ module: DebugModule; controller: DebugController }> | null>(null);
  const debugUnsubscribe = useRef<(() => void) | null>(null);
  const [debugState, setDebugState] = useState<DebugUiState>(idleDebugState);
  const [debugBreakpoints, setDebugBreakpoints] = useState<ReadonlyMap<string, readonly number[]>>(() => new Map());
  const [sourceControlEntries, setSourceControlEntries] = useState<readonly SourceControlEntry[]>([]);
  const [sourceControlDiff, setSourceControlDiff] = useState<SourceControlDiff>();
  const [sourceWrites, setSourceWrites] = useState(0);
  const sourceControlRoot = sourceControlVisible && screen === 'editor' ? root?.path : undefined;
  const liveSourceControlRoot = useRef(sourceControlRoot);
  liveSourceControlRoot.current = sourceControlRoot;
  const sourceControlBridge = useMemo<SourceControlBridge | undefined>(() => {
    if (!sourceControlRoot) return;
    return {
      status: () => bridge.sourceControl.status(sourceControlRoot),
      createTag: (request) => bridge.sourceControl.createTag(sourceControlRoot, request),
      createBranch: (request) => bridge.sourceControl.createBranch(sourceControlRoot, request),
      switchBranch: (request) => bridge.sourceControl.switchBranch(sourceControlRoot, request),
      fetchGitHub: (request) => bridge.sourceControl.fetchGitHub(sourceControlRoot, request),
      saveStashSnapshot: () => bridge.sourceControl.saveStashSnapshot(sourceControlRoot),
      popStash: (request) => bridge.sourceControl.popStash(sourceControlRoot, request),
      conflict: (request) => bridge.sourceControl.conflict(sourceControlRoot, request),
      cancelBlame: (path) => bridge.sourceControl.cancelBlame(sourceControlRoot, path),
      blame: (request) => bridge.sourceControl.blame(sourceControlRoot, request),
      previewComparison: (request) => bridge.sourceControl.previewComparison(sourceControlRoot, request),
      browse: () => bridge.sourceControl.browse(sourceControlRoot),
      github: (repository) => bridge.sourceControl.github(sourceControlRoot, repository),
      githubSignIn: () => bridge.sourceControl.githubSignIn(sourceControlRoot),
      githubSignOut: () => bridge.sourceControl.githubSignOut(sourceControlRoot),
      onGitHubAuthEvent: callback => bridge.sourceControl.onGitHubAuthEvent(callback),
      githubPullRequest: (request) => bridge.sourceControl.githubPullRequest(sourceControlRoot, request),
      githubIssue: (request) => bridge.sourceControl.githubIssue(sourceControlRoot, request),
      createGitHubPullRequest: (request) => bridge.sourceControl.createGitHubPullRequest(sourceControlRoot, request),
      cloneGitHub: (repository, access) => bridge.sourceControl.cloneGitHub(sourceControlRoot, repository, access),
      closeGitHub: () => bridge.sourceControl.closeGitHub(sourceControlRoot),
      openGitHubPage: (url) => bridge.sourceControl.openGitHubPage(sourceControlRoot, url),
      trust: () => bridge.sourceControl.trust(sourceControlRoot),
      diff: (request) => bridge.sourceControl.diff(sourceControlRoot, request),
      change: (request) => bridge.sourceControl.change(sourceControlRoot, request),
      discardWorking: (request) => bridge.sourceControl.discardWorking(sourceControlRoot, request),
      commit: (request) => bridge.sourceControl.commit(sourceControlRoot, request),
      close: () => bridge.sourceControl.close(sourceControlRoot),
    };
  }, [sourceControlRoot]);
  useEffect(() => () => { void sourceControlBridge?.close().catch(() => {}); }, [sourceControlBridge]);
  const closeSourceControl = useCallback(() => {
    setSourceControlVisible(false);
    setSourceControlDiff(undefined);
    setSourceControlEntries([]);
  }, []);
  const toggleSourceControl = () => {
    if (sourceControlVisible) closeSourceControl();
    else {
      setDebugVisible(false);
      setSourceControlVisible(true);
    }
  };
  const ensureDebug = useCallback(async () => {
    if (debugController.current && debugModule) return { module: debugModule, controller: debugController.current };
    if (debugLoad.current) return debugLoad.current;
    const pending = import('./debug').then((module) => {
      const controller = new module.DebugController(bridge.debug);
      debugController.current = controller;
      debugUnsubscribe.current = controller.subscribe(() => setDebugState(controller.getSnapshot()));
      setDebugState(controller.getSnapshot());
      setDebugModule(module);
      return { module, controller };
    }).finally(() => { debugLoad.current = null; });
    debugLoad.current = pending;
    return pending;
  }, [debugModule]);
  const closeDebug = useCallback(() => setDebugVisible(false), []);
  const [sessionAvailable, setSessionAvailable] = useState(false);
  const [resumingSession, setResumingSession] = useState(false);
  const sessionStarted = useRef(false);
  const sessionRoot = useRef(root);
  sessionRoot.current = root;
  const [target, setTarget] = useState<string | null>(null);
  const navigation = useRef({ back: [] as SourceLocation[], forward: [] as SourceLocation[], pending: false });
  const [navigationState, setNavigationState] = useState({ back: false, forward: false });
  useEffect(() => {
    const history = navigation.current;
    if (history.back.length || history.forward.length || history.pending) {
      navigation.current = { back: [], forward: [], pending: false };
      setNavigationState({ back: false, forward: false });
    }
  }, [root?.path]);
  const panelMode = screen === 'editor' && auxiliaryVisible && mode !== 'free' ? mode : null;
  const needsPackLibrary = screen === 'editor' && panelMode === 'learn';
  const panelRoot = panelMode === 'projects' ? root?.path : undefined;
  const panelKey = panelMode ? panelMode + (panelRoot ? ':' + panelRoot : '') : null;
  const [panelContent, setPanelContent] = useState<PanelContent | null>(null);
  const [panelAttempt, setPanelAttempt] = useState(0);
  const requestedPanel = useRef<string | null>(null);
  const learningPanel = useRef(false);

  const [treeRevision, setTreeRevision] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tutorLesson, setTutorLesson] = useState<{ packId: string; lessonId: string; request: number }>();
  const explanationOpening = useRef(false);
  const explanationMode = useRef(mode);
  explanationMode.current = mode;
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
  const formatRequest = useRef<AbortController | null>(null);
  const [formatting, setFormatting] = useState(false);
  const splitActions = useRef<DocumentSplitActions | null>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const commands = useRef<(value: MenuCommand) => void>(() => {});
  const closeRequest = useRef<() => void>(() => {});
  const recentlyClosed = useRef<ClosedTab[]>([]);
  const pendingTabClosures = useRef<string[]>([]);
  const drainingTabClosures = useRef(false);

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
  }, (path) => {
    const repository = liveSourceControlRoot.current;
    if (repository && isWithin(path, repository)) setSourceWrites((count) => count + 1);
  }));
  const editorGroups = useRef<EditorGroupsSnapshot | undefined>(undefined);
  const [initialEditorGroups, setInitialEditorGroups] = useState<EditorGroupsSnapshot>();
  const [sessionWriter] = useState(() => new EditorSessionWriter(
    async () => {
      if (sessionStarted.current) await bridge.editorSession.save(captureEditorSession(
        documents, sessionRoot.current?.path ?? null, editorGroups.current, rootsRef.current.map(({ path }) => path)));
    },
    (reason) => notify(`Could not checkpoint the editor session. ${errorMessage(reason)}`, true),
  ));
  const handleEditorGroups = useCallback((snapshot: EditorGroupsSnapshot) => {
    editorGroups.current = snapshot;
    setInitialEditorGroups(snapshot);
    sessionWriter.schedule();
  }, [sessionWriter]);
  const { tabs, activeId } = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const active = tabs.find(({ id }) => id === activeId);
  useEffect(() => setSourceControlDiff(undefined), [activeId]);
  const selectWorkbenchTab = useCallback((id: string) => { setSourceControlDiff(undefined); documents.select(id); }, [documents]);
  const hasUnsavedSource = useCallback((path: string) => {
    const key = sourceControlPathKey(path);
    return documents.getSnapshot().tabs.some((tab) => tab.path && (tab.dirty || tab.conflict)
      && sourceControlPathKey(tab.path) === key);
  }, [documents]);
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

  const explanationTab = dialog?.kind === 'explanation' ? dialog.tabId : null;
  const subscribeExplanationInvalidation = useCallback((listener: () => void) => explanationTab
    ? documents.subscribeText(explanationTab, listener) : () => {}, [documents, explanationTab]);
  const refreshExplanationContext = useCallback(async (request: ExplanationRequest): Promise<ExplanationRequest> => {
    if (!request.code) return request;
    const { captureEditorContext } = await import('./explanations/editor-context');
    const code = captureEditorContext(documents);
    if (!code || code.path !== request.code.path || code.label !== request.code.label) throw new Error('The active source changed. Reopen explanations.');
    return { ...request, code };
  }, [documents]);
  useEffect(() => {
    setDialog(current => current?.kind === 'explanation' && (current.root !== (root?.path ?? null)
      || current.mode !== mode || current.tabId !== activeId || current.epoch !== active?.epoch
      || settings.resourceProfile !== 'full' || screen !== 'editor' || active?.conflict
      || current.mode === 'learn' && current.learningPack !== (packLibrary?.selected ?? null)) ? null : current);
  }, [root?.path, mode, activeId, active?.epoch, active?.conflict, settings.resourceProfile, screen, packLibrary?.selected]);

  async function openExplanation(request: ExplanationRequest) {
    if (explanationOpening.current || settingsRef.current.resourceProfile !== 'full') return;
    explanationOpening.current = true;
    const ownerRoot = sessionRoot.current?.path ?? null;
    const ownerMode = explanationMode.current;
    const before = documents.getSnapshot();
    try {
      const { captureEditorContext, diagnosticContext } = await import('./explanations/editor-context');
      const code = captureEditorContext(documents);
      const current = documents.getSnapshot();
      if (ownerRoot !== (sessionRoot.current?.path ?? null) || ownerMode !== explanationMode.current || before.activeId !== current.activeId) return;
      const tab = current.tabs.find(item => item.id === current.activeId);
      setDialog({ kind: 'explanation', request: { ...request, ...(code ? { code } : {}), ...(request.diagnostic ? { diagnostic: diagnosticContext(request.diagnostic) } : {}) },
        tabId: current.activeId, root: ownerRoot, mode: ownerMode, epoch: tab?.epoch, learningPack: selectedLearningLanguage.current });
    } catch (reason) { notify(errorMessage(reason), true); }
    finally { explanationOpening.current = false; }
  }
  const openExplanationCitation = (result: ExplanationOpenResult) => {
    setDialog(null);
    if (result.entry) {
      if (result.range) void navigateSource({ path: result.entry.path, line: result.range.startLine, column: result.range.startColumn });
      else openWorkbenchEntry(result.entry);
    } else if (result.lesson) {
      setTutorLesson({ ...result.lesson, request: performance.now() });
    } else if (result.text !== undefined) setDialog({ kind: 'explanation-excerpt', label: result.label ?? 'Reviewed excerpt', text: result.text });
  };

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
      if (preferences.settings.checkUpdatesOnLaunch) void checkUpdates(true);
    }).catch((reason: unknown) => {
      if (!cancelled) notify(errorMessage(reason), true);
    }).finally(() => {
      if (!cancelled) setPreferencesReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(noticeTimer.current);
    };
  }, [documents, notify, checkUpdates]);

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
    packVisibility.current = needsPackLibrary ? 'learn' : 'hidden';
  }, [needsPackLibrary]);

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
    if (!needsPackLibrary) {
      setPackLibrary(null);
      setPackLoadError(undefined);
      return;
    }
    let current = true;
    setPackLoadError(undefined);
    void bridge.learningPacks.getLibrary(true).then((library) => {
      if (current) applyPackLibrary(library);
    }, (reason: unknown) => {
      if (current) setPackLoadError(errorMessage(reason));
    });
    return () => { current = false; };
  }, [needsPackLibrary, packAttempt, applyPackLibrary]);

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

  const changeTheme = useCallback(async (selection: string, loaded?: ThemeData) => {
    if (!preferencesReady || themeChanging.current) throw new Error('Please wait for the current theme to finish loading.');
    themeChanging.current = true;
    try {
      const id = themeForPreference(selection);
      const palette = id === activeThemeId.current ? null : loaded?.id === id ? loaded : await bridge.themes.load(id);
      const recentThemes = [selection, ...settingsRef.current.recentThemes.filter((item) => item !== selection)].slice(0, 8);
      const saved = await bridge.updateSettings({ theme: selection, recentThemes });
      applySettings({ theme: saved.theme, recentThemes: saved.recentThemes });
      if (palette) activateTheme(palette);
    } finally {
      themeChanging.current = false;
    }
  }, [activateTheme, applySettings, preferencesReady]);

  async function changeThemeFavorite(id: string) {
    const favorites = settingsRef.current.themeFavorites;
    const themeFavorites = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
    const saved = await bridge.updateSettings({ themeFavorites });
    applySettings({ themeFavorites: saved.themeFavorites });
  }

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
  const showDebug = useCallback(() => {
    if (screen === 'welcome') enterWorkspace();
    closeSourceControl();
    setDebugVisible(true);
    void ensureDebug().catch((reason: unknown) => notify(`Could not open Run and Debug. ${errorMessage(reason)}`, true));
  }, [closeSourceControl, ensureDebug, enterWorkspace, notify, screen]);
  const toggleDebug = useCallback(() => {
    if (debugVisible) closeDebug();
    else showDebug();
  }, [closeDebug, debugVisible, showDebug]);
  useEffect(() => () => { terminalController.current?.dispose(); }, []);
  useEffect(() => () => {
    debugUnsubscribe.current?.();
    debugUnsubscribe.current = null;
    const controller = debugController.current;
    debugController.current = null;
    if (controller) void controller.dispose(false);
  }, []);

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
  const debugBreakpointRows = useCallback((path: string): DebugBreakpointResult[] =>
    [...(debugBreakpoints.get(sourceControlPathKey(path)) ?? [])]
      .sort((left, right) => left - right)
      .slice(0, 256)
      .map((line) => ({ path, line, verified: false })), [debugBreakpoints]);

  useEffect(() => {
    const controller = debugController.current;
    if (!debugVisible || !debugModule || !controller
      || debugState.phase === 'starting' || debugState.phase === 'running'
      || debugState.phase === 'paused' || debugState.phase === 'stopping') return;
    const active = tabs.find(({ id }) => id === activeId);
    controller.setBreakpoints(active?.path ? debugBreakpointRows(active.path) : []);
  }, [activeId, debugBreakpointRows, debugModule, debugState.phase, debugVisible, tabs]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    if (!Number.isInteger(line) || line < 1) return;
    const key = sourceControlPathKey(path);
    setDebugBreakpoints((current) => {
      const next = new Map(current);
      const lines = new Set(next.get(key) ?? []);
      if (lines.has(line)) lines.delete(line);
      else if (lines.size < 256) lines.add(line);
      if (lines.size) next.set(key, [...lines].sort((left, right) => left - right));
      else next.delete(key);
      const controller = debugController.current;
      if (controller && debugState.phase !== 'running' && debugState.phase !== 'paused') {
        controller.setBreakpoints([...lines].sort((left, right) => left - right)
          .map((entry) => ({ path, line: entry, verified: false })));
      }
      return next;
    });
  }, [debugState.phase]);

  async function startDebugging() {
    if (screen !== 'editor' || nativeDialogOpen.current) return;
    let tab = documents.getSnapshot().tabs.find(({ id }) => id === documents.getSnapshot().activeId);
    if (!tab?.path || tab.viewer || tab.notebookMode || tab.error || tab.conflict) {
      notify('Open a saved C or C++ source file to start debugging.', true);
      return;
    }
    const language = fileLanguage(tab.name).id;
    if (language !== 'c' && language !== 'cpp') {
      notify('The first debugger milestone supports saved C and C++ source files.', true);
      return;
    }
    if (tab.dirty && !await saveTab(tab.id)) return;
    tab = documents.getSnapshot().tabs.find(({ id }) => id === tab?.id);
    const expectedRevision = tab ? documents.savedRevision(tab.id) : undefined;
    const expectedContentHash = tab ? documents.savedContentHash(tab.id) : undefined;
    if (!tab?.path || tab.dirty || tab.conflict || !expectedRevision || !expectedContentHash) {
      notify('Save the current file before starting the debugger.', true);
      return;
    }
    showDebug();
    selectBottomTab('debug');
    if (!settingsRef.current.showOutput) updateSettings({ showOutput: true });
    try {
      const { controller } = await ensureDebug();
      const request: DebugStartRequest = {
        sourcePath: tab.path, language, version: tab.epoch, expectedRevision, expectedContentHash,
        breakpoints: debugBreakpointRows(tab.path).map(({ verified: _verified, message: _message, id: _id, ...item }) => item),
      };
      await controller.start(request);
    } catch (reason) {
      notify(errorMessage(reason), true);
    }
  }
  async function resumeSession() {
    if (nativeDialogOpen.current || sessionStarted.current) return;
    nativeDialogOpen.current = true;
    setResumingSession(true);
    try {
      const resumed = await bridge.editorSession.resume();
      if (sessionStarted.current) return;
      const recovered = new Set<string>();
      const restoredIds = new Map<number, string>();
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
        restoredIds.set(index, id);
        if (notebookMode) documents.setNotebookMode(id, notebookMode);
        if (view) documents.setEditorView(id, view);
        if (index === resumed.activeIndex) selected = id;
      }
      if (selected) documents.select(selected);
      if (resumed.editorGroups) {
        const groups: EditorGroupsSnapshot = { version: 1, layout: resumed.editorGroups.layout,
          activeGroupId: resumed.editorGroups.activeGroupId,
          groups: resumed.editorGroups.groups.map((group) => ({ id: group.id,
            tabs: group.tabs.flatMap((index) => restoredIds.has(index) ? [restoredIds.get(index)!] : []),
            activeId: restoredIds.get(group.activeIndex) ?? null,
          })) };
        setInitialEditorGroups(groups);
        editorGroups.current = groups;
      }
      if (recovered.size) setRecoveryDrafts((drafts) => drafts.filter(({ id }) => !recovered.has(id)));
      if (resumed.root) {
        setRoot(resumed.root);
        setRoots(resumed.roots?.length ? resumed.roots : [resumed.root]);
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
    if (next !== mode && (projectDraft.current || practiceDraft.current)) {
      notify('Save or close the current draft before switching workspaces.');
      return;
    }
    closeSourceControl();
    if (next !== 'practice') setPracticeExercise(undefined);
    setMode(next);
    setLensSelection(undefined);
    setAuxiliaryVisible(true);
    enterWorkspace();
  };
  const showWelcome = () => {
    closeSourceControl();
    setLensSelection(undefined);
    setScreen('welcome');
  };
  const toggleExplorer = () => {
    updateSettings({ showExplorer: !settingsRef.current.showExplorer });
  };
  const openEntry = useCallback((entry: Entry) => {
    dismissOnboarding();
    if (entry.kind === 'folder') {
      closeSourceControl();
      setRoot(entry);
      setRoots([entry]);
      setTarget(entry.path);
      refreshTree();
      if (!settingsRef.current.showExplorer) updateSettings({ showExplorer: true });
    } else {
      documents.open(entry);
    }
    enterWorkspace();
  }, [closeSourceControl, dismissOnboarding, documents, enterWorkspace, refreshTree, updateSettings]);
  const openWorkbenchEntry = useCallback((entry: Entry) => { setSourceControlDiff(undefined); openEntry(entry); }, [openEntry]);
  const selectWorkspaceTarget = useCallback((path: string) => {
    setTarget(path);
    const owner = rootsRef.current.find((entry) => isWithin(path, entry.path));
    if (owner && owner.path !== root?.path) {
      closeSourceControl();
      setRoot(owner);
    }
  }, [closeSourceControl, root?.path]);

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

  useEffect(() => {
    const binding = effectiveShortcut('rename-symbol', settings.shortcuts, bridge.platform);
    if (!/^F(?:[1-9]|1[0-2])$/.test(binding)) return;
    const invokeRename = (event: KeyboardEvent) => {
      if (event.key.toUpperCase() !== binding || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (!target?.closest('.monaco-editor')
        && target?.closest('[role="tree"], input, textarea, select, dialog, [contenteditable="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      commands.current('rename-symbol');
    };
    window.addEventListener('keydown', invokeRename, true);
    return () => window.removeEventListener('keydown', invokeRename, true);
  }, [bridge.platform, settings.shortcuts]);

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
  const addFolder = async () => {
    if (nativeDialogOpen.current) return;
    nativeDialogOpen.current = true;
    try {
      const entry = await bridge.addFolder();
      if (!entry) return;
      setRoots((current) => current.some(({ path }) => path === entry.path) ? current : [...current, entry]);
      setTarget(entry.path);
      refreshRecents();
      refreshTree();
      enterWorkspace();
    } catch (reason) { notify(errorMessage(reason), true); }
    finally { nativeDialogOpen.current = false; }
  };
  const removeFolder = async (path: string) => {
    try {
      if (!await bridge.removeFolder(path)) return;
      setRoots((current) => {
        const next = current.filter((entry) => entry.path !== path);
        if (root?.path === path) setRoot(next[0] ?? null);
        setTarget((selected) => selected && isWithin(path, selected) ? next[0]?.path ?? null : selected);
        return next;
      });
      refreshTree();
    } catch (reason) { notify(errorMessage(reason), true); }
  };
  const reorderFolder = async (path: string, offset: -1 | 1) => {
    try {
      if (!await bridge.reorderFolder(path, offset)) return;
      setRoots((current) => {
        const index = current.findIndex((entry) => entry.path === path);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    } catch (reason) { notify(errorMessage(reason), true); }
  };
  const saveWorkspace = async () => {
    if (nativeDialogOpen.current || !rootsRef.current.length) return;
    nativeDialogOpen.current = true;
    try {
      if (await bridge.saveWorkspace(rootsRef.current.map(({ path }) => path), settingsRef.current)) {
        notify('Workspace configuration saved.');
      }
    } catch (reason) { notify(errorMessage(reason), true); }
    finally { nativeDialogOpen.current = false; }
  };
  const openWorkspace = async () => {
    if (nativeDialogOpen.current) return;
    const current = documents.getSnapshot();
    if (current.tabs.some((tab) => tab.dirty || tab.conflict || tab.notebookRunning)) {
      notify('Save, close, or keep drafts for modified files before opening another workspace.', true);
      return;
    }
    nativeDialogOpen.current = true;
    try {
      const opened = await bridge.openWorkspace();
      if (!opened) return;
      for (const tab of current.tabs) documents.close(tab.id);
      closeSourceControl();
      setRoots(opened.roots);
      setRoot(opened.roots[0] ?? null);
      setTarget(opened.roots[0]?.path ?? null);
      const nextSettings = { ...settingsRef.current, ...opened.settings };
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      documents.setSettings(nextSettings);
      setInitialEditorGroups(undefined);
      editorGroups.current = undefined;
      refreshRecents();
      refreshTree();
      enterWorkspace();
    } catch (reason) { notify(errorMessage(reason), true); }
    finally { nativeDialogOpen.current = false; }
  };
  function currentSourceLocation(): SourceLocation | undefined {
    const { tabs: openTabs, activeId: selected } = documents.getSnapshot();
    const tab = openTabs.find(({ id }) => id === selected);
    if (!tab || tab.error || tab.viewer || tab.notebookMode === 'notebook') return;
    const cursor = editor.current?.position(tab.id);
    const saved = documents.getEditorView(tab.id)?.selections[0];
    return { path: tab.path ?? undefined, tabId: tab.id,
      line: cursor?.line ?? saved?.positionLineNumber ?? 1,
      column: cursor?.column ?? saved?.positionColumn ?? 1 };
  }

  async function showSourceLocation(location: SourceLocation): Promise<boolean> {
    const findTab = () => documents.getSnapshot().tabs.find((tab) =>
      location.path ? tab.path === location.path : tab.id === location.tabId);
    let tab = findTab();
    if (!tab && location.path) {
      await openNative(() => bridge.quickOpen.open(location.path!));
      tab = findTab();
    }
    if (!tab || tab.error || tab.viewer || tab.notebookMode === 'notebook') return false;
    if (tab.path) splitActions.current?.showSource(tab.path);
    const id = tab.id;
    documents.select(id);
    if (!editor.current?.goToLine(location.line, location.column, id)) {
      documents.requestPosition(id, location.line, location.column);
    }
    return true;
  }

  async function navigateSource(location: SourceLocation, direction?: 'back' | 'forward') {
    const history = navigation.current;
    if (history.pending) return;
    history.pending = true;
    const origin = currentSourceLocation();
    setSourceControlDiff(undefined);
    try {
      const shown = await showSourceLocation(location);
      if (navigation.current !== history) return;
      if (!shown) {
        if (direction) {
          history[direction].pop();
          setNavigationState({ back: history.back.length > 0, forward: history.forward.length > 0 });
        }
        return;
      }
      if (direction) {
        history[direction].pop();
        if (origin) pushLocation(history[direction === 'back' ? 'forward' : 'back'], origin);
      } else if (origin && ((location.path ? origin.path !== location.path : origin.tabId !== location.tabId)
        || origin.line !== location.line || origin.column !== location.column)) {
        pushLocation(history.back, origin);
        history.forward.length = 0;
      }
      setNavigationState({ back: history.back.length > 0, forward: history.forward.length > 0 });
    } finally {
      history.pending = false;
    }
  }

  function walkHistory(direction: 'back' | 'forward') {
    const location = navigation.current[direction].at(-1);
    if (location) void navigateSource(location, direction);
  }

  function openSearchMatch(path: string, { line, column }: Pick<WorkspaceSearchMatch, 'line' | 'column'>) {
    setDialog(null);
    void navigateSource({ path, line, column });
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
    void navigateSource({ tabId, path, line, column });
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

  function canFormatDocument() {
    return screen === 'editor' && active && !active.viewer && !active.error && !active.notebookMode && !active.conflict
      && splitActions.current?.markdown?.mode !== 'preview';
  }

  async function formatDocument() {
    if (formatRequest.current) return;
    const actions = editor.current;
    if (!activeId || !actions || !canFormatDocument()) {
      notify('Open an editable source file to format it.', true);
      return;
    }
    const controller = new AbortController();
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        event.stopPropagation();
        controller.abort('escape');
      }
    };
    formatRequest.current = controller;
    setFormatting(true);
    window.addEventListener('keydown', cancel, true);
    try {
      const result = await actions.format(activeId, controller);
      if (result.kind === 'formatted') notify('Formatted with ' + result.tool + '.');
      else if (result.kind === 'unchanged') notify(result.tool ? 'Already formatted.' : 'Document is empty.');
      else notify(result.message, result.kind !== 'cancelled');
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      window.removeEventListener('keydown', cancel, true);
      formatRequest.current = null;
      setFormatting(false);
    }
  }

  function rememberClosedTab(tab: Tab) {
    const history = recentlyClosed.current;
    history.unshift({ path: tab.path, name: tab.name });
    if (history.length > 24) history.length = 24;
  }

  function closeSettledTab(id: string, remember = true) {
    const tab = documents.getSnapshot().tabs.find((entry) => entry.id === id);
    if (!tab) return;
    if (remember) rememberClosedTab(tab);
    documents.close(id);
  }

  async function drainTabClosures() {
    if (drainingTabClosures.current || dialog || nativeDialogOpen.current) return;
    drainingTabClosures.current = true;
    try {
      while (pendingTabClosures.current.length) {
        const id = pendingTabClosures.current.shift()!;
        await documents.settle([id]);
        const tab = documents.getSnapshot().tabs.find((entry) => entry.id === id);
        if (!tab) continue;
        if (tab.notebookRunning) {
          pendingTabClosures.current = [];
          notify('Finish or stop the notebook run before closing its tab.', true);
          return;
        }
        if (tab.dirty) {
          setNotice(null);
          setDialog({ kind: 'close-tab', id, name: tab.name });
          return;
        }
        closeSettledTab(id);
      }
    } finally {
      drainingTabClosures.current = false;
    }
  }

  function requestCloseTabs(ids: readonly string[]) {
    if (dialog || nativeDialogOpen.current || drainingTabClosures.current) return;
    const open = new Set(documents.getSnapshot().tabs.map(({ id }) => id));
    pendingTabClosures.current = [...new Set(ids)].filter((id) => open.has(id));
    void drainTabClosures();
  }

  function handleTabContextAction(action: TabContextAction, id: string) {
    const openTabs = documents.getSnapshot().tabs;
    const position = openTabs.findIndex((tab) => tab.id === id);
    if (position < 0) return;
    if (action === 'close') requestCloseTabs([id]);
    else if (action === 'close-others') requestCloseTabs(openTabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
    else if (action === 'close-right') requestCloseTabs(openTabs.slice(position + 1).map((tab) => tab.id));
    else if (action === 'close-saved') requestCloseTabs(openTabs.filter((tab) => !tab.dirty).map((tab) => tab.id));
    else requestCloseTabs(openTabs.map((tab) => tab.id));
  }

  function handleExplorerContextAction(action: ExplorerContextAction, entry: Entry, isRoot: boolean) {
    if (action === 'open') {
      if (entry.kind === 'file') openWorkbenchEntry(entry);
      else selectWorkspaceTarget(entry.path);
    } else if (action === 'new-file' || action === 'new-folder') {
      if (entry.kind !== 'folder') return;
      selectWorkspaceTarget(entry.path);
      setDialog({ kind: 'create', entryKind: action === 'new-file' ? 'file' : 'folder', parent: entry.path });
    } else if (action === 'rename' && !isRoot) setDialog({ kind: 'rename', entry });
    else if (action === 'trash' && !isRoot) void trashEntry(entry);
    else if (action === 'copy-path') {
      void bridge.copyPath(entry.path).then(() => notify('Copied path.')).catch((reason: unknown) => notify(errorMessage(reason), true));
    } else if (action === 'reveal') {
      void bridge.revealInFolder(entry.path).catch((reason: unknown) => notify(errorMessage(reason), true));
    } else if (action === 'remove-root' && isRoot) void removeFolder(entry.path);
  }

  async function closeTab(id: string) {
    requestCloseTabs([id]);
  }

  function reopenClosedTab() {
    const closed = recentlyClosed.current.shift();
    if (!closed) return;
    if (closed.path) openWorkbenchEntry({ kind: 'file', path: closed.path, name: closed.name });
    else {
      documents.open(undefined, { name: closed.name, text: '' });
      enterWorkspace();
    }
  }

  useEffect(() => {
    if (!dialog && pendingTabClosures.current.length) void drainTabClosures();
  }, [dialog]);

  async function checkpointBackup() {
    const resume = await documents.checkpointDrafts();
    try { await sessionWriter.flush(true); } finally { resume(); }
  }
  useEffect(() => {
    if (!restoreRequest || dialog) return;
    const token = restoreRequest; setRestoreRequest(null);
    void bridge.backup.applyRestore(token).catch(reason => {
      notify(errorMessage(reason), true); void bridge.backup.cancel();
    });
  }, [restoreRequest, dialog]);

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
    if (dialog?.kind === 'explanation') {
      // Read-only explanations do not block Quit. Revoke and drain their
      // request, then preserve the editor's existing unsaved-file workflow.
      setDialog(null);
      void bridge.explanations.cancel().then(() => {
        if (practiceDraft.current || projectDraft.current) setDialog({ kind: 'close-workspace-draft' });
        else requestCloseFiles();
      }, reason => { notify(errorMessage(reason), true); void bridge.confirmWindowClose(false); });
      return;
    }
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

  async function runTask(record: TaskRecord, task: TaskDefinition) {
    setDialog(null);
    if (screen !== 'editor' || running.current || !rootsRef.current.some(({ path }) => path === record.root)) return;
    const pending = documents.getSnapshot().tabs.some(tab => tab.path && isWithin(tab.path, record.root) && (tab.dirty || tab.conflict));
    if (pending) {
      notify('Save or resolve modified workspace files before running a build task.', true);
      return;
    }
    running.current = true;
    const request: NonNullable<typeof liveRun.current> = { id: crypto.randomUUID(), cancelled: false };
    liveRun.current = request;
    try {
      setBottomTab('run');
      if (!settingsRef.current.showOutput) updateSettings({ showOutput: true });
      runConsole.start(task.label, settingsRef.current.keepRunOutput);
      const streamed = new Promise<void>((resolve) => { request.complete = resolve; });
      const launch = bridge.tasks.run(record.root, task.id, record.revision, request.id);
      if (consoleSize.current) void bridge.runConsole.resize(request.id, ...consoleSize.current).catch(() => {});
      const [graph] = await Promise.all([launch, streamed]);
      const last = graph.completed.at(-1)?.result;
      const cancelled: RunResult = { status: 'cancelled', compiler: null, compileOutput: '', programOutput: '', exitCode: null,
        durationMs: 0, message: graph.completed.length ? 'Task sequence stopped.' : 'Task run was canceled before execution.' };
      runConsole.finish(last ?? cancelled);
      if (!graph.cancelled && last?.status === 'success') {
        notify(`${graph.completed.length} task${graph.completed.length === 1 ? '' : 's'} completed.`);
      }
    } catch (reason) {
      runConsole.fail(errorMessage(reason));
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
      if (onboarding) {
        if (!['open-file', 'open-folder', 'new-file', 'new-starter', 'quick-open', 'stop'].includes(value)) return;
        dismissOnboarding();
      }
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
        case 'save-all': if (screen === 'editor') void saveMany(tabs); break;
        case 'close-tab':
          if (sourceControlDiff) setSourceControlDiff(undefined);
          else if (id && screen === 'editor') void closeTab(id);
          break;
        case 'close-other-tabs':
          if (id && screen === 'editor') requestCloseTabs(tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
          break;
        case 'close-tabs-to-right': {
          const position = tabs.findIndex((tab) => tab.id === id);
          if (position >= 0 && screen === 'editor') requestCloseTabs(tabs.slice(position + 1).map((tab) => tab.id));
          break;
        }
        case 'close-saved-tabs':
          if (screen === 'editor') requestCloseTabs(tabs.filter((tab) => !tab.dirty).map((tab) => tab.id));
          break;
        case 'close-all-tabs':
          if (screen === 'editor') requestCloseTabs(tabs.map((tab) => tab.id));
          break;
        case 'reopen-closed-tab': reopenClosedTab(); break;
        case 'next-tab':
        case 'previous-tab': {
          if (screen !== 'editor' || tabs.length < 2) break;
          const position = tabs.findIndex((tab) => tab.id === id);
          const step = value === 'next-tab' ? 1 : -1;
          documents.select(tabs[(position + step + tabs.length) % tabs.length].id);
          break;
        }
        case 'cycle-next-tab': splitActions.current?.groups.cycleTab(1); break;
        case 'cycle-previous-tab': splitActions.current?.groups.cycleTab(-1); break;
        case 'move-tab-left':
        case 'move-tab-right':
          if (id && screen === 'editor') documents.move(id, value === 'move-tab-left' ? -1 : 1);
          break;
        case 'find': find(); break;
        case 'replace': find(true); break;
        case 'add-cursor-above': editor.current?.multiCursor('above'); break;
        case 'add-cursor-below': editor.current?.multiCursor('below'); break;
        case 'select-next-occurrence': editor.current?.multiCursor('next'); break;
        case 'select-all-occurrences': editor.current?.multiCursor('all'); break;
        case 'choose-theme': setDialog({ kind: 'settings', browseThemes: true }); break;
        case 'language-support': setDialog({ kind: 'language-support' }); break;
        case 'go-to-definition': editor.current?.goToDefinition(); break;
        case 'find-references': {
          if (!availableCommand(value) || !editor.current) break;
          const pending = { kind: 'source-references' } as const;
          setDialog(pending);
          void editor.current.findReferences().then((locations) => {
            setDialog((current) => current === pending ? { ...pending, locations } : current);
          }).catch((error: unknown) => {
            setDialog((current) => current === pending ? null : current);
            notify(errorMessage(error), true);
          });
          break;
        }
        case 'rename-symbol': {
          const initial = availableCommand(value) ? editor.current?.renameTarget() : undefined;
          if (initial) setDialog({ kind: 'symbol-rename', initial });
          break;
        }
        case 'navigate-back': walkHistory('back'); break;
        case 'navigate-forward': walkHistory('forward'); break;
        case 'format-document': void formatDocument(); break;
        case 'go-to-line': {
          const lines = editor.current?.lineCount();
          if (id && active && !active.viewer && screen === 'editor' && lines && splitActions.current?.markdown?.mode !== 'preview') {
            setDialog({ kind: 'go-to-line', tabId: id, lines });
          }
          break;
        }
        case 'focus-editor': {
          if (screen !== 'editor') break;
          if (sourceControlDiff) setSourceControlDiff(undefined);
          if (active?.viewer || active?.notebookMode === 'notebook') {
            const code = tabs.find((tab) => !tab.viewer && tab.notebookMode !== 'notebook');
            if (code) documents.select(code.id);
          } else if (splitActions.current?.markdown?.mode === 'preview') splitActions.current.markdown.togglePreview();
          else editor.current?.focus();
          break;
        }
        case 'toggle-editor-split': if (screen === 'editor') splitActions.current?.source?.toggle(); break;
        case 'focus-editor-split': if (screen === 'editor') splitActions.current?.source?.focusSecond(); break;
        case 'split-editor-left': splitActions.current?.groups.split('left'); break;
        case 'split-editor-right': splitActions.current?.groups.split('right'); break;
        case 'split-editor-up': splitActions.current?.groups.split('up'); break;
        case 'split-editor-down': splitActions.current?.groups.split('down'); break;
        case 'focus-editor-group-left': splitActions.current?.groups.focus('left'); break;
        case 'focus-editor-group-right': splitActions.current?.groups.focus('right'); break;
        case 'focus-editor-group-up': splitActions.current?.groups.focus('up'); break;
        case 'focus-editor-group-down': splitActions.current?.groups.focus('down'); break;
        case 'focus-next-editor-group': splitActions.current?.groups.cycle(1); break;
        case 'focus-previous-editor-group': splitActions.current?.groups.cycle(-1); break;
        case 'move-editor-left': splitActions.current?.groups.move('left'); break;
        case 'move-editor-right': splitActions.current?.groups.move('right'); break;
        case 'move-editor-up': splitActions.current?.groups.move('up'); break;
        case 'move-editor-down': splitActions.current?.groups.move('down'); break;
        case 'close-editor-group': splitActions.current?.groups.close(); break;
        case 'markdown-preview': if (screen === 'editor') splitActions.current?.markdown?.togglePreview(); break;
        case 'markdown-split': if (screen === 'editor') splitActions.current?.markdown?.toggleSplit(); break;
        case 'toggle-document-split': splitActions.current?.toggle(); break;
        case 'focus-document-split': splitActions.current?.focusDivider(); break;
        case 'run': void run(); break;
        case 'run-task': if (root) setDialog({ kind: 'tasks' }); break;
        case 'run-tests': if (availableCommand(value)) setDialog({ kind: 'project-tests' }); break;
        case 'test-explorer': if (availableCommand(value)) setDialog({ kind: 'test-explorer' }); break;
        case 'ask-ion': if (availableCommand(value)) void openExplanation({ purpose: 'ask', action: 'ask-question', question: '' }); break;
        case 'preview-web': void previewWeb(); break;
        case 'stop': stop(); break;
        case 'toggle-explorer': toggleExplorer(); break;
        case 'focus-explorer':
          if (screen !== 'editor') break;
          if (!settingsRef.current.showExplorer) updateSettings({ showExplorer: true });
          requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="tree"][aria-label="Workspace files"]')
            ?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus());
          break;
        case 'toggle-source-control': if (screen === 'editor') toggleSourceControl(); break;
        case 'toggle-debug': toggleDebug(); break;
        case 'start-debugging': void startDebugging(); break;
        case 'debug-continue': void debugController.current?.command('continue'); break;
        case 'debug-pause': void debugController.current?.command('pause'); break;
        case 'debug-step-over': void debugController.current?.command('next'); break;
        case 'debug-step-into': void debugController.current?.command('stepIn'); break;
        case 'debug-step-out': void debugController.current?.command('stepOut'); break;
        case 'debug-restart': void debugController.current?.command('restart'); break;
        case 'debug-stop': void debugController.current?.command('stop'); break;
        case 'toggle-breakpoint': editor.current?.toggleBreakpoint(); break;
        case 'focus-debug-console':
          selectBottomTab('debug');
          if (!settingsRef.current.showOutput) updateSettings({ showOutput: true });
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.debug-repl input')?.focus());
          break;
        // Preserve existing customized shortcut IDs while retiring the Marketplace experience.
        case 'toggle-marketplace': setDialog({ kind: 'learning-content' }); break;
        case 'toggle-output': if (screen === 'editor') toggleBottom(); break;
        case 'toggle-terminal':
          if (screen === 'editor' && settingsRef.current.showOutput && bottomTab === 'terminal') toggleBottom();
          else showTerminal();
          break;
        case 'focus-terminal': showTerminal(); break;
        case 'toggle-auxiliary':
          if (sourceControlVisible) closeSourceControl();
          else if (debugVisible) closeDebug();
          else if (mode !== 'free' && screen === 'editor') toggleAuxiliary();
          break;
        case 'settings': setDialog({ kind: 'settings' }); break;
      }
    };
  });

  const learningPacks = {
    packs: bridge.learningPacks, library: packLibrary, loadError: packLoadError,
    onLibraryChange: applyPackLibrary, onRetry: () => setPackAttempt((attempt) => attempt + 1),
  };

  function renderSourceControl() {
    if (!sourceControlVisible) return undefined;
    if (!sourceControlBridge) return <aside className="explorer" aria-label="Source Control">
      <div className="pane-title"><h2>Source Control</h2><button className="icon-button" type="button"
        aria-label="Close Source Control" onClick={closeSourceControl}><Icon name="x" size={15}/></button></div>
      <div className="explorer-empty"><Icon name="git" size={24}/><p>Open a Git repository folder to see changes.</p>
        <button className="button" type="button" onClick={openFolder}>Open Folder</button></div>
    </aside>;
    return <Suspense fallback={<p className="tree-message" role="status">Opening Source Control…</p>}>
      <SourceControlPanel key={sourceControlRoot} bridge={sourceControlBridge} onClose={closeSourceControl}
        activePath={!sourceControlDiff && active && !active.viewer && !active.error && active.notebookMode !== 'notebook' ? active.path ?? undefined : undefined}
        onEntries={setSourceControlEntries} onDiff={setSourceControlDiff} isDirty={hasUnsavedSource}
        dirtyPaths={sourceControlRoot ? tabs.filter(tab => tab.path && (tab.dirty || tab.conflict) && isWithin(tab.path, sourceControlRoot)).map(tab => tab.path!) : []}
        revision={treeRevision + sourceWrites}/>
    </Suspense>;
  }

  function renderDebugPanel() {
    if (!debugVisible) return undefined;
    if (!debugModule) return <p className="tree-message" role="status">Opening Run and Debug…</p>;
    const DebugPanel = debugModule.DebugPanel;
    return <DebugPanel state={debugState} canStart={canDebugActive}
      onStart={() => { void startDebugging(); }} onAction={(action) => { void debugController.current?.command(action); }}
      onSelectFrame={(frame: DebugUiFrame) => { void debugController.current?.selectFrame(frame).then((selected) => {
        if (selected?.path) void navigateSource({ path: selected.path, line: selected.line, column: selected.column });
      }); }}
      onExpandScope={(reference) => { void debugController.current?.expandScope(reference); }}
      onToggleBreakpoint={(breakpoint: DebugUiBreakpoint) => toggleBreakpoint(breakpoint.path, breakpoint.line)}
      onRemoveBreakpoint={(breakpoint: DebugUiBreakpoint) => {
        const current = debugBreakpoints.get(sourceControlPathKey(breakpoint.path));
        if (current?.includes(breakpoint.line)) toggleBreakpoint(breakpoint.path, breakpoint.line);
      }}
      onAddWatch={(expression) => { void debugController.current?.addWatch(expression); }}
      onRemoveWatch={(id) => debugController.current?.removeWatch(id)} onClose={closeDebug}/>;
  }

  const renderDebugConsole = debugModule ? (tabsNode: ReactNode) => {
    const DebugConsole = debugModule.DebugConsole;
    return <DebugConsole state={debugState} tabs={tabsNode}
      onEvaluate={(expression) => { void debugController.current?.evaluate(expression); }}
      onClear={() => debugController.current?.clearConsole()} onClose={toggleBottom}/>;
  } : undefined;

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
      case 'learn': return <module.Component canAskTutor={settings.resourceProfile === 'full'} lessonSelection={tutorLesson}
        onTutor={({ packId, lessonId, diagnostic }) => void openExplanation({ purpose: 'tutor', action: diagnostic ? 'debug' : lessonId ? 'concept' : 'hint',
          question: diagnostic ? 'Help me investigate this diagnostic without writing the solution.' : 'Help me understand this concept and reason about my own code.',
          ...(packId && lessonId ? { lesson: { packId, lessonId } } : {}), ...(diagnostic ? { diagnostic } : {}) })} {...learningPacks} bridge={bridge.learning} includeCatalog={true}
        practice={bridge.practice} onPrepareRun={(path) => saveMany(documents.affected(path))} onStopRun={stop}
        onManageContent={() => setDialog({ kind: 'learning-content' })} onPractice={() => selectWorkspace('practice')}
        feedback={runReport?.tabId === activeId || lensSelection ? feedback : undefined} onClose={closeAuxiliary}
        lensEnabled={settings.learningLens} sourceCurrent={sourceCurrent} lensSelection={feedback ? lensSelection : undefined}
        canRevealDiagnostic={(diagnostic) => problemRows.some(({ problem, canReveal }) => canReveal && problem.raw === diagnostic.raw)}
        onRevealDiagnostic={(diagnostic) => revealProblem(problemRows.findIndex(({ problem, canReveal }) => canReveal && problem.raw === diagnostic.raw))}
        onExercise={({ entry, problemId }, stayInLearn) => {
          setPracticeExercise(problemId);
          if (!stayInLearn) selectWorkspace('practice');
          openEntry(entry);
        }}/>;
      case 'projects': return <module.Component onExplain={(action: ExplanationAction, project: NonNullable<ExplanationRequest['project']>) => void openExplanation({ purpose: 'project-lens', action, project,
        question: action === 'health' ? 'Identify evidence-based potential issues and suggestions. Clearly state uncertainty; do not claim a verified vulnerability or score.'
          : action === 'teach-project' ? 'Give a beginner reading path with validated citations and concept-checking questions.'
          : action === 'next-steps' ? 'Suggest a small dependency-ordered roadmap grounded in the reviewed evidence, with acceptance criteria and risks. Do not execute anything.'
          : action === 'architecture' ? 'Explain the apparent architecture, module relationships and data flow. Separate observed facts from inferences and unknowns.'
          : action === 'ask-codebase' ? 'Where should I begin reading this project? Ground your answer in the selected evidence.'
          : 'Explain what this project appears to do, with both beginner and technical explanations. Distinguish declarations from working behavior.' })} root={root} onOpenFolder={openFolder} resourceProfile={settings.resourceProfile}
        onOpenLensSource={({ entry, range }) => {
          if (range) void navigateSource({ path: entry.path, line: range.startLine, column: range.startColumn });
          else openWorkbenchEntry(entry);
        }}
        beforeRun={() => saveMany(root ? documents.affected(root.path) : [])} onDirtyChange={markProjectDraft}/>;
      case 'practice': return <module.Component bridge={bridge.practice} onOpenEntry={openEntry}
        onLearn={() => selectWorkspace('learn')}
        initialProblem={practiceExercise}
        onPrepareRun={(path) => saveMany(documents.affected(path))}
        onClose={closeAuxiliary} onDirtyChange={markPracticeDraft}/>;
    }
  }

  const canRun = Boolean(active && !active.error && runLanguage(active.name));
  const canDebugActive = Boolean(active?.path && !active.error && !active.viewer && !active.notebookMode && !active.conflict
    && (fileLanguage(active.name).id === 'c' || fileLanguage(active.name).id === 'cpp'));
  const debugSessionActive = debugState.phase === 'starting' || debugState.phase === 'running'
    || debugState.phase === 'paused' || debugState.phase === 'stopping';
  const runBusy = runPhase === 'preparing' || runPhase === 'compiling' || runPhase === 'running';
  const shortcut = (id: MenuCommand) => displayShortcut(id, settings.shortcuts, bridge.platform);
  const hint = (id: MenuCommand, label: string) => shortcut(id) ? `${label} (${shortcut(id)})` : label;
  function availableCommand(id: MenuCommand): boolean {
    if (id === 'command-palette') return false;
    if (id === 'choose-theme' || id === 'language-support') return true;
    if (id === 'navigate-back') return screen === 'editor' && navigationState.back;
    if (id === 'navigate-forward') return screen === 'editor' && navigationState.forward;
    if (id === 'workspace-search') return Boolean(root);
    if (['quick-open', 'new-file', 'new-starter', 'open-file', 'open-folder', 'settings', 'toggle-terminal', 'focus-terminal', 'toggle-debug'].includes(id)) return true;
    if (screen !== 'editor') return false;
    switch (id) {
      case 'ask-ion': return mode === 'free' && settings.resourceProfile === 'full';
      case 'insert-starter': return Boolean(starterTarget);
      case 'format-document': return Boolean(canFormatDocument()) && !formatting;
      case 'go-to-definition':
      case 'find-references':
      case 'rename-symbol': {
        if (!active?.path || active.error || active.viewer) return false;
        const language = fileLanguage(active.name);
        const operation = id === 'go-to-definition' ? 'definition' : id === 'find-references' ? 'references' : 'rename';
        return settings.smartLanguages.includes(language.id) && Boolean(language.semantic?.operations.includes(operation));
      }
      case 'save':
      case 'save-as': return Boolean(active && !active.viewer && !active.error && active.notebookMode !== 'notebook');
      case 'save-all': return tabs.some((tab) => tab.dirty && !tab.viewer && !tab.error && tab.notebookMode !== 'notebook');
      case 'replace':
      case 'go-to-line': return Boolean(active && !active.viewer && !active.error && active.notebookMode !== 'notebook'
        && splitActions.current?.markdown?.mode !== 'preview');
      case 'find': return Boolean(active && splitActions.current?.markdown?.mode !== 'preview');
      case 'close-tab': return Boolean(active);
      case 'close-other-tabs': return Boolean(active) && tabs.length > 1;
      case 'close-tabs-to-right': return Boolean(activeId) && tabs.findIndex((tab) => tab.id === activeId) < tabs.length - 1;
      case 'close-saved-tabs': return tabs.some((tab) => !tab.dirty);
      case 'close-all-tabs': return tabs.length > 0;
      case 'reopen-closed-tab': return recentlyClosed.current.length > 0;
      case 'focus-explorer': return Boolean(root);
      case 'markdown-preview':
      case 'markdown-split': return Boolean(splitActions.current?.markdown);
      case 'focus-editor': return tabs.some((tab) => !tab.viewer);
      case 'toggle-editor-split': return Boolean(splitActions.current?.source);
      case 'focus-editor-split': return Boolean(splitActions.current?.source?.active);
      case 'split-editor-left':
      case 'split-editor-right':
      case 'split-editor-up':
      case 'split-editor-down': return Boolean(active && !active.viewer && !active.error && splitActions.current
        && splitActions.current.groups.count < 4);
      case 'focus-editor-group-left':
      case 'focus-editor-group-right':
      case 'focus-editor-group-up':
      case 'focus-editor-group-down':
      case 'focus-next-editor-group':
      case 'focus-previous-editor-group':
      case 'move-editor-left':
      case 'move-editor-right':
      case 'move-editor-up':
      case 'move-editor-down':
      case 'close-editor-group': return (splitActions.current?.groups.count ?? 0) > 1;
      case 'next-tab':
      case 'previous-tab':
      case 'cycle-next-tab':
      case 'cycle-previous-tab': return tabs.length > 1;
      case 'move-tab-left':
      case 'move-tab-right': return tabs.length > 1 && Boolean(active);
      case 'add-cursor-above':
      case 'add-cursor-below':
      case 'select-next-occurrence':
      case 'select-all-occurrences': return Boolean(active && !active.viewer && !active.error
        && active.notebookMode !== 'notebook' && splitActions.current?.markdown?.mode !== 'preview');
      case 'run': return canRun && !runBusy;
      case 'run-task': return Boolean(root) && !runBusy;
      case 'start-debugging': return canDebugActive && !debugSessionActive;
      case 'debug-continue': return debugState.phase === 'paused';
      case 'debug-pause': return debugState.phase === 'running';
      case 'debug-step-over':
      case 'debug-step-into':
      case 'debug-step-out': return debugState.phase === 'paused';
      case 'debug-restart': return Boolean(debugState.canRestart) && debugSessionActive;
      case 'debug-stop': return debugSessionActive;
      case 'toggle-breakpoint': return canDebugActive;
      case 'focus-debug-console': return Boolean(debugModule);
      case 'run-tests':
      case 'test-explorer': return Boolean(root) && !runBusy;
      case 'stop': return runBusy;
      case 'preview-web': return Boolean(active && !active.error && canPreviewWeb(active.name));
      case 'toggle-document-split': return splitActions.current?.canToggle ?? false;
      case 'focus-document-split': return splitActions.current?.hasDivider ?? false;
      case 'toggle-auxiliary': return mode !== 'free';
      default: return true;
    }
  }
  const selectedDebugFrame = debugState.frames.find((frame) => frame.selected) ?? debugState.frames[0];
  const debugStopped = debugState.phase === 'paused' && selectedDebugFrame?.path && selectedDebugFrame.line
    ? { path: selectedDebugFrame.path, line: selectedDebugFrame.line } : undefined;
  return (
    <div className="app-shell" style={appearance.style} data-theme={appearance.kind} data-theme-id={displayTheme?.id}
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
          {updates.status?.state === 'available' && <button className="button title-update" type="button"
            data-testid="title-update" disabled={Boolean(updates.busy)}
            title={updates.downloaded ? 'Install and restart Ion in its existing location'
              : `Download Ion ${updates.status.latest} from GitHub`}
            onClick={() => {
              if (updates.downloaded) void updates.install().then((error) => { if (error) notify(error, true); });
              else void updates.download().then((error) => { if (error) notify(error, true); });
            }}>
            <Icon name={updates.downloaded ? 'check' : 'download'} size={14}/>
            {updates.busy === 'download' ? 'Downloading…' : updates.busy === 'install' ? 'Preparing update…'
              : updates.downloaded ? 'Install and Restart' : 'Update available'}
          </button>}
          {recoveryDrafts.length > 0 && <button className="button" data-testid="recover-edits"
            onClick={() => setDialog({ kind: 'recovery' })}>Recover edits ({recoveryDrafts.length})</button>}
          {screen === 'editor' ? <>
            {active && canPreviewWeb(active.name) && <button className="button" data-testid="preview-web" disabled={Boolean(active.error)}
              title="Preview local web project" onClick={() => void previewWeb()}>Preview</button>}
            {root && <button className="button title-run-tests" type="button" data-testid="run-tests" aria-label="Run Tests"
              title={hint('run-tests', 'Run Tests')} disabled={runBusy} onClick={() => setDialog({ kind: 'project-tests' })}>
              <Icon name="flask" size={14}/><span>Run Tests</span></button>}
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
      {(screen === 'editor' || notebookRunning) && <Workbench documents={documents} hidden={screen === 'welcome'} mode={mode} onWorkspace={selectWorkspace}
          initialEditorGroups={initialEditorGroups} onEditorGroupsChange={handleEditorGroups}
          auxiliary={renderAuxiliary()} debugPanel={renderDebugPanel()} debugConsole={renderDebugConsole}
          onToggleAuxiliary={sourceControlVisible ? closeSourceControl : debugVisible ? closeDebug : toggleAuxiliary}
          sourceControl={renderSourceControl()} sourceControlEntries={sourceControlVisible ? sourceControlEntries : undefined}
          onToggleSourceControl={toggleSourceControl} onToggleDebug={toggleDebug}
          sourceControlDiff={sourceControlDiff && <Suspense fallback={<p className="tree-message" role="status">Opening diff…</p>}>
            <SourceControlDiffView diff={sourceControlDiff} onClose={() => setSourceControlDiff(undefined)}
              dirty={hasUnsavedSource(sourceControlDiff.absolutePath)} theme={displayTheme} accentColor={appearance.accentColor}/>
          </Suspense>}
          onToggleExplorer={toggleExplorer}
          active={active} tabs={tabs} root={root} roots={roots} target={target}
          treeRevision={treeRevision} settings={settings} activeTheme={displayTheme} accentColor={appearance.accentColor}
          runConsole={runConsole} canRun={canRun} canRerun={Boolean(lastRun)} cursorRef={cursorRef}
          bottomTab={bottomTab} terminalFocus={terminalFocus} terminalController={terminalController}
          debugEnabled={Boolean(debugModule)} debugBreakpoints={debugBreakpoints} debugStopped={debugStopped}
          onToggleBreakpoint={toggleBreakpoint}
          problemRows={problemRows} problemFile={runReport?.name} problemsStale={Boolean(problemRows.length) && !sourceCurrent}
          selectedProblem={selectedProblem} problemMarkers={problemMarkers} onRevealProblem={revealProblem} onExplainProblem={explainProblem}
          onNavigateSource={(path, line, column) => { void navigateSource({ path, line, column }); }}
          navigation={navigationState} onHistory={walkHistory}
          onBottomTab={selectBottomTab} onToggleBottom={toggleBottom}
          onSelect={selectWorkbenchTab} onCloseTab={(id) => void closeTab(id)} onTabContextAction={handleTabContextAction}
          canReopenClosedTab={recentlyClosed.current.length > 0} onReopenClosedTab={reopenClosedTab}
          onOpenEntry={openWorkbenchEntry} onTarget={selectWorkspaceTarget}
          onCreate={(kind) => { if (target) setDialog({ kind: 'create', entryKind: kind, parent: target }); }}
          onRename={(entry) => setDialog({ kind: 'rename', entry })} onTrash={(entry) => void trashEntry(entry)}
          onExplorerContextAction={handleExplorerContextAction}
          onRefresh={refreshTree} onNew={newFile} onOpenFile={openFile} onOpenFolder={openFolder}
          onAddFolder={() => void addFolder()} onRemoveFolder={(path) => void removeFolder(path)}
          onReorderFolder={(path, offset) => void reorderFolder(path, offset)}
          onSaveWorkspace={() => void saveWorkspace()} onOpenWorkspace={() => void openWorkspace()}
          onInsertStarter={starterTarget ? insertStarter : undefined}
          formatting={formatting} onFormat={() => { void formatDocument(); }}
          onSettings={updateSettings} onRun={() => void run()} onRerun={() => { if (lastRun) void run(lastRun); }}
          onStop={stop} onRunInput={writeRunInput} onConsoleResize={resizeConsole}
          onEditorActions={setEditor} onSplitActions={setSplitActions} onCursor={updateCursor} onFind={find} onSaveAs={(id) => void saveTab(id, 'as')}
          onReload={(id) => { if (active) setDialog({ kind: 'reload', id, name: active.name, dirty: active.dirty }); }}/>}
      <footer className="status-bar" data-testid="status">
        <span className="local-status"><span className="signal"/>{screen === 'welcome' ? 'Local desktop' : modeNames[mode]}</span>
        <button className="profile-status" type="button" title="Open resource profile settings"
          onClick={() => setDialog({ kind: 'settings' })}>{settings.resourceProfile === 'minimal' ? 'Minimal' : 'Full'}</button>
        <span className={`status-notice ${!formatting && notice?.error ? 'error' : ''}`}
          role={!formatting && notice?.error ? 'alert' : 'status'} title={formatting ? 'Formatting document… Press Esc to cancel.' : notice?.message}>
          {formatting ? <><Icon name="clock" size={13}/><span>Formatting document… Press Esc to cancel.</span></>
            : notice && <><Icon name={notice.error ? 'warning' : 'check'} size={13}/><span>{notice.message}</span></>}
        </span>
        {screen === 'welcome' && <span className="welcome-status"><Icon name="keyboard" size={14}/> {hint('new-file', 'New File')} <span>·</span> {hint('open-file', 'Open File')}</span>}
      </footer>

      {onboarding && <Onboarding replay={onboarding === 'replay'} onClose={dismissOnboarding}
        onStart={() => { dismissOnboarding(); chooseStarter(); }}
        onOpenFolder={() => { setMode('free'); openFolder(); }}
        onWorkspace={(next) => { dismissOnboarding(); selectWorkspace(next); }}
        error={notice?.error ? notice.message : undefined}/>}
      <Suspense fallback={null}>
        {dialog?.kind === 'explanation' && <ExplanationDialog initialRequest={dialog.request} bridge={bridge.explanations}
          subscribeInvalidation={subscribeExplanationInvalidation} refreshContext={refreshExplanationContext}
          onOpenCitation={openExplanationCitation} onClose={() => setDialog(null)}
          onRecommendations={dialog.request.purpose === 'project-lens' && root ? (reply, review) => setDialog({ kind: 'recommendations', root, reply, review }) : undefined}/>}
        {dialog?.kind === 'recommendations' && <ReviewRecommendations root={dialog.root} reply={dialog.reply} review={dialog.review}
          bridge={bridge.projects} onDirtyChange={markProjectDraft} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); notify('Reviewed milestones saved locally. No tests were approved or run.'); }}/>}
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
          dirtyPaths={tabs.filter(tab => tab.path && (tab.dirty || tab.conflict) && isWithin(tab.path, root.path)).map(tab => tab.path!)}
          onApplied={paths => {
            for (const tab of documents.getSnapshot().tabs) if (tab.path && paths.includes(tab.path)) documents.markConflict(tab.id, tab.path);
            if (paths.length) { setSourceWrites(value => value + 1); notify(`${paths.length} saved ${paths.length === 1 ? 'file was' : 'files were'} updated. Open tabs require review.`); }
          }}
          onOpen={(path, match) => void openSearchMatch(path, match)} onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'language-support' && <LanguageSupport initial={fileLanguage(active?.name ?? '').id}
          onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'test-explorer' && root && <TestExplorer api={bridge.testExplorer} roots={roots.length ? roots : [root]}
          beforeRun={async selectedRoot => !documents.getSnapshot().tabs.some(({ path, dirty, conflict }) =>
            path && isWithin(path, selectedRoot) && (dirty || conflict))}
          onNavigate={(selectedRoot, path, line) => {
            const separator = selectedRoot.includes('\\') ? '\\' : '/';
            const absolute = selectedRoot.replace(/[\\/]$/, '') + separator + path.split('/').join(separator);
            if (isWithin(absolute, selectedRoot)) { setDialog(null); void navigateSource({ path: absolute, line, column: 1 }); }
          }}
          onSavedTests={selectedRoot => setDialog({ kind: 'project-tests', root: selectedRoot })}
          onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'project-tests' && root && <ProjectTestsDialog key={(dialog.root ?? root).path} root={dialog.root ?? root}
          beforeRun={async () => !documents.getSnapshot().tabs.some(({ path, dirty, conflict }) =>
            path && isWithin(path, (dialog.root ?? root).path) && (dirty || conflict))}
          onNavigate={(path, line, column) => { setDialog(null); void navigateSource({ path, line, column }); }}
          onConfigure={() => { setDialog(null); closeSourceControl(); selectWorkspace('projects'); }}
          onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'tasks' && root && <TaskPicker key={root.path} api={bridge.tasks} root={root.path}
          onRun={(record, task) => void runTask(record, task)} onClose={() => setDialog(null)}/>}
        {dialog?.kind === 'go-to-line' && <GoToLine lines={dialog.lines} onClose={() => setDialog(null)}
          onGo={(line) => {
            const id = dialog.tabId;
            setDialog(null);
            requestAnimationFrame(() => {
              if (documents.getSnapshot().activeId === id) void navigateSource({ tabId: id, line, column: 1 });
            });
          }}/>}
      </Suspense>
      {dialog?.kind === 'explanation-excerpt' && <Modal title="Reviewed excerpt" onClose={() => setDialog(null)}>
        <p>{dialog.label}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{dialog.text}</pre>
      </Modal>}
      {dialog?.kind === 'source-references' && <Modal title="Find References" className="command-picker" onClose={() => setDialog(null)}>
        <div className="source-references" data-testid="source-references">
          {dialog.locations?.length ? dialog.locations.map(({ path, line, column }) => (
            <button className="button" key={`${path}:${line}:${column}`} type="button" data-testid="source-reference"
              title={path} onClick={() => { setDialog(null); void navigateSource({ path, line, column }); }}>
              {root && isWithin(path, root.path) ? path.slice(root.path.length).replace(/^[/\\]+/, '') : path}
              <span>{line}:{column}</span>
            </button>)) : <p role="status">{dialog.locations ? 'No references found.' : 'Finding references…'}</p>}
        </div>
      </Modal>}
      {dialog?.kind === 'symbol-rename' && <EntryDialog title="Review Symbol Rename" initial={dialog.initial}
        onSubmit={async (name) => {
          const preview = await editor.current?.reviewRename(name);
          if (!preview) throw new Error('Open a saved smart-language source file and place the cursor on a symbol.');
          setDialog({ kind: 'symbol-rename-review', preview });
        }} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'symbol-rename-review' && <ConfirmDialog title="Apply reviewed rename"
        message={`${dialog.preview.edits} ${dialog.preview.edits === 1 ? 'edit' : 'edits'} across ${dialog.preview.files.length} saved ${dialog.preview.files.length === 1 ? 'file' : 'files'}: ${dialog.preview.files.slice(0, 6).map(file => file.relativePath).join(', ')}${dialog.preview.files.length > 6 ? ', …' : ''}. Ion will recheck every file before publishing.`}
        action="Apply Rename" onConfirm={async () => {
          try {
            const result = await bridge.languageTools.applyEdit(dialog.preview.token);
            for (const tab of documents.getSnapshot().tabs) if (tab.path && result.applied.includes(tab.path)) documents.markConflict(tab.id, tab.path);
            if (result.applied.length) { setSourceWrites(value => value + 1); refreshTree(); }
            if (result.failed.length) notify(`${result.failed.length} file changes were not applied. ${result.failed[0].message}`, true);
            else notify(`Applied ${dialog.preview.edits} reviewed symbol ${dialog.preview.edits === 1 ? 'edit' : 'edits'}. Open tabs require review.`);
            setDialog(null);
          } catch (reason) { notify(errorMessage(reason), true); }
        }} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'new-starter' && <StarterDialog onChoose={createDraft} onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'settings' && <PreferencesDialog settings={settings} activeTheme={activeTheme}
        onLearningContent={() => setDialog({ kind: 'learning-content' })}
        onChange={updateSettings} onUpdateLaunchChange={changeUpdateLaunch} preferencesReady={preferencesReady} updates={updates}
        onInstallUpdate={() => { setDialog(null); void updates.install().then((error) => { if (error) notify(error, true); }); }}
        onThemeChange={changeTheme} onThemePreview={setPreviewTheme} onThemeFavorite={changeThemeFavorite}
        startBrowsing={dialog.browseThemes} onLanguageSupport={() => setDialog({ kind: 'language-support' })}
        onShortcutChange={changeShortcuts} onExportProfile={exportLocalProfile} onBackup={mode => setDialog({ kind: 'backup', mode })}
        onReplayIntro={() => { setDialog(null); setOnboarding('replay'); }}
        onClose={() => setDialog(null)}/>}
      {dialog?.kind === 'backup' && <Suspense fallback={<Modal title="Opening backup tools" onClose={() => setDialog(null)}><p role="status">Loading local backup tools…</p></Modal>}>
        <BackupDialog mode={dialog.mode} checkpoint={checkpointBackup} onClose={() => setDialog(null)}
          onApply={token => { setDialog(null); setRestoreRequest(token); }}/>
      </Suspense>}
      {dialog?.kind === 'learning-content'  && <Modal title="Learning Content" className="preferences" onClose={() => setDialog(null)}>
        <Suspense fallback={<p role="status">Opening learning content…</p>}>
          <LearningContentSettings packs={bridge.learningPacks} onLibraryChange={applyPackLibrary}/>
        </Suspense>
      </Modal>}
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
          closeSettledTab(dialog.id);
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
        onClose={() => { pendingTabClosures.current = []; setDialog(null); }}/>
      }
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
