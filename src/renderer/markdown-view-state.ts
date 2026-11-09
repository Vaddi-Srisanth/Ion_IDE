import { isMarkdownFile } from '../shared/markdown-path';

export type MarkdownMode = 'source' | 'preview' | 'split';

const key = 'ion.markdown-views.v1';
export const markdownHistoryLimit = 100;

export function readMarkdownModes(): Map<string, MarkdownMode> {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored || stored.length > 450_000) return new Map();
    const entries: unknown = JSON.parse(stored);
    if (Array.isArray(entries)) return new Map(entries.slice(-markdownHistoryLimit).filter((entry) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length <= 4096
      && isMarkdownFile(entry[0]) && (entry[1] === 'preview' || entry[1] === 'split')));
  } catch { /* The current window still works if local storage is unavailable. */ }
  return new Map();
}

export function writeMarkdownModes(modes: Map<string, MarkdownMode>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...modes].filter(([path]) => !path.startsWith('tab:') && path.length <= 4096)));
  } catch { /* Keep the in-memory mode even if local storage is unavailable. */ }
}
