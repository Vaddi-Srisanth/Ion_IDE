import type { RunResult } from '../../shared/contracts';
import type { RunUpdate } from '../../shared/run-console';

type Phase = 'idle' | 'preparing' | 'compiling' | 'running' | 'finished';

interface ConsoleState {
  phase: Phase;
  name: string | null;
  label: string | null;
  result: RunResult | null;
  error: string | null;
  run: number;
  hasOutput: boolean;
}

type OutputEvent =
  | { kind: 'replace'; parts: readonly string[] }
  | { kind: 'append'; text: string };

interface Transcript {
  parts: string[];
  length: number;
  clipped: boolean;
}

const runLimit = 272 * 1024;
const chunkLimit = 8 * 1024;
const initialState: ConsoleState = {
  phase: 'idle', name: null, label: null, result: null, error: null, run: 0, hasOutput: false,
};

const newTranscript = (): Transcript => ({ parts: [], length: 0, clipped: false });
// Leave the alternate screen without DECRST 1049's unconditional cursor restore.
const endTerminalMode = '\x18\x1b[?47l\x1b[?1000;1002;1003;1006;2004;2026l\x1b[?25h\x1b[0m';

function plainText(text: string): string {
  // Compiler diagnostics and file names are text, even when they contain control characters.
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?|\n/g, '\r\n').replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

export class RunConsoleStore {
  private state = initialState;
  private transcript = newTranscript();
  private previous: Transcript | null = null;
  private listeners = new Set<() => void>();
  private outputListeners = new Set<(event: OutputEvent) => void>();

  getSnapshot = (): ConsoleState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeOutput = (listener: (event: OutputEvent) => void): (() => void) => {
    this.outputListeners.add(listener);
    listener(this.replacement());
    return () => { this.outputListeners.delete(listener); };
  };

  start(name: string, preserveOutput: boolean): void {
    this.previous = preserveOutput && this.transcript.length ? this.transcript : null;
    this.transcript = newTranscript();
    this.output(this.replacement());
    this.publish({
      phase: 'preparing', name, label: null, result: null, error: null,
      run: this.state.run + 1, hasOutput: true,
    });
    this.append(plainText(`${this.previous ? '\n' : ''}› Run ${name}\n`));
  }

  update(update: RunUpdate): void {
    if (update.kind === 'phase') {
      this.publish({ phase: update.phase, label: update.label ?? this.state.label });
    } else {
      this.append(update.stream === 'compiler' ? plainText(update.text) : update.text);
    }
  }

  finish(result: RunResult): void {
    if (this.transcript.length) this.appendControlText(endTerminalMode);
    if (this.state.phase !== 'running' && result.status !== 'success' && result.status !== 'compile-error') {
      this.appendControlText(plainText(`\n${result.message}\n`));
    }
    // Output already arrived through the terminal stream. Retain only the run summary.
    this.publish({ phase: 'finished', result: { ...result, compileOutput: '', programOutput: '',
      programStdout: undefined, programStderr: undefined, learning: undefined }, error: null });
  }

  fail(message: string): void {
    this.appendControlText(endTerminalMode);
    if (this.state.phase !== 'running') this.appendControlText(plainText(`\n${message}\n`));
    this.publish({ phase: 'finished', result: null, error: message });
  }

  inputRejected(): void {
    // Input rejection must not stop the running program or destroy its output.
    this.publish({ error: 'Input was not sent: paste at most 16,000 characters at a time.' });
  }

  clear(): void {
    this.previous = null;
    this.transcript = newTranscript();
    this.output(this.replacement());
    this.publish({ hasOutput: false });
  }

  private append(text: string): void {
    if (!text) return;
    const transcript = this.transcript;
    if (transcript.length + text.length > runLimit) {
      if (!transcript.clipped) {
        transcript.clipped = true;
        this.appendControlText(endTerminalMode + '\r\n[Console history limit reached]\r\n');
      }
      return;
    }
    this.appendControlText(text);
  }

  private appendControlText(text: string): void {
    const { parts } = this.transcript;
    const last = parts.at(-1);
    if (last !== undefined && last.length + text.length <= chunkLimit) parts[parts.length - 1] = last + text;
    else parts.push(text);
    this.transcript.length += text.length;
    this.output({ kind: 'append', text });
    if (!this.state.hasOutput) this.publish({ hasOutput: true });
  }

  private replacement(): OutputEvent {
    return { kind: 'replace', parts: [...(this.previous?.parts ?? []), ...this.transcript.parts] };
  }

  private output(event: OutputEvent): void {
    for (const listener of this.outputListeners) listener(event);
  }

  private publish(patch: Partial<ConsoleState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
