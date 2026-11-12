import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { buildWindowsUpdater } from './windows/build-updater.mjs'

export async function buildUpdater(destination, platform, arch) {
  await mkdir(dirname(destination), { recursive: true })
  if (platform === 'win32') return buildWindowsUpdater(destination, arch)
  if (platform !== 'darwin') return
  await promisify(execFile)('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
    '-arch', arch === 'x64' ? 'x86_64' : arch, '-mmacosx-version-min=13.0', 'src/main/update-helper-mac.m',
    '-framework', 'AppKit', '-framework', 'Security', '-o', destination])
}
