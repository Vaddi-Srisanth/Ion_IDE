import { editor, languages, MarkerSeverity, Range, Uri, type CancellationToken, type Position } from 'monaco-editor/editor/editor.api.js';
import { toolTextLimit, type SourceReference, type ToolOperation } from '../shared/language-tools';
import { errorMessage } from './documents';
import type { ProblemRow } from './Problems';

const encoder = new TextEncoder();
const modelAttachments = new WeakMap<editor.ITextModel, number>();
type Query = (operation: ToolOperation, position?: Position, cancellation?: CancellationToken, search?: string) => Promise<string[][] | undefined>;

function attachModel(model: editor.ITextModel) {
  modelAttachments.set(model, (modelAttachments.get(model) ?? 0) + 1);
  let attached = true;
  return () => {
    if (!attached) return false;
    attached = false;
    const remaining = Math.max(0, (modelAttachments.get(model) ?? 1) - 1);
    if (remaining) modelAttachments.set(model, remaining);
    else modelAttachments.delete(model);
    return remaining === 0;
  };
}

export function createToolQuery(model: editor.ITextModel, current: () => boolean, options: {
  language: string; label: string; path?: string; onStatus(status: string | null): void;
}): Query {
  const { language, label, path, onStatus } = options;
  return async (operation, position, cancellation, search) => {
    if (!path || !current() || cancellation?.isCancellationRequested) return;
    const overLimit = () => { onStatus(`${label} is limited to files up to 256 KiB.`); return undefined; };
    if (model.getValueLength() > toolTextLimit) return overLimit();
    const version = model.getVersionId();
    const valid = () => current() && !cancellation?.isCancellationRequested && model.getVersionId() === version;
    const requestId = crypto.randomUUID();
    const subscription = cancellation?.onCancellationRequested(() => { void window.ion.languageTools.cancel(requestId).catch(() => {}); });
    try {
      const text = model.getValue();
      if (encoder.encode(text).length > toolTextLimit) return overLimit();
      const result = await window.ion.languageTools.query({
        requestId, language, path, operation, version, text, offset: position ? model.getOffsetAt(position) : 0,
        ...(search !== undefined ? { search } : {}),
      });
      if (!valid() || result?.version !== version) return;
      onStatus(null);
      return result.rows;
    } catch (error) {
      if (valid()) onStatus(errorMessage(error));
    } finally { subscription?.dispose(); }
  };
}

export function sourceReferences(rows: string[][]): SourceReference[] {
  const seen = new Set<string>();
  return rows.flatMap(([path, line, column]) => {
    const row = Number(line);
    const col = Number(column);
    if (!path || !Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(col) || col < 1) return [];
    const key = JSON.stringify([path, row, col]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ path, line: row, column: col }];
  });
}

export function sourceNavigationProviders(model: editor.ITextModel, path: string, query: Query, declaration = false) {
  const locations = async (operation: 'definition' | 'declaration' | 'references', position: Position, cancellation: CancellationToken) =>
    sourceReferences(await query(operation, position, cancellation) ?? []).map(({ path: file, line, column }) => ({
      uri: file === path ? model.uri : Uri.file(file), range: new Range(line, column, line, column + 1),
    }));
  const language = model.getLanguageId();
  const handles = [
    languages.registerDefinitionProvider(language, {
      provideDefinition: (item, position, token) => item === model
        ? locations('definition', position, token) : [],
    }),
    languages.registerReferenceProvider(language, {
      provideReferences: (item, position, _context, token) => item === model
        ? locations('references', position, token) : [],
    }),
  ];
  if (declaration) handles.push(languages.registerDeclarationProvider(language, {
    provideDeclaration: (item, position, token) => item === model
      ? locations('declaration', position, token) : [],
  }));
  return handles;
}

export function attachSourceNavigation(instance: editor.IStandaloneCodeEditor, model: editor.ITextModel, options: {
  language: string; label: string; path: string; onStatus(status: string | null): void;
}) {
  let active = true;
  const current = () => active && !model.isDisposed() && instance.getModel() === model;
  const handles = sourceNavigationProviders(model, options.path, createToolQuery(model, current, options));
  return {
    dispose() {
      active = false;
      handles.forEach((handle) => handle.dispose());
      void window.ion.languageTools.release(false, options.language).catch(() => {});
    },
  };
}

export interface LiveToolReport {
  path: string;
  rows: ProblemRow[];
}

const completionKinds: Record<number, languages.CompletionItemKind> = {
  2: languages.CompletionItemKind.Method, 3: languages.CompletionItemKind.Function,
  4: languages.CompletionItemKind.Constructor, 5: languages.CompletionItemKind.Field,
  6: languages.CompletionItemKind.Variable, 7: languages.CompletionItemKind.Class,
  8: languages.CompletionItemKind.Interface, 9: languages.CompletionItemKind.Module,
  10: languages.CompletionItemKind.Property, 13: languages.CompletionItemKind.Enum,
  14: languages.CompletionItemKind.Keyword, 15: languages.CompletionItemKind.Snippet,
  21: languages.CompletionItemKind.Constant, 22: languages.CompletionItemKind.Struct,
};

export function attachLspTools(instance: editor.IStandaloneCodeEditor, model: editor.ITextModel, options: {
  language: string; label: string; path: string; diagnostics: boolean; complete: boolean; signature: boolean; hover: boolean;
  declaration?: boolean; documentSymbols?: boolean; workspaceSymbols?: boolean;
  onReport(report: LiveToolReport | null): void; onStatus(status: string | null): void;
}) {
  const detachModel = attachModel(model);
  let active = true;
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  const owner = `ion-lsp-${options.language}`;
  const current = () => active && !model.isDisposed() && instance.getModel() === model;
  const query = createToolQuery(model, current, options);
  const handles = sourceNavigationProviders(model, options.path, query, options.declaration);

  if (options.documentSymbols) handles.push(languages.registerDocumentSymbolProvider(model.getLanguageId(), {
    async provideDocumentSymbols(item, token) {
      if (item !== model) return [];
      const rows = await query('documentSymbols', undefined, token);
      return (rows ?? []).flatMap(([name, kind, detail, path, line, column]) => {
        const row = Number(line), col = Number(column);
        if (!name || path !== options.path || !Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(col) || col < 1) return [];
        const range = new Range(row, col, row, col + 1);
        return [{ name, detail, kind: Math.max(0, Number(kind) - 1) as languages.SymbolKind, tags: [], range, selectionRange: range }];
      });
    },
  }));

  if (options.complete) handles.push(languages.registerCompletionItemProvider(model.getLanguageId(), {
    triggerCharacters: ['.', ':'],
    async provideCompletionItems(item, position, _context, token) {
      if (item !== model) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new Range(position.lineNumber, word.startColumn, position.lineNumber,
        model.getWordAtPosition(position)?.endColumn ?? position.column);
      const rows = await query('complete', position, token);
      return { suggestions: (rows ?? []).flatMap(([label, kind, detail, insertText]) => label ? [{
        label, kind: completionKinds[Number(kind)] ?? languages.CompletionItemKind.Text,
        detail, insertText: insertText || label, range,
      }] : []) };
    },
  }));

  if (options.signature) handles.push(languages.registerSignatureHelpProvider(model.getLanguageId(), {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(item, position, token) {
      if (item !== model) return null;
      const rows = await query('signature', position, token);
      if (!rows?.length) return null;
      return { value: { activeSignature: 0, activeParameter: Number(rows[0][0]) || 0,
        signatures: rows.map(([, label, ...parameters]) => ({ label, parameters: parameters.map(label => ({ label })) })) }, dispose() {} };
    },
  }));

  if (options.hover) handles.push(languages.registerHoverProvider(model.getLanguageId(), {
    async provideHover(item, position, token) {
      if (item !== model) return null;
      const rows = await query('hover', position, token);
      return rows?.[0]?.[1] ? { contents: [{ value: rows[0][1] }] } : null;
    },
  }));

  function diagnostics() {
    clearTimeout(diagnosticTimer);
    if (!options.diagnostics) return;
    diagnosticTimer = setTimeout(async () => {
      const rows = await query('diagnostics');
      if (!rows || !current()) return;
      const markers: editor.IMarkerData[] = [];
      const problems: ProblemRow[] = [];
      for (const [level, start, end, message, source] of rows) {
        const offset = Number(start), finish = Number(end);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > model.getValueLength() || !message) continue;
        const from = model.getPositionAt(offset);
        const to = model.getPositionAt(Number.isSafeInteger(finish) && finish > offset ? finish : offset + 1);
        const severity = level === 'error' ? MarkerSeverity.Error : level === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Info;
        markers.push({ startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber,
          endColumn: to.column, severity, message, source: `${source || options.label} · ${level}` });
        problems.push({ problem: { raw: message, severity: level === 'error' || level === 'warning' ? level : 'note',
          location: { file: options.path, line: from.lineNumber, column: from.column } }, canReveal: true });
      }
      editor.setModelMarkers(model, owner, markers);
      options.onReport({ path: options.path, rows: problems });
    }, 400);
  }
  if (options.diagnostics) {
    handles.push(model.onDidChangeContent(diagnostics));
  }

  return {
    dispose() {
      active = false;
      clearTimeout(diagnosticTimer);
      handles.forEach(handle => handle.dispose());
      if (!model.isDisposed()) editor.setModelMarkers(model, owner, []);
      options.onReport(null);
      options.onStatus(null);
      if (detachModel()) void window.ion.languageTools.release(false, options.language, options.path).catch(() => {});
    },
  };
}
