import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const quiet = { windowsHide: true, timeout: 90_000 }

async function compilerEnvironment() {
  if (process.env.VSCMD_ARG_TGT_ARCH === 'x64' && process.env.INCLUDE && process.env.LIB) return process.env
  const programFiles = process.env['ProgramFiles(x86)']
  if (!programFiles) throw new Error('Build the Windows terminal in an x64 Visual Studio Developer Command Prompt.')
  const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], quiet)
  const install = stdout.trim()
  if (!isAbsolute(install) || /["%\r\n]/.test(install)) throw new Error('Install the Visual Studio C++ x64 tools and Windows SDK.')
  const setup = join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const prepared = await run(cmd, ['/d', '/v:off', '/s', '/c', `""${setup}" >nul && set"`], {
    ...quiet, windowsVerbatimArguments: true,
  })
  const env = {}
  for (const line of prepared.stdout.split(/\r?\n/)) {
    const equals = line.indexOf('=')
    if (equals > 0) env[line.slice(0, equals)] = line.slice(equals + 1)
  }
  if (!env.INCLUDE || !env.LIB) throw new Error('The x64 compiler environment did not initialize.')
  return env
}

async function requireX64Executable(path) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(64)
    const pe = Buffer.alloc(6)
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length || header.readUInt16LE() !== 0x5a4d
      || (await handle.read(pe, 0, pe.length, header.readUInt32LE(60))).bytesRead !== pe.length
      || pe.readUInt32LE() !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error('The supplied Windows PTY helper is not a Windows x64 executable.')
    }
  } finally {
    await handle.close()
  }
}

export async function buildWindowsPty(destination, arch) {
  if (arch !== 'x64') throw new Error('The Windows PTY helper currently targets x64.')
  if (process.platform !== 'win32') {
    const prebuilt = process.env.ION_WINDOWS_PTY_EXE
    if (!prebuilt) {
      console.log('Cross-build without a Windows PTY helper. Run Console will use line input.')
      return
    }
    await requireX64Executable(prebuilt)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(prebuilt, destination)
    return
  }
  const env = await compilerEnvironment()
  const scratch = await mkdtemp(join(tmpdir(), 'ion-conpty-build-'))
  try {
    await mkdir(dirname(destination), { recursive: true })
    await run('cl.exe', ['/nologo', '/std:c++17', '/O2', '/W4', '/EHsc', '/MT', '/DUNICODE', '/D_UNICODE',
      resolve('src/main/run-console/pty-windows.cpp'), '/Fe:' + resolve(destination),
      // The parent supplies the three transport pipes. The helper itself needs no console host.
      '/link', '/SUBSYSTEM:WINDOWS', '/ENTRY:wmainCRTStartup'], {
      ...quiet, cwd: scratch, env,
    })
    await requireX64Executable(destination)
  } catch (error) {
    if (error?.stdout) console.error(error.stdout.trim())
    if (error?.stderr) console.error(error.stderr.trim())
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
