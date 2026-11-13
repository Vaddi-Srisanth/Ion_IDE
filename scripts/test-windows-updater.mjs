import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { eventually, requireVisibleDesktop } from './desktop-harness.mjs'
import { buildWindowsUpdater } from './windows/build-updater.mjs'
import { inspectUpdaterProcesses } from './windows/updater-processes.mjs'

assert.equal(process.platform, 'win32', 'Run this installed-app test on a disposable Windows machine.')
requireVisibleDesktop()
assert.ok(process.env.LOCALAPPDATA && process.env.APPDATA)
const execute = promisify(execFile)
const quiet = { windowsHide: true, timeout: 180000 }
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const installer = resolve(process.argv[2] ?? `release/Ion-IDE-${version}-windows-x64-setup.exe`)
const root = join(process.env.LOCALAPPDATA, 'Programs', 'Ion IDE')
const target = join(root, 'App', 'Ion IDE.exe')
const uninstaller = join(root, 'Uninstall.exe')
const uninstallRegistry = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dev.ionide.desktop'
const installedProfile = join(process.env.APPDATA, 'Ion IDE')
const present = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
assert.equal(await present(root), false, 'Do not run updater integration checks against an existing installation.')
assert.equal(await present(installedProfile), false, 'Do not run updater checks against an existing user profile.')
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-native-updater-')))
const profile = join(scratch, 'profile café 学习')
const stage = join(scratch, 'installer café 学习')
const helper = join(stage, 'ion-update.exe')
const setup = join(stage, `Ion-IDE-${version}-windows-x64-setup.exe`)
const digest = createHash('sha256').update(await readFile(installer)).digest('hex')
let child
let browser
let updating
let restartedPid
let activePid
let phase = 'setup'
let primaryError
const processChecks = []
const sourceIdentity = { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null }
const portFile = join(profile, 'DevToolsActivePort')

async function processCandidates() {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |
      Where-Object { $_.ExecutablePath -eq $env:ION_UPDATE_TARGET } | Select-Object -First 65 | ForEach-Object {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId;
          executablePath = [string]$_.ExecutablePath; command = [string]$_.CommandLine;
          created = $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
      })
    ConvertTo-Json -Compress -InputObject $rows
  `], { ...quiet, timeout: 10000, maxBuffer: 512 * 1024,
    env: { ...process.env, ION_UPDATE_TARGET: target } })
  const rows = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
  return Array.isArray(rows) ? rows : rows ? [rows] : []
}

function inspectCandidates(rows, previous, purpose) {
  const inspected = inspectUpdaterProcesses(rows, { target, profile, previous })
  processChecks.push({ phase, purpose, previous: previous ?? null, mainCount: inspected.mainCount,
    selectedPid: inspected.selected?.pid ?? null, candidates: inspected.facts })
  if (processChecks.length > 12) processChecks.shift()
  return inspected
}

async function saveProcessChecks() {
  await mkdir('performance-results', { recursive: true })
  await writeFile('performance-results/windows-updater-diagnostics.json', JSON.stringify({
    phase, checksComplete: false, sourceIdentity, processChecks,
  }, null, 2) + '\n')
}

// .NET MainWindowHandle/CloseMainWindow excludes hidden windows. CI launches
// this disposable app with windowsHide, so enumerate its actual owned Chromium
// frame instead and use the ordinary WM_CLOSE route, never TerminateProcess.
const nativeWindows = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class IonUpdateWindows {
  private delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", SetLastError = true, ExactSpelling = true)] private static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  public static IntPtr[] Find(uint process) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == process) {
        StringBuilder name = new StringBuilder(256);
        GetClassNameW(window, name, name.Capacity);
        if (name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) found.Add(window);
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static bool RequestClose(IntPtr window) { return PostMessageW(window, 0x0010, UIntPtr.Zero, IntPtr.Zero); }
}
`

async function ownedWindows(pid, closeWindows = false) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const inspected = inspectCandidates(await processCandidates(), undefined, closeWindows ? 'normal-close' : 'native-frame')
  const selected = inspected.selected
  assert.ok(selected?.pid === pid, 'Refusing to act outside the unique exact disposable Ion main process/profile.')
  const script = `
    $ErrorActionPreference = 'Stop'
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:ION_UPDATE_PID)
    if (!$owner -or $owner.ExecutablePath -ne $env:ION_UPDATE_TARGET -or
        $owner.CommandLine -cne $env:ION_UPDATE_COMMAND -or
        $owner.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $env:ION_UPDATE_CREATED) {
      throw 'Refusing to act on a process outside the exact disposable Ion profile.'
    }
    Add-Type -TypeDefinition @'
${nativeWindows}
'@
    $windows = @([IonUpdateWindows]::Find([uint32]$env:ION_UPDATE_PID))
    if ($env:ION_UPDATE_CLOSE -eq '1') {
      if ($windows.Count -eq 0) { throw 'No owned Ion frame accepted a normal close request.' }
      foreach ($window in $windows) {
        if (![IonUpdateWindows]::RequestClose($window)) { throw 'The owned Ion frame could not receive WM_CLOSE.' }
      }
    }
    $windows.Count
  `
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...quiet, env: { ...process.env, ION_UPDATE_PID: String(pid), ION_UPDATE_TARGET: target,
      ION_UPDATE_COMMAND: selected.command, ION_UPDATE_CREATED: selected.created,
      ION_UPDATE_CLOSE: closeWindows ? '1' : '0' },
  })
  return Number(stdout.trim())
}

async function close(pid, page) {
  if (page && !page.isClosed()) {
    // Use the live renderer for the initially CDP-attached session. Context
    // destruction is expected only if the real window/process actually exits.
    await page.evaluate(() => window.close()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error
    })
  } else await ownedWindows(pid, true)
  await eventually(async () => {
    try { process.kill(pid, 0); return false } catch { return true }
  }, 'The owned test application did not close normally.', 20000)
}

async function connect() {
  let port
  await eventually(async () => {
    port = Number(await readFile(portFile, 'utf8').then(text => text.split(/\r?\n/)[0], () => ''))
    if (!port) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      return response.ok
    } catch { return false }
  }, 'The owned app did not start its local test endpoint.', 30000)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 20000 })
  await page.getByTestId('welcome').waitFor({ timeout: 20000 })
  return page
}

function args(extra = {}) {
  return Object.entries({ '--parent': String(activePid ?? child.pid), '--installer': setup, '--target': target,
    '--sha256': digest, '--version': version, '--profile': profile, ...extra }).flat()
}

async function findRestart(previous) {
  let foundPid
  try {
    await eventually(async () => {
      const inspected = inspectCandidates(await processCandidates(), previous, 'restart-selection')
      foundPid = inspected.selected?.pid
      return Boolean(foundPid)
    }, 'Ion did not restart with the same private profile.', 30000)
    // A native window and a fresh creation-identity recheck establish that the
    // uniquely selected exact-profile main got beyond process launch.
    await eventually(async () => await ownedWindows(foundPid) > 0,
      'The restarted Ion process did not create its native frame.', 30000)
  } catch (error) {
    await saveProcessChecks().catch(reason => console.error('Restart candidate receipt unavailable:', reason?.message ?? reason))
    throw error
  }
  await saveProcessChecks()
  return foundPid
}

async function registryValue(name, view = 32) {
  try {
    const { stdout } = await execute('reg.exe', ['query', uninstallRegistry, '/v', name, `/reg:${view}`], quiet)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const value = stdout.match(new RegExp(`^\\s*${escaped}\\s+REG_SZ\\s+(.+)$`, 'm'))
    assert.ok(value, `Expected a string value for ${name}.`)
    return value[1].trim()
  } catch (error) {
    if (error.code === 1) return null
    throw error
  }
}

async function rejected(extra, code) {
  await assert.rejects(execute(helper, args(extra), quiet), error => error.code === code)
  assert.equal(child.exitCode, null, 'A rejected update must not stop Ion.')
}

async function begin(extra = {}) {
  let ready = ''
  let errors = ''
  updating = spawn(helper, args(extra), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  updating.stdout.setEncoding('utf8').on('data', text => { ready += text })
  updating.stderr.setEncoding('utf8').on('data', text => { errors += text })
  const updated = once(updating, 'exit')
  await eventually(() => {
    assert.equal(updating.exitCode, null, errors)
    return ready.includes('READY\n')
  }, 'The updater did not validate and acknowledge readiness.', 30000)
  return { updated, error: () => errors }
}

async function diagnostics(error) {
  try { inspectCandidates(await processCandidates(), undefined, 'final-diagnostics') }
  catch (reason) {
    processChecks.push({ phase, purpose: 'final-diagnostics', unavailable: String(reason?.message ?? reason).slice(0, 500) })
    if (processChecks.length > 12) processChecks.shift()
  }
  const report = { phase, checksComplete: !error && phase === 'complete', sourceIdentity, processChecks,
    primary: error ? { message: String(error?.message ?? error).slice(0, 3000), code: error?.code } : null, receipts: {}, layout: [] }
  for (const [name, path] of [['stage', join(stage, 'result.json')], ['profile', join(profile, 'updates', 'result.json')]]) {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid receipt size/type')
      const value = JSON.parse(await readFile(path, 'utf8'))
      report.receipts[name] = Object.fromEntries(['schemaVersion', 'state', 'version', 'message', 'backupBytes', 'backupMs', 'rollbackOperation', 'rollbackError']
        .filter(key => typeof value[key] === 'string' || typeof value[key] === 'number').map(key => [key, value[key]]))
    } catch (reason) { report.receipts[name] = { unavailable: reason.code ?? reason.message } }
  }
  const backups = (await readdir(root).catch(() => [])).filter(name => /^\.ion-update-(?:backup|failed)-[a-f0-9]{32}$/.test(name)).slice(0, 8)
  for (const relative of ['App/Ion IDE.exe', 'Uninstall.exe', ...backups.flatMap(name => [name, name + '/App/Ion IDE.exe', name + '/Ion IDE.exe', name + '/Uninstall.exe'])]) {
    try {
      const info = await lstat(join(root, ...relative.split('/')))
      const item = { relative, size: info.size, directory: info.isDirectory(), symlink: info.isSymbolicLink() }
      // Files here belong only to the disposable install. Hash bounded files;
      // never print document contents or unrestricted directory listings.
      if (info.isFile() && !info.isSymbolicLink() && info.size < 256 * 1024 * 1024) {
        item.sha256 = createHash('sha256').update(await readFile(join(root, ...relative.split('/')))).digest('hex')
      }
      report.layout.push(item)
    } catch (reason) { report.layout.push({ relative, unavailable: reason.code ?? reason.message }) }
  }
  if (error) console.error('PRIMARY WINDOWS UPDATER FAILURE:', error?.stack ?? error)
  console.error('WINDOWS UPDATER DIAGNOSTICS:', JSON.stringify(report))
  await mkdir('performance-results', { recursive: true })
  await writeFile('performance-results/windows-updater-diagnostics.json', JSON.stringify(report, null, 2) + '\n')
}

try {
  await mkdir(profile)
  await mkdir(stage)
  await copyFile(installer, setup)
  await buildWindowsUpdater(helper, 'x64')
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$v=(Get-Item -LiteralPath $env:ION_UPDATE_HELPER).VersionInfo; if($v.CompanyName -cne $env:ION_UPDATE_PUBLISHER -or $v.ProductVersion -cne $env:ION_UPDATE_VERSION) { throw "Updater VERSIONINFO did not match publisher/version" }'],
  { ...quiet, env: { ...process.env, ION_UPDATE_HELPER: helper, ION_UPDATE_VERSION: version,
    ION_UPDATE_PUBLISHER: process.env.ION_WIN_SIGN === '1' ? process.env.ION_WIN_SIGN_PUBLISHER : 'Ion IDE' } })
  const prefs = JSON.stringify({ version: 1, settings: { autoSave: false, openFullScreen: false }, recents: [] })
  await writeFile(join(profile, 'preferences.json'), prefs)
  await writeFile(join(scratch, 'user-code.c'), '#include <stdio.h>\nint main(void) { return 0; }\n')
  await writeFile(`${setup}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
  // Prefer the actual previous release to prove an upgrade, not just a reinstall.
  const initial = process.env.ION_PREVIOUS_WINDOWS_INSTALLER ? resolve(process.env.ION_PREVIOUS_WINDOWS_INSTALLER) : installer
  await execute(initial, ['/S'], quiet)
  await writeFile(join(root, 'App', 'unowned-test-file.txt'), 'Preserve this file')
  child = spawn(target, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { stdio: 'ignore', windowsHide: true })
  const page = await connect()
  assert.equal((await page.evaluate(() => window.ion.updates.status())).current,
    process.env.ION_PREVIOUS_WINDOWS_INSTALLER ? '0.9.6' : version)
  console.log('PASS real installed Ion starts with a separate Unicode test profile.')

  phase = 'security-rejections'

  await rejected({ '--target': join(scratch, 'Ion IDE.exe') }, 3)
  await rejected({ '--parent': String(process.pid) }, 4)
  await rejected({ '--sha256': '0'.repeat(64) }, 5)
  await rejected({ '--version': '999.0.0' }, 5)
  await rejected({ '--timeout-ms': '25' }, 6)
  const timedOut = JSON.parse(await readFile(join(stage, 'result.json'), 'utf8'))
  assert.equal(timedOut.state, 'failed')
  assert.match(timedOut.message, /did not exit/)
  assert.equal(await readFile(join(root, 'App', 'unowned-test-file.txt'), 'utf8'), 'Preserve this file')
  assert.equal(await readFile(`${setup}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n')
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'updates', 'result.json'), 'utf8')), timedOut)
  console.log('PASS wrong target, unrelated parent, wrong checksum/version and natural-exit timeout preserve the running application.')

  // A tiny explicitly-owned test installer corrupts only this disposable
  // installed executable, uninstaller and version metadata before failing.
  // This proves rollback restores real bytes and the exact old DisplayVersion.
  const failureSetup = join(stage, 'failure-fixture.exe')
  const failureSource = [
    'Unicode true', 'Name "Ion updater failure fixture"', 'OutFile "failure-fixture.exe"',
    'RequestExecutionLevel user', `VIProductVersion "${version}.0"`,
    `VIAddVersionKey "ProductVersion" "${version}"`, 'Section',
    'ClearErrors',
    'FileOpen $0 "$LOCALAPPDATA\\Programs\\Ion IDE\\App\\Ion IDE.exe" w',
    'IfErrors failed',
    'FileWrite $0 "Deliberately damaged disposable test executable"', 'FileClose $0',
    'ClearErrors',
    'FileOpen $0 "$LOCALAPPDATA\\Programs\\Ion IDE\\Uninstall.exe" w',
    'IfErrors failed',
    'FileWrite $0 "Deliberately damaged disposable test uninstaller"', 'FileClose $0',
    'ClearErrors',
    'WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dev.ionide.desktop" "DisplayVersion" "999.9.9"',
    'WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dev.ionide.desktop" "IonUpdaterTestMarker" "Preserve unrelated registry values"',
    'IfErrors failed',
    'FileOpen $0 "$LOCALAPPDATA\\Programs\\Ion IDE\\updater-fixture-mutated.txt" w',
    'FileWrite $0 "The disposable executable was changed"', 'FileClose $0', 'failed:',
    'SetErrorLevel 77', 'Quit', 'SectionEnd', '',
  ].join('\n')
  await writeFile(join(stage, 'failure-fixture.nsi'), failureSource)
  const makensis = process.env.ION_MAKENSIS ?? join(process.env['ProgramFiles(x86)'], 'NSIS', 'makensis.exe')
  await execute(makensis, ['/V2', 'failure-fixture.nsi'], { ...quiet, cwd: stage })
  const originalInstalledHash = createHash('sha256').update(await readFile(target)).digest('hex')
  const originalUninstallerHash = createHash('sha256').update(await readFile(uninstaller)).digest('hex')
  const originalVersions = await Promise.all([32, 64].map(view => registryValue('DisplayVersion', view)))
  phase = 'failing-installer-rollback'
  const failedInstall = await begin({ '--installer': failureSetup,
    '--sha256': createHash('sha256').update(await readFile(failureSetup)).digest('hex') })
  await rm(portFile, { force: true })
  await close(child.pid, page)
  assert.deepEqual(await Promise.race([failedInstall.updated, sleep(180000, undefined, { ref: false }).then(() => 'timeout')]),
    [8, null], failedInstall.error())
  const rollback = JSON.parse(await readFile(join(stage, 'result.json'), 'utf8'))
  assert.equal(rollback.state, 'failed')
  assert.match(rollback.message, /previous application and installer metadata were restored/)
  assert.equal(await readFile(join(root, 'updater-fixture-mutated.txt'), 'utf8'), 'The disposable executable was changed')
  await rm(join(root, 'updater-fixture-mutated.txt'))
  assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'), originalInstalledHash)
  assert.equal(createHash('sha256').update(await readFile(uninstaller)).digest('hex'), originalUninstallerHash)
  assert.deepEqual(await Promise.all([32, 64].map(view => registryValue('DisplayVersion', view))), originalVersions)
  assert.equal(await registryValue('IonUpdaterTestMarker'), 'Preserve unrelated registry values')
  assert.ok(rollback.backupBytes > 0 && rollback.backupMs >= 0)
  activePid = await findRestart(child.pid)
  console.log('PASS a failing native installer damages the disposable executable/uninstaller/DisplayVersion; rollback restores exact bytes and versions, preserves unrelated registry values and restarts the same profile.')

  // This integration fixture is locally built, not an internet download. The
  // previous rejection cases verify an Internet-zone mark is retained. Use the
  // Local-Machine zone for unattended setup; never auto-approve SmartScreen or
  // remove marks from a user's downloaded installer. A real marked installer
  // may require native user consent and is a separate manual release check.
  await writeFile(`${setup}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=0\r\n')

  phase = 'real-upgrade'
  const successful = await begin()
  await assert.rejects(writeFile(setup, 'untrusted replacement'), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code))
  assert.equal(createHash('sha256').update(await readFile(setup)).digest('hex'), digest)
  assert.equal(await readFile(`${setup}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=0\r\n')
  assert.doesNotThrow(() => process.kill(activePid, 0), 'The updater waits without killing its parent.')
  await rm(portFile, { force: true })
  const priorPid = activePid
  await close(priorPid)
  activePid = undefined
  assert.deepEqual(await Promise.race([successful.updated, sleep(180000, undefined, { ref: false }).then(() => 'timeout')]),
    [0, null], successful.error())
  const receipt = JSON.parse(await readFile(join(stage, 'result.json'), 'utf8'))
  assert.equal(receipt.state, 'installed')
  assert.equal(receipt.version, version)
  // Identify only the app restarted by the helper with our exact private profile.
  restartedPid = await findRestart(priorPid)
  assert.ok(Number.isSafeInteger(restartedPid) && restartedPid > 0 && restartedPid !== child.pid)
  assert.equal(JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8')).settings.autoSave, false)
  assert.equal(await readFile(join(root, 'App', 'unowned-test-file.txt'), 'utf8'), 'Preserve this file')
  assert.match(await readFile(join(scratch, 'user-code.c'), 'utf8'), /stdio/)
  assert.equal(await present(join(root, 'App', 'resources', 'ion-update.exe')), true)
  assert.equal(await readFile(`${setup}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=0\r\n')
  await close(restartedPid)
  restartedPid = undefined
  await rm(join(root, 'App', 'unowned-test-file.txt'))
  console.log('PASS real local-fixture installer upgrades in place, restarts the same Unicode profile, preserves code/settings/unowned files and retains the zone metadata.')
  phase = 'complete'
  await diagnostics()
} catch (error) {
  primaryError = error
  // Print the primary failure before teardown can encounter a damaged binary.
  console.error('PRIMARY WINDOWS UPDATER FAILURE PHASE:', phase, error?.stack ?? error)
  try { await diagnostics(error) } catch (reason) { console.error('Updater diagnostics unavailable:', reason?.message ?? reason) }
  throw error
} finally {
  const cleanupErrors = []
  const safely = async (label, operation) => {
    try { await operation() } catch (error) {
      cleanupErrors.push(error)
      console.error('Windows updater teardown warning:', label, error?.message ?? error)
    }
  }
  for (const pid of [restartedPid, activePid, child?.exitCode === null ? child.pid : undefined]) {
    if (pid) await safely('owned application process', () => execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], quiet))
  }
  if (updating?.exitCode === null) await safely('owned update process', () => execute('taskkill.exe', ['/PID', String(updating.pid), '/T', '/F'], quiet))
  if (browser) await safely('test CDP connection', () => Promise.race([browser.close(), sleep(2000)]))
  await safely('fixture marker', () => rm(join(root, 'App', 'unowned-test-file.txt'), { force: true }))
  await safely('mutation proof', () => rm(join(root, 'updater-fixture-mutated.txt'), { force: true }))
  await safely('disposable uninstaller', async () => {
    if (await present(uninstaller)) await execute(uninstaller, ['/S'], quiet)
  })
  await safely('private test folder', () => rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }))
  if (!primaryError && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'The updater passed, but its disposable resources did not clean up.')
}
