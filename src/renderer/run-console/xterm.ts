import type { ITheme, Terminal } from '@xterm/xterm';

// Even three UTF-8 bytes per code unit fit the helper's 16 KiB frame and 64 KiB queue.
const inputChunk = 5_000;
export const terminalDimension = (value: number) => Math.max(2, Math.min(512, value));

function safeSliceEnd(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  return end < text.length && previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end;
}

export function sendTerminalInput(text: string, send: (chunk: string) => void, pasteLimit = 16_000): boolean {
  // Reject the entire paste before sending any prefix. A clipped command or
  // program input can mean something different from what the user submitted.
  if (text.length > pasteLimit) return false;
  for (let start = 0; start < text.length;) {
    const end = safeSliceEnd(text, Math.min(text.length, start + inputChunk));
    send(text.slice(start, end));
    start = end;
  }
  return true;
}

export function readTerminalTheme(shell: HTMLElement): ITheme {
  const style = getComputedStyle(shell);
  const color = (token: string, fallback: string) => style.getPropertyValue(token).trim() || fallback;
  const light = shell.dataset.theme === 'light';
  return {
    background: color('--panel', '#121620'),
    foreground: color('--text', '#bdc8d7'),
    cursor: color('--accent', '#7be7db'),
    cursorAccent: color('--accent-ink', '#062520'),
    selectionBackground: color('--accent-bg', '#1c3439'),
    selectionForeground: color('--ink', '#e9eff8'),
    black: light ? '#282d35' : '#232832',
    brightBlack: color('--muted', '#91a0b4'),
    red: color('--danger', '#f1a1a7'),
    brightRed: light ? '#a3243a' : '#ffb5b6',
    green: color('--mint', '#91ddae'),
    brightGreen: light ? '#25704a' : '#b6f6c8',
    yellow: color('--amber', '#ebc394'),
    brightYellow: light ? '#8c5012' : '#ffe0ab',
    blue: light ? '#23579f' : '#9dbff7',
    brightBlue: light ? '#24487e' : '#c1d7ff',
    magenta: color('--lilac', '#bdabec'),
    brightMagenta: light ? '#733d94' : '#e7cbff',
    cyan: color('--accent', '#7be7db'),
    brightCyan: light ? '#0b756e' : '#abf5ed',
    white: color('--text', '#bdc8d7'),
    brightWhite: color('--ink', '#e9eff8'),
  };
}

export function blockHostTerminalSequences(terminal: Terminal) {
  return [0, 1, 2, 8, 52].map((code) => terminal.parser.registerOscHandler(code, () => true));
}
