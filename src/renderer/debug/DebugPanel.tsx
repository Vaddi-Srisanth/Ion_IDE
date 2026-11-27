import { useState, type FormEvent } from 'react';
import { Icon } from '../icons';
import type { DebugUiAction, DebugUiBreakpoint, DebugUiFrame, DebugUiState } from './types';
import './debug.css';

export interface DebugPanelProps {
  state: DebugUiState;
  canStart: boolean;
  onStart(): void;
  onAction(action: DebugUiAction): void;
  onSelectFrame(frame: DebugUiFrame): void;
  onExpandScope(reference: number): void;
  onToggleBreakpoint(breakpoint: DebugUiBreakpoint): void;
  onRemoveBreakpoint(breakpoint: DebugUiBreakpoint): void;
  onAddWatch(expression: string): void;
  onRemoveWatch(id: string): void;
  onClose(): void;
}

const busyPhases = new Set(['starting', 'stopping']);

export function DebugPanel({ state, canStart, onStart, onAction, onSelectFrame, onExpandScope,
  onToggleBreakpoint, onRemoveBreakpoint, onAddWatch, onRemoveWatch, onClose }: DebugPanelProps) {
  const [watch, setWatch] = useState('');
  const active = state.phase === 'running' || state.phase === 'paused' || state.phase === 'starting' || state.phase === 'stopping';
  const paused = state.phase === 'paused';
  const busy = busyPhases.has(state.phase);
  const submitWatch = (event: FormEvent) => {
    event.preventDefault();
    const expression = watch.trim();
    if (!expression || expression.length > 512) return;
    onAddWatch(expression);
    setWatch('');
  };

  return <aside className="debug-pane" aria-label="Run and Debug" data-testid="debug-panel" data-phase={state.phase}>
    <div className="pane-title debug-pane-title">
      <span>Run and Debug</span>
      <div className="pane-tools">
        <button className="icon-button" type="button" aria-label="Close Run and Debug" title="Close Run and Debug"
          onClick={onClose}><Icon name="x" size={14}/></button>
      </div>
    </div>
    <div className="debug-pane-body">
      <section className="debug-launch" aria-label="Debug session">
        <div className="debug-launch-summary">
          <strong title={state.activeFile}>{state.activeName ?? 'Active C/C++ file'}</strong>
          <span className={`debug-status debug-status-${state.phase}`} role="status" aria-live="polite">{state.status}</span>
        </div>
        {!active ? <button className="button debug-start" type="button" disabled={!canStart || busy}
          data-testid="debug-start" onClick={onStart}><Icon name="play" size={14}/>Start Debugging</button>
          : <DebugToolbar state={state} onAction={onAction}/>}
        {state.error && <p className="debug-notice" role="alert"><Icon name="warning" size={14}/>{state.error}</p>}
        {!canStart && !active && <p className="debug-hint">Open a saved C or C++ file to start a reviewed debug session.</p>}
      </section>

      <DebugSection title="Call Stack" count={state.frames.length} empty="No paused stack frames.">
        <ul className="debug-list debug-call-stack" aria-label="Call Stack">
          {state.frames.slice(0, 200).map((frame) => <li key={`${frame.threadId}:${frame.id}`}>
            <button type="button" className="debug-row" aria-current={frame.selected || undefined}
              data-testid="debug-frame" onClick={() => onSelectFrame(frame)}>
              <span className="debug-row-main"><strong>{frame.name}</strong>
                <small>{frame.source ?? frame.path?.split(/[/\\]/).at(-1) ?? 'Source unavailable'}</small></span>
              {frame.line !== undefined && <span className="debug-location">:{frame.line}</span>}
            </button>
          </li>)}
        </ul>
      </DebugSection>

      <DebugSection title="Variables" count={state.scopes.length} empty={paused ? 'No variables reported.' : 'Pause to inspect variables.'}>
        <div className="debug-scopes" aria-label="Variables">
          {state.scopes.slice(0, 32).map((scope) => <section key={scope.variablesReference} className="debug-scope">
            <button type="button" className="debug-section-toggle" aria-expanded={scope.expanded ?? false}
              onClick={() => onExpandScope(scope.variablesReference)}>
              <Icon name={scope.expanded ? 'down' : 'chevron'} size={12}/><span>{scope.name}</span>
              {scope.expensive && <small>On demand</small>}
            </button>
            {scope.expanded && <VariableList variables={scope.variables ?? []}/>}
          </section>)}
        </div>
      </DebugSection>

      <DebugSection title="Watch" count={state.watches.length} empty="Add an expression to inspect when paused.">
        <ul className="debug-list" aria-label="Watch expressions">
          {state.watches.slice(0, 64).map((item) => <li key={item.id} className="debug-watch">
            <span className="debug-row-main"><strong title={item.expression}>{item.expression}</strong>
              <small className={item.error ? 'debug-value-error' : undefined}>{item.error ?? item.value ?? 'Not evaluated'}</small></span>
            {item.type && <span className="debug-variable-type">{item.type}</span>}
            <button className="icon-button" type="button" aria-label={`Remove watch ${item.expression}`}
              onClick={() => onRemoveWatch(item.id)}><Icon name="x" size={12}/></button>
          </li>)}
        </ul>
        <form className="debug-watch-form" onSubmit={submitWatch}>
          <input value={watch} maxLength={512} aria-label="Watch expression" placeholder="Add expression"
            onChange={(event) => setWatch(event.target.value)}/>
          <button className="icon-button" type="submit" disabled={!watch.trim()} title="Add watch" aria-label="Add watch">
            <Icon name="plus" size={14}/>
          </button>
        </form>
      </DebugSection>

      <DebugSection title="Breakpoints" count={state.breakpoints.length} empty="Use the editor gutter or F9 to add a breakpoint.">
        <ul className="debug-list" aria-label="Breakpoints">
          {state.breakpoints.slice(0, 256).map((breakpoint) => <li key={breakpoint.id} className="debug-breakpoint">
            <label className="debug-breakpoint-label" title={breakpoint.path}>
              <input type="checkbox" checked={breakpoint.enabled} onChange={() => onToggleBreakpoint(breakpoint)}/>
              <span className={`debug-breakpoint-dot${breakpoint.verified === false ? ' unverified' : ''}`} aria-hidden="true"/>
              <span className="debug-row-main"><strong>{breakpoint.name}:{breakpoint.line}</strong>
                {breakpoint.message && <small>{breakpoint.message}</small>}</span>
            </label>
            <button className="icon-button" type="button" aria-label={`Remove breakpoint ${breakpoint.name} line ${breakpoint.line}`}
              onClick={() => onRemoveBreakpoint(breakpoint)}><Icon name="x" size={12}/></button>
          </li>)}
        </ul>
      </DebugSection>
    </div>
  </aside>;
}
function DebugToolbar({ state, onAction }: { state: DebugUiState; onAction(action: DebugUiAction): void }) {
  const paused = state.phase === 'paused';
  const stopping = state.phase === 'stopping';
  return <div className="debug-toolbar" role="toolbar" aria-label="Debug controls">
    <ToolButton label={paused ? 'Continue' : 'Pause'} icon={paused ? 'play' : 'stop'} disabled={stopping || (!paused && !state.canPause)}
      onClick={() => onAction(paused ? 'continue' : 'pause')}/>
    <ToolButton label="Step Over" text="↷" disabled={!paused || stopping} onClick={() => onAction('next')}/>
    <ToolButton label="Step Into" text="↓" disabled={!paused || stopping} onClick={() => onAction('stepIn')}/>
    <ToolButton label="Step Out" text="↑" disabled={!paused || stopping} onClick={() => onAction('stepOut')}/>
    <ToolButton label="Restart" icon="refresh" disabled={!state.canRestart || stopping} onClick={() => onAction('restart')}/>
    <ToolButton label="Stop Debugging" icon="stop" disabled={stopping} danger onClick={() => onAction('stop')}/>
  </div>;
}

function ToolButton({ label, icon, text, disabled, danger, onClick }: { label: string; icon?: 'play' | 'stop' | 'refresh'; text?: string;
  disabled?: boolean; danger?: boolean; onClick(): void }) {
  return <button className={`icon-button debug-tool${danger ? ' danger' : ''}`} type="button" title={label} aria-label={label}
    disabled={disabled} onClick={onClick}>{icon ? <Icon name={icon} size={14}/> : <span aria-hidden="true">{text}</span>}</button>;
}

function DebugSection({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return <details className="debug-section" open>
    <summary><span>{title}</span><span className="debug-count">{count}</span></summary>
    {count ? children : <p className="debug-empty">{empty}</p>}
  </details>;
}

function VariableList({ variables }: { variables: readonly import('./types').DebugUiVariable[] }) {
  return <ul className="debug-list debug-variables">
    {variables.slice(0, 500).map((variable, index) => <li key={`${variable.name}:${index}`} className="debug-variable">
      <span className={variable.changed ? 'changed' : undefined}>{variable.name}</span>
      <span className="debug-variable-value" title={variable.value}>{variable.value}</span>
      {variable.type && <span className="debug-variable-type">{variable.type}</span>}
    </li>)}
  </ul>;
}
