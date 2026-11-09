import { runLanguage } from './run-console'

export const starterLanguages = [
  { id: 'c', label: 'C', extension: 'c', suggestedName: 'main.c' },
  { id: 'cpp', label: 'C++', extension: 'cpp', suggestedName: 'main.cpp' },
  { id: 'java', label: 'Java', extension: 'java', suggestedName: 'Main.java' },
  { id: 'python', label: 'Python', extension: 'py', suggestedName: 'main.py' },
  { id: 'javascript', label: 'JavaScript', extension: 'js', suggestedName: 'main.js' },
  { id: 'typescript', label: 'TypeScript', extension: 'ts', suggestedName: 'main.ts' },
  { id: 'html', label: 'HTML', extension: 'html', suggestedName: 'index.html' },
  { id: 'css', label: 'CSS', extension: 'css', suggestedName: 'styles.css' },
  { id: 'go', label: 'Go', extension: 'go', suggestedName: 'main.go' },
  { id: 'rust', label: 'Rust', extension: 'rs', suggestedName: 'main.rs' },
  { id: 'shell', label: 'Shell', extension: 'sh', suggestedName: 'script.sh' },
  { id: 'sql', label: 'SQL', extension: 'sql', suggestedName: 'query.sql' },
] as const

export type StarterLanguage = typeof starterLanguages[number]

const aliases: Partial<Record<string, StarterLanguage['id']>> = {
  jsx: 'javascript', tsx: 'typescript', htm: 'html', bash: 'shell', zsh: 'shell',
}

function basename(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? ''
}

function extension(file: string): string {
  const separator = file.lastIndexOf('.')
  return separator === -1 ? '' : file.slice(separator + 1).toLowerCase()
}

export function starterLanguageFor(name: string): StarterLanguage | undefined {
  const file = basename(name)
  const suffix = extension(file)
  const id = runLanguage(file) ?? (Object.hasOwn(aliases, suffix) ? aliases[suffix] : undefined)
  return starterLanguages.find((language) => id ? language.id === id : language.extension === suffix)
}

const reservedJavaNames = new Set(
  ('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally ' +
    'float for goto if implements import instanceof int interface long native new package private protected public return short ' +
    'static strictfp super switch synchronized this throw throws transient try void volatile while _ false null true ' +
    'exports module non-sealed open opens permits provides record requires sealed to transitive uses var when with yield').split(' '),
)

function javaDeclaration(fileName: string, portable: boolean): string {
  const file = basename(fileName)
  const name = extension(file) === 'java' ? file.slice(0, -'.java'.length) : ''
  return !portable && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reservedJavaNames.has(name)
    ? 'public class ' + name + ' {'
    : 'class Main {'
}

export function starterCode(
  language: StarterLanguage,
  fileName: string,
  options: { portableJava?: boolean } = {},
): { text: string; line: number; column: number } {
  const body = '    '
  const make = (lines: readonly string[], line: number) => ({
    text: lines.join('\n') + '\n', line, column: lines[line - 1].length + 1,
  })

  switch (language.id) {
    case 'c':
      return make(['#include <stdio.h>', '', 'int main(void) {', body, '    return 0;', '}'], 4)
    case 'cpp':
      return make(['#include <iostream>', '', 'int main() {', body, '    return 0;', '}'], 4)
    case 'java':
      return make([javaDeclaration(fileName, options.portableJava === true),
        '    public static void main(String[] args) {', body + body, '    }', '}'], 3)
    case 'python':
      return make(['def main():', body, '    pass', '', '', 'if __name__ == "__main__":', '    main()'], 2)
    case 'javascript':
      return make(['function main() {', body, '}', '', 'main();'], 2)
    case 'typescript':
      return make(['function main(): void {', body, '}', '', 'main();'], 2)
    case 'html':
      return make(['<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">', '  <title>Document</title>',
        '</head>', '<body>', '  ', '</body>', '</html>'], 9)
    case 'css':
      return make([':root {', '  ', '}'], 2)
    case 'go':
      return make(['package main', '', 'func main() {', '\t', '}'], 4)
    case 'rust':
      return make(['fn main() {', body, '}'], 2)
    case 'shell':
      return make([extension(basename(fileName)) === 'zsh' ? '#!/usr/bin/env zsh' : '#!/usr/bin/env bash', ''], 2)
    case 'sql':
      return make(['-- Write your SQL here.', ''], 2)
  }
}
