import type { DebugAction, DebugBreakpointResult, DebugBridge, DebugEvent, DebugFrame, DebugSession,
  DebugStartRequest, DebugState } from '../../shared/debug';
import { debugLimits } from '../../shared/debug';
import { errorMessage } from '../documents';
import { emptyDebugUiState, type DebugUiAction, type DebugUiBreakpoint, type DebugUiFrame,
  type DebugUiOutput, type DebugUiPhase, type DebugUiScope, type DebugUiState, type DebugUiWatch } from './types';

const outputEntryLimit = 2048;
const watchLimit = 64;

export class DebugController {
  private state: DebugUiState = emptyDebugUiState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private session: DebugSession | null = null;
  private threadId: number | undefined;
  private selectedFrameId: number | undefined;
  private outputId = 0;
  private outputBytes = 0;
  private watchId = 0;
  private generation = 0;
  private disposed = false;

  constructor(private readonly bridge: DebugBridge) {
    this.unsubscribe = bridge.onEvent((event) => { void this.event(event); });
    // Opening Run and Debug may inspect existing main-owned state. It never
    // discovers tools or starts an adapter/debuggee by itself.
    const generation = this.generation;
    void bridge.status().then((session) => {
      if (!this.disposed && this.generation === generation && session) this.acceptSession(session);
    }, () => {});
  }

  getSnapshot = (): DebugUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async start(request: DebugStartRequest): Promise<void> {
    if (this.disposed || this.active()) return;
    this.generation++;
    this.publish({ phase: 'starting', status: 'Starting…', error: undefined, activeFile: request.sourcePath,
      activeName: request.sourcePath.split(/[/\\]/).at(-1), frames: [], scopes: [],
      breakpoints: request.breakpoints.map((item, index) => breakpointView(item, index)) });
    try {
      this.acceptSession(await this.bridge.start(request));
    } catch (reason) {
      this.fail(reason);
    }
  }

  async command(action: DebugUiAction): Promise<void> {
    const id = this.session?.id;
    if (!id || this.disposed) return;
    if (action === 'stop') return this.stop();
    if (action === 'restart' && !this.state.canRestart) return;
    try {
      await this.bridge.action(id, action as DebugAction, this.threadId);
      if (action === 'continue' || action === 'next' || action === 'stepIn' || action === 'stepOut') {
        this.publish({ phase: 'running', status: action === 'continue' ? 'Running' : 'Stepping…', frames: [], scopes: [] });
      }
    } catch (reason) { this.fail(reason); }
  }

  async stop(): Promise<void> {
    const id = this.session?.id;
    if (!id || this.state.phase === 'stopping' || this.disposed) return;
    this.publish({ phase: 'stopping', status: 'Stopping…' });
    try {
      await this.bridge.stop(id);
      if (this.session?.id === id) this.finish('Stopped');
    } catch (reason) { this.fail(reason); }
  }

  async selectFrame(frame: DebugUiFrame): Promise<DebugFrame | undefined> {
    const id = this.session?.id;
    if (!id || this.state.phase !== 'paused' || this.disposed) return;
    this.selectedFrameId = frame.id;
    this.publish({ frames: this.state.frames.map((entry) => ({ ...entry, selected: entry.id === frame.id })), scopes: [] });
    try {
      const scopes = await this.bridge.scopes(id, frame.id);
      if (this.session?.id !== id || this.selectedFrameId !== frame.id || this.state.phase !== 'paused') return;
      this.publish({ scopes: scopes.slice(0, debugLimits.scopes).map((scope): DebugUiScope => ({ ...scope, expanded: false })) });
      await this.refreshWatches();
      return { id: frame.id, name: frame.name, path: frame.path, line: frame.line ?? 1, column: frame.column ?? 1 };
    } catch (reason) { this.fail(reason); }
  }

  async expandScope(reference: number): Promise<void> {
    const id = this.session?.id;
    const scope = this.state.scopes.find((entry) => entry.variablesReference === reference);
    if (!id || !scope || this.state.phase !== 'paused') return;
    if (scope.expanded) {
      this.publish({ scopes: this.state.scopes.map((entry) => entry.variablesReference === reference
        ? { ...entry, expanded: false } : entry) });
      return;
    }
    try {
      const variables = await this.bridge.variables(id, reference);
      if (this.session?.id !== id || this.state.phase !== 'paused') return;
      this.publish({ scopes: this.state.scopes.map((entry) => entry.variablesReference === reference
        ? { ...entry, expanded: true, variables: variables.slice(0, debugLimits.variables).map((item) => ({ ...item })) } : entry) });
    } catch (reason) { this.fail(reason); }
  }

  async addWatch(expression: string): Promise<void> {
    const value = expression.trim().slice(0, debugLimits.expressionBytes);
    if (!value || this.state.watches.length >= watchLimit) return;
    const item: DebugUiWatch = { id: `watch-${++this.watchId}`, expression: value };
    this.publish({ watches: [...this.state.watches, item] });
    if (this.state.phase === 'paused') await this.evaluateWatch(item);
  }

  removeWatch(id: string): void {
    this.publish({ watches: this.state.watches.filter((entry) => entry.id !== id) });
  }

  async evaluate(expression: string): Promise<void> {
    const value = expression.trim();
    const id = this.session?.id;
    if (!id || !value || value.length > debugLimits.expressionBytes || this.state.phase !== 'paused') return;
    try {
      const result = await this.bridge.evaluate(id, value, this.selectedFrameId);
      if (this.session?.id !== id) return;
      this.append('console', `› ${value}\n${result.result}${result.type ? ` · ${result.type}` : ''}\n`);
    } catch (reason) { this.append('stderr', `${errorMessage(reason)}\n`); }
  }

  setBreakpoints(breakpoints: readonly DebugBreakpointResult[]): void {
    this.publish({ breakpoints: breakpoints.slice(0, debugLimits.breakpoints).map((item, index) => breakpointView(item, index)) });
  }

  clearConsole(): void {
    this.outputBytes = 0;
    this.publish({ output: [] });
  }

  async dispose(stop = false): Promise<void> {
    if (this.disposed) return;
    if (stop && this.session) await this.stop();
    this.generation++;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  private async event(event: DebugEvent) {
    if (this.disposed || event.sessionId !== this.session?.id) return;
    if (event.type === 'output') {
      this.append(event.category, event.output);
      return;
    }
    if (event.type === 'breakpoints') {
      this.setBreakpoints(event.breakpoints);
      return;
    }
    this.threadId = event.threadId ?? this.threadId;
    const phase = phaseFor(event.state);
    this.publish({ phase, status: labelFor(event.state, event.reason), error: event.state === 'error' ? event.reason : undefined,
      canEvaluate: phase === 'paused', ...(phase === 'running' ? { frames: [], scopes: [] } : {}) });
    if (event.state === 'stopped' && this.threadId !== undefined) await this.loadStack(this.threadId);
    if (event.state === 'terminated') this.finish(event.reason ?? 'Finished');
  }

  private async loadStack(threadId: number) {
    const id = this.session?.id;
    if (!id || this.state.phase !== 'paused') return;
    try {
      const frames = await this.bridge.stack(id, threadId);
      if (this.session?.id !== id || this.threadId !== threadId || this.state.phase !== 'paused') return;
      const views = frames.slice(0, debugLimits.frames).map((frame, index): DebugUiFrame => ({ ...frame, threadId, selected: index === 0,
        source: frame.path?.split(/[/\\]/).at(-1) }));
      this.selectedFrameId = views[0]?.id;
      this.publish({ frames: views, scopes: [] });
      if (views[0]) await this.selectFrame(views[0]);
    } catch (reason) { this.fail(reason); }
  }

  private async refreshWatches() {
    if (this.state.phase !== 'paused') return;
    await Promise.all(this.state.watches.map((item) => this.evaluateWatch(item)));
  }

  private async evaluateWatch(item: DebugUiWatch) {
    const id = this.session?.id;
    if (!id || this.state.phase !== 'paused') return;
    try {
      const result = await this.bridge.evaluate(id, item.expression, this.selectedFrameId);
      if (this.session?.id !== id || this.state.phase !== 'paused') return;
      this.publish({ watches: this.state.watches.map((entry) => entry.id === item.id
        ? { ...entry, value: result.result, type: result.type, error: undefined } : entry) });
    } catch (reason) {
      this.publish({ watches: this.state.watches.map((entry) => entry.id === item.id
        ? { ...entry, value: undefined, type: undefined, error: errorMessage(reason) } : entry) });
    }
  }

  private acceptSession(session: DebugSession) {
    this.session = session;
    this.threadId = session.threadId;
    this.selectedFrameId = undefined;
    const phase = phaseFor(session.state);
    this.publish({ sessionId: session.id, phase: phaseFor(session.state), status: labelFor(session.state),
      activeFile: session.sourcePath, activeName: session.sourcePath.split(/[/\\]/).at(-1), error: undefined,
      frames: [], scopes: [], breakpoints: session.breakpoints.map((item, index) => breakpointView(item, index)),
      canPause: phase === 'running', canRestart: true, canEvaluate: phase === 'paused' });
    if (phase === 'paused' && this.threadId !== undefined) void this.loadStack(this.threadId);
  }

  private append(category: DebugUiOutput['category'], value: string) {
    if (!value || this.outputBytes >= debugLimits.outputBytes) return;
    const text = truncateUtf8(value, Math.min(debugLimits.stringBytes, debugLimits.outputBytes - this.outputBytes));
    this.outputBytes += utf8Bytes(text);
    let output = [...this.state.output, { id: ++this.outputId, category, text }];
    if (output.length > outputEntryLimit) output = output.slice(-outputEntryLimit);
    this.publish({ output });
  }

  private fail(reason: unknown) {
    const error = errorMessage(reason);
    this.publish({ phase: 'error', status: 'Debugging failed', error });
    this.append('stderr', `${error}\n`);
  }

  private finish(status: string) {
    this.session = null;
    this.threadId = undefined;
    this.selectedFrameId = undefined;
    this.publish({ phase: 'finished', status, sessionId: undefined, frames: [], scopes: [], canPause: false,
      canRestart: false, canEvaluate: false });
  }

  private active() {
    return this.session !== null;
  }

  private publish(patch: Partial<DebugUiState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8Bytes = (value: string) => encoder.encode(value).byteLength;
function truncateUtf8(value: string, limit: number) {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= limit) return value;
  let decoded = decoder.decode(encoded.subarray(0, limit));
  while (decoded && utf8Bytes(decoded) > limit) decoded = decoded.slice(0, -1);
  return decoded;
}

function phaseFor(state: DebugState): DebugUiPhase {
  return state === 'stopped' ? 'paused' : state === 'terminated' ? 'finished' : state;
}

function labelFor(state: DebugState, reason?: string) {
  return reason ?? ({ idle: 'Ready', starting: 'Starting…', running: 'Running', stopped: 'Paused',
    terminated: 'Finished', error: 'Debugging failed' } satisfies Record<DebugState, string>)[state];
}

function breakpointView(item: Omit<DebugBreakpointResult, 'verified'> & { verified?: boolean }, index: number): DebugUiBreakpoint {
  return { id: `${item.path}:${item.line}:${item.column ?? 0}:${index}`, path: item.path,
    name: item.path.split(/[/\\]/).at(-1) ?? item.path, line: item.line, enabled: true,
    verified: item.verified, message: item.message };
}
