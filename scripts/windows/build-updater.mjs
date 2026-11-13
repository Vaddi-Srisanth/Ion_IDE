import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { windowsSigningOptions } from './signing.mjs'

const run = promisify(execFile)
const quiet = { windowsHide: true, timeout: 90_000 }

async function environment() {
  if (process.env.VSCMD_ARG_TGT_ARCH === 'x64' && process.env.INCLUDE && process.env.LIB) return process.env
  const programFiles = process.env['ProgramFiles(x86)']
  if (!programFiles) throw new Error('Build the Windows updater in an x64 Visual Studio Developer Command Prompt.')
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
  const result = {}
  for (const line of prepared.stdout.split(/\r?\n/)) {
    const equals = line.indexOf('=')
    if (equals > 0) result[line.slice(0, equals)] = line.slice(equals + 1)
  }
  if (!result.INCLUDE || !result.LIB) throw new Error('The x64 compiler environment did not initialize.')
  return result
}

async function requireX64Executable(path) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(64)
    const pe = Buffer.alloc(6)
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || header.readUInt16LE() !== 0x5a4d
      || (await file.read(pe, 0, pe.length, header.readUInt32LE(60))).bytesRead !== pe.length
      || pe.readUInt32LE() !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error('The supplied Windows updater is not a Windows x64 executable.')
    }
  } finally { await file.close() }
}

export async function buildWindowsUpdater(destination, arch) {
  if (arch !== 'x64') throw new Error('The Windows updater currently targets x64.')
  await mkdir(dirname(destination), { recursive: true })
  if (process.platform !== 'win32') {
    const prebuilt = process.env.ION_WINDOWS_UPDATE_EXE
    if (!prebuilt) throw new Error('A cross-build requires the verified Windows x64 update helper.')
    await requireX64Executable(prebuilt)
    await copyFile(prebuilt, destination)
    return
  }
  const env = await environment()
  const scratch = await mkdtemp(join(tmpdir(), 'ion-updater-build-'))
  try {
    const { version } = JSON.parse(await readFile('package.json', 'utf8'))
    const parts = typeof version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version) ? version.split('.').map(Number) : []
    if (parts.length !== 3 || parts.some(part => part > 65535)) throw new Error('The Windows updater requires a numeric three-part product version.')
    const publisher = windowsSigningOptions()?.publisher ?? 'Ion IDE'
    const resource = join(scratch, 'updater.rc')
    const compiledResource = join(scratch, 'updater.res')
    // Publisher validation forbids control/preprocessor/escape characters.
    // UTF-16 keeps non-ASCII certificate publisher names exact in VERSIONINFO.
    const rc = '\ufeff#include <winver.h>\r\n1 VERSIONINFO\r\n'
      + 'FILEVERSION ' + [...parts, 0].join(',') + '\r\nPRODUCTVERSION ' + [...parts, 0].join(',') + '\r\n'
      + 'FILEFLAGSMASK 0x3fL\r\nFILEFLAGS 0\r\nFILEOS VOS_NT_WINDOWS32\r\nFILETYPE VFT_APP\r\nFILESUBTYPE 0\r\nBEGIN\r\n'
      + ' BLOCK "StringFileInfo"\r\n BEGIN\r\n  BLOCK "040904B0"\r\n  BEGIN\r\n'
      + '   VALUE "CompanyName", "' + publisher + '\\0"\r\n'
      + '   VALUE "FileDescription", "Ion IDE update helper\\0"\r\n'
      + '   VALUE "OriginalFilename", "ion-update.exe\\0"\r\n'
      + '   VALUE "ProductName", "Ion IDE\\0"\r\n'
      + '   VALUE "FileVersion", "' + version + '\\0"\r\n'
      + '   VALUE "ProductVersion", "' + version + '\\0"\r\n'
      + '  END\r\n END\r\n BLOCK "VarFileInfo"\r\n BEGIN\r\n  VALUE "Translation", 0x409, 1200\r\n END\r\nEND\r\n'
    await writeFile(resource, Buffer.from(rc, 'utf16le'))
    await run('rc.exe', ['/nologo', '/fo', compiledResource, resource], { ...quiet, cwd: scratch, env })
    await run('cl.exe' , ['/nologo', '/std:c++17', '/O2', '/W4', '/EHsc', '/MT', '/DUNICODE', '/D_UNICODE',
      resolve('src/main/update-helper-win.cpp'), compiledResource, '/Fe:' + resolve(destination),
      '/link', '/SUBSYSTEM:WINDOWS', '/ENTRY:wmainCRTStartup', 'bcrypt.lib', 'shell32.lib', 'ole32.lib', 'version.lib', 'uuid.lib', 'advapi32.lib'],
    { ...quiet, cwd: scratch, env })
    await requireX64Executable(destination)
  } catch (error) {
    if (error?.stdout) console.error(error.stdout.trim())
    throw error
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
