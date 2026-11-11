import { execFile } from 'node:child_process'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const windows = process.platform === 'win32'
const name = windows ? 'ion-file-ops.exe' : 'ion-file-ops'
const nativeCodes = /^(?:EEXIST|ENOENT|EACCES|EPERM|EBUSY|ENOTSUP|EXDEV|SCOPE_CHANGED|BACKUP_RETAINED|FILE_OPERATION_FAILED)$/

export interface FileMutations {
  rename(source: string, target: string, parent: BigIntStats, caseOnly?: boolean): Promise<void>
  replace(source: string, target: string, parent: BigIntStats, backup: string): Promise<void>
  prepare(target: string, parent: BigIntStats, mode: number, kind: 'file' | 'folder', input?: string): Promise<void>
  move(source: string, target: string, from: BigIntStats, to: BigIntStats): Promise<void>
}

export function fileMutations(executable = process.env.ION_FILE_MUTATIONS_TEST_HELPER
  || join(__dirname, '..', 'native', name)): FileMutations {
  function run(args: string[], input = ''): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, args, { windowsHide: true, timeout: 15_000, maxBuffer: 2048 }, (reason, _stdout, stderr) => {
        if (!reason) return resolve()
        const detail = stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
        const code = nativeCodes.test(detail) ? detail : 'FILE_OPERATION_FAILED'
        const message = code === 'EEXIST' ? 'A file or folder with that name already exists.'
          : code === 'SCOPE_CHANGED' ? 'The destination folder changed. Reopen the folder and try again.'
          : code === 'ENOTSUP' ? 'This volume does not support safe replacement. Use Save As on a local volume.'
          : code === 'EXDEV' ? 'Use the system file manager to move this item across volumes.'
          : code === 'BACKUP_RETAINED' ? 'A competing change interrupted the file operation.'
          : 'Ion could not safely update this file.'
        reject(Object.assign(new Error(message, { cause: reason }), { code }))
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(input, 'utf8')
    })
  }
  const identity = (stats: BigIntStats) => [String(stats.dev), String(stats.ino)]
  return {
    rename: (source, target, parent, caseOnly = false) => run(['rename', dirname(target), basename(source), basename(target),
      ...identity(parent), caseOnly ? '1' : '0']),
    replace: (source, target, parent, backup) => run(['replace', dirname(target), basename(source), basename(target),
      ...identity(parent), basename(backup)]),
    prepare: (target, parent, mode, kind, input) => run(['prepare', dirname(target), basename(target),
      ...identity(parent), mode.toString(8), kind], input),
    move: (source, target, from, to) => run(['move', dirname(source), basename(source), dirname(target), basename(target),
      ...identity(from), ...identity(to)]),
  }
}
