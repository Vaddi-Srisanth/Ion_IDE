import { editor, languages, Range, Uri, type Position } from 'monaco-editor/editor/editor.api.js';
import { toolTextLimit, type SourceReference, type ToolOperation } from '../shared/language-tools';
import { errorMessage } from './documents';

const encoder = new TextEncoder();
type Query = (operation: ToolOperation, position?: Position, cancelled?: () => boolean) => Promise<string[][] | undefined>;

export function createToolQuery(model: editor.ITextModel, current: () => boolean, options: {
  language: string; label: string; path?: string; onStatus(status: string | null): void;
}): Query {
  const { language, label, path, onStatus } = options;
  return async (operation, position, cancelled = () => false) => {
    if (!path || !current() || cancelled()) return;
    const overLimit = () => { onStatus(`${label} is limited to files up to 256 KiB.`); return undefined; };
    if (model.getValueLength() > toolTextLimit) return overLimit();
    const version = model.getVersionId();
    const valid = () => current() && !cancelled() && model.getVersionId() === version;
    try {
      const text = model.getValue();
      if (encoder.encode(text).length > toolTextLimit) return overLimit();
      const result = await window.ion.languageTools.query({
        language, path, operation, version, text, offset: position ? model.getOffsetAt(position) : 0,
      });
      if (!valid() || result?.version !== version) return;
      onStatus(null);
      return result.rows;
    } catch (error) {
      if (valid()) onStatus(errorMessage(error));
    }
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

export function sourceNavigationProviders(model: editor.ITextModel, path: string, query: Query) {
  const locations = async (operation: 'definition' | 'references', position: Position, cancelled: () => boolean) =>
    sourceReferences(await query(operation, position, cancelled) ?? []).map(({ path: file, line, column }) => ({
      uri: file === path ? model.uri : Uri.file(file), range: new Range(line, column, line, column + 1),
    }));
  const language = model.getLanguageId();
  return [
    languages.registerDefinitionProvider(language, {
      provideDefinition: (item, position, token) => item === model
        ? locations('definition', position, () => token.isCancellationRequested) : [],
    }),
    languages.registerReferenceProvider(language, {
      provideReferences: (item, position, _context, token) => item === model
        ? locations('references', position, () => token.isCancellationRequested) : [],
    }),
  ];
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
