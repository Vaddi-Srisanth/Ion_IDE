import { editor, languages, MarkerSeverity, Range, Uri, type IDisposable, type Position } from 'monaco-editor/editor/editor.api.js';
import { toolTextLimit, type ToolOperation } from '../../shared/language-tools';
import type { ProblemRow } from '../Problems';

const owner = 'ion-java-live';
const encoder = new TextEncoder();
const keywords = 'abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public record return sealed short static super switch synchronized this throw throws try var void volatile while yield'.split(' ');
const snippetRows = [
  ['sout', 'Print a line', 'System.out.println(${1});'],
  ['psvm', 'Main method', 'public static void main(String[] args) {\n\t$0\n}'],
  ['main', 'Main method', 'public static void main(String[] args) {\n\t$0\n}'],
  ['fori', 'Indexed loop', 'for (int ${1:i} = 0; ${1:i} < ${2:limit}; ${1:i}++) {\n\t$0\n}'],
  ['foreach', 'Enhanced for loop', 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}'],
  ['if', 'Conditional block', 'if (${1:condition}) {\n\t$0\n}'],
  ['while', 'While loop', 'while (${1:condition}) {\n\t$0\n}'],
  ['trycatch', 'Try / catch', 'try {\n\t$0\n} catch (${1:Exception} ${2:error}) {\n\t\n}'],
  ['ctor', 'Constructor', '${1:public} ${2:ClassName}(${3}) {\n\t$0\n}'],
];
const kinds: Record<string, languages.CompletionItemKind> = {
  class: languages.CompletionItemKind.Class,
  method: languages.CompletionItemKind.Method,
  field: languages.CompletionItemKind.Field,
  variable: languages.CompletionItemKind.Variable,
  package: languages.CompletionItemKind.Module,
};

export interface LiveToolReport {
  path: string;
  rows: ProblemRow[];
}

interface Options {
  smart: boolean;
  path?: string;
  onReport(report: LiveToolReport | null): void;
  onStatus(status: string | null): void;
  onNavigate(path: string, line: number, column: number): void;
}

export function attachJavaTools(instance: editor.IStandaloneCodeEditor, model: editor.ITextModel, options: Options): IDisposable {
  const { smart, path } = options;
  let active = true;
  let reportedProblems = false;
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  const handles: IDisposable[] = [];
  const smartFile = smart ? path : undefined;
  const current = () => active && !model.isDisposed() && instance.getModel() === model;

  async function query(operation: ToolOperation, position?: Position, cancelled = () => false) {
    if (!smartFile || !current() || cancelled()) return;
    if (model.getValueLength() > toolTextLimit) {
      options.onStatus('Smart Java is limited to files up to 256 KiB.');
      return;
    }
    const version = model.getVersionId();
    try {
      const text = model.getValue();
      if (encoder.encode(text).length > toolTextLimit) {
        options.onStatus('Smart Java is limited to files up to 256 KiB.');
        return;
      }
      const result = await window.ion.languageTools.query({
        language: 'java', path: smartFile, operation, version, text,
        offset: position ? model.getOffsetAt(position) : 0,
      });
      if (!current() || cancelled() || model.getVersionId() !== version || result?.version !== version) return;
      options.onStatus(null);
      return result.rows;
    } catch (error) {
      if (current() && !cancelled() && model.getVersionId() === version) {
        options.onStatus(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Java analysis unavailable.');
      }
    }
  }

  function diagnostics() {
    clearTimeout(diagnosticTimer);
    if (!smartFile) return;
    if (reportedProblems) {
      reportedProblems = false;
      editor.setModelMarkers(model, owner, []);
      options.onReport({ path: smartFile, rows: [] });
    }
    diagnosticTimer = setTimeout(async () => {
      const rows = await query('diagnostics');
      if (!rows) return;
      const markers: editor.IMarkerData[] = [];
      const problems: ProblemRow[] = [];
      for (const [level, start, end, message] of rows) {
        const offset = Number(start);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > model.getValueLength() || !message) continue;
        const from = model.getPositionAt(offset);
        const finish = Number(end);
        const to = model.getPositionAt(Number.isSafeInteger(finish) && finish > offset ? finish : offset + 1);
        const severity = level === 'error' ? MarkerSeverity.Error : level === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Info;
        markers.push({ startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber,
          endColumn: to.column, severity, message, source: `javac · ${level} · ${from.lineNumber}:${from.column}` });
        problems.push({ problem: { raw: message, severity: level === 'error' || level === 'warning' ? level : 'note',
          location: { file: smartFile, line: from.lineNumber, column: from.column } }, canReveal: true });
      }
      if (problems.length) {
        editor.setModelMarkers(model, owner, markers);
        reportedProblems = true;
        options.onReport({ path: smartFile, rows: problems });
      }
    }, 350);
  }

  handles.push(languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.'],
    async provideCompletionItems(item, position, _context, token) {
      if (item !== model || !current()) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new Range(position.lineNumber, word.startColumn, position.lineNumber,
        model.getWordAtPosition(position)?.endColumn ?? position.column);
      const prefix = word.word;
      const member = model.getLineContent(position.lineNumber).charAt(word.startColumn - 2) === '.';
      const suggestions: languages.CompletionItem[] = [];
      if (!member && prefix) {
        for (const [label, detail, insertText] of snippetRows) {
          if (label.startsWith(prefix)) suggestions.push({
            label, detail, insertText, range, kind: languages.CompletionItemKind.Snippet,
            insertTextRules: languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: '0' + label,
          });
        }
        for (const label of keywords) {
          if (label.startsWith(prefix)) suggestions.push({ label, insertText: label, range,
            kind: languages.CompletionItemKind.Keyword, sortText: '2' + label });
        }
      }
      // Exact snippet shortcuts remain responsive even while the JDK is busy.
      if (member || !snippetRows.some(([label]) => label === prefix)) {
        const rows = await query('complete', position, () => token.isCancellationRequested);
        for (const [label, kind, detail, insertText] of rows ?? []) {
          if (kinds[kind] !== undefined && label && insertText) {
            suggestions.push({ label, kind: kinds[kind], detail, insertText, range, sortText: '1' + label });
          }
        }
      }
      return { suggestions };
    },
  }));

  const locations = async (operation: 'definition' | 'references', position: Position, cancelled: () => boolean) =>
    (await query(operation, position, cancelled) ?? []).flatMap(([file, line, column]) => {
      const row = Number(line);
      const col = Number(column);
      if (!file || !Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(col) || col < 1) return [];
      return [{ uri: file === path ? model.uri : Uri.file(file), range: new Range(row, col, row, col + 1) }];
    });

  if (smartFile) {
    handles.push(model.onDidChangeContent(diagnostics));
    handles.push(languages.registerDefinitionProvider('java', {
      provideDefinition: (item, position, token) => item === model ? locations('definition', position, () => token.isCancellationRequested) : [],
    }));
    handles.push(languages.registerReferenceProvider('java', {
      provideReferences: (item, position, _context, token) =>
        item === model ? locations('references', position, () => token.isCancellationRequested) : [],
    }));
    handles.push(languages.registerSignatureHelpProvider('java', {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(item, position, token) {
        if (item !== model) return null;
        const rows = await query('signature', position, () => token.isCancellationRequested);
        if (!rows?.length) return null;
        return { value: { activeSignature: 0, activeParameter: Number(rows[0][0]) || 0,
          signatures: rows.map(([, label, ...parameters]) => ({ label, parameters: parameters.map((label) => ({ label })) })) },
          dispose() {} };
      },
    }));
    handles.push(editor.registerEditorOpener({
      openCodeEditor(source, resource, location) {
        if (source !== instance || !current() || resource.scheme !== 'file' || resource.toString() === model.uri.toString()) return false;
        options.onNavigate(resource.fsPath, location ? ('lineNumber' in location ? location.lineNumber : location.startLineNumber) : 1,
          location ? ('column' in location ? location.column : location.startColumn) : 1);
        return true;
      },
    }));
    diagnostics();
    options.onReport({ path: smartFile, rows: [] });
  }

  return {
    dispose() {
      active = false;
      clearTimeout(diagnosticTimer);
      for (const handle of handles) handle.dispose();
      if (!model.isDisposed()) editor.setModelMarkers(model, owner, []);
      options.onReport(null);
      options.onStatus(null);
      if (smartFile) void window.ion.languageTools.release(false).catch(() => {});
    },
  };
}
