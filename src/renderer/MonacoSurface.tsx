import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
import type { LiveToolReport } from './language-editor-tools';
import { fileLanguage } from '../shared/languages';
import type { LanguageEditPreview, SourceReference } from '../shared/language-tools';
import { sourcePathFromUri } from '../shared/source-path';
import { applyEditorTheme, clearEditorTheme } from './themes/editor-theme';
import { MonacoModelPool } from './monaco-model-pool';

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
  focusSecondary(): void;
  lineCount(): number;
  goToDefinition(): void;
  multiCursor(action: 'above' | 'below' | 'next' | 'all'): void;
  findReferences(): Promise<SourceReference[]>;
  renameTarget(): string | undefined;
  reviewRename(replacement: string): Promise<LanguageEditPreview | undefined>;
  position(tabId: string): { line: number; column: number } | undefined;
  goToLine(line: number, column?: number, tabId?: string): boolean;
  captureView(): (() => void) | undefined;
  insertStarter(starter: { text: string; line: number; column: number }): boolean;
  format(tabId: string, controller: AbortController): Promise<FormatResult>;
  toggleBreakpoint(): void;
}

interface Props {
  documents: Documents;
  tab: Tab | undefined;
  settings: Settings;
  copilotActive?: boolean;
  activeTheme: ThemeData | null;
  accentColor?: string;
  sourceHidden?: boolean;
  split?: boolean;
  splitPercent?: number;
  onSplitPercent?(percent: number): void;
  workspacePath?: string;
  problemMarkers?: readonly ProblemMarker[];
  debugEnabled?: boolean;
  breakpointLines?: readonly number[];
  debugStoppedLine?: number;
  onToggleBreakpoint?(path: string, line: number): void;
  onActions(actions: EditorActions | null): void;
  onFocus?(): void;
  onCursor(line: number, column: number): void;
  onLanguageReport(report: LiveToolReport | null): void;
  onNavigateSource(path: string, line: number, column: number): void;
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

const modelPools = new WeakMap<Documents, MonacoModelPool>();
function modelPoolFor(documents: Documents, tabSize: number) {
  let pool = modelPools.get(documents);
  if (!pool) {
    pool = new MonacoModelPool(documents, tabSize);
    modelPools.set(documents, pool);
  }
  return pool;
}

export default function MonacoSurface({
  documents, tab, settings, copilotActive = false, activeTheme, accentColor, sourceHidden, workspacePath, problemMarkers,
  debugEnabled = false, breakpointLines, debugStoppedLine, onToggleBreakpoint,
  split = false, splitPercent = 50, onSplitPercent, onActions, onFocus, onCursor, onLanguageReport, onNavigateSource,
}: Props) {
  const modelPool = modelPoolFor(documents, settings.tabSize);
  const ownerKey = useRef(crypto.randomUUID()).current;
  const host = useRef<HTMLDivElement>(null);
  const secondaryHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor>(null);
  const secondaryRef = useRef<editor.IStandaloneCodeEditor>(null);
  const commandEditor = useRef<editor.IStandaloneCodeEditor>(null);
  const secondaryViews = useRef(new Map<string, editor.ICodeEditorViewState>());
  const localViews = useRef(new Map<string, editor.ICodeEditorViewState>());
  const displayed = useRef<string | null>(null);
  const initialSettings = useRef(settings);
  const sourceHiddenRef = useRef(sourceHidden);
  const copilotActiveRef = useRef(copilotActive);
  const copilotTabRef = useRef(tab);
  const activeFormat = useRef<AbortController | null>(null);
  sourceHiddenRef.current = sourceHidden;
  copilotActiveRef.current = copilotActive;
  copilotTabRef.current = tab;
  useEffect(() => {
    if (sourceHidden) activeFormat.current?.abort('view');
  }, [sourceHidden]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const id = tab?.id ?? null;
  const [languageStatus, setLanguageStatus] = useState<string | null>(null);
  const navigateSource = useRef(onNavigateSource);
  navigateSource.current = onNavigateSource;
  const focusRequest = useRef(onFocus);
  focusRequest.current = onFocus;
  const cursorRequest = useRef(onCursor);
  cursorRequest.current = onCursor;
  const toggleBreakpointRequest = useRef(onToggleBreakpoint);
  toggleBreakpointRequest.current = onToggleBreakpoint;

  useLayoutEffect(() => {
    if (activeTheme) applyEditorTheme(activeTheme, accentColor);
    else editor.setTheme('vs-dark');
  }, [activeTheme, accentColor]);

  useEffect(() => {
    if (!host.current) return;
    const instance = editor.create(host.current, {
      model: null,
      automaticLayout: true,
      ariaLabel: 'Code editor',
      accessibilitySupport: 'auto',
      contextmenu: true,
      minimap: { enabled: false },
      glyphMargin: debugEnabled,
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
    instance.updateOptions({ inlineSuggest: { enabled: copilotActiveRef.current } });
    type IonInlineCompletion = languages.InlineCompletion & { copilotId: string };
    const copilotProvider: languages.InlineCompletionsProvider<languages.InlineCompletions<IonInlineCompletion>> = {
      async provideInlineCompletions(model, position, context, token) {
        const currentTab = copilotTabRef.current;
        if (!copilotActiveRef.current || sourceHiddenRef.current || instance.getModel() !== model || !instance.hasTextFocus()
          || !currentTab?.path || currentTab.viewer || currentTab.notebookMode || model.isDisposed()) return { items: [] };
        const requestId = crypto.randomUUID();
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => {
          controller.abort(); void window.ion.copilot.cancelCompletion(requestId).catch(() => {})
        });
        try {
          const result = await window.ion.copilot.complete(requestId, { uri: Uri.file(currentTab.path).toString(), languageId: model.getLanguageId(),
            version: model.getVersionId(), text: model.getValue() }, { line: position.lineNumber - 1, character: position.column - 1 },
          context.triggerKind === languages.InlineCompletionTriggerKind.Explicit ? 2 : 1);
          if (controller.signal.aborted || token.isCancellationRequested || instance.getModel() !== model
            || model.isDisposed() || model.getVersionId() !== result[0]?.version) return { items: [] };
          return { items: result.map(completion => ({
            copilotId: completion.id,
            insertText: completion.text,
            range: { startLineNumber: completion.range.start.line + 1, startColumn: completion.range.start.character + 1,
              endLineNumber: completion.range.end.line + 1, endColumn: completion.range.end.character + 1 },
          })) };
        } catch { return { items: [] } } finally { cancellation.dispose() }
      },
      handleItemDidShow(_completions, item) { void window.ion.copilot.shown(item.copilotId).catch(() => {}) },
      handlePartialAccept(_completions, item, acceptedCharacters) {
        void window.ion.copilot.partiallyAccepted(item.copilotId, acceptedCharacters).catch(() => {})
      },
      handleEndOfLifetime(_completions, item, reason) {
        if (reason.kind === languages.InlineCompletionEndOfLifeReasonKind.Accepted) void window.ion.copilot.accepted(item.copilotId).catch(() => {})
      },
      disposeInlineCompletions() {},
    };
    const copilotRegistration = languages.registerInlineCompletionsProvider('*', copilotProvider);
    commandEditor.current = instance;
    const focusListener = instance.onDidFocusEditorWidget(() => { commandEditor.current = instance; focusRequest.current?.(); });
    const gutterListener = instance.onMouseDown((event) => {
      if (!debugEnabled || event.target.type !== editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
      const selected = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
      if (selected?.path) toggleBreakpointRequest.current?.(selected.path, event.target.position.lineNumber);
    });
    const rememberActiveView = () => {
      const id = displayed.current;
      if (id && !sourceHiddenRef.current) rememberView(documents, id, instance);
    };
    const cursorListener = instance.onDidChangeCursorSelection(({ selection }) => {
      cursorRequest.current(selection.positionLineNumber, selection.positionColumn);
      rememberActiveView();
    });
    const scrollListener = instance.onDidScrollChange(({ scrollTopChanged, scrollLeftChanged }) => {
      if (scrollTopChanged || scrollLeftChanged) rememberActiveView();
    });
    const unregister = modelPool.register((id) => {
      if (displayed.current !== id || instance.getModel() !== modelPool.get(id)) return;
      displayed.current = null;
      instance.setModel(null);
    });
    const opener = editor.registerEditorOpener({
      openCodeEditor(source, resource, location) {
        if (source !== instance || resource.scheme !== 'file') return false;
        const tab = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        const path = resource.toString() === instance.getModel()?.uri.toString() ? tab?.path
          : sourcePathFromUri(resource, window.ion.platform);
        if (!path) return false;
        const line = location ? ('lineNumber' in location ? location.lineNumber : location.startLineNumber) : 1;
        const column = location ? ('column' in location ? location.column : location.startColumn) : 1;
        navigateSource.current(path, line, column);
        return true;
      },
    });
    onActions({
      find(replace = false) {
        const target = commandEditor.current ?? instance;
        if (!target.getModel()) return;
        target.focus();
        void target.getAction(replace ? 'editor.action.startFindReplaceAction' : 'actions.find')?.run();
      },
      focus: () => instance.focus(),
      focusSecondary: () => secondaryRef.current?.focus(),
      lineCount: () => instance.getModel()?.getLineCount() ?? 0,
      goToDefinition() {
        if (!instance.getModel() || sourceHiddenRef.current) return;
        instance.focus();
        void instance.getAction('editor.action.revealDefinition')?.run();
      },
      multiCursor(action) {
        const target = commandEditor.current ?? instance;
        const model = target.getModel();
        if (!model || sourceHiddenRef.current) return;
        const id = {
          above: 'editor.action.insertCursorAbove', below: 'editor.action.insertCursorBelow',
          next: 'editor.action.addSelectionToNextFindMatch', all: 'editor.action.selectHighlights',
        }[action];
        target.focus();
        void import('monaco-editor/editor/contrib/multicursor/browser/multicursor.js').then(() => {
          if (target.getModel() === model && !model.isDisposed() && !sourceHiddenRef.current) {
            target.trigger('ion-multi-cursor', id, undefined);
          }
        });
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
      renameTarget() {
        const model = instance.getModel();
        const position = instance.getPosition();
        const tab = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        if (!model || !position || !tab?.path || tab.dirty || tab.conflict || sourceHiddenRef.current) return;
        const language = fileLanguage(tab.name);
        if (!language.semantic?.operations.includes('rename')) return;
        return model.getWordAtPosition(position)?.word;
      },
      async reviewRename(replacement) {
        const model = instance.getModel();
        const position = instance.getPosition();
        const tab = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        if (!model || !position || !tab?.path || sourceHiddenRef.current) return;
        const language = fileLanguage(tab.name);
        if (!language.semantic?.operations.includes('rename')) return;
        const text = model.getValue();
        const dirtyPaths = documents.getSnapshot().tabs.flatMap(entry => entry.path && (entry.dirty || entry.conflict) ? [entry.path] : []);
        return window.ion.languageTools.reviewRename({
          requestId: crypto.randomUUID(), language: language.id, path: tab.path, operation: 'rename',
          version: model.getVersionId(), text, offset: model.getOffsetAt(position), replacement,
        }, replacement, dirtyPaths);
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
        if (!id || !model || modelPool.get(id) !== model || sourceHiddenRef.current
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
      toggleBreakpoint() {
        const target = commandEditor.current ?? instance;
        const selected = documents.getSnapshot().tabs.find(({ id }) => id === displayed.current);
        const line = target.getPosition()?.lineNumber;
        if (selected?.path && line && !sourceHiddenRef.current) toggleBreakpointRequest.current?.(selected.path, line);
      },
    });

    return () => {
      activeFormat.current?.abort('view');
      onActions(null);
      copilotRegistration.dispose();
      opener.dispose();
      cursorListener.dispose();
      scrollListener.dispose();
      focusListener.dispose();
      gutterListener.dispose();
      unregister();
      if (displayed.current) modelPool.release(displayed.current, ownerKey);
      displayed.current = null;
      instance.setModel(null);
      instance.dispose();
      editorRef.current = null;
      commandEditor.current = null;
    };
  }, [debugEnabled, documents, modelPool, onActions, ownerKey]);

  useEffect(() => clearEditorTheme, []);
  useEffect(() => { editorRef.current?.updateOptions({ inlineSuggest: { enabled: copilotActive } }) }, [copilotActive]);
  useLayoutEffect(() => {
    void window.ion.copilot.closeDocument().catch(() => {});
  }, [copilotActive, sourceHidden, tab?.id, tab?.path]);

  const { fontSize, lineNumbers, wordWrap, tabSize } = settings;
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      wordWrap: wordWrap ? 'on' : 'off',
      lineNumbers: lineNumbers ? 'on' : 'off',
      glyphMargin: debugEnabled,
    });
    secondaryRef.current?.updateOptions({ glyphMargin: debugEnabled });
  }, [debugEnabled, fontSize, lineNumbers, wordWrap]);

  useEffect(() => {
    const primary = editorRef.current;
    const model = primary?.getModel();
    const element = secondaryHost.current;
    if (!split || !primary || !model || !element || !id || loaded !== id) return;
    const secondary = editor.create(element, {
      model, automaticLayout: true, ariaLabel: 'Second code editor', accessibilitySupport: 'auto',
      contextmenu: true, minimap: { enabled: false }, disableLayerHinting: true,
      guides: { bracketPairs: false }, renderLineHighlight: 'line', scrollBeyondLastLine: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }, padding: { top: 14, bottom: 14 },
      fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', fontLigatures: false, fontSize,
      lineNumbers: lineNumbers ? 'on' : 'off', wordWrap: wordWrap ? 'on' : 'off',
      renderValidationDecorations: 'off', quickSuggestions: false, suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off', inlineSuggest: { enabled: false }, codeLens: false,
      stickyScroll: { enabled: false }, links: false, tabCompletion: 'off', overviewRulerLanes: 0,
      occurrencesHighlight: 'off', smoothScrolling: false, cursorBlinking: 'solid', cursorSmoothCaretAnimation: 'off',
    });
    secondaryRef.current = secondary;
    const view = secondaryViews.current.get(id);
    if (view) secondary.restoreViewState(view);
    else secondary.setScrollTop(primary.getScrollTop());
    const cursor = secondary.onDidChangeCursorSelection(({ selection }) => {
      cursorRequest.current(selection.positionLineNumber, selection.positionColumn);
    });
    const focus = secondary.onDidFocusEditorWidget(() => { commandEditor.current = secondary; });
    return () => {
      const saved = secondary.saveViewState();
      if (saved) secondaryViews.current.set(id, saved);
      cursor.dispose();
      focus.dispose();
      if (commandEditor.current === secondary) commandEditor.current = primary;
      secondary.setModel(null);
      secondary.dispose();
      if (secondaryRef.current === secondary) secondaryRef.current = null;
    };
  }, [split, id, loaded, fontSize, lineNumbers, wordWrap]);
  useEffect(() => {
    modelPool.updateTabSize(tabSize);
  }, [modelPool, tabSize]);

  const epoch = tab?.epoch ?? 0;
  const capability = fileLanguage(tab?.name ?? '');
  const language = capability.syntax ?? 'plaintext';
  const java = capability.id === 'java' && !sourceHidden;
  const semantic = !sourceHidden && settings.smartLanguages.includes(capability.id) ? capability.semantic : undefined;
  const smart = java && Boolean(semantic);
  const semanticEnabled = Boolean(semantic);
  const automaticSuggestions = (java || semanticEnabled) && settings.automaticSuggestions;
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    const oldId = displayed.current;
    if (oldId && oldId !== id) {
      const view = instance.saveViewState();
      if (view) localViews.current.set(oldId, view);
      modelPool.release(oldId, ownerKey);
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
      instance.setModel(null);
      setLoaded(null);
      const selected = documents.getSnapshot().tabs.find((entry) => entry.id === tabId && entry.epoch === epoch);
      if (!selected) return;
      const model = await modelPool.acquire(selected, language, ownerKey);
      if (!model || cancelled || !documents.getSnapshot().tabs.some((entry) => entry.id === tabId && entry.epoch === epoch)) {
        if (model) modelPool.release(tabId, ownerKey);
        return;
      }
      if (instance.getModel() !== model) {
        instance.setModel(model);
        const localView = localViews.current.get(tabId);
        if (localView) {
          instance.restoreViewState(localView);
        } else {
          const previousView = documents.getEditorView(tabId);
          if (previousView) {
            instance.setSelections(previousView.selections);
            instance.setScrollPosition(previousView);
          }
        }
      }
      const cursor = documents.takeInitialCursor(tabId);
      if (cursor) revealLocation(instance, model, cursor.line, cursor.column);
      displayed.current = tabId;
      if (!sourceHiddenRef.current) rememberView(documents, tabId, instance);
      const position = instance.getPosition();
      if (position) cursorRequest.current(position.lineNumber, position.column);
      if (!sourceHiddenRef.current) instance.focus();
      setLoaded(tabId);
    }

    void show();
    return () => { cancelled = true; };
  }, [documents, id, language, epoch, modelPool, ownerKey]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      quickSuggestions: automaticSuggestions ? { other: 'on', comments: 'off', strings: 'off' } : false,
      suggestOnTriggerCharacters: automaticSuggestions,
      parameterHints: { enabled: semanticEnabled },
      renderValidationDecorations: semanticEnabled ? 'on' : 'off',
      lightbulb: { enabled: editor.ShowLightbulbIconMode.Off },
    });
  }, [automaticSuggestions, semanticEnabled]);

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
      } else if (semantic && path) {
        const { attachLspTools } = await import('./language-editor-tools');
        if (cancelled || instance.getModel() !== model) return;
        tools = attachLspTools(instance, model, {
          language: capability.id, label: semantic.adapter === 'clangd' ? 'Smart C/C++' : `Smart ${capability.label}`, path,
          diagnostics: semantic.operations.includes('diagnostics'), complete: semantic.operations.includes('complete'),
          signature: semantic.operations.includes('signature'), hover: semantic.operations.includes('hover'),
          declaration: semantic.operations.includes('declaration'), documentSymbols: semantic.operations.includes('documentSymbols'),
          workspaceSymbols: semantic.operations.includes('workspaceSymbols'),
          onReport: onLanguageReport, onStatus: setLanguageStatus,
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

  useLayoutEffect(() => {
    const primary = editorRef.current;
    const model = primary?.getModel();
    if (!debugEnabled || !primary || !model || loaded !== id || sourceHidden) return;
    const items: editor.IModelDeltaDecoration[] = [];
    for (const line of breakpointLines ?? []) {
      if (!Number.isInteger(line) || line < 1 || line > model.getLineCount()) continue;
      items.push({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { glyphMarginClassName: 'ion-debug-breakpoint-glyph', glyphMarginHoverMessage: { value: 'Breakpoint' } },
      });
    }
    if (debugStoppedLine && debugStoppedLine <= model.getLineCount()) {
      items.push({
        range: { startLineNumber: debugStoppedLine, startColumn: 1, endLineNumber: debugStoppedLine, endColumn: 1 },
        options: { isWholeLine: true, className: 'ion-debug-stopped-line', glyphMarginClassName: 'ion-debug-stopped-glyph' },
      });
    }
    const primaryDecorations = primary.createDecorationsCollection(items);
    const secondaryDecorations = secondaryRef.current?.createDecorationsCollection(items);
    return () => { primaryDecorations.clear(); secondaryDecorations?.clear(); };
  }, [breakpointLines, debugEnabled, debugStoppedLine, id, loaded, sourceHidden, split]);

  const retry = () => { if (tab) void documents.reload(tab.id); };
  return (
    <div className={`editor-surface${tab ? "" : " editor-parked"}${split ? ' source-editor-split' : ''}`} data-testid="editor"
      data-source-split={split || undefined} style={split ? { '--source-split': `${splitPercent}%` } as CSSProperties : undefined}
      data-smart-java={smart || undefined} aria-hidden={!tab || undefined}>
      <div className="monaco-host primary-monaco-host" ref={host}/>
      {split && <><div className="source-splitter" role="separator" tabIndex={0} aria-orientation="vertical"
        aria-label="Resize code editor split" aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitPercent}
        onPointerDown={(event) => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
          if (bounds?.width) onSplitPercent?.(Math.max(25, Math.min(75, Math.round(100 * (event.clientX - bounds.left) / bounds.width))));
        }} onKeyDown={(event) => {
          const delta = event.key === 'ArrowLeft' ? -3 : event.key === 'ArrowRight' ? 3 : 0;
          if (delta) { event.preventDefault(); onSplitPercent?.(Math.max(25, Math.min(75, splitPercent + delta))); }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); onSplitPercent?.(event.key === 'Home' ? 25 : 75); }
        }}/><div className="secondary-monaco-host" ref={secondaryHost}/></>}
      {semanticEnabled && languageStatus && <div className="java-tool-status" role="status">{languageStatus}</div>}
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
