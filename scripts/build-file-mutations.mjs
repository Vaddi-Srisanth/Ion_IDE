import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { buildWindowsFileMutations } from './windows/build-pty.mjs'

const run = promisify(execFile)

export async function buildFileMutations(destination, platform = process.platform, arch = process.arch) {
  await mkdir(dirname(destination), { recursive: true })
  if (platform === 'win32') return buildWindowsFileMutations(destination, arch)
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'src/main/native-file-mutations.c', '-o', destination]
  if (platform === 'darwin') {
    return run('/usr/bin/xcrun', ['clang', '-D_DARWIN_C_SOURCE', '-arch', arch === 'x64' ? 'x86_64' : arch,
      '-mmacosx-version-min=13.0', ...args])
  }
  return run('cc', args)
}
