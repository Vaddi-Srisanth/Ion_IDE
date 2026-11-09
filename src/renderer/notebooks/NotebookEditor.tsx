import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../../shared/contracts';
import { notebookText, parseNotebook, type NotebookCell, type NotebookDocument } from '../../shared/notebook-format';
import type { NotebookKernelLifetime } from '../../shared/notebook-kernel';
import type { ThemeData } from '../../shared/themes';
import { NotebookEdits } from '../../shared/notebook-edits';
import NotebookCellEditor from './NotebookCellEditor';
import { NotebookCode, NotebookMarkup, NotebookOutputs } from './notebook-content';
import { NotebookKernelToolbar, useNotebookKernel } from './notebook-kernel';
import './notebook.css';

export interface NotebookEditorProps {
  source: string;
  name: string;
  path: string | null;
  settings: Settings;
  activeTheme: ThemeData | null;
  accentColor?: string;
  onOpenJson(): void;
  onConnect(getText: () => string): () => void;
  onChange(): void;
  onRunningChange(running: boolean): void;
  onKernelPolicyChange(lifetime: NotebookKernelLifetime): void;
}

type CellType = 'code' | 'markdown' | 'raw';
type CellEntry = { key: string; cell: NotebookCell };

const overscan = 220;
const topPadding = 12;

function estimateCell(cell: NotebookCell): number {
  const source = notebookText(cell.source, 2000) ?? '';
  const lines = source.split('\n').length;
  return 60 + Math.min(lines, 12) * 18 + (cell.outputs?.length ? 72 : 0);
}

function indexAt(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(low, offsets.length - 2));
}

function useCellViewport(cells: readonly CellEntry[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const observer = useRef<ResizeObserver>(null);
  const rows = useRef(new Set<HTMLDivElement>());
  const [measurements, setMeasurements] = useState(new Map<string, number>());
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  const estimates = useMemo(() => cells.map(({ cell }) => estimateCell(cell)), [cells]);
  const offsets = useMemo(() => {
    const positions = [topPadding];
    estimates.forEach((height, index) => positions.push(positions[index] + (measurements.get(cells[index].key) ?? height)));
    return positions;
  }, [cells, estimates, measurements]);
  const previousOffsets = useRef(offsets);

  const refreshViewport = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const top = element.scrollTop;
    const height = element.clientHeight;
    setViewport((old) => old.top === top && old.height === height ? old : { top, height });
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const resize = new ResizeObserver((entries) => {
      const updates: [string, number][] = [];
      for (const entry of entries) {
        if (entry.target === element) {
          refreshViewport();
          continue;
        }
        const row = entry.target as HTMLDivElement;
        if (!rows.current.has(row)) continue;
        const height = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? row.getBoundingClientRect().height);
        if (height > 0 && row.dataset.cellKey) updates.push([row.dataset.cellKey, height]);
      }
      if (updates.length) setMeasurements((current) => {
        if (updates.every(([index, height]) => current.get(index) === height)) return current;
        const next = new Map(current);
        for (const [index, height] of updates) next.set(index, height);
        return next;
      });
    });
    observer.current = resize;
    resize.observe(element);
    rows.current.forEach((row) => resize.observe(row));
    refreshViewport();
    return () => { observer.current = null; resize.disconnect(); };
  }, [refreshViewport]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const previous = previousOffsets.current;
    previousOffsets.current = offsets;
    if (!element || previous === offsets || previous.length !== offsets.length) return;
    const anchor = indexAt(previous, element.scrollTop);
    element.scrollTop += offsets[anchor] - previous[anchor];
    refreshViewport();
  }, [offsets, refreshViewport]);

  const measure = useCallback((row: HTMLDivElement | null) => {
    if (!row) return;
    rows.current.add(row);
    observer.current?.observe(row);
    return () => {
      observer.current?.unobserve(row);
      rows.current.delete(row);
    };
  }, []);

  function reveal(index: number) {
    const element = scroller.current;
    if (!element) return;
    const top = offsets[index];
    if (top < element.scrollTop || top >= element.scrollTop + element.clientHeight - 45) {
      element.scrollTop = Math.max(0, top - topPadding);
      refreshViewport();
    }
  }

  const first = indexAt(offsets, viewport.top - overscan);
  const last = Math.min(cells.length, indexAt(offsets, viewport.top + viewport.height + overscan) + 1);
  return { scroller, measure, offsets, first, last, reveal, refreshViewport };
}

function metadataPreview(value: unknown) {
  let budget = 250;
  function preview(item: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 6) return '…';
    if (typeof item === 'string') return item.length > 240 ? item.slice(0, 240) + '…' : item;
    if (Array.isArray(item)) return item.slice(0, 24).map((entry) => preview(entry, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 24)
      .map(([key, entry]) => [key.slice(0, 200), preview(entry, depth + 1)]));
    return item;
  }
  const text = JSON.stringify(preview(value, 0), null, 2);
  return text.length > 12_000 ? text.slice(0, 12_000) + '\n…' : text;
}

function kernelName(metadata: NotebookDocument['metadata']): string {
  const kernel = metadata.kernelspec;
  if (!kernel || typeof kernel !== 'object' || !('display_name' in kernel) || typeof kernel.display_name !== 'string') return '';
  return kernel.display_name.slice(0, 90);
}

function preferredKernel(metadata: NotebookDocument['metadata']): string | undefined {
  const kernel = metadata.kernelspec;
  if (!kernel || typeof kernel !== 'object' || !('name' in kernel) || typeof kernel.name !== 'string') return;
  return /^[\w.-]{1,100}$/.test(kernel.name) ? kernel.name : undefined;
}

function isPython(metadata: NotebookDocument['metadata']): boolean {
  const language = metadata.language_info;
  if (language && typeof language === 'object' && 'name' in language && typeof language.name === 'string') {
    return language.name.toLowerCase() === 'python';
  }
  const kernel = metadata.kernelspec;
  if (kernel && typeof kernel === 'object' && 'language' in kernel && typeof kernel.language === 'string') {
    return kernel.language.toLowerCase() === 'python';
  }
  return true;
}

const CellContent = memo(function CellContent({ cell, python }: { cell: NotebookCell; python: boolean }) {
  if (cell.cell_type === 'markdown') {
    return <NotebookMarkup value={cell.source} isMarkdown attachments={cell.attachments}/>;
  }
  return <NotebookCode value={cell.source} highlight={cell.cell_type === 'code' && python}/>;
});

function NotebookView({ document, model, name, path, settings, activeTheme, accentColor, onConnect, onChange, onOpenJson,
  onRunningChange, onKernelPolicyChange }:
  Omit<NotebookEditorProps, 'source'> & { document: NotebookDocument; model: NotebookEdits }) {
  const cells = model.cells;
  const virtual = useCellViewport(cells);
  const [selected, setSelected] = useState(cells[0]?.key);
  const [editing, setEditing] = useState<string>();
  const [conversion, setConversion] = useState<{ key: string; type: CellType }>();
  const [message, setMessage] = useState('');
  const [hiddenOutputs, setHiddenOutputs] = useState(new Set<string>());
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [, redraw] = useState(0);
  const selectedIndex = useMemo(() => cells.findIndex(({ key }) => key === selected), [cells, selected]);
  const kernel = kernelName(document.metadata);
  const python = isPython(document.metadata);
  const metadata = useMemo(() => metadataOpen ? metadataPreview(document.metadata) : '', [document.metadata, metadataOpen]);
  const runnable = useMemo(() => cells.filter(({ cell }) => cell.cell_type === 'code'), [cells]);
  const above = useMemo(() => cells.slice(0, Math.max(0, selectedIndex)).filter(({ cell }) => cell.cell_type === 'code'), [cells, selectedIndex]);
  const selectedCode = cells[selectedIndex]?.cell.cell_type === 'code' ? [cells[selectedIndex]] : [];
  const execution = useNotebookKernel({ path: python ? path : null, preferredName: preferredKernel(document.metadata), onRunningChange,
    onExecution: (key, result) => { commit(() => model.setExecution(key, result.count, result.outputs)); } });
  const running = execution.running;
  const frame = useRef(0);
  const nextReveal = useRef<string>(undefined);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => onConnect(() => model.serialize()), [model, onConnect]);
  useLayoutEffect(() => {
    if (!nextReveal.current) return;
    const index = cells.findIndex(({ key }) => key === nextReveal.current);
    nextReveal.current = undefined;
    if (index >= 0) virtual.reveal(index);
  }, [cells, virtual]);

  function commit(operation: () => boolean): boolean {
    try {
      if (!operation()) return false;
      setMessage('');
      redraw((current) => current + 1);
      onChange();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not edit this notebook.');
      return false;
    }
  }

  function select(index: number) {
    const next = Math.min(cells.length - 1, Math.max(0, index));
    if (next < 0) return;
    const key = cells[next].key;
    if (key !== selected) {
      setSelected(key);
      setEditing(undefined);
      setConversion(undefined);
    }
    virtual.reveal(next);
  }

  function addCell() {
    let key: string | undefined;
    if (!commit(() => { key = model.addCell('code', selected); return true; }) || !key) return;
    nextReveal.current = key;
    setSelected(key);
    setEditing(key);
    setConversion(undefined);
  }

  function removeCell(key: string, index: number) {
    if (!commit(() => model.deleteCell(key))) return;
    const next = model.cells[Math.min(index, model.cells.length - 1)]?.key;
    nextReveal.current = next;
    setSelected(next);
    setEditing(undefined);
    setConversion(undefined);
  }

  function moveCell(key: string, direction: -1 | 1) {
    if (commit(() => model.moveCell(key, direction))) nextReveal.current = key;
  }

  function setType(key: string, type: CellType, allowDiscard = false) {
    if (!allowDiscard && model.conversionDropsData(key, type)) {
      setConversion({ key, type });
      return;
    }
    if (commit(() => model.setCellType(key, type, allowDiscard))) setConversion(undefined);
  }

  function history(redo: boolean) {
    if (running) return;
    if (!commit(() => redo ? model.redo() : model.undo())) return;
    if (!model.cells.some(({ key }) => key === selected)) {
      const next = model.cells[Math.min(Math.max(0, selectedIndex), model.cells.length - 1)]?.key;
      setSelected(next);
      setEditing(undefined);
      nextReveal.current = next;
    }
    setConversion(undefined);
  }

  function endEditing() {
    setEditing(undefined);
    virtual.scroller.current?.focus({ preventScroll: true });
  }

  function toggleOutputs(key: string) {
    setHiddenOutputs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return <section className="notebook-editor" data-testid="notebook-view" aria-label={`Notebook ${name}`}
    onKeyDown={(event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || !(event.target instanceof HTMLElement)
        || event.target.closest('.notebook-monaco')) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      event.preventDefault();
      history(key === 'y' || event.shiftKey);
    }}>
    <div className="notebook-toolbar" role="toolbar" aria-label="Notebook controls">
      <div className="notebook-toolbar-title">
        <span className="notebook-tag">Notebook</span>
        <strong title={name}>{name}</strong>
        {kernel && <span className="notebook-kernel" title={kernel}>{kernel}</span>}
      </div>
      <div className="notebook-toolbar-actions">
        <button className="button" type="button" onClick={addCell} disabled={Boolean(running)}>Add cell</button>
        <button className="button notebook-nav" type="button" onClick={() => history(false)} disabled={!!running || !model.canUndo} aria-label="Undo notebook edit">↶</button>
        <button className="button notebook-nav" type="button" onClick={() => history(true)} disabled={!!running || !model.canRedo} aria-label="Redo notebook edit">↷</button>
        <button className="button notebook-nav" type="button" onClick={() => select(selectedIndex - 1)} disabled={selectedIndex <= 0} aria-label="Previous cell">↑</button>
        <span className="notebook-count" aria-live="polite">{cells.length ? `Cell ${selectedIndex + 1} of ${cells.length}` : '0 cells'}</span>
        <button className="button notebook-nav" type="button" onClick={() => select(selectedIndex + 1)} disabled={selectedIndex >= cells.length - 1} aria-label="Next cell">↓</button>
        <button className="button" type="button" onClick={() => setMetadataOpen(!metadataOpen)} aria-expanded={metadataOpen}>Metadata</button>
        <button className="button" type="button" data-testid="notebook-open-json" disabled={Boolean(running)} onClick={onOpenJson}>Open as JSON</button>
      </div>
    </div>
    <NotebookKernelToolbar kernel={execution} path={path} python={python} selected={selectedCode} above={above} all={runnable}
      lifetime={settings.notebookKernelLifetime} onLifetimeChange={onKernelPolicyChange}/>
    {message && <p className="notebook-feedback notebook-error" role="alert">{message}</p>}
    {metadataOpen && <section className="notebook-metadata" aria-label="Notebook metadata">
      <p className="notebook-muted">Jupyter notebook format {document.nbformat}.{document.nbformat_minor}</p>
      <pre className="notebook-code">{metadata}</pre>
    </section>}
    <div className="notebook-scroll" data-testid="notebook-scroll" ref={virtual.scroller} tabIndex={0} aria-label="Notebook cells"
      onScroll={() => {
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => { frame.current = 0; virtual.refreshViewport(); });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          select(selectedIndex + (event.key === 'ArrowUp' ? -1 : 1));
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          select(event.key === 'Home' ? 0 : cells.length - 1);
        }
      }}>
      {!cells.length && <p className="notebook-feedback">This notebook has no cells.</p>}
      <div className="notebook-cells" role="list" style={{ height: virtual.offsets.at(-1) }}>
        {cells.slice(virtual.first, virtual.last).map(({ key, cell }, offset) => {
          const index = virtual.first + offset;
          const kind = cell.cell_type === 'code' ? 'Code' : cell.cell_type === 'markdown' ? 'Markdown' : cell.cell_type === 'raw' ? 'Raw' : 'Unknown';
          const isRunningCell = running?.key === key;
          const outputs = isRunningCell ? running.outputs : cell.outputs ?? [];
          const collapsed = hiddenOutputs.has(key);
          const active = selected === key;
          const sourceEditor = active && editing === key;
          const editable = kind !== 'Unknown';
          return <div className="notebook-row" ref={virtual.measure} key={key} data-cell-index={index} data-cell-key={key}
            style={{ top: virtual.offsets[index] }} role="listitem" aria-setsize={cells.length} aria-posinset={index + 1}>
            <article className="notebook-cell" data-testid="notebook-cell" data-cell-index={index}
              data-cell-type={cell.cell_type} data-selected={active} aria-current={active || undefined}>
              <header className="notebook-cell-header">
                <button className="notebook-cell-select" type="button" onClick={() => select(index)} aria-label={`Select ${kind.toLowerCase()} cell ${index + 1}`}>
                  {cell.cell_type === 'code' && <span className="notebook-execution"
                    aria-label={isRunningCell ? 'Executing cell' : `Execution count ${cell.execution_count ?? 'empty'}`}>
                    [{isRunningCell ? '*' : cell.execution_count ?? ' '}]
                  </span>}
                  <span>{kind}</span><span className="notebook-cell-number">{index + 1}</span>
                </button>
                <div className="notebook-cell-actions">
                  {active && <>
                    {editable && <>
                      <select className="notebook-cell-type" aria-label="Cell type" value={cell.cell_type} disabled={Boolean(running)}
                        onChange={(event) => setType(key, event.target.value as CellType)}>
                        <option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option>
                      </select>
                      <button className="button" type="button" disabled={!!running && !sourceEditor} onClick={sourceEditor ? endEditing : () => setEditing(key)}>
                        {sourceEditor ? 'Done editing' : 'Edit cell'}
                      </button>
                    </>}
                    <button className="button notebook-nav" type="button" aria-label="Move cell up" disabled={!!running || index === 0} onClick={() => moveCell(key, -1)}>↑</button>
                    <button className="button notebook-nav" type="button" aria-label="Move cell down" disabled={!!running || index === cells.length - 1} onClick={() => moveCell(key, 1)}>↓</button>
                    <button className="button" type="button" disabled={Boolean(running)} onClick={() => removeCell(key, index)}>Delete cell</button>
                  </>}
                  {isRunningCell && <span className="notebook-muted">Running…</span>}
                  {outputs.length > 0 && <button className="button notebook-output-toggle" type="button" onClick={() => toggleOutputs(key)}
                    aria-expanded={!collapsed}>{collapsed ? 'Show outputs' : 'Hide outputs'}</button>}
                </div>
              </header>
              {conversion?.key === key && <div className="notebook-conversion" role="alert">
                <span>Changing the cell type removes its outputs or attachments. Undo restores them.</span>
                <button className="button" type="button" disabled={Boolean(running)} onClick={() => setType(key, conversion.type, true)}>Change type</button>
                <button className="button" type="button" onClick={() => setConversion(undefined)}>Cancel</button>
              </div>}
              {sourceEditor ? <NotebookCellEditor value={notebookText(cell.source) ?? ''} settings={settings} activeTheme={activeTheme}
                accentColor={accentColor} readOnly={Boolean(running)} language={cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'code' && python ? 'python' : 'plaintext'}
                onChange={(value) => commit(() => model.setSource(key, value))} onHistory={history} onDone={endEditing}/>
                : <div className="notebook-cell-content"><CellContent cell={cell} python={python}/></div>}
              {!!outputs.length && !collapsed && <NotebookOutputs outputs={outputs}/>}
            </article>
          </div>;
        })}
      </div>
    </div>
  </section>;
}

export default function NotebookEditor({ source, ...props }: NotebookEditorProps) {
  const parsed = useMemo(() => {
    try {
      const document = parseNotebook(source);
      return { document, model: new NotebookEdits(source, document) };
    }
    catch (error) { return { error: error instanceof Error ? error.message : 'Could not read this notebook.' }; }
  }, [source]);
  if (parsed.document) return <NotebookView document={parsed.document} model={parsed.model} {...props}/>;
  return <section className="notebook-editor" data-testid="notebook-view" aria-label={`Notebook ${props.name}`}>
    <div className="notebook-feedback notebook-invalid" role="alert">
      <strong>Could not open this notebook</strong>
      <p>{parsed.error}</p>
      <button className="button" type="button" data-testid="notebook-open-json" onClick={props.onOpenJson}>Open as JSON</button>
    </div>
  </section>;
}
