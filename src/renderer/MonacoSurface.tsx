import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProblemMarker } from './Problems';
import { editor, languages, Selection, Uri } from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/csharp/register.js';
import 'monaco-editor/languages/definitions/dart/register.js';
import 'monaco-editor/languages/definitions/kotlin/register.js';
import 'monaco-editor/languages/definitions/perl/register.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/ruby/register.js';
import 'monaco-editor/languages/definitions/swift/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import type { Settings } from '../shared/contracts';
import { editorViewSelectionLimit } from '../shared/editor-session';
import { maxEditableTextBytes } from '../shared/large-text';
import type { FormatResult } from '../shared/format-code';
import type { ThemeData } from '../shared/themes';
import { Documents, type Tab } from './documents';
import type { LiveToolReport } from './java/editor-tools';
import { fileLanguage } from '../shared/languages';
import type { SourceReference } from '../shared/language-tools';
import { applyEditorTheme, clearEditorTheme } from './themes/editor-theme';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON'] });
languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\],:]/, 'delimiter'],
    ],
  },
});

export interface EditorActions {
  find(replace?: boolean): void;
  focus(): void;
  lineCount(): number;
  goToDefinition(): void;
  findReferences(): Promise<SourceReference[]>;
  position(tabId: string): { line: number; column: number } | undefined;
  goToLine(line: number, column?: number, tabId?: string): boolean;
  captureView(): (() => void) | undefined;
  insertStarter(starter: { text: string; line: number; column: number }): boolean;
  format(tabId: string, controller: AbortController): Promise<FormatResult>;
}

interface Props {
  documents: Documents;
  tab: Tab | undefined;
  settings: Settings;
  activeTheme: ThemeData | null;
  accentColor?: string;
  sourceHidden?: boolean;
  workspacePath?: string;
  problemMarkers?: readonly ProblemMarker[];
  onActions(actions: EditorActions | null): void;
  onCursor(line: number, column: number): void;
  onLanguageReport(report: LiveToolReport | null): void;
  onNavigateSource(path: string, line: number, column: number): void;
}

interface CachedModel {
  model: editor.ITextModel;
  listener: { dispose(): void };
  view?: editor.ICodeEditorViewState;
}

const MODEL_LIMIT = 3;
const textOf = (model: editor.ITextModel) => model.getValue(undefined, true);

function discardModel(model: editor.ITextModel) {
  if (model.canUndo() || model.canRedo()) model.setValue('');
  model.dispose();
}

function releaseModel(documents: Documents, id: string, { model, listener }: CachedModel) {
  listener.dispose();
  const { uri } = model;
  const discardUndo = model.canUndo() || model.canRedo() ? () => {
    // Reopen without a widget to let Monaco remove this URI's detached history.
    discardModel(editor.createModel('', 'plaintext', uri));
  } : undefined;
  documents.releaseModel(id, () => textOf(model), discardUndo);
  model.dispose();
}

function rememberView(documents: Documents, id: string, instance: editor.IStandaloneCodeEditor) {
  const selections = instance.getSelections();
  if (!selections?.length) return;
  documents.setEditorView(id, {
    selections: selections.slice(0, editorViewSelectionLimit).map((selection) => ({
      selectionStartLineNumber: selection.selectionStartLineNumber,
      selectionStartColumn: selection.selectionStartColumn,
      positionLineNumber: selection.positionLineNumber,
      positionColumn: selection.positionColumn,
    })),
    scrollTop: instance.getScrollTop(), scrollLeft: instance.getScrollLeft(),
  });
}

function revealLocation(instance: editor.IStandaloneCodeEditor, model: editor.ITextModel, line: number, column: number) {
  const position = model.validatePosition({ lineNumber: line, column });
  instance.setPosition(position);
  instance.revealPositionInCenterIfOutsideViewport(position);
}

export default function MonacoSurface({
  documents, tab, settings, activeTheme, accentColor, sourceHidden, workspacePath, problemMarkers,
  onActions, onCursor, onLanguageReport, onNavigateSource,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor>(null);
  const cache = useRef(new Map<string, CachedModel>());
  const displayed = useRef<string | null>(null);
  const initialSettings = useRef(settings);
  const sourceHiddenRef = useRef(sourceHidden);
  const activeFormat = useRef<AbortController | null>(null);
  sourceHiddenRef.current = sourceHidden;
  useEffect(() => {
    if (sourceHidden) activeFormat.current?.abort('view');
  }, [sourceHidden]);
  const tabSizeRef = useRef(settings.tabSize);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [languageStatus, setLanguageStatus] = useState<string | null>(null);
  const navigateSource = useRef(onNavigateSource);
  navigateSource.current = onNavigateSource;

  useLayoutEffect(() => {
    if (activeTheme) applyEditorTheme(activeTheme, accentColor);
    else editor.setTheme('vs-dark');
  }, [activeTheme, accentColor]);

  useEffect(() => {
    if (!host.current) return;
    const models = cache.current;
    const instance = editor.create(host.current, {
      model: null,
      automaticLayout: true,
      ariaLabel: 'Code editor',
      accessibilitySupport: 'auto',
      contextmenu: true,
      minimap: { enabled: false },
      disableLayerHinting: true,
      guides: { bracketPairs: false },
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 14, bottom: 14 },
      fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
      fontLigatures: false,
      fontSize: initialSettings.current.fontSize,
      lineNumbers: initialSettings.current.lineNumbers ? 'on' : 'off',
      wordWrap: initialSettings.current.wordWrap ? 'on' : 'off',
      renderValidationDecorations: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      inlineSuggest: { enabled: false },
      codeLens: false,
      stickyScroll: { enabled: false },
      links: false,
      tabCompletion: 'off',
      overviewRulerLanes: 0,
      occurrencesHighlight: 'off',
      smoothScrolling: false,
      cursorBlinking: 'solid',
      cursorSmoothCaretAnimation: 'off',
    });

    editorRef.current = instance;
    const rememberActiveView = () => {
      const id = displayed.current;
      if (id && !sourceHiddenRef.current) rememberView(documents, id, instance);
    };
    const cursorListener = instance.onDidChangeCursorSelection(({ selection }) => {
      onCursor(selection.positionLineNumber, selection.positionColumn);
      rememberActiveView();
    });
    const scrollListener = instance.onDidScrollChange(({ scrollTopChanged, scrollLeftChanged }) => {
      if (scrollTopChanged || scrollLeftChanged) rememberActiveView();
    });
    const drop = (id: string) => {
      const cached = models.get(id);
      if (cached) {
        if (instance.getModel() === cached.model) {
          displayed.current = null;
          instance.setModel(null);
        }
        cached.listener.dispose();
        discardModel(cached.model);
        models.delete(id);
      }
    };

    documents.attachModels({
      getText(id) {
        const model = models.get(id)?.model;
        return model ? textOf(model) : undefined;
      },
      getTextPrefix(id, length) {
        const model = models.get(id)?.model;
        if (!model) return;
        if (model.getValueLength() <= length) return model.getValue();
        const end = model.getPositionAt(length);
        return model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column });
      },
      drop,
    });
    const opener = editor.registerEditorOpener({
      openCodeEditor(source, resource, location) {
        if (source !== instance || resource.scheme !== 'file') return false;
        const tab = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        const path = resource.toString() === instance.getModel()?.uri.toString() ? tab?.path : resource.fsPath;
        if (!path) return false;
        const line = location ? ('lineNumber' in location ? location.lineNumber : location.startLineNumber) : 1;
        const column = location ? ('column' in location ? location.column : location.startColumn) : 1;
        navigateSource.current(path, line, column);
        return true;
      },
    });
    onActions({
      find(replace = false) {
        if (!instance.getModel()) return;
        instance.focus();
        void instance.getAction(replace ? 'editor.action.startFindReplaceAction' : 'actions.find')?.run();
      },
      focus: () => instance.focus(),
      lineCount: () => instance.getModel()?.getLineCount() ?? 0,
      goToDefinition() {
        if (!instance.getModel() || sourceHiddenRef.current) return;
        instance.focus();
        void instance.getAction('editor.action.revealDefinition')?.run();
      },
      async findReferences() {
        const model = instance.getModel();
        const position = instance.getPosition();
        const tab = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        if (!model || !position || !tab?.path || sourceHiddenRef.current) return [];
        const { id, label } = fileLanguage(tab.name);
        const current = () => instance.getModel() === model && !model.isDisposed() && !sourceHiddenRef.current;
        const { createToolQuery, sourceReferences } = await import('./language-editor-tools');
        const query = createToolQuery(model, current, { language: id, label, path: tab.path, onStatus: setLanguageStatus });
        return sourceReferences(await query('references', position) ?? []);
      },
      position(tabId) {
        const position = displayed.current === tabId ? instance.getPosition() : null;
        if (position) return { line: position.lineNumber, column: position.column };
      },
      captureView() {
        const model = instance.getModel();
        const view = instance.saveViewState();
        if (!model || !view) return undefined;
        return () => {
          if (editorRef.current !== instance || instance.getModel() !== model) return;
          instance.layout();
          instance.restoreViewState(view);
        };
      },
      goToLine(line, column = 1, tabId) {
        const model = instance.getModel();
        if (!model || (tabId !== undefined && displayed.current !== tabId)) return false;
        revealLocation(instance, model, line, column);
        if (!sourceHiddenRef.current) instance.focus();
        return true;
      },
      insertStarter({ text, line, column }) {
        const id = documents.getSnapshot().activeId;
        const model = instance.getModel();
        if (!id || !model || models.get(id)?.model !== model || sourceHiddenRef.current
          || model.getValueLength(undefined, true) !== 0 || !text) return false;
        instance.pushUndoStop();
        const inserted = instance.executeEdits('ion-insert-starter', [{
          range: model.getFullModelRange(), text,
        }], [new Selection(line, column, line, column)]);
        if (!inserted) return false;
        instance.pushUndoStop();
        instance.revealLineInCenterIfOutsideViewport(line);
        instance.focus();
        return true;
      },
      async format(tabId, controller) {
        const { signal } = controller;
        const model = instance.getModel();
        const initial = documents.getSnapshot().tabs.find((entry) => entry.id === tabId);
        const editorUnavailable: FormatResult = { kind: 'error', message: 'Open an editable source file to format it.' };
        if (!model || displayed.current !== tabId || !initial || initial.viewer || initial.notebookMode || initial.error
          || initial.conflict || sourceHiddenRef.current || instance.getRawOptions().readOnly) return editorUnavailable;
        if (model.getValueLength() > maxEditableTextBytes) {
          return { kind: 'error', message: 'The source exceeds Ion’s 2 MiB editable file limit.' };
        }
        const version = model.getVersionId();
        const stillActive = () => {
          const snapshot = documents.getSnapshot();
          const tab = snapshot.tabs.find((entry) => entry.id === tabId);
          return snapshot.activeId === tabId && !sourceHiddenRef.current && instance.getModel() === model
            && tab?.epoch === initial.epoch && tab.path === initial.path && tab.name === initial.name && !tab.conflict;
        };
        const cancelled = (): FormatResult => ({ kind: 'cancelled',
          message: signal.reason === 'edit' ? 'Document changed. Formatting skipped.' : 'Formatting cancelled.' });
        const unsubscribe = documents.subscribe(() => { if (!stillActive()) controller.abort('view'); });
        const modelChanged = model.onDidChangeContent(() => controller.abort('edit'));
        const editorChanged = instance.onDidChangeModel(() => controller.abort('view'));
        const id = crypto.randomUUID();
        let sent = false;
        const cancel = () => { if (sent) void window.ion.formatting.cancel(id).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        activeFormat.current = controller;
        const release = await documents.holdAutosaveForFormat(tabId);
        try {
          if (signal.aborted || !stillActive()) return cancelled();
          const savedRevision = documents.savedRevision(tabId);
          const options = model.getOptions();
          sent = true;
          const result = await window.ion.formatting.run({
            id, name: initial.name, path: initial.path, revision: savedRevision, text: model.getValue(),
            eol: model.getEOL() === '\r\n' ? '\r\n' : '\n', tabSize: options.tabSize, insertSpaces: options.insertSpaces,
          });
          if (signal.aborted || !stillActive() || model.getVersionId() !== version
            || documents.savedRevision(tabId) !== savedRevision) return cancelled();
          if (result.kind === 'conflict' && initial.path) documents.markConflict(tabId, initial.path);
          if (result.kind !== 'formatted') return result;
          modelChanged.dispose();
          const selections = instance.getSelections() ?? [];
          const scroll = { scrollTop: instance.getScrollTop(), scrollLeft: instance.getScrollLeft() };
          instance.pushUndoStop();
          const applied = instance.executeEdits('ion-format-document', [{ range: model.getFullModelRange(), text: result.text }],
            () => selections.map((selection) => Selection.fromPositions(
              model.validatePosition(selection.getSelectionStart()), model.validatePosition(selection.getPosition()),
            )));
          instance.pushUndoStop();
          instance.setScrollPosition(scroll);
          if (applied && model.getVersionId() === version + 1) {
            const buffer = (model as editor.ITextModel & {
              getTextBuffer?(): { ionCompactFormattedText?(text: string): void };
            }).getTextBuffer?.();
            buffer?.ionCompactFormattedText?.(result.text);
          }
          return applied ? result : editorUnavailable;
        } finally {
          release();
          unsubscribe();
          modelChanged.dispose();
          editorChanged.dispose();
          signal.removeEventListener('abort', cancel);
          if (activeFormat.current === controller) activeFormat.current = null;
        }
      },
    });

    return () => {
      activeFormat.current?.abort('view');
      onActions(null);
      opener.dispose();
      cursorListener.dispose();
      scrollListener.dispose();
      displayed.current = null;
      instance.setModel(null);
      for (const [id, cached] of models) releaseModel(documents, id, cached);
      models.clear();
      documents.attachModels(null);
      instance.dispose();
      editorRef.current = null;
    };
  }, [documents, onActions, onCursor]);

  useEffect(() => clearEditorTheme, []);

  const { fontSize, lineNumbers, wordWrap, tabSize } = settings;
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      wordWrap: wordWrap ? 'on' : 'off',
      lineNumbers: lineNumbers ? 'on' : 'off',
    });
  }, [fontSize, lineNumbers, wordWrap]);
  useEffect(() => {
    tabSizeRef.current = tabSize;
    for (const { model } of cache.current.values()) model.updateOptions({ tabSize });
  }, [tabSize]);

  const id = tab?.id ?? null;
  const epoch = tab?.epoch ?? 0;
  const capability = fileLanguage(tab?.name ?? '');
  const language = capability.syntax ?? 'plaintext';
  const java = capability.id === 'java' && !sourceHidden;
  const semantic = !sourceHidden && settings.smartLanguages.includes(capability.id) ? capability.semantic : undefined;
  const smart = java && Boolean(semantic);
  const automaticSuggestions = java && settings.automaticSuggestions;
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    const models = cache.current;
    const oldId = displayed.current;
    if (oldId && oldId !== id) {
      const previous = models.get(oldId);
      if (previous && instance.getModel() === previous.model) {
        previous.view = instance.saveViewState() ?? undefined;
      }
    }
    displayed.current = null;
    if (!id) {
      instance.setModel(null);
      setLoaded(null);
      return;
    }
    const tabId = id;
    let cancelled = false;

    async function show() {
      if (!instance) return;
      let cached = models.get(tabId);
      if (!cached) {
        instance.setModel(null);
        setLoaded(null);
        let value: string;
        try {
          value = await documents.loadText(tabId);
        } catch {
          return;
        }
        if (cancelled || !documents.getSnapshot().tabs.some((entry) => entry.id === tabId && entry.epoch === epoch)) return;
        // Monaco retains bounded edit deltas for file-model URIs and restores
        // them only when the recreated buffer matches. This URI is a tab key.
        const uri = Uri.file(`/ion/editor/${tabId}/${epoch}`);
        const model = editor.createModel(value, language, uri);
        model.updateOptions({ tabSize: tabSizeRef.current, insertSpaces: true });
        cached = { model, listener: model.onDidChangeContent(() => documents.changed(tabId)) };
        models.set(tabId, cached);
        documents.modelReady(tabId);
      } else {
        if (cached.model.getLanguageId() !== language) editor.setModelLanguage(cached.model, language);
        models.delete(tabId);
        models.set(tabId, cached);
      }
      if (instance.getModel() !== cached.model) {
        instance.setModel(cached.model);
        if (cached.view) {
          instance.restoreViewState(cached.view);
          cached.view = undefined;
        } else {
          const previousView = documents.getEditorView(tabId);
          if (previousView) {
            instance.setSelections(previousView.selections);
            instance.setScrollPosition(previousView);
          }
        }
      }
      const cursor = documents.takeInitialCursor(tabId);
      if (cursor) revealLocation(instance, cached.model, cursor.line, cursor.column);
      displayed.current = tabId;
      if (!sourceHiddenRef.current) rememberView(documents, tabId, instance);
      while (models.size > MODEL_LIMIT) {
        const first = models.entries().next().value;
        if (!first) break;
        const [old, item] = first;
        releaseModel(documents, old, item);
        models.delete(old);
      }
      const position = instance.getPosition();
      if (position) onCursor(position.lineNumber, position.column);
      if (!sourceHiddenRef.current) instance.focus();
      setLoaded(tabId);
    }

    void show();
    return () => { cancelled = true; };
  }, [documents, id, language, epoch, onCursor]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      quickSuggestions: automaticSuggestions ? { other: 'on', comments: 'off', strings: 'off' } : false,
      suggestOnTriggerCharacters: automaticSuggestions,
      parameterHints: { enabled: Boolean(smart) },
      renderValidationDecorations: smart ? 'on' : 'off',
      lightbulb: { enabled: editor.ShowLightbulbIconMode.Off },
    });
  }, [automaticSuggestions, smart]);

  const path = tab?.path;
  useEffect(() => {
    const instance = editorRef.current;
    const model = instance?.getModel();
    if ((!java && !semantic) || !id || loaded !== id || !instance || !model || displayed.current !== id) return;
    let cancelled = false;
    let tools: { dispose(): void } | undefined;
    const attach = async () => {
      if (java) {
        const { attachJavaTools } = await import('./java/editor-tools');
        if (cancelled || instance.getModel() !== model) return;
        tools = attachJavaTools(instance, model, {
          smart, path: path ?? undefined, onReport: onLanguageReport, onStatus: setLanguageStatus,
        });
      } else if (semantic?.adapter === 'clangd' && path) {
        const { attachSourceNavigation } = await import('./language-editor-tools');
        if (cancelled || instance.getModel() !== model) return;
        tools = attachSourceNavigation(instance, model, {
          language: capability.id, label: 'Smart C/C++', path, onStatus: setLanguageStatus,
        });
      }
    };
    void attach().catch(() => { if (!cancelled) setLanguageStatus('Language tools could not be loaded.'); });
    return () => {
      cancelled = true;
      tools?.dispose();
      setLanguageStatus(null);
    };
  }, [java, id, loaded, epoch, path, workspacePath, semantic, smart, capability.id, onLanguageReport]);

  useLayoutEffect(() => {
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model || loaded !== id || sourceHidden || !problemMarkers?.length) return;
    const decorations = instance.createDecorationsCollection(problemMarkers
      .filter(({ line }) => line <= model.getLineCount())
      .map(({ line, lens, selected }) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          isWholeLine: true,
          className: (lens ? 'ion-lens-line' : 'ion-problem-line') + (selected ? ' ion-problem-selected' : ''),
          linesDecorationsClassName: lens ? 'ion-lens-gutter' : 'ion-problem-gutter',
        },
      })));
    return () => { decorations.clear(); };
  }, [id, loaded, problemMarkers, sourceHidden]);

  const retry = () => { if (tab) void documents.reload(tab.id); };
  return (
    <div className={`editor-surface${tab ? "" : " editor-parked"}`} data-testid="editor"
      data-smart-java={smart || undefined} aria-hidden={!tab || undefined}>
      <div className="monaco-host" ref={host}/>
      {java && languageStatus && <div className="java-tool-status" role="status">{languageStatus}</div>}
      {tab && loaded !== tab.id && (
        <div className="editor-loading" role={tab.error ? 'alert' : 'status'}>
          {tab.error
            ? <><p>{tab.error}</p><button className="button" onClick={retry}>Retry</button></>
            : 'Opening file…'}
        </div>
      )}
    </div>
  );
}
