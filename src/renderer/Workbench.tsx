import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ComponentType, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Entry, EntryKind, MenuCommand, Settings, WorkspaceMode } from '../shared/contracts';
import { displayShortcut } from '../shared/shortcuts';
import type { ThemeData } from '../shared/themes';
import type { SourceControlEntry } from '../shared/source-control';
import type { BottomTab } from '../shared/terminal';
import { errorMessage, type Documents, type Tab } from './documents';
import { Explorer } from './Explorer';
import { Icon } from './icons';
import { loadEditor, loadedEditor } from './load-editor';
import type MonacoSurface from './MonacoSurface';
import type { EditorActions } from './MonacoSurface';
import type { LiveToolReport } from './language-editor-tools';
import { Output } from './Output';
import { Problems, type ProblemMarker, type ProblemRow } from './Problems';
import type { RunConsoleStore } from './run-console/store';
import type { TerminalController } from './terminal/controller';
import type { TerminalPaneProps } from './terminal/TerminalPane';
import './terminal/panel.css';
import { isWithin, languageFor, sourceControlPathKey } from './paths';
import { fileLanguage } from '../shared/languages';
import { DocumentPane } from './viewers/DocumentPane';
import { NotebookPane } from './NotebookPane';
import { MarkdownPreviewPane } from './MarkdownPreviewPane';
import { isMarkdownFile } from '../shared/markdown-path';
import { largeTextError } from '../shared/large-text';
import { LargeTextPreview } from './LargeTextPreview';
import { markdownHistoryLimit, readMarkdownModes, writeMarkdownModes, type MarkdownMode } from './markdown-view-state';
import { EditorGroups, type EditorGroup, type EditorGroupLayout, type EditorGroupsSnapshot, type EditorTabTraversal } from './editor-groups';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

export type TabContextAction = 'close' | 'close-others' | 'close-right' | 'close-saved' | 'close-all';
export type ExplorerContextAction = 'open' | 'new-file' | 'new-folder' | 'rename' | 'trash' | 'copy-path'
  | 'reveal' | 'open-terminal' | 'remove-root';

function EditorContent(props: ComponentProps<typeof MonacoSurface>) {
  const [editorModule, setEditorModule] = useState(loadedEditor);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (editorModule) return;
    let cancelled = false;
    void loadEditor().then((module) => {
      if (!cancelled) setEditorModule(module);
    }, (reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => { cancelled = true; };
  }, [attempt, editorModule]);

  if (editorModule) return <editorModule.default {...props}/>;
  if (!props.tab) return null;
  return (
    <div className="editor-loading" role={error ? 'alert' : 'status'}>
      {error
        ? <><p>Could not start the editor. {error}</p><button className="button"
          onClick={() => { setError(null); setAttempt((previous) => previous + 1); }}>Retry</button></>
        : 'Starting editor…'}
    </div>
  );
}

interface GroupPaneProps {
  group: EditorGroup;
  activeGroupId: string;
  documents: Documents;
  groups: EditorGroups;
  tabs: Tab[];
  root: Entry | null;
  roots?: Entry[];
  hidden?: boolean;
  settings: Settings;
  activeTheme: ThemeData | null;
  accentColor?: string;
  problemMarkers?: readonly ProblemMarker[];
  debugEnabled?: boolean;
  debugBreakpoints?: ReadonlyMap<string, readonly number[]>;
  debugStopped?: { path: string; line: number };
  onToggleBreakpoint?(path: string, line: number): void;
  onCloseTab(id: string): void;
  onTabMenu(event: MouseEvent<HTMLElement>, tabId: string, groupId: string): void;
  onSaveAs(id: string): void;
  onReload(id: string): void;
  onSettings(patch: Partial<Settings>): void;
  onActions(groupId: string, actions: EditorActions | null): void;
  onCursor(line: number, column: number): void;
  onLanguageReport(report: LiveToolReport | null): void;
  onNavigateSource(path: string, line: number, column: number): void;
}

function EditorGroupPane({ group, activeGroupId, documents, groups, tabs, root, roots, hidden, settings, activeTheme, accentColor,
  problemMarkers, debugEnabled, debugBreakpoints, debugStopped, onToggleBreakpoint,
  onCloseTab, onTabMenu, onSaveAs, onReload, onSettings, onActions, onCursor, onLanguageReport, onNavigateSource }: GroupPaneProps) {
  const active = tabs.find(({ id }) => id === group.activeId);
  const groupTabs = group.tabs.flatMap((id) => tabs.find((tab) => tab.id === id) ?? []);
  const focused = group.id === activeGroupId;
  const largeText = active?.path && active.error?.startsWith(largeTextError) ? active : undefined;
  const source = active && !active.viewer && active.notebookMode !== 'notebook' ? active : undefined;
  const owner = active?.path ? (roots ?? (root ? [root] : [])).find((entry) => isWithin(active.path!, entry.path)) : undefined;
  const registerActions = useCallback((actions: EditorActions | null) => onActions(group.id, actions), [group.id, onActions]);
  const focus = useCallback(() => {
    if (active && !focused) groups.select(group.id, active.id);
  }, [active, focused, group.id, groups]);
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-ion-editor-tab')) as { tabId?: unknown; groupId?: unknown };
      if (typeof value.tabId === 'string' && typeof value.groupId === 'string') groups.moveTab(value.tabId, value.groupId, group.id);
    } catch { /* Ignore non-Ion drag payloads. */ }
  };
  return <section className={`editor-group${focused ? ' active' : ''}`} data-testid="editor-group" data-group-id={group.id}
    onPointerDown={focus} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
    <div className="tab-strip editor-group-tabs">
      <div className="tab-scroll" role="tablist" aria-label={`Open files in ${group.id}`}>
        {groupTabs.map((tab) => <div key={tab.id} className={`editor-tab ${active?.id === tab.id ? 'active' : ''}`}
          data-testid="group-tab" data-path={tab.path ?? undefined} draggable onContextMenu={(event) => onTabMenu(event, tab.id, group.id)} onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-ion-editor-tab', JSON.stringify({ tabId: tab.id, groupId: group.id }));
          }}>
          <button className="tab-name" role="tab" aria-selected={active?.id === tab.id} title={tab.path ?? tab.name}
            onClick={() => groups.select(group.id, tab.id)}><Icon name={/\.[ch]$/i.test(tab.name) ? 'code' : 'file'} size={14}/><span>{tab.name}</span></button>
          <button className={`tab-close ${tab.dirty ? 'tab-dirty' : ''}`} data-testid="group-close-tab"
            aria-label={`Close ${tab.name}`} onClick={() => onCloseTab(tab.id)}><Icon name="x" size={13}/></button>
        </div>)}
      </div>
      <div className="editor-group-actions" role="group" aria-label="Editor group actions">
        <button className="icon-button" type="button" aria-label="Split editor right" title="Split editor right"
          onClick={() => groups.split(group.id, 'right')}><Icon name="columns" size={14}/></button>
        <button className="icon-button" type="button" aria-label="Split editor down" title="Split editor down"
          onClick={() => groups.split(group.id, 'down')}><Icon name="plus" size={14}/></button>
        <button className="icon-button" type="button" aria-label="Close editor group" title="Close editor group"
          disabled={groups.getSnapshot().groups.length === 1} onClick={() => groups.close(group.id)}><Icon name="x" size={14}/></button>
      </div>
    </div>
    <div className="editor-group-content">
      {active && <div className="editor-breadcrumb" title={active.path ?? active.name}>
        <Icon name={owner ? 'folder' : 'file'} size={13}/><strong>{owner && active.path
          ? owner.name + '/' + active.path.slice(owner.path.length).replace(/^[/\\]+/, '').replaceAll('\\', '/') : active.name}</strong>
      </div>}
      {active?.conflict && <div className="conflict-banner" role="alert"><Icon name="warning" size={16}/>
        <span>This file changed on disk.{active.dirty && ' Your edits are unsaved.'}</span>
        <button className="button" onClick={() => onSaveAs(active.id)}>Save As…</button>
        <button className="button" onClick={() => onReload(active.id)}>Reload</button></div>}
      {source && !largeText && <EditorContent documents={documents} tab={source} settings={settings} activeTheme={activeTheme}
        accentColor={accentColor} sourceHidden={Boolean(hidden) || !focused} workspacePath={root?.path}
        debugEnabled={debugEnabled} breakpointLines={source.path ? debugBreakpoints?.get(sourceControlPathKey(source.path)) : undefined}
        debugStoppedLine={source.path && debugStopped && sourceControlPathKey(source.path) === sourceControlPathKey(debugStopped.path)
          ? debugStopped.line : undefined} onToggleBreakpoint={onToggleBreakpoint}
        problemMarkers={focused ? problemMarkers : undefined} onActions={registerActions} onFocus={focus}
        onCursor={onCursor} onLanguageReport={onLanguageReport} onNavigateSource={onNavigateSource}/>}
      {largeText?.path && <LargeTextPreview key={`${largeText.id}:${largeText.epoch}`} path={largeText.path}/>}
      {active?.notebookMode === 'notebook' && <NotebookPane key={active.epoch} tab={active} documents={documents}
        onKernelPolicyChange={(policy) => onSettings({ notebookKernelLifetime: policy })} settings={settings}
        activeTheme={activeTheme} accentColor={accentColor}/>}
      {active?.viewer && active.path && <DocumentPane key={`${active.id}:${active.epoch}`} path={active.path} name={active.name}
        format={active.viewer} pinned={false} onPin={() => {}}/>}
      {!active && <div className="editor-empty"><p>No file in this editor group.</p></div>}
    </div>
  </section>;
}

interface GroupLayoutProps extends Omit<GroupPaneProps, 'group'> {
  layout: EditorGroupLayout;
  snapshot: EditorGroupsSnapshot;
}

function EditorGroupLayoutView({ layout, snapshot, groups, ...props }: GroupLayoutProps) {
  if (layout.kind === 'group') {
    const group = snapshot.groups.find(({ id }) => id === layout.groupId);
    return group ? <EditorGroupPane {...props} groups={groups} group={group}/> : null;
  }
  const horizontal = layout.orientation === 'horizontal';
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const length = horizontal ? bounds?.width : bounds?.height;
    const offset = horizontal ? event.clientX - (bounds?.left ?? 0) : event.clientY - (bounds?.top ?? 0);
    if (length) groups.resize(layout.id, offset * 100 / length);
  };
  return <div className="editor-group-split" data-orientation={layout.orientation} data-testid="editor-group-split">
    <div className="editor-group-branch" style={{ flexBasis: `${layout.percent}%` }}>
      <EditorGroupLayoutView {...props} groups={groups} layout={layout.first} snapshot={snapshot}/>
    </div>
    <div className={`splitter ${horizontal ? 'split-columns' : 'split-rows'}`} role="separator" tabIndex={0}
      aria-label={`Resize ${layout.orientation} editor groups`} aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={20} aria-valuemax={80} aria-valuenow={layout.percent}
      onPointerDown={(event) => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={resize} onKeyDown={(event) => {
        const lower = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const upper = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (event.key === lower || event.key === upper) {
          event.preventDefault();
          groups.resize(layout.id, layout.percent + (event.key === lower ? -3 : 3));
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          groups.resize(layout.id, event.key === 'Home' ? 20 : 80);
        }
      }}/>
    <div className="editor-group-branch">
      <EditorGroupLayoutView {...props} groups={groups} layout={layout.second} snapshot={snapshot}/>
    </div>
  </div>;
}

function BottomTabs({ active, count, onSelect }: { active: BottomTab; count: number; onSelect(tab: BottomTab): void }) {
  const tabs = [
    { id: 'terminal', title: 'Terminal', icon: 'terminal' },
    { id: 'run', title: 'Run Console', icon: 'play' },
    { id: 'debug', title: 'Debug Console', icon: 'debug' },
    { id: 'problems', title: 'Problems', icon: 'warning' },
  ] as const;
  return <div className="bottom-tabs" role="tablist" aria-label="Bottom panel">
    {tabs.map(({ id, title, icon }, index) => <button key={id} className="bottom-tab" role="tab" type="button"
      id={'bottom-tab-' + id} aria-controls={'bottom-content-' + id} aria-selected={active === id}
      tabIndex={active === id ? 0 : -1} data-testid={'bottom-' + id + '-tab'}
      onClick={() => onSelect(id)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + step + tabs.length) % tabs.length].id;
        event.preventDefault();
        onSelect(next);
        requestAnimationFrame(() => document.getElementById('bottom-tab-' + next)?.focus());
      }}><Icon name={icon} size={13}/>{title}
        {id === 'problems' && count > 0 && <span className="problems-count">{count}</span>}</button>)}
  </div>;
}

function TerminalLoader(props: TerminalPaneProps) {
  const [Pane, setPane] = useState<ComponentType<TerminalPaneProps> | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void import('./terminal/TerminalPane').then(({ TerminalPane }) => {
      if (live) setPane(() => TerminalPane);
    }, () => {
      if (live) setError(true);
    });
    return () => { live = false; };
  }, [attempt]);
  if (Pane) return <Pane {...props}/>;
  return <section className="output integrated-terminal">
    <div className="pane-title">
      {props.tabs}
      <div className="pane-tools"><button type="button" className="icon-button" aria-label="Hide Terminal Panel"
        title="Hide Terminal Panel" onClick={props.onHide}><Icon name="down" size={15}/></button></div>
    </div>
    <div className="bottom-tab-content" role="tabpanel" id="bottom-content-terminal" aria-labelledby="bottom-tab-terminal">
      <div className="terminal-empty">
        {error ? <><p role="alert">The terminal could not load.</p><button type="button" className="button"
          onClick={() => { setError(false); setAttempt((value) => value + 1); }}>Retry</button></>
          : <p role="status">Loading terminal…</p>}
      </div>
    </div>
  </section>;
}

interface SplitterProps {
  label: string;
  vertical?: boolean;
  setting: 'explorerWidth' | 'auxiliaryWidth' | 'outputHeight';
  value: number;
  min: number;
  max: number;
  onResize(patch: Partial<Settings>): void;
}

function Splitter({ label, vertical = false, setting, value, min, max, onResize }: SplitterProps) {
  const start = useRef<{ initial: number; coordinate: number; next: number } | null>(null);
  const limit = (size: number) => Math.max(min, Math.min(max, Math.round(size)));
  const pointer = (event: PointerEvent<HTMLDivElement>) => vertical ? event.clientY : event.clientX;
  const variable = setting === 'auxiliaryWidth' ? '--auxiliary-width-live'
    : setting === 'explorerWidth' ? '--explorer-width-live' : '--output-height-live';
  const end = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const next = start.current?.next;
    start.current = null;
    if (commit && next !== undefined) onResize({ [setting]: next });
    event.currentTarget.closest<HTMLElement>('.workspace')?.style.removeProperty(variable);
  };
  return (
    <div className={`splitter ${vertical ? 'split-rows' : 'split-columns'}`}
      role="separator" aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-label={label}
      aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onKeyDown={(event) => {
        const direction = vertical ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
        const change = direction[event.key as keyof typeof direction];
        if (!change) return;
        event.preventDefault();
        onResize({ [setting]: limit(value + change * 12) });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pane = vertical ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
        const rect = pane?.getBoundingClientRect();
        const initial = Math.round((vertical ? rect?.height : rect?.width) ?? value);
        start.current = { initial, coordinate: pointer(event), next: initial };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const movement = (pointer(event) - start.current.coordinate) * (vertical ? -1 : 1);
        start.current.next = limit(start.current.initial + movement);
        event.currentTarget.closest<HTMLElement>('.workspace')?.style.setProperty(variable, `${start.current.next}px`);
      }}
      onPointerUp={(event) => end(event, true)} onPointerCancel={(event) => end(event, false)} />
  );
}

export interface DocumentSplitActions {
  canToggle: boolean;
  hasDivider: boolean;
  toggle(): void;
  focusDivider(): void;
  showSource(path: string): void;
  markdown?: { mode: MarkdownMode; togglePreview(): void; toggleSplit(): void };
  source?: { active: boolean; toggle(): void; focusSecond(): void };
  groups: {
    count: number;
    split(direction: 'left' | 'right' | 'up' | 'down'): void;
    focus(direction: 'left' | 'right' | 'up' | 'down'): void;
    cycle(step: -1 | 1): void;
    move(direction: 'left' | 'right' | 'up' | 'down'): void;
    close(): void;
    cycleTab(direction: -1 | 1): void;
  };
}

export interface WorkbenchProps {
  documents: Documents;
  initialEditorGroups?: EditorGroupsSnapshot;
  onEditorGroupsChange?(snapshot: EditorGroupsSnapshot): void;
  hidden?: boolean;
  mode: WorkspaceMode;
  auxiliary?: ReactNode;
  debugPanel?: ReactNode;
  debugConsole?(tabs: ReactNode): ReactNode;
  sourceControl?: ReactNode;
  sourceControlEntries?: readonly SourceControlEntry[];
  sourceControlDiff?: ReactNode;
  onToggleAuxiliary(): void;
  onWorkspace(mode: WorkspaceMode): void;
  onToggleExplorer(): void;
  onToggleSourceControl(): void;
  onToggleDebug(): void;
  active: Tab | undefined;
  tabs: Tab[];
  root: Entry | null;
  roots?: Entry[];
  target: string | null;
  treeRevision: number;
  settings: Settings;
  activeTheme: ThemeData | null;
  accentColor?: string;
  runConsole: RunConsoleStore;
  bottomTab: BottomTab;
  problemRows: readonly ProblemRow[];
  problemFile?: string;
  problemsStale: boolean;
  selectedProblem?: number;
  problemMarkers?: readonly ProblemMarker[];
  debugEnabled?: boolean;
  debugBreakpoints?: ReadonlyMap<string, readonly number[]>;
  debugStopped?: { path: string; line: number };
  onToggleBreakpoint(path: string, line: number): void;
  onRevealProblem(index: number): void;
  onExplainProblem(index: number): void;
  onNavigateSource(path: string, line: number, column: number): void;
  navigation: { back: boolean; forward: boolean };
  onHistory(direction: 'back' | 'forward'): void;
  terminalFocus: number;
  terminalController: RefObject<TerminalController | null>;
  onBottomTab(tab: BottomTab): void;
  onToggleBottom(): void;
  canRun: boolean;
  canRerun: boolean;
  cursorRef: React.RefObject<HTMLSpanElement | null>;
  onSelect(id: string): void;
  onCloseTab(id: string): void;
  onTabContextAction(action: TabContextAction, id: string): void;
  canReopenClosedTab: boolean;
  onReopenClosedTab(): void;
  onOpenEntry(entry: Entry): void;
  onTarget(path: string): void;
  onCreate(kind: EntryKind): void;
  onRename(entry: Entry): void;
  onTrash(entry: Entry): void;
  onExplorerContextAction(action: ExplorerContextAction, entry: Entry, root: boolean): void;
  onRefresh(): void;
  onNew(): void;
  onInsertStarter?(): void;
  formatting: boolean;
  onFormat(): void;
  onOpenFile(): void;
  onOpenFolder(): void;
  onAddFolder(): void;
  onRemoveFolder(path: string): void;
  onReorderFolder(path: string, offset: -1 | 1): void;
  onSaveWorkspace(): void;
  onOpenWorkspace(): void;
  onSettings(patch: Partial<Settings>): void;
  onRun(): void;
  onRerun(): void;
  onStop(): void;
  onRunInput(text: string): void;
  onConsoleResize(cols: number, rows: number): void;
  onEditorActions(actions: EditorActions | null): void;
  onSplitActions(actions: DocumentSplitActions | null): void;
  onCursor(line: number, column: number): void;
  onFind(replace?: boolean): void;
  onSaveAs(id: string): void;
  onReload(id: string): void;
}

export function Workbench(props: WorkbenchProps) {
  const {
    documents, initialEditorGroups, onEditorGroupsChange, hidden, mode, auxiliary, debugPanel, debugConsole, sourceControl, sourceControlEntries, sourceControlDiff,
    onToggleAuxiliary, onWorkspace, onToggleExplorer, onToggleSourceControl, onToggleDebug,
    active, tabs, root, roots, target, treeRevision, settings, activeTheme, accentColor,
    runConsole, bottomTab, problemRows, problemFile, problemsStale, selectedProblem, problemMarkers,
    debugEnabled, debugBreakpoints, debugStopped, onToggleBreakpoint, onRevealProblem, onExplainProblem,
    terminalFocus, terminalController, onBottomTab, onToggleBottom, canRun, canRerun, cursorRef,
    onSelect, onCloseTab, onTabContextAction, canReopenClosedTab, onReopenClosedTab, onOpenEntry, onTarget, onCreate, onRename, onTrash,
    onExplorerContextAction, onRefresh,
    onNew, onInsertStarter, formatting, onFormat, onOpenFile, onOpenFolder, onAddFolder, onRemoveFolder, onReorderFolder,
    onSaveWorkspace, onOpenWorkspace, onSettings, onRun, onRerun, onStop, onRunInput, onConsoleResize, onEditorActions, onSplitActions, onCursor,
    onFind, onSaveAs, onReload, onNavigateSource, navigation, onHistory,
  } = props;
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [sourceSplit, setSourceSplit] = useState(false);
  const [sourceSplitPercent, setSourceSplitPercent] = useState(50);
  const [markdownPercent, setMarkdownPercent] = useState(50);
  const [markdownModes, setMarkdownModes] = useState(readMarkdownModes);
  const [languageReport, setLanguageReport] = useState<LiveToolReport | null>(null);
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{ id: number; root: string }>();
  const [tabMenu, setTabMenu] = useState<{ tabId: string; groupId: string; x: number; y: number } | null>(null);
  const [explorerMenu, setExplorerMenu] = useState<{ entry: Entry; root: boolean; x: number; y: number } | null>(null);
  const [editorGroups] = useState(() => {
    const groups = new EditorGroups(documents);
    if (initialEditorGroups) groups.restore(initialEditorGroups);
    return groups;
  });
  const tabTraversal = useRef<EditorTabTraversal | null>(null);
  const cycleTab = useCallback((direction: -1 | 1) => {
    const initial = tabTraversal.current ?? editorGroups.beginTabTraversal();
    if (!initial) return;
    const next = editorGroups.stepTabTraversal(initial, direction);
    tabTraversal.current = next;
    editorGroups.previewTabTraversal(next);
  }, [editorGroups]);
  useEffect(() => {
    const finish = (commit: boolean) => {
      const session = tabTraversal.current;
      tabTraversal.current = null;
      if (!session) return;
      if (commit) editorGroups.commitTabTraversal(session);
      else editorGroups.cancelTabTraversal(session);
    };
    const keyup = (event: globalThis.KeyboardEvent) => { if (event.key === 'Control') finish(true); };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && tabTraversal.current) {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };
    const blur = () => finish(true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', blur);
      finish(true);
    };
  }, [editorGroups]);
  useEffect(() => terminalController.current?.setWorkspaceRoot(root?.path), [root?.path, terminalController]);
  const groupSnapshot = useSyncExternalStore(editorGroups.subscribe, editorGroups.getSnapshot);
  useEffect(() => () => editorGroups.dispose(), [editorGroups]);
  useEffect(() => onEditorGroupsChange?.(groupSnapshot), [groupSnapshot, onEditorGroupsChange]);
  const groupMode = groupSnapshot.groups.length > 1;
  const openTabMenu = (event: MouseEvent<HTMLElement>, tabId: string, groupId = groupSnapshot.activeGroupId) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setTabMenu({ tabId, groupId, x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + bounds.height });
  };
  const menuTabIndex = tabMenu ? tabs.findIndex(({ id }) => id === tabMenu.tabId) : -1;
  const tabMenuItems: readonly ContextMenuItem[] = tabMenu ? [
    { type: 'item', id: 'split-right', label: 'Split Right' },
    { type: 'item', id: 'split-down', label: 'Split Down' },
    { type: 'separator', id: 'split-separator' },
    { type: 'item', id: 'close', label: 'Close' },
    { type: 'item', id: 'close-others', label: 'Close Others', disabled: tabs.length < 2 },
    { type: 'item', id: 'close-right', label: 'Close to the Right', disabled: menuTabIndex < 0 || menuTabIndex === tabs.length - 1 },
    { type: 'item', id: 'close-saved', label: 'Close Saved', disabled: !tabs.some((tab) => !tab.dirty) },
    { type: 'item', id: 'close-all', label: 'Close All' },
    { type: 'separator', id: 'history-separator' },
    { type: 'item', id: 'reopen', label: 'Reopen Closed Editor', disabled: !canReopenClosedTab },
  ] : [];
  const explorerMenuItems: readonly ContextMenuItem[] = explorerMenu ? [
    { type: 'item', id: 'open', label: explorerMenu.entry.kind === 'folder' ? 'Select Folder' : 'Open' },
    { type: 'separator', id: 'create-separator' },
    { type: 'item', id: 'new-file', label: 'New File…', disabled: explorerMenu.entry.kind !== 'folder' },
    { type: 'item', id: 'new-folder', label: 'New Folder…', disabled: explorerMenu.entry.kind !== 'folder' },
    { type: 'item', id: 'rename', label: 'Rename…', disabled: explorerMenu.root },
    { type: 'item', id: 'trash', label: 'Move to Trash', disabled: explorerMenu.root, danger: true },
    { type: 'separator', id: 'path-separator' },
    { type: 'item', id: 'copy-path', label: 'Copy Path' },
    { type: 'item', id: 'reveal', label: window.ion.platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Explorer' },
    { type: 'item', id: 'open-terminal', label: 'Open in Integrated Terminal' },
    ...(explorerMenu.root && (roots?.length ?? 0) > 1
      ? [{ type: 'separator', id: 'root-separator' } as const,
        { type: 'item', id: 'remove-root', label: 'Remove Folder from Workspace' } as const] : []),
  ] : [];
  const hasSmartSource = tabs.some((tab) => tab.path && settings.smartLanguages.includes(fileLanguage(tab.name).id));
  useEffect(() => {
    if (!hasSmartSource) void window.ion.languageTools.release(true).catch(() => {});
  }, [hasSmartSource]);
  const markdownScroll = useRef(new Map<string, number>());
  const markdownRestore = useRef<{ id: string; restore?: () => void; focus: boolean } | undefined>(undefined);
  const editorActions = useRef<EditorActions | null>(null);
  const groupEditorActions = useRef(new Map<string, EditorActions>());
  const registerEditorActions = useCallback((actions: EditorActions | null) => {
    editorActions.current = actions;
    onEditorActions(actions);
  }, [onEditorActions]);
  const registerGroupActions = useCallback((groupId: string, actions: EditorActions | null) => {
    if (actions) groupEditorActions.current.set(groupId, actions);
    else groupEditorActions.current.delete(groupId);
    if (editorGroups.getSnapshot().activeGroupId === groupId) {
      editorActions.current = actions;
      onEditorActions(actions);
    }
  }, [editorGroups, onEditorActions]);
  useLayoutEffect(() => {
    if (!groupMode) return;
    const actions = groupEditorActions.current.get(groupSnapshot.activeGroupId) ?? null;
    editorActions.current = actions;
    onEditorActions(actions);
  }, [groupMode, groupSnapshot.activeGroupId, onEditorActions]);
  const divider = useRef<HTMLDivElement>(null);
  const lastCodeId = useRef<string | undefined>(undefined);
  const notebook = active?.notebookMode === 'notebook' ? active : undefined;
  const notebookTabs = tabs.filter((tab) => tab.notebookMode === 'notebook' && (tab.id === notebook?.id || tab.notebookRunning));
  const activeCode = active?.viewer || notebook ? undefined : active;
  const activeWorkspaceRoot = activeCode?.path
    ? (roots ?? (root ? [root] : [])).find((entry) => isWithin(activeCode.path!, entry.path)) : undefined;
  const largeText = activeCode?.path && activeCode.error?.startsWith(largeTextError) ? activeCode : undefined;
  const markdown = activeCode && !largeText && isMarkdownFile(activeCode.name) ? activeCode : undefined;
  const markdownKey = markdown ? markdown.path ?? `tab:${markdown.id}` : undefined;
  const markdownMode = markdownKey ? markdownModes.get(markdownKey) ?? 'source' : 'source';
  const showMarkdown = Boolean(markdownKey && markdownMode !== 'source' && !hidden);
  const markdownSplit = showMarkdown && markdownMode === 'split';
  const sourceHidden = showMarkdown && !markdownSplit;
  const rememberMarkdownScroll = useCallback((top: number) => {
    if (!markdownKey) return;
    const scroll = markdownScroll.current;
    scroll.delete(markdownKey);
    scroll.set(markdownKey, top);
    if (scroll.size > markdownHistoryLimit) scroll.delete(scroll.keys().next().value!);
  }, [markdownKey]);

  function changeMarkdownMode(next: MarkdownMode) {
    if (!markdown || !markdownKey || markdownMode === next) return;
    const restore = markdownMode === 'preview' ? markdownRestore.current?.restore : editorActions.current?.captureView();
    markdownRestore.current = { id: markdown.id, restore, focus: next !== 'preview' };
    const modes = new Map(markdownModes);
    modes.delete(markdownKey);
    if (next !== 'source') modes.set(markdownKey, next);
    if (modes.size > markdownHistoryLimit) modes.delete(modes.keys().next().value!);
    setMarkdownModes(modes);
    writeMarkdownModes(modes);
  }
  const toggleMarkdownPreview = () => changeMarkdownMode(markdownMode === 'preview' ? 'source' : 'preview');
  const toggleMarkdownSplit = () => changeMarkdownMode(markdownMode === 'split' ? 'source' : 'split');
  useLayoutEffect(() => {
    const pending = markdownRestore.current;
    if (!pending) return;
    if (pending.id !== markdown?.id) markdownRestore.current = undefined;
    else if (markdownMode !== 'preview') {
      markdownRestore.current = undefined;
      pending.restore?.();
      if (pending.focus) editorActions.current?.focus();
    }
  }, [markdown?.id, markdownMode]);
  useLayoutEffect(() => {
    if (activeCode) lastCodeId.current = activeCode.id;
  }, [activeCode]);
  const isCodeTab = (tab: Tab) => !tab.viewer && tab.notebookMode !== 'notebook';
  const previousCode = tabs.find((tab) => isCodeTab(tab) && tab.id === lastCodeId.current);
  const codeTab = activeCode ?? previousCode;
  const pinned = pinnedId ? tabs.find((tab) => tab.id === pinnedId && tab.viewer) : undefined;
  const activePreview = notebook || showMarkdown ? undefined : active?.viewer ? active : pinned;
  const documentSplit = Boolean(activeCode && activePreview);
  const split = documentSplit || markdownSplit;
  const dividerPercent = markdownSplit ? markdownPercent : splitPercent;
  const setDividerPercent = markdownSplit ? setMarkdownPercent : setSplitPercent;
  function toggleSplit() {
    if (!activePreview) return;
    if (activePreview.id === pinned?.id) {
      setPinnedId(null);
    } else {
      setPinnedId(activePreview.id);
      const code = previousCode ?? tabs.find(isCodeTab);
      if (code) onSelect(code.id);
    }
  }
  useLayoutEffect(() => {
    onSplitActions({
      canToggle: Boolean(activePreview), hasDivider: split, toggle: toggleSplit,
      focusDivider: () => divider.current?.focus(),
      showSource(path) {
        if (markdownModes.get(path) !== 'preview') return;
        const modes = new Map(markdownModes);
        modes.delete(path);
        if (markdown?.path === path) markdownRestore.current = undefined;
        setMarkdownModes(modes);
        writeMarkdownModes(modes);
      },
      markdown: markdown && { mode: markdownMode, togglePreview: toggleMarkdownPreview, toggleSplit: toggleMarkdownSplit },
      source: activeCode && {
        active: sourceSplit, toggle: () => setSourceSplit((value) => !value),
        focusSecond: () => editorActions.current?.focusSecondary(),
      },
      groups: {
        count: groupSnapshot.groups.length,
        split: (direction) => { editorGroups.split(groupSnapshot.activeGroupId, direction); },
        focus: (direction) => { editorGroups.focus(direction); },
        cycle: (step) => { editorGroups.cycle(step); },
        move: (direction) => { editorGroups.moveActive(direction); },
        close: () => { editorGroups.close(groupSnapshot.activeGroupId); },
        cycleTab,
      },
    });
    return () => onSplitActions(null);
  });
  const hasActiveTab = Boolean(codeTab);
  useEffect(() => { if (!codeTab) setSourceSplit(false); }, [codeTab]);
  const keepEditorWarm = settings.resourceProfile === 'full';
  const [editorStarted, setEditorStarted] = useState(hasActiveTab && keepEditorWarm);
  useEffect(() => {
    if (!keepEditorWarm) setEditorStarted(false);
    else if (hasActiveTab) setEditorStarted(true);
  }, [hasActiveTab, keepEditorWarm]);
  const modeName = mode === 'free' ? 'Free Coding' : { learn: 'Learn', projects: 'Projects', practice: 'Practice' }[mode];
  const hint = (command: MenuCommand, label: string) => {
    const key = displayShortcut(command, settings.shortcuts, window.ion.platform);
    return key ? `${label} (${key})` : label;
  };
  const language = activeCode ? languageFor(activeCode.name).label : null;
  const panelSizes = {
    '--auxiliary-width': `${settings.auxiliaryWidth}px`,
    '--explorer-width': `${settings.explorerWidth}px`,
    '--output-height': `${settings.outputHeight}px`, ...(hidden && { display: 'none' }),
  } as CSSProperties;
  const live = activeCode && settings.smartLanguages.includes(fileLanguage(activeCode.name).id)
    && languageReport && activeCode.path === languageReport.path ? languageReport : null;
  const bottomTabs = <BottomTabs active={bottomTab} count={problemRows.length + (live?.rows.length ?? 0)} onSelect={onBottomTab}/>;
  return (
    <>
      <main className="workspace" style={panelSizes} data-testid="workspace" aria-label={`${modeName} workspace`} data-mode={mode}>
        <nav className="activity-bar" aria-label="Workspace panels">
          <button className="activity-button" title={hint('toggle-explorer', 'Toggle Explorer')} aria-label="Toggle Explorer"
            aria-pressed={settings.showExplorer} onClick={onToggleExplorer}>
            <Icon name="files" size={20}/>
          </button>
          <button className="activity-button" type="button" title={hint('toggle-source-control', 'Source Control')}
            aria-label="Source Control" aria-pressed={Boolean(sourceControl)} data-testid="toggle-source-control" onClick={onToggleSourceControl}>
            <Icon name="git" size={20}/>
          </button>
          <button className="activity-button" type="button" title={hint('toggle-debug', 'Run and Debug')}
            aria-label="Run and Debug" aria-pressed={Boolean(debugPanel)} data-testid="toggle-debug" onClick={onToggleDebug}>
            <Icon name="debug" size={20}/>
          </button>
          <button className="activity-button" title={hint('find', 'Find in File')} aria-label="Find in File"
            disabled={!active || active.viewer === 'pptx' || Boolean(notebook) || sourceHidden} onClick={() => onFind()}><Icon name="search" size={19}/></button>
          <button className="activity-button" title={hint('toggle-output', 'Toggle Console')} aria-label="Toggle Console"
            aria-pressed={settings.showOutput} onClick={onToggleBottom}>
            <Icon name="terminal" size={20}/>
          </button>
          <div className="activity-divider"/>
          <button className="activity-button experience-button" type="button" title="Code" aria-label="Code" aria-pressed={mode === 'free'}
            onClick={() => onWorkspace('free')}><Icon name="code" size={19}/><span>Code</span></button>
          <button className="activity-button experience-button" type="button" title={mode === 'learn' || mode === 'practice' ? hint('toggle-auxiliary', `Toggle ${modeName} panel`) : 'Learn'}
            aria-label={mode === 'learn' || mode === 'practice' ? `Toggle ${modeName} panel` : 'Learn'} data-testid="navigate-learn"
            aria-pressed={(mode === 'learn' || mode === 'practice') && Boolean(auxiliary) && !sourceControl}
            onClick={() => mode === 'learn' || mode === 'practice' ? onToggleAuxiliary() : onWorkspace('learn')}><Icon name="book" size={18}/><span>Learn</span></button>
          <button className="activity-button experience-button" type="button" title={mode === 'projects' ? hint('toggle-auxiliary', 'Toggle Projects panel') : 'Projects'}
            aria-label={mode === 'projects' ? 'Toggle Projects panel' : 'Projects'} data-testid="navigate-projects"
            aria-pressed={mode === 'projects' && Boolean(auxiliary) && !sourceControl}
            onClick={() => mode === 'projects' ? onToggleAuxiliary() : onWorkspace('projects')}><Icon name="map" size={18}/><span>Projects</span></button>
          <div className="activity-end"><span className="signal" title="Local workspace"/></div>
        </nav>
        {settings.showExplorer && <>
          <div className="explorer-frame">
            <Explorer
              root={root} roots={roots} activePath={active?.path ?? null} target={target} tabs={tabs} revision={treeRevision}
              sourceControlEntries={sourceControlEntries}
              onOpen={onOpenEntry} onTarget={onTarget} onCreate={onCreate} onRename={onRename} onTrash={onTrash}
              onContextMenu={(entry, isRoot, position) => setExplorerMenu({ entry, root: isRoot, ...position })}
              onRefresh={onRefresh} onOpenFolder={onOpenFolder} onAddFolder={onAddFolder} onRemoveFolder={onRemoveFolder}
              onReorderFolder={onReorderFolder} onSaveWorkspace={onSaveWorkspace} onOpenWorkspace={onOpenWorkspace}/>
          </div>
          <Splitter label="Resize Explorer" value={settings.explorerWidth}
            setting="explorerWidth" min={150} max={620} onResize={onSettings}/>
        </>}
        {(auxiliary || debugPanel || sourceControl) && <>
          <div className="auxiliary-frame">
            {auxiliary && <div className="auxiliary-underlay" hidden={Boolean(sourceControl || debugPanel)}>{auxiliary}</div>}
            {debugPanel && <div className="auxiliary-underlay" hidden={Boolean(sourceControl)}>{debugPanel}</div>}
            {sourceControl}
          </div>
          <Splitter label={sourceControl ? 'Resize Source Control' : debugPanel ? 'Resize Run and Debug' : `Resize ${modeName} panel`} value={settings.auxiliaryWidth} setting="auxiliaryWidth"
            min={220} max={620} onResize={onSettings}/>
        </>}
        <div className="editor-column">
          <div className="editor-stack">
            {groupMode && <EditorGroupLayoutView layout={groupSnapshot.layout} snapshot={groupSnapshot} groups={editorGroups}
              activeGroupId={groupSnapshot.activeGroupId} documents={documents} tabs={tabs} root={root} roots={roots} hidden={hidden}
              settings={settings} activeTheme={activeTheme} accentColor={accentColor} problemMarkers={problemMarkers}
              debugEnabled={debugEnabled} debugBreakpoints={debugBreakpoints} debugStopped={debugStopped}
              onToggleBreakpoint={onToggleBreakpoint}
              onCloseTab={onCloseTab} onSaveAs={onSaveAs} onReload={onReload} onSettings={onSettings}
              onTabMenu={openTabMenu}
              onActions={registerGroupActions} onCursor={onCursor} onLanguageReport={setLanguageReport}
              onNavigateSource={onNavigateSource}/>}
            {!groupMode && <>
            <div className="tab-strip">
              <div className="tab-scroll" aria-label="Open files">
                {tabs.map((tab) => (
                  <div key={tab.id} className={`editor-tab ${active?.id === tab.id ? 'active' : ''}`}
                    data-testid="tab" data-path={tab.path ?? undefined} onContextMenu={(event) => openTabMenu(event, tab.id)}>
                    <button className="tab-name" title={tab.path ?? (tab.recoveredFrom ? `Recovered from ${tab.recoveredFrom}` : tab.name)} aria-current={active?.id === tab.id ? 'true' : undefined}
                      onClick={() => onSelect(tab.id)}>
                      <Icon name={/\.[ch]$/i.test(tab.name) ? 'code' : 'file'} size={14}/><span>{tab.name}</span>
                    </button>
                    <button className={`tab-close ${tab.dirty ? 'tab-dirty' : ''}`} data-testid="close-tab"
                      data-path={tab.path ?? undefined} aria-label={`Close ${tab.name}`}
                      title={tab.dirty ? 'Unsaved changes · Close file' : 'Close file'}
                      onClick={() => onCloseTab(tab.id)}><Icon name="x" size={13}/></button>
                  </div>
                ))}
              </div>
              {onInsertStarter && <button className="icon-button tab-add" aria-label="Insert Starter Code" data-testid="insert-starter"
                title={hint('insert-starter', 'Insert starter code into an empty file')} onClick={onInsertStarter}><Icon name="code" size={15}/></button>}
              <button className="icon-button tab-add" aria-label="New file" title={hint('new-file', 'New file')} onClick={onNew}><Icon name="plus" size={15}/></button>
              {markdown && <div className="markdown-view-actions" role="group" aria-label="Markdown view">
                <button className="icon-button" type="button" data-testid="markdown-preview-toggle"
                  aria-label={sourceHidden ? 'Show Markdown source' : 'Show Markdown preview'}
                  title={hint('markdown-preview', sourceHidden ? 'Show Markdown source' : 'Show Markdown preview')}
                  aria-pressed={sourceHidden} onClick={toggleMarkdownPreview}><Icon name={sourceHidden ? 'code' : 'eye'} size={16}/></button>
                <button className="icon-button" type="button" data-testid="markdown-split-toggle" aria-label="Toggle Markdown split view"
                  title={hint('markdown-split', 'Toggle Markdown split view')} aria-pressed={markdownSplit}
                  onClick={toggleMarkdownSplit}><Icon name="columns" size={16}/></button>
              </div>}
              {activeCode && !largeText && !sourceHidden && <button className="icon-button tab-add" type="button"
                data-testid="source-split-toggle" aria-label="Split Code Editor" aria-pressed={sourceSplit}
                title={hint('toggle-editor-split', 'Split Code Editor')} onClick={() => setSourceSplit((value) => !value)}>
                <Icon name="columns" size={15}/></button>}
              {activeCode && !largeText && !sourceHidden && <button className="icon-button tab-add" type="button"
                data-testid="editor-group-split-right" aria-label="Open Editor Group Right" title="Open Editor Group Right"
                onClick={() => editorGroups.split(groupSnapshot.activeGroupId, 'right')}><Icon name="plus" size={14}/></button>}
            </div>
            <div className="editor-view-row" data-testid={markdownSplit ? 'markdown-split' : documentSplit ? 'document-split' : undefined}
              data-markdown-mode={markdown && markdownMode}
              style={split ? { '--document-split': `${dividerPercent}%` } as CSSProperties : undefined}>
              <div className="code-pane" hidden={Boolean(active?.viewer || notebook)} inert={sourceHidden || Boolean(sourceControlDiff) || undefined}>
                {activeCode && (
                  <>
                    <div className="editor-breadcrumb" title={activeCode.path ?? activeCode.name}>
                      <button className="icon-button source-back" aria-label="Go Back" title="Go Back" type="button"
                        disabled={!navigation.back} onClick={() => onHistory('back')}><Icon name="arrow" size={13}/></button>
                      <button className="icon-button" aria-label="Go Forward" title="Go Forward" type="button"
                        disabled={!navigation.forward} onClick={() => onHistory('forward')}><Icon name="arrow" size={13}/></button>
                      <Icon name={activeWorkspaceRoot ? 'folder' : 'file'} size={13}/>
                      <strong>{activeWorkspaceRoot && activeCode.path
                        ? activeWorkspaceRoot.name + '/' + activeCode.path.slice(activeWorkspaceRoot.path.length).replace(/^[/\\]+/, '').replaceAll('\\', '/')
                        : activeCode.name}</strong>
                      {activeCode.notebookMode === 'json' && <button className="button" onClick={() => documents.setNotebookMode(activeCode.id, 'notebook')}>Open Notebook</button>}
                    </div>
                    {activeCode.conflict && (
                      <div className="conflict-banner" role="alert">
                        <Icon name="warning" size={16}/><span>This file changed on disk.{activeCode.dirty && ' Your edits are unsaved.'}</span>
                        <button className="button" onClick={() => onSaveAs(activeCode.id)}>Save As…</button>
                        <button className="button" onClick={() => onReload(activeCode.id)}>Reload</button>
                      </div>
                    )}
                  </>
                )}
                {(codeTab || (editorStarted && keepEditorWarm)) && <EditorContent documents={documents} tab={largeText ? undefined : activeCode} settings={settings}
                  activeTheme={activeTheme} accentColor={accentColor} sourceHidden={sourceHidden || hidden} problemMarkers={problemMarkers}
                  debugEnabled={debugEnabled} breakpointLines={activeCode?.path ? debugBreakpoints?.get(sourceControlPathKey(activeCode.path)) : undefined}
                  debugStoppedLine={activeCode?.path && debugStopped && sourceControlPathKey(activeCode.path) === sourceControlPathKey(debugStopped.path)
                    ? debugStopped.line : undefined} onToggleBreakpoint={onToggleBreakpoint}
                  split={sourceSplit && Boolean(activeCode) && !sourceHidden && !hidden} splitPercent={sourceSplitPercent} onSplitPercent={setSourceSplitPercent}
                  workspacePath={root?.path} onLanguageReport={setLanguageReport} onNavigateSource={onNavigateSource}
                  onActions={registerEditorActions} onCursor={onCursor}/>}
                {largeText?.path && <LargeTextPreview key={`${largeText.id}:${largeText.epoch}`} path={largeText.path}/>}
                {!active && (
                  <div className="editor-empty">
                    <div className="empty-logo"><Icon name="logo" size={43}/></div>
                    <h2>Ready to code.</h2>
                    <p>Choose a file in the explorer or start with a blank editor.</p>
                    <div className="empty-actions">
                      <button className="button primary" onClick={onNew}><Icon name="plus" size={15}/> New File</button>
                      <button className="button" onClick={onOpenFile}>Open File</button>
                    </div>
                  </div>
                )}
              </div>
              {notebookTabs.map((tab) => <div className="code-pane" hidden={tab.id !== notebook?.id} inert={Boolean(sourceControlDiff) || undefined} key={tab.id}>
                {tab.conflict && <div className="conflict-banner" role="alert">
                  <Icon name="warning" size={16}/><span>This file changed on disk.{tab.dirty && ' Your edits are unsaved.'}</span>
                  <button className="button" disabled={tab.notebookRunning} onClick={() => onSaveAs(tab.id)}>Save As…</button>
                  <button className="button" disabled={tab.notebookRunning} onClick={() => onReload(tab.id)}>Reload</button>
                </div>}
                <NotebookPane key={tab.epoch} tab={tab} documents={documents} onKernelPolicyChange={(policy) => onSettings({ notebookKernelLifetime: policy })}
                  settings={settings} activeTheme={activeTheme} accentColor={accentColor}/>
              </div>)}
              {split && <div ref={divider} className="splitter split-columns" role="separator" tabIndex={0} aria-orientation="vertical"
                aria-label={markdownSplit ? 'Resize Markdown split' : 'Resize document split'} aria-valuemin={26} aria-valuemax={74} aria-valuenow={dividerPercent}
                onPointerDown={(event) => {
                  if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                  if (bounds?.width) setDividerPercent(Math.max(26, Math.min(74, Math.round(100 * (event.clientX - bounds.left) / bounds.width))));
                }}
                onKeyDown={(event) => {
                  const delta = event.key === 'ArrowLeft' ? -3 : event.key === 'ArrowRight' ? 3 : 0;
                  if (delta) { event.preventDefault(); setDividerPercent((value) => Math.max(26, Math.min(74, value + delta))); }
                  if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    setDividerPercent(event.key === 'Home' ? 26 : 74);
                  }
                }}/>}
              {markdown && !hidden && <MarkdownPreviewPane key={`${markdown.id}:${markdown.epoch}`} visible={showMarkdown}
                id={markdown.id} path={markdown.path} workspacePath={root?.path} documents={documents} theme={activeTheme}
                scrollTop={markdownKey ? markdownScroll.current.get(markdownKey) : undefined} onScrollTop={rememberMarkdownScroll}
                onOpenEntry={onOpenEntry}/>}
              {activePreview?.path && activePreview.viewer && <DocumentPane
                key={activePreview.id + ':' + activePreview.epoch} path={activePreview.path}
                name={activePreview.name} format={activePreview.viewer} pinned={activePreview.id === pinned?.id}
                onPin={toggleSplit}/>}
              {sourceControlDiff && <div className="source-control-diff-slot">{sourceControlDiff}</div>}
            </div>
            </>}
          </div>
          {settings.showOutput && !hidden && <>
            <Splitter label="Resize Console" vertical value={settings.outputHeight} setting="outputHeight" min={100} max={600}
              onResize={onSettings}/>
            <div className="output-frame">
              {bottomTab === 'terminal'
                ? <TerminalLoader controller={terminalController} tabs={bottomTabs} focusRequest={terminalFocus}
                  workspaceRoot={root?.path} openRequest={terminalOpenRequest} onHide={onToggleBottom}/>
                : bottomTab === 'debug' && debugConsole ? debugConsole(bottomTabs)
                : bottomTab === 'problems' ? <Problems tabs={bottomTabs} rows={problemRows} file={problemFile}
                  live={live ? { file: activeCode?.name, rows: live.rows, onReveal(index) {
                    const location = live.rows[index]?.problem.location;
                    if (location) editorActions.current?.goToLine(location.line, location.column, activeCode?.id);
                  } } : undefined} stale={problemsStale} selected={selectedProblem}
                  onReveal={onRevealProblem} onExplain={onExplainProblem} onClose={onToggleBottom}/>
                : <Output store={runConsole} tabs={bottomTabs} canRun={canRun} canRerun={canRerun} onRun={onRun} onRerun={onRerun} onStop={onStop}
                  onInput={onRunInput} onResize={onConsoleResize} onClose={onToggleBottom}/>}
            </div>
          </>}
        </div>
      </main>
      {tabMenu && <ContextMenu open position={{ x: tabMenu.x, y: tabMenu.y }} items={tabMenuItems}
        ariaLabel="Editor tab actions" onClose={() => setTabMenu(null)} onSelect={(item) => {
          if (item.id === 'split-right' || item.id === 'split-down') {
            editorGroups.select(tabMenu.groupId, tabMenu.tabId);
            editorGroups.split(tabMenu.groupId, item.id === 'split-right' ? 'right' : 'down');
          } else if (item.id === 'reopen') onReopenClosedTab();
          else {
            const action = ({ close: 'close', 'close-others': 'close-others', 'close-right': 'close-right',
              'close-saved': 'close-saved', 'close-all': 'close-all' } as const)[item.id as TabContextAction];
            if (action) onTabContextAction(action, tabMenu.tabId);
          }
        }}/>
      }
      {explorerMenu && <ContextMenu open position={{ x: explorerMenu.x, y: explorerMenu.y }} items={explorerMenuItems}
        ariaLabel="Explorer actions" onClose={() => setExplorerMenu(null)}
        onSelect={(item) => {
          if (item.id === 'open-terminal') {
            const terminalRoot = explorerMenu.entry.kind === 'folder' ? explorerMenu.entry.path
              : explorerMenu.entry.path.replace(/[\\/][^\\/]+$/, '');
            if (bottomTab !== 'terminal') onBottomTab('terminal');
            if (!settings.showOutput) onToggleBottom();
            setTerminalOpenRequest({ id: Date.now(), root: terminalRoot });
          } else onExplorerContextAction(item.id as ExplorerContextAction, explorerMenu.entry, explorerMenu.root);
        }}/>
      }
      <div className="document-status" style={hidden ? { display: 'none' } : undefined}>
        {codeTab && <span ref={cursorRef} hidden={!activeCode || Boolean(largeText) || sourceHidden}>Ln 1, Col 1</span>}
        {activeCode && !largeText && <><span>{settings.tabSize} spaces</span><span>UTF-8</span><span>{language}</span></>}
        {largeText && <span>UTF-8 · Read only</span>}
        {active?.viewer && <span>{active.viewer.toUpperCase()} · Read only</span>}
        {notebook && <span>Jupyter Notebook</span>}
        <span className="status-autosave"><Icon name="bolt" size={12}/> Autosave {settings.autoSave ? active?.conflict ? 'paused' : 'on' : 'off'}</span>
        <button className="status-format" type="button" data-testid="format-document" title="Format Document"
          aria-label="Format Document" aria-busy={formatting || undefined}
          disabled={formatting || !activeCode || Boolean(activeCode.error || activeCode.conflict || activeCode.notebookMode || largeText) || sourceHidden}
          onClick={onFormat}><Icon name="format" size={12}/><span>Format</span></button>
      </div>
    </>
  );
}
