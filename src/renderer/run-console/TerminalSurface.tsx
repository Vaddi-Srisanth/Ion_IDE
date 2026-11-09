import { useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { RunConsoleStore } from './store';
import { blockHostTerminalSequences, readTerminalTheme, sendTerminalInput, terminalDimension } from './xterm';

export interface TerminalSurfaceProps {
  store: RunConsoleStore;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
}

export function TerminalSurface({ store, onInput, onResize }: TerminalSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onInput, onResize });
  useLayoutEffect(() => { callbacks.current = { onInput, onResize }; }, [onInput, onResize]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const shell = element.closest<HTMLElement>('.app-shell') ?? element;
    const terminal = new Terminal({
      fontFamily: getComputedStyle(shell).getPropertyValue('--mono').trim() || 'Menlo, monospace',
      fontSize: 12, lineHeight: 1.15, scrollback: 1200,
      cursorBlink: false, disableStdin: true, altClickMovesCursor: false, theme: readTerminalTheme(shell),
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminal.textarea?.setAttribute('data-testid', 'run-console-input');
    terminal.textarea?.setAttribute('aria-label', 'Run Console input');

    // Ignore terminal control sequences that target host actions.
    const handlers = blockHostTerminalSequences(terminal);
    let live = true;
    let replay = 0;
    let replaying = false;
    let focusedRun = 0;
    let previousSize: { run: number; cols: number; rows: number } | null = null;
    function sendSize(rawCols: number, rawRows: number) {
      const { run } = store.getSnapshot();
      const cols = terminalDimension(rawCols);
      const rows = terminalDimension(rawRows);
      if (previousSize?.run === run && previousSize.cols === cols && previousSize.rows === rows) return;
      previousSize = { run, cols, rows };
      callbacks.current.onResize(cols, rows);
    }
    function updateInput() {
      if (!live) return;
      const state = store.getSnapshot();
      const interactive = state.phase === 'running' && !replaying;
      if (terminal.options.disableStdin === interactive) terminal.options.disableStdin = !interactive;
      if (interactive && state.run !== focusedRun) {
        focusedRun = state.run;
        fit.fit();
        sendSize(terminal.cols, terminal.rows);
        terminal.focus();
      }
    }
    const offOutput = store.subscribeOutput((event) => {
      if (event.kind === 'append') {
        terminal.write(event.text);
      } else {
        const id = ++replay;
        replaying = true;
        updateInput();
        // Queue the reset with the writes so Clear cannot race already-queued bytes.
        terminal.write('\x18\x1bc' + event.parts.join(''), () => {
          if (id === replay) {
            replaying = false;
            updateInput();
          }
        });
      }
    });
    const data = terminal.onData((value) => {
      if (!replaying && store.getSnapshot().phase === 'running') sendTerminalInput(value, callbacks.current.onInput);
    });
    const resizing = terminal.onResize(({ cols, rows }) => sendSize(cols, rows));
    const offState = store.subscribe(updateInput);
    updateInput();

    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; fit.fit(); });
    });
    observer.observe(element);
    fit.fit();
    sendSize(terminal.cols, terminal.rows);
    const appearance = new MutationObserver(() => { terminal.options.theme = readTerminalTheme(shell); });
    appearance.observe(shell, { attributes: true, attributeFilter: ['style', 'data-theme'] });

    return () => {
      live = false;
      cancelAnimationFrame(resizeFrame);
      appearance.disconnect();
      observer.disconnect();
      offState();
      offOutput();
      data.dispose();
      resizing.dispose();
      for (const handler of handlers) handler.dispose();
      terminal.dispose();
    };
  }, [store]);

  return <div className="run-terminal" data-testid="run-console-terminal">
    <div className="run-terminal-host" ref={host}/>
  </div>;
}
