import { fileLanguage } from '../shared/languages';

export function basename(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path;
}

export function isWithin(path: string, parent: string, platform = window.ion.platform): boolean {
  // Windows may return the same canonical file identity with different drive or
  // component casing. This helper controls renderer scoping only; main-process
  // filesystem authority still validates canonical paths at every boundary.
  const candidate = platform === 'win32' ? path.replaceAll('/', '\\').toLowerCase() : path;
  const root = platform === 'win32' ? parent.replaceAll('/', '\\').toLowerCase() : parent;
  if (candidate === root) return true;
  if (/[/\\]$/.test(root)) return candidate.startsWith(root);
  return candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`);
}

export function sourceControlPathKey(path: string): string {
  return window.ion.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
}

export function languageFor(name: string): { id: string; label: string } {
  const language = fileLanguage(name);
  return { id: language.syntax ?? 'plaintext', label: language.label };
}
