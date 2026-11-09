import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import type { RunStatus } from '../shared/contracts';
import { Icon } from './icons';
import type { RunConsoleStore } from './run-console/store';
import type { TerminalSurfaceProps } from './run-console/TerminalSurface';
import './run-console/console.css';

interface OutputProps {
  store: RunConsoleStore;
  canRun: boolean;
  canRerun?: boolean;
  onRun(): void;
  onRerun(): void;
  onStop(): void;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onClose(): void;
}

const statusLabel: Record<RunStatus, string> = {
  success: 'Finished',
  'compile-error': 'Compilation failed',
  'runtime-error': 'Program failed',
  'missing-toolchain': 'Toolchain unavailable',
  timeout: 'Timed out',
  'output-limit': 'Output limit',
  cancelled: 'Stopped',
  rejected: 'Run skipped',
};

export function Output({ store, canRun, canRerun, onRun, onRerun, onStop, onInput, onResize, onClose }: OutputProps) {
  const { phase, name, label, result, error, hasOutput } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [Surface, setSurface] = useState<ComponentType<TerminalSurfaceProps> | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let live = true;
    void import('./run-console/TerminalSurface').then(({ TerminalSurface }) => {
      if (live) setSurface(() => TerminalSurface);
    }).catch(() => {
      if (live) setLoadError(true);
    });
    return () => { live = false; };
  }, []);

  const busy = phase === 'preparing' || phase === 'compiling' || phase === 'running';
  const status = phase === 'preparing' ? 'Preparing…' : phase === 'compiling' ? 'Compiling…'
    : phase === 'running' ? 'Running' : result ? statusLabel[result.status] : error ? 'Run failed' : 'Ready';
  const bad = Boolean(error || (result && !['success', 'cancelled', 'rejected'].includes(result.status)));

  return (
    <section className="output run-console" aria-label="Run Console" data-testid="output"
      data-status={result?.status ?? (error ? 'runtime-error' : undefined)} data-phase={phase}>
      <div className="pane-title run-console-title">
        <div className="run-console-title-text">
          <Icon name="terminal" size={15}/>
          <h2>Run Console</h2>
          {name && <span className="run-console-file" title={name}>{name}</span>}
        </div>
        <div className="pane-tools">
          <span className={`run-tag ${bad ? 'bad' : result?.status === 'success' || phase === 'running' ? 'good' : ''}`}
            role="status" data-testid="run-status">{status}</span>
          <button className="icon-button" aria-label="Run active file" title="Run active file" disabled={!canRun || busy}
            data-testid="run-console-run" onClick={onRun}><Icon name="play" size={14}/></button>
          <button className="icon-button" aria-label="Rerun last file" title="Rerun last file" disabled={!(canRerun ?? name) || busy}
            data-testid="run-console-rerun" onClick={onRerun}><Icon name="refresh" size={14}/></button>
          <button className="icon-button" aria-label="Stop process" title="Stop process" disabled={!busy}
            data-testid="run-console-stop" onClick={onStop}><Icon name="stop" size={14}/></button>
          <button className="icon-button" aria-label="Clear console" title="Clear console" disabled={busy || !hasOutput}
            data-testid="run-console-clear" onClick={() => store.clear()}><Icon name="trash" size={14}/></button>
          <button className="icon-button" aria-label="Hide console" title="Hide console"
            onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
      </div>
      {Surface ? <Surface store={store} onInput={onInput} onResize={onResize}/> : (
        <p className="run-console-placeholder" role={loadError ? 'alert' : 'status'}>
          {loadError ? 'The terminal could not load. Close and reopen the console to retry.' : 'Loading terminal…'}
        </p>
      )}
      <div className="run-console-footer">
        <span className={bad ? 'console-error' : undefined} title={error ?? result?.message ?? label ?? undefined}>
          {error ?? result?.message ?? (phase === 'running' ? 'Type here to send input to the program.' : label)
            ?? 'Run a file to see output and enter input here.'}
        </span>
        {result && <span className="run-console-duration" data-testid="run-console-duration">
          {result.exitCode !== null ? `Exit ${result.exitCode} · ` : result.programSignal ? `${result.programSignal} · ` : ''}
          {result.durationMs} ms
        </span>}
      </div>
    </section>
  );
}
