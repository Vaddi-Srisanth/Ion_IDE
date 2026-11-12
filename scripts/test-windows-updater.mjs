import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { eventually, requireVisibleDesktop } from './desktop-harness.mjs'
import { buildWindowsUpdater } from './windows/build-updater.mjs'

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
const scratch = await mkdtemp(join(tmpdir(), 'ion-native-updater-'))
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
const portFile = join(profile, 'DevToolsActivePort')

async function close(pid) {
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `if (!(Get-Process -Id ${pid}).CloseMainWindow()) { exit 1 }`], quiet)
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
  await eventually(async () => {
    const found = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:ION_UPDATE_TARGET -and $_.CommandLine.Contains($env:ION_UPDATE_PROFILE) }); if ($p.Count -ne 1) { exit 1 }; $p[0].ProcessId'],
    { ...quiet, env: { ...process.env, ION_UPDATE_TARGET: target, ION_UPDATE_PROFILE: profile } }).catch(() => null)
    foundPid = Number(found?.stdout.trim())
    return Number.isSafeInteger(foundPid) && foundPid > 0 && foundPid !== previous
  }, 'Ion did not restart with the same private profile.', 30000)
  // A native window establishes that the restarted process got beyond launch.
  await eventually(async () => {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${foundPid}).MainWindowHandle`], quiet)
    return Number(stdout.trim()) !== 0
  }, 'The restarted Ion process did not create its window.', 30000)
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

try {
  await mkdir(profile)
  await mkdir(stage)
  await copyFile(installer, setup)
  await buildWindowsUpdater(helper, 'x64')
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
  const failedInstall = await begin({ '--installer': failureSetup,
    '--sha256': createHash('sha256').update(await readFile(failureSetup)).digest('hex') })
  await rm(portFile, { force: true })
  await close(child.pid)
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
} finally {
  for (const pid of [restartedPid, activePid, child?.exitCode === null ? child.pid : undefined]) {
    if (pid) await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], quiet).catch(() => {})
  }
  if (updating?.exitCode === null) await execute('taskkill.exe', ['/PID', String(updating.pid), '/T', '/F'], quiet).catch(() => {})
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2000)])
  await rm(join(root, 'App', 'unowned-test-file.txt'), { force: true })
  await rm(join(root, 'updater-fixture-mutated.txt'), { force: true })
  if (await present(uninstaller)) await execute(uninstaller, ['/S'], quiet).catch(() => {})
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
