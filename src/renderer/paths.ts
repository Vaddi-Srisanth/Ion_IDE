import { fileLanguage } from '../shared/languages';

export function basename(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path;
}

export function isWithin(path: string, parent: string): boolean {
  if (path === parent) return true;
  if (/[/\\]$/.test(parent)) return path.startsWith(parent);
  return path.startsWith(`${parent}/`) || path.startsWith(`${parent}\\`);
}

export function sourceControlPathKey(path: string): string {
  return window.ion.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
}

export function languageFor(name: string): { id: string; label: string } {
  const language = fileLanguage(name);
  return { id: language.syntax ?? 'plaintext', label: language.label };
}
