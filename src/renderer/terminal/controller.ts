import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { maxTerminalSessions, type TerminalBridge, type TerminalEvent, type TerminalSessionInfo } from '../../shared/terminal';
import { errorMessage } from '../documents';
import { blockHostTerminalSequences, readTerminalTheme, sendTerminalInput, terminalDimension } from '../run-console/xterm';

const maximumPendingInput = 64_000;
const initialSize = { cols: 80, rows: 24 };

type Exit = Extract<TerminalEvent, { kind: 'exit' }>;
interface SessionView extends TerminalSessionInfo {
  number: number;
  exit?: Exit;
}
interface Session {
  view: SessionView;
  terminal: Terminal;
  host: HTMLDivElement;
  fit: FitAddon;
  size: typeof initialSize;
  search?: Promise<SearchAddon>;
  pending: string[];
  pendingLength: number;
  sending: boolean;
  closed: boolean;
}

export interface TerminalSnapshot {
  active: string | null;
  sessions: SessionView[];
  opening: boolean;
  error: string | null;
}

export class TerminalController {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private snapshot: TerminalSnapshot = { active: null, sessions: [], opening: false, error: null };
  private nextNumber = 1;
  private started = false;
  private disposed = false;
  private focused: string | null = null;

  constructor(private readonly bridge: TerminalBridge, private readonly isMac: boolean) {
    this.unsubscribe = bridge.onEvent((event) => this.receive(event));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  ensureFirst() {
    if (!this.started) void this.create();
  }

  async create() {
    if (this.disposed || this.snapshot.opening || this.sessions.size >= maxTerminalSessions) return;
    this.started = true;
    this.update({ opening: true, error: null });
    const size = this.sessions.get(this.snapshot.active ?? '')?.size ?? initialSize;
    let created: TerminalSessionInfo | undefined;
    try {
      created = await this.bridge.create(size.cols, size.rows);
      if (this.disposed) {
        await this.bridge.close(created.id);
        return;
      }
      const terminal = new Terminal({
        cols: size.cols, rows: size.rows, fontFamily: 'Menlo, monospace', fontSize: 12, lineHeight: 1.15,
        cursorBlink: false, altClickMovesCursor: false, minimumContrastRatio: 4.5, scrollback: 2000,
      });
      const host = document.createElement('div');
      host.className = 'terminal-surface';
      const session: Session = {
        view: { ...created, number: this.nextNumber++ }, terminal, host, fit: new FitAddon(), size,
        pending: [], pendingLength: 0, sending: false, closed: false,
      };
      blockHostTerminalSequences(terminal);
      terminal.loadAddon(session.fit);
      terminal.onData((data) => this.send(session, data));
      terminal.onResize(({ cols, rows }) => {
        if (cols === session.size.cols && rows === session.size.rows) return;
        session.size = { cols, rows };
        if (!session.view.exit && !session.closed) {
          void this.bridge.resize(session.view.id, cols, rows).catch((error: unknown) => this.reportSessionError(session, error));
        }
      });
      this.sessions.set(created.id, session);
      this.update({ active: created.id, sessions: this.list() });
      await this.bridge.attach(created.id);
    } catch (error) {
      if (created) {
        if (this.sessions.has(created.id)) await this.close(created.id);
        else await this.bridge.close(created.id).catch(() => {});
      }
      this.report(error);
    } finally {
      this.update({ opening: false });
    }
  }

  select(id: string) {
    if (this.sessions.has(id) && this.snapshot.active !== id) this.update({ active: id, error: null });
  }

  async close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    const previous = this.snapshot.sessions.findIndex((item) => item.id === id);
    this.sessions.delete(id);
    this.release(session);
    const sessions = this.list();
    this.update({
      active: this.snapshot.active === id ? sessions[Math.min(previous, sessions.length - 1)]?.id ?? null : this.snapshot.active,
      sessions,
      error: null,
    });
    try {
      await this.bridge.close(id);
    } catch (error) {
      this.report(error);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
    for (const session of this.sessions.values()) {
      this.release(session);
      void this.bridge.close(session.view.id).catch(() => {});
    }
    this.sessions.clear();
  }

  mount(id: string, parent: HTMLElement, openFind: () => void) {
    const session = this.sessions.get(id);
    if (!session) return;
    const { terminal, host } = session;
    const shell = parent.closest<HTMLElement>('.app-shell') ?? parent;
    parent.appendChild(host);
    terminal.options.fontFamily = getComputedStyle(shell).getPropertyValue('--mono').trim() || 'Menlo, monospace';
    terminal.options.theme = readTerminalTheme(shell);
    if (!terminal.element) {
      terminal.open(host);
      terminal.textarea?.setAttribute('data-testid', 'terminal-input');
      terminal.textarea?.setAttribute('aria-label', 'Terminal input');
    }
    terminal.attachCustomKeyEventHandler((event) => this.handleKey(session, event, openFind));

    const focus = () => this.setFocus(id);
    const blur = () => { if (this.focused === id) this.setFocus(null); };
    terminal.textarea?.addEventListener('focus', focus);
    terminal.textarea?.addEventListener('blur', blur);

    const fit = () => {
      if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
      const dimensions = session.fit.proposeDimensions();
      if (!dimensions) return;
      const cols = terminalDimension(dimensions.cols);
      const rows = terminalDimension(dimensions.rows);
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
    };
    let frame = 0;
    const resize = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; fit(); });
    });
    const appearance = new MutationObserver(() => { terminal.options.theme = readTerminalTheme(shell); });
    resize.observe(host);
    appearance.observe(shell, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    fit();
    terminal.refresh(0, terminal.rows - 1);
    terminal.focus();

    return () => {
      blur();
      terminal.textarea?.removeEventListener('focus', focus);
      terminal.textarea?.removeEventListener('blur', blur);
      if (!session.closed) terminal.attachCustomKeyEventHandler(() => true);
      cancelAnimationFrame(frame);
      resize.disconnect();
      appearance.disconnect();
      host.remove();
    };
  }

  focus(id: string) {
    this.sessions.get(id)?.terminal.focus();
  }

  clear(id: string) {
    const session = this.sessions.get(id);
    if (session) session.terminal.write('', () => {
      if (!session.closed) session.terminal.clear();
    });
  }

  async find(id: string, query: string, previous: boolean, incremental: boolean): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || !query || !session.host.isConnected) return false;
    session.search ??= import('@xterm/addon-search').then(({ SearchAddon }) => {
      const search = new SearchAddon();
      if (!session.closed) session.terminal.loadAddon(search);
      return search;
    }, (error: unknown) => {
      session.search = undefined;
      throw error;
    });
    const search = await session.search;
    if (session.closed || !session.host.isConnected) return false;
    return previous ? search.findPrevious(query) : search.findNext(query, { incremental });
  }

  clearFind(id: string) {
    const session = this.sessions.get(id);
    if (session?.search) void session.search.then((addon) => {
      if (!session.closed) addon.clearDecorations();
    }).catch(() => {});
  }

  private receive(event: TerminalEvent) {
    const session = this.sessions.get(event.id);
    if (event.kind === 'data') {
      const ack = () => { void this.bridge.ack(event.id, event.sequence).catch(() => {}); };
      if (session) session.terminal.write(event.text, ack);
      else ack();
    } else if (session) {
      session.view = { ...session.view, exit: event };
      session.terminal.options.disableStdin = true;
      session.terminal.write(event.code === null ? '\r\n[Shell exited]\r\n' : `\r\n[Shell exited with code ${event.code}]\r\n`);
      this.update({ sessions: this.list() });
    }
  }

  private setFocus(id: string | null) {
    if (this.focused === id) return;
    this.focused = id;
    void this.bridge.setFocus(id !== null).catch(() => {});
  }

  private handleKey(session: Session, event: KeyboardEvent, openFind: () => void) {
    if (event.type !== 'keydown' || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (this.isMac && event.metaKey && !event.ctrlKey && !event.shiftKey && key === 'f') {
      event.preventDefault();
      openFind();
      return false;
    }
    const clipboard = this.isMac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey;
    if (clipboard && (key === 'c' || key === 'v')) {
      event.preventDefault();
      const selected = session.terminal.getSelection();
      if (key === 'c' && selected) void this.bridge.copy(selected).catch((error: unknown) => this.reportSessionError(session, error));
      if (key === 'v' && !session.view.exit) void this.bridge.paste().catch((error: unknown) => this.reportSessionError(session, error));
      return false;
    }
    return true;
  }

  private send(session: Session, data: string) {
    if (session.view.exit || session.closed) return;
    if (session.pendingLength + data.length > maximumPendingInput) {
      this.report(new Error('Terminal input is busy. Wait for the shell before pasting again.'));
      return;
    }
    sendTerminalInput(data, (part) => {
      session.pending.push(part);
      session.pendingLength += part.length;
    }, maximumPendingInput);
    if (!session.sending) void this.flushInput(session);
  }

  private async flushInput(session: Session) {
    session.sending = true;
    try {
      while (!session.closed && !session.view.exit && session.pending.length) {
        const chunk = session.pending.shift()!;
        session.pendingLength -= chunk.length;
        await this.bridge.input(session.view.id, chunk);
      }
    } catch (error) {
      session.pending.length = 0;
      session.pendingLength = 0;
      this.reportSessionError(session, error);
    } finally {
      session.sending = false;
    }
  }

  private reportSessionError(session: Session, error: unknown) {
    if (!session.closed && !session.view.exit) this.report(error);
  }

  private report(error: unknown) {
    this.update({ error: errorMessage(error) });
  }

  private release(session: Session) {
    if (this.focused === session.view.id) this.setFocus(null);
    session.closed = true;
    session.pending.length = 0;
    session.pendingLength = 0;
    session.terminal.dispose();
    session.host.remove();
  }

  private list() {
    return Array.from(this.sessions.values(), (session) => session.view);
  }

  private update(patch: Partial<TerminalSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
