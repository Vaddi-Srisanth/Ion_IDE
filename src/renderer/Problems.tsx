import type { ReactNode } from 'react';
import type { CompilerProblem, LearningDiagnostic } from '../shared/learning';
import { Icon } from './icons';

export interface ProblemRow {
  problem: CompilerProblem;
  lesson?: LearningDiagnostic;
  canReveal: boolean;
}

export interface ProblemMarker {
  line: number;
  lens: boolean;
  selected: boolean;
}

interface ProblemGroup {
  file?: string;
  rows: readonly ProblemRow[];
  onReveal(index: number): void;
}

export function Problems({ tabs, file, rows, stale, live, selected, onReveal, onExplain, onClose }: {
  tabs: ReactNode;
  file?: string;
  rows: readonly ProblemRow[];
  stale: boolean;
  live?: ProblemGroup;
  selected?: number;
  onReveal(index: number): void;
  onExplain(index: number): void;
  onClose(): void;
}) {
  return <section className="output problems-panel" data-testid="problems-panel">
    <div className="pane-title">
      {tabs}
      <div className="pane-tools"><button className="icon-button" type="button" aria-label="Hide Problems panel" onClick={onClose}>
        <Icon name="down" size={15}/>
      </button></div>
    </div>
    <div className="bottom-tab-content problems-content" role="tabpanel" id="bottom-content-problems" aria-labelledby="bottom-tab-problems">
      {live && <ProblemResults {...live} label="the current Java buffer"/>}
      {rows.length > 0 && <ProblemResults file={file} rows={rows} stale={stale} label="the last run"
        selected={selected} onReveal={onReveal} onExplain={onExplain}/>}
      {!live && rows.length === 0 && <p className="problems-empty">No compiler diagnostics to show. Run a source file to check it.</p>}
    </div>
  </section>;
}

function ProblemResults({ file, rows, stale, label, selected, onReveal, onExplain }: ProblemGroup & {
  stale?: boolean;
  label: string;
  selected?: number;
  onExplain?(index: number): void;
}) {
  if (!rows.length) return <p className="problems-empty">No current Java diagnostics to show.</p>;
  return <>
    <div className="problems-summary">
      <strong>{file}</strong>
      <span>{rows.length} {rows.length === 1 ? 'diagnostic' : 'diagnostics'} from {label}</span>
    </div>
    {stale && <p className="problems-stale">These results refer to the compiled file. Run the current source to refresh its locations.</p>}
    <ul className="problem-list">
      {rows.map(({ problem, lesson, canReveal }, index) => {
        const location = problem.location;
        const name = location?.file.split(/[/\\]/).at(-1);
        return <li key={index} className="problem-row" data-testid="problem-row" data-category={lesson?.category}
          aria-current={selected === index || undefined} data-selected={selected === index || undefined} data-severity={problem.severity}>
          <div className="problem-meta">
            <span className="problem-severity">{problem.severity}</span>
            {location && <span className="problem-location" title={location.file}>
              {name}:{location.line}{location.column === undefined ? '' : ':' + location.column}
            </span>}
            {lesson && <span className="problem-lens-label">Learning Lens</span>}
          </div>
          <pre className="problem-message">{problem.raw}</pre>
          {(canReveal || lesson) && <div className="problem-actions">
            {canReveal && <button type="button" className="button" data-testid="problem-reveal"
              onClick={() => onReveal(index)}>Go to source</button>}
            {lesson && onExplain && <button type="button" className="button problem-explain" data-testid="problem-explain"
              onClick={() => onExplain(index)}>{lesson.occurrence === 'repeated' ? 'Explain again' : 'Explain'}</button>}
          </div>}
        </li>;
      })}
    </ul>
  </>;
}
