import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../icons';
import type { DebugUiState } from './types';
import './debug.css';

export interface DebugConsoleProps {
  state: DebugUiState;
  tabs: ReactNode;
  onEvaluate(expression: string): void;
  onClear(): void;
  onClose(): void;
}
export function DebugConsole({ state, tabs, onEvaluate, onClear, onClose }: DebugConsoleProps) {
  const [expression, setExpression] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [state.output.length]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = expression.trim();
    if (!value || value.length > 512 || state.phase !== 'paused') return;
    onEvaluate(value);
    setExpression('');
  };
  return <section className="output debug-console" aria-label="Debug Console" data-testid="debug-console">
    <div className="pane-title">
      {tabs}
      <div className="pane-tools">
        <span className={`run-tag ${state.phase === 'paused' || state.phase === 'running' ? 'good' : state.phase === 'error' ? 'bad' : ''}`}
          role="status">{state.status}</span>
        <button className="icon-button" type="button" aria-label="Clear Debug Console" title="Clear Debug Console"
          disabled={!state.output.length} onClick={onClear}><Icon name="trash" size={14}/></button>
        <button className="icon-button" type="button" aria-label="Hide Debug Console" title="Hide Debug Console"
          onClick={onClose}><Icon name="down" size={15}/></button>
      </div>
    </div>
    <div className="bottom-tab-content debug-console-content" role="tabpanel" id="bottom-content-debug" aria-labelledby="bottom-tab-debug">
      <div className="debug-transcript" role="log" aria-live="polite" aria-relevant="additions text">
        {!state.output.length && <p className="debug-console-empty">Start a debug session to see program and adapter output.</p>}
        {state.output.slice(-2048).map((entry) => <pre key={entry.id} className={`debug-output debug-output-${entry.category}`}>{entry.text}</pre>)}
        <div ref={end}/>
      </div>
      <form className="debug-repl" onSubmit={submit}>
        <span aria-hidden="true">›</span>
        <input value={expression} maxLength={512} aria-label="Debug Console expression" placeholder={state.phase === 'paused'
          ? 'Evaluate in the selected frame' : 'Pause execution to evaluate'} disabled={state.phase !== 'paused'}
          onChange={(event) => setExpression(event.target.value)}/>
        <button type="submit" className="icon-button" aria-label="Evaluate expression" title="Evaluate expression"
          disabled={state.phase !== 'paused' || !expression.trim()}><Icon name="arrow" size={14}/></button>
      </form>
    </div>
  </section>;
}
