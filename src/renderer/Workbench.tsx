import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ComponentType, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Entry, EntryKind, MenuCommand, Settings, WorkspaceMode } from '../shared/contracts';
import { displayShortcut } from '../shared/shortcuts';
import type { ThemeData } from '../shared/themes';
import type { BottomTab } from '../shared/terminal';
import { errorMessage, type Documents, type Tab } from './documents';
import { Explorer } from './Explorer';
import { Icon } from './icons';
import { loadEditor, loadedEditor } from './load-editor';
import type MonacoSurface from './MonacoSurface';
import type { EditorActions } from './MonacoSurface';
import type { LiveToolReport } from './java/editor-tools';
import { Output } from './Output';
import { Problems, type ProblemMarker, type ProblemRow } from './Problems';
import type { RunConsoleStore } from './run-console/store';
import type { TerminalController } from './terminal/controller';
import type { TerminalPaneProps } from './terminal/TerminalPane';
import './terminal/panel.css';
import { languageFor } from './paths';
import { DocumentPane } from './viewers/DocumentPane';
import { NotebookPane } from './NotebookPane';
import { MarkdownPreviewPane } from './MarkdownPreviewPane';
import { isMarkdownFile } from '../shared/markdown-path';
import { largeTextError } from '../shared/large-text';
import { LargeTextPreview } from './LargeTextPreview';
import { markdownHistoryLimit, readMarkdownModes, writeMarkdownModes, type MarkdownMode } from './markdown-view-state';

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

function BottomTabs({ active, count, onSelect }: { active: BottomTab; count: number; onSelect(tab: BottomTab): void }) {
  const tabs = [
    { id: 'terminal', title: 'Terminal', icon: 'terminal' },
    { id: 'run', title: 'Run Console', icon: 'play' },
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
}

export interface WorkbenchProps {
  documents: Documents;
  hidden?: boolean;
  mode: WorkspaceMode;
  auxiliary?: ReactNode;
  marketplace?: ReactNode;
  onToggleAuxiliary(): void;
  onToggleExplorer(): void;
  onToggleMarketplace(): void;
  active: Tab | undefined;
  tabs: Tab[];
  root: Entry | null;
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
  onRevealProblem(index: number): void;
  onExplainProblem(index: number): void;
  onNavigateSource(path: string, line: number, column: number): void;
  terminalFocus: number;
  terminalController: RefObject<TerminalController | null>;
  onBottomTab(tab: BottomTab): void;
  onToggleBottom(): void;
  canRun: boolean;
  canRerun: boolean;
  cursorRef: React.RefObject<HTMLSpanElement | null>;
  onSelect(id: string): void;
  onCloseTab(id: string): void;
  onOpenEntry(entry: Entry): void;
  onTarget(path: string): void;
  onCreate(kind: EntryKind): void;
  onRename(entry: Entry): void;
  onTrash(entry: Entry): void;
  onRefresh(): void;
  onNew(): void;
  onInsertStarter?(): void;
  formatting: boolean;
  onFormat(): void;
  onOpenFile(): void;
  onOpenFolder(): void;
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
    documents, hidden, mode, auxiliary, marketplace, onToggleAuxiliary, onToggleExplorer, onToggleMarketplace,
    active, tabs, root, target, treeRevision, settings, activeTheme, accentColor,
    runConsole, bottomTab, problemRows, problemFile, problemsStale, selectedProblem, problemMarkers, onRevealProblem, onExplainProblem,
    terminalFocus, terminalController, onBottomTab, onToggleBottom, canRun, canRerun, cursorRef,
    onSelect, onCloseTab, onOpenEntry, onTarget, onCreate, onRename, onTrash, onRefresh,
    onNew, onInsertStarter, formatting, onFormat, onOpenFile, onOpenFolder, onSettings, onRun, onRerun, onStop, onRunInput, onConsoleResize, onEditorActions, onSplitActions, onCursor,
    onFind, onSaveAs, onReload, onNavigateSource,
  } = props;
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [markdownPercent, setMarkdownPercent] = useState(50);
  const [markdownModes, setMarkdownModes] = useState(readMarkdownModes);
  const [languageReport, setLanguageReport] = useState<LiveToolReport | null>(null);
  const smartJava = settings.smartLanguages?.includes('java');
  const hasJavaSource = smartJava && tabs.some((tab) => tab.path && languageFor(tab.name).id === 'java');
  useEffect(() => {
    if (smartJava && !hasJavaSource) void window.ion.languageTools.release(true).catch(() => {});
  }, [smartJava, hasJavaSource]);
  const markdownScroll = useRef(new Map<string, number>());
  const markdownRestore = useRef<{ id: string; restore?: () => void; focus: boolean } | undefined>(undefined);
  const editorActions = useRef<EditorActions | null>(null);
  const registerEditorActions = useCallback((actions: EditorActions | null) => {
    editorActions.current = actions;
    onEditorActions(actions);
  }, [onEditorActions]);
  const divider = useRef<HTMLDivElement>(null);
  const lastCodeId = useRef<string | undefined>(undefined);
  const notebook = active?.notebookMode === 'notebook' ? active : undefined;
  const notebookTabs = tabs.filter((tab) => tab.notebookMode === 'notebook' && (tab.id === notebook?.id || tab.notebookRunning));
  const activeCode = active?.viewer || notebook ? undefined : active;
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
    });
    return () => onSplitActions(null);
  });
  const codeTab = activeCode ?? previousCode;
  const hasActiveTab = Boolean(codeTab);
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
  const live = smartJava && languageReport && activeCode?.path === languageReport.path ? languageReport : null;
  const bottomTabs = <BottomTabs active={bottomTab} count={problemRows.length + (live?.rows.length ?? 0)} onSelect={onBottomTab}/>;
  return (
    <>
      <main className="workspace" style={panelSizes} data-testid="workspace" aria-label={`${modeName} workspace`} data-mode={mode}>
        <nav className="activity-bar" aria-label="Workspace panels">
          <button className="activity-button" title={hint('toggle-explorer', 'Toggle Explorer')} aria-label="Toggle Explorer"
            aria-pressed={settings.showExplorer && !marketplace} onClick={onToggleExplorer}>
            <Icon name="files" size={20}/>
          </button>
          <button className="activity-button" title={hint('find', 'Find in File')} aria-label="Find in File"
            disabled={!active || active.viewer === 'pptx' || Boolean(notebook) || sourceHidden} onClick={() => onFind()}><Icon name="search" size={19}/></button>
          <button className="activity-button" title={hint('toggle-output', 'Toggle Console')} aria-label="Toggle Console"
            aria-pressed={settings.showOutput} onClick={onToggleBottom}>
            <Icon name="terminal" size={20}/>
          </button>
          {mode !== 'free' && <button className="activity-button" title={hint('toggle-auxiliary', `Toggle ${modeName} panel`)}
            aria-label={`Toggle ${modeName} panel`} aria-pressed={Boolean(auxiliary)} onClick={onToggleAuxiliary}>
            <Icon name={mode === 'learn' ? 'book' : mode === 'projects' ? 'map' : 'flask'} size={19}/>
          </button>}
          <button className="activity-button" type="button" title={hint('toggle-marketplace', 'Marketplace')}
            aria-label="Marketplace" aria-pressed={Boolean(marketplace)} data-testid="toggle-marketplace" onClick={onToggleMarketplace}>
            <Icon name="marketplace" size={19}/>
          </button>
          <div className="activity-end"><span className="signal" title="Local workspace"/></div>
        </nav>
        {(settings.showExplorer || marketplace) && <>
          <div className="explorer-frame">
            {settings.showExplorer && <Explorer hidden={Boolean(marketplace)}
              root={root} activePath={active?.path ?? null} target={target} tabs={tabs} revision={treeRevision}
              onOpen={onOpenEntry} onTarget={onTarget} onCreate={onCreate} onRename={onRename} onTrash={onTrash}
              onRefresh={onRefresh} onOpenFolder={onOpenFolder}/>}
            {marketplace}
          </div>
          <Splitter label={marketplace ? 'Resize Marketplace' : 'Resize Explorer'} value={settings.explorerWidth}
            setting="explorerWidth" min={150} max={620} onResize={onSettings}/>
        </>}
        {auxiliary && <>
          <div className="auxiliary-frame">{auxiliary}</div>
          <Splitter label={`Resize ${modeName} panel`} value={settings.auxiliaryWidth} setting="auxiliaryWidth"
            min={220} max={620} onResize={onSettings}/>
        </>}
        <div className="editor-column">
          <div className="editor-stack">
            <div className="tab-strip">
              <div className="tab-scroll" aria-label="Open files">
                {tabs.map((tab) => (
                  <div key={tab.id} className={`editor-tab ${active?.id === tab.id ? 'active' : ''}`}
                    data-testid="tab" data-path={tab.path ?? undefined}>
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
            </div>
            <div className="editor-view-row" data-testid={markdownSplit ? 'markdown-split' : documentSplit ? 'document-split' : undefined}
              data-markdown-mode={markdown && markdownMode}
              style={split ? { '--document-split': `${dividerPercent}%` } as CSSProperties : undefined}>
              <div className="code-pane" hidden={Boolean(active?.viewer || notebook)} inert={sourceHidden || undefined}>
                {activeCode && (
                  <>
                    <div className="editor-breadcrumb" title={activeCode.path ?? activeCode.name}>
                      {root && <><Icon name="folder" size={13}/><span>{root.name}</span><Icon name="chevron" size={12}/></>}
                      <Icon name="file" size={13}/><strong>{activeCode.name}</strong>
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
              {notebookTabs.map((tab) => <div className="code-pane" hidden={tab.id !== notebook?.id} key={tab.id}>
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
            </div>
          </div>
          {settings.showOutput && !hidden && <>
            <Splitter label="Resize Console" vertical value={settings.outputHeight} setting="outputHeight" min={100} max={600}
              onResize={onSettings}/>
            <div className="output-frame">
              {bottomTab === 'terminal'
                ? <TerminalLoader controller={terminalController} tabs={bottomTabs} focusRequest={terminalFocus} onHide={onToggleBottom}/>
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
