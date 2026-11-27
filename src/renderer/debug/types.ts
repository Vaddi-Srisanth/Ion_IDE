export type DebugUiPhase = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'finished' | 'error';

export type DebugUiAction = 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'restart' | 'stop';

export interface DebugUiBreakpoint {
  id: string;
  path: string;
  name: string;
  line: number;
  enabled: boolean;
  verified?: boolean;
  message?: string;
}

export interface DebugUiFrame {
  id: number;
  threadId: number;
  name: string;
  path?: string;
  source?: string;
  line?: number;
  column?: number;
  selected?: boolean;
}

export interface DebugUiVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
  changed?: boolean;
}

export interface DebugUiScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  expanded?: boolean;
  variables?: readonly DebugUiVariable[];
}

export interface DebugUiWatch {
  id: string;
  expression: string;
  value?: string;
  type?: string;
  error?: string;
}

export interface DebugUiOutput {
  id: number;
  category: 'console' | 'stdout' | 'stderr' | 'important' | 'telemetry';
  text: string;
}

export interface DebugUiState {
  phase: DebugUiPhase;
  status: string;
  sessionId?: string;
  activeFile?: string;
  activeName?: string;
  error?: string;
  frames: readonly DebugUiFrame[];
  scopes: readonly DebugUiScope[];
  breakpoints: readonly DebugUiBreakpoint[];
  watches: readonly DebugUiWatch[];
  output: readonly DebugUiOutput[];
  canPause?: boolean;
  canRestart?: boolean;
  canEvaluate?: boolean;
}

export const emptyDebugUiState: DebugUiState = {
  phase: 'idle', status: 'Ready', frames: [], scopes: [], breakpoints: [], watches: [], output: [],
};
