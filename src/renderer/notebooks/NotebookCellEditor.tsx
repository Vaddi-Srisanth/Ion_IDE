import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor/editor/editor.api.js';
import type { Settings } from '../../shared/contracts';
import type { ThemeData } from '../../shared/themes';
import { loadEditor } from '../load-editor';

interface Props {
  value: string;
  language: 'python' | 'markdown' | 'plaintext';
  settings: Settings;
  activeTheme: ThemeData | null;
  accentColor?: string;
  readOnly?: boolean;
  onChange(value: string): void;
  onHistory(redo: boolean): void;
  onDone(): void;
}

interface ActiveEditor {
  widget: editor.IStandaloneCodeEditor;
  model: editor.ITextModel;
  theme(theme: ThemeData | null, accent?: string): void;
}

function updateSettings({ widget, model }: ActiveEditor, settings: Settings) {
  widget.updateOptions({ fontSize: settings.fontSize, wordWrap: settings.wordWrap ? 'on' : 'off',
    lineNumbers: settings.lineNumbers ? 'on' : 'off' });
  model.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
}

export default function NotebookCellEditor(props: Props) {
  const { value, language, settings, activeTheme, accentColor, readOnly } = props;
  const host = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveEditor>(null);
  const latest = useRef(props);
  const updating = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'fallback'>('loading');
  latest.current = props;

  useEffect(() => {
    let current = true;
    let dispose: (() => void) | undefined;
    setState('loading');
    void Promise.all([loadEditor(), import('monaco-editor/editor/editor.api.js'), import('../themes/editor-theme')])
      .then(([, api, { applyEditorTheme }]) => {
        if (!current || !host.current) return;
        const model = api.editor.createModel(latest.current.value, language);
        let widget: editor.IStandaloneCodeEditor;
        try {
          widget = api.editor.create(host.current, {
            model, automaticLayout: true, ariaLabel: 'Notebook cell source', readOnly: latest.current.readOnly,
            fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
            minimap: { enabled: false }, disableLayerHinting: true,
            overviewRulerLanes: 0, lineDecorationsWidth: 8, lineNumbersMinChars: 2,
            padding: { top: 8, bottom: 8 }, scrollBeyondLastLine: false,
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
            quickSuggestions: false, suggestOnTriggerCharacters: false,
            wordBasedSuggestions: 'off', inlineSuggest: { enabled: false },
            renderValidationDecorations: 'off', cursorBlinking: 'solid',
            stickyScroll: { enabled: false }, links: false,
          });
        } catch (error) {
          model.dispose();
          throw error;
        }
        const listener = widget.onDidChangeModelContent(() => {
          if (!updating.current) latest.current.onChange(model.getValue());
        });
        dispose = () => { listener.dispose(); widget.dispose(); model.dispose(); };
        const live: ActiveEditor = { widget, model, theme(theme, accent) {
          if (theme) applyEditorTheme(theme, accent);
          else api.editor.setTheme('vs-dark');
        } };
        active.current = live;
        updateSettings(live, latest.current.settings);
        live.theme(latest.current.activeTheme, latest.current.accentColor);
        widget.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyZ, () => latest.current.onHistory(false));
        widget.addCommand(api.KeyMod.CtrlCmd | api.KeyMod.Shift | api.KeyCode.KeyZ, () => latest.current.onHistory(true));
        widget.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyY, () => latest.current.onHistory(true));
        widget.addCommand(api.KeyCode.Escape, () => latest.current.onDone());
        widget.focus();
        setState('ready');
      }).catch(() => {
        if (!current) return;
        dispose?.();
        dispose = undefined;
        active.current = null;
        setState('fallback');
      });
    return () => { current = false; active.current = null; dispose?.(); };
  }, [language]);

  useLayoutEffect(() => {
    const live = active.current;
    if (!live || live.model.getValue() === value) return;
    const position = live.widget.getPosition();
    updating.current = true;
    try {
      live.model.setValue(value);
      if (position) live.widget.setPosition(live.model.validatePosition(position));
    } finally { updating.current = false; }
  }, [value]);

  useLayoutEffect(() => { if (active.current) updateSettings(active.current, settings); }, [settings]);
  useLayoutEffect(() => { active.current?.theme(activeTheme, accentColor); }, [activeTheme, accentColor]);
  useLayoutEffect(() => { active.current?.widget.updateOptions({ readOnly }); }, [readOnly]);

  return <div className="notebook-cell-editor" data-testid="notebook-cell-editor">
    {state === 'loading' && <p className="notebook-edit-loading" role="status">Opening cell editor…</p>}
    {state === 'fallback' && <textarea className="notebook-edit-fallback" aria-label="Notebook cell source" autoFocus value={value} readOnly={readOnly}
      onChange={(event) => props.onChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); props.onDone(); }
      }}/>}
    <div className="notebook-monaco" ref={host}/>
  </div>;
}
