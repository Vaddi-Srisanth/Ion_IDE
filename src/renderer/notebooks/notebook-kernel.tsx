import { useEffect, useRef, useState } from 'react';
import { notebookText, type NotebookCell, type NotebookOutput } from '../../shared/notebook-format';
import type { NotebookKernelEnvironment, NotebookKernelResult, NotebookKernelStatus } from '../../shared/notebook-kernel';
import { errorMessage } from '../documents';

type RunCell = { key: string; cell: NotebookCell };
type Running = { key: string; position: number; total: number; outputs: NotebookOutput[] };
type Batch = { id?: string; cancelled: boolean };

const stopped: NotebookKernelStatus = { state: 'stopped' };
const liveOutputLimit = 16;
const liveStreamLimit = 24 * 1024;

function addLiveOutput(outputs: NotebookOutput[], next: NotebookOutput): NotebookOutput[] {
  if (next.output_type === 'ion-clear-output') return [];
  if (next.output_type === 'stream') {
    const last = outputs.at(-1);
    const append = last?.output_type === 'stream' && last.name === next.name;
    const previous = append ? notebookText(last.text, liveStreamLimit) ?? '' : '';
    if (previous.length >= liveStreamLimit) return outputs;
    const text = previous + (notebookText(next.text, liveStreamLimit - previous.length) ?? '');
    if (append) return [...outputs.slice(0, -1), { ...next, text }];
    next = { ...next, text };
  }
  return outputs.length < liveOutputLimit ? [...outputs, next] : outputs;
}

export function useNotebookKernel({ path, preferredName, onRunningChange, onExecution }: {
  path: string | null;
  preferredName?: string;
  onRunningChange(running: boolean): void;
  onExecution(key: string, result: NotebookKernelResult): void;
}) {
  const [status, setStatus] = useState<NotebookKernelStatus>(stopped);
  const [environments, setEnvironments] = useState<NotebookKernelEnvironment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [discovered, setDiscovered] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [running, setRunning] = useState<Running | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const batch = useRef<Batch>(null);
  const mounted = useRef(false);
  const api = window.ion.notebooks;

  useEffect(() => {
    let current = true;
    mounted.current = true;
    if (!path) return () => { mounted.current = false; };
    void api.status(path).then((initial) => {
      if (current) setStatus(initial);
    }).catch(() => { /* Opening the notebook remains independent of kernel availability. */ });
    const unsubscribe = api.onOutput(({ path: source, id, output }) => {
      if (!batch.current || source !== path || batch.current.id !== id) return;
      setRunning((active) => {
        if (!active) return active;
        const outputs = addLiveOutput(active.outputs, output);
        return outputs === active.outputs ? active : { ...active, outputs };
      });
    });
    return () => { current = false; mounted.current = false; unsubscribe(); };
  }, [api, path]);

  async function refresh() {
    if (!path) return;
    const updated = await api.status(path);
    if (mounted.current) setStatus(updated);
  }

  async function discover() {
    if (!path || configuring) return;
    setConfiguring(true);
    setMessage(undefined);
    try {
      const found = await api.discover(path);
      if (!mounted.current) return;
      setEnvironments(found);
      setDiscovered(true);
      if (!found.length) setMessage({ text: 'No compatible Python kernels found. Choose a Python with Jupyter Client and ipykernel installed.' });
    } catch (error) {
      if (mounted.current) setMessage({ text: errorMessage(error), error: true });
    } finally { if (mounted.current) setConfiguring(false); }
  }

  async function choose() {
    if (!path || configuring) return;
    setConfiguring(true);
    setMessage(undefined);
    try {
      const choice = await api.choose(path);
      if (!mounted.current || !choice) return;
      setEnvironments((current) => [choice, ...current.filter(({ id }) => id !== choice.id)]);
      setSelectedId(choice.id);
    } catch (error) {
      if (mounted.current) setMessage({ text: errorMessage(error), error: true });
    } finally { if (mounted.current) setConfiguring(false); }
  }

  async function run(cells: readonly RunCell[]) {
    if (!path || !cells.length || batch.current || controlling || configuring) return;
    const operation: Batch = { cancelled: false };
    batch.current = operation;
    onRunningChange(true);
    setMessage(undefined);
    try {
      for (const [index, { key, cell }] of cells.entries()) {
        if (operation.cancelled) break;
        const id = crypto.randomUUID();
        operation.id = id;
        setRunning({ key, position: index + 1, total: cells.length, outputs: [] });
        const result = await api.run(path, { id, code: notebookText(cell.source) ?? '',
          environmentId: selectedId || undefined, preferredName });
        if (!mounted.current) break;
        if (result.status !== 'interrupted' || result.count !== null || result.outputs.length) onExecution(key, result);
        if (result.status !== 'ok') {
          setMessage(result.status === 'error' ? { text: 'A cell raised an error. See its output for the traceback.', error: true }
            : { text: 'Execution interrupted.' });
          break;
        }
      }
    } catch (error) {
      if (mounted.current && !operation.cancelled) setMessage({ text: errorMessage(error), error: true });
    } finally {
      batch.current = null;
      if (mounted.current) {
        setRunning(null);
        onRunningChange(false);
        await refresh().catch(() => {});
      }
    }
  }

  async function control(action: 'restart' | 'interrupt' | 'stop') {
    if (!path || controlling) return;
    if (batch.current && action !== 'restart') batch.current.cancelled = true;
    setControlling(true);
    setMessage(undefined);
    try {
      await api[action](path);
      if (mounted.current) await refresh();
    } catch (error) {
      if (mounted.current) setMessage({ text: errorMessage(error), error: true });
    } finally { if (mounted.current) setControlling(false); }
  }

  const activeEnvironment = status.environment;
  const choices = activeEnvironment && !environments.some(({ id }) => id === activeEnvironment.id)
    ? [activeEnvironment, ...environments] : environments;
  const currentEnvironmentId = selectedId && choices.some(({ id }) => id === selectedId)
    ? selectedId : activeEnvironment?.id ?? '';

  return { status, choices, currentEnvironmentId, discovered, configuring, controlling, running, message,
    discover, choose, run, control, select: setSelectedId };
}

type KernelView = ReturnType<typeof useNotebookKernel>;

export function NotebookKernelToolbar({ kernel, path, python, selected, above, all, lifetime, onLifetimeChange }: {
  kernel: KernelView;
  path: string | null;
  python: boolean;
  selected: readonly RunCell[];
  above: readonly RunCell[];
  all: readonly RunCell[];
  lifetime: 'tab' | 'window';
  onLifetimeChange(lifetime: 'tab' | 'window'): void;
}) {
  if (!path || !python) return <p className="notebook-kernel-toolbar notebook-muted">
    {!path ? 'Save this notebook to enable local execution.' : 'Local execution is available for Python notebooks.'}
  </p>;
  const state = kernel.status.state;
  const locked = Boolean(kernel.running || kernel.configuring || kernel.controlling);
  const status = kernel.running ? `Running cell ${kernel.running.position}/${kernel.running.total}`
    : state === 'starting' ? 'Starting kernel…' : state === 'idle' ? 'Kernel ready'
      : state === 'busy' ? 'Kernel busy' : 'Kernel stopped';
  return <div className="notebook-kernel-toolbar">
    <div className="notebook-kernel-actions" role="toolbar" aria-label="Local kernel controls">
      <button className="button notebook-primary-run" type="button" data-testid="notebook-run-cell" disabled={locked || !selected.length}
        onClick={() => void kernel.run(selected)}>Run cell</button>
      <button className="button" type="button" data-testid="notebook-run-above" disabled={locked || !above.length}
        onClick={() => void kernel.run(above)}>Run above</button>
      <button className="button" type="button" data-testid="notebook-run-all" disabled={locked || !all.length}
        onClick={() => void kernel.run(all)}>Run all</button>
      <button className="button" type="button" data-testid="notebook-kernel-interrupt" disabled={kernel.controlling || (!kernel.running && state !== 'busy')}
        onClick={() => void kernel.control('interrupt')}>Interrupt</button>
      <button className="button" type="button" data-testid="notebook-kernel-restart" disabled={locked || state === 'stopped'}
        onClick={() => void kernel.control('restart')}>Restart</button>
      <button className="button" type="button" data-testid="notebook-kernel-stop" disabled={kernel.controlling || (!kernel.running && state === 'stopped')}
        onClick={() => void kernel.control('stop')}>Stop kernel</button>
    </div>
    <div className="notebook-kernel-actions" aria-label="Python environment">
      <span className="notebook-kernel-status" data-testid="notebook-kernel-status" role="status">{status}</span>
      <button className="button" type="button" data-testid="notebook-kernel-discover" disabled={locked}
        onClick={() => void kernel.discover()}>{kernel.configuring ? 'Checking Python…' : 'Find kernels'}</button>
      <button className="button" type="button" data-testid="notebook-kernel-choose" disabled={locked || state !== 'stopped'}
        onClick={() => void kernel.choose()}>Choose Python…</button>
      {(kernel.discovered || kernel.choices.length > 0) && <select className="notebook-cell-type" data-testid="notebook-kernel-select"
        aria-label="Python kernel" disabled={locked || state !== 'stopped'} value={kernel.currentEnvironmentId}
        onChange={(event) => kernel.select(event.target.value)}>
        <option value="">Automatic kernel</option>
        {kernel.choices.map(({ id, label, path: pythonPath }) => <option key={id} value={id} title={pythonPath}>{label}</option>)}
      </select>}
      <select className="notebook-cell-type" data-testid="notebook-kernel-lifetime" aria-label="Kernel lifetime" value={lifetime}
        onChange={(event) => onLifetimeChange(event.target.value === 'window' ? 'window' : 'tab')}>
        <option value="tab">Stop when tab closes</option><option value="window">Keep until window closes</option>
      </select>
    </div>
    {kernel.message && <p className={`notebook-kernel-message${kernel.message.error ? ' notebook-error' : ''}`}
      role={kernel.message.error ? 'alert' : 'status'}>{kernel.message.text}</p>}
  </div>;
}
