import { win32 } from 'node:path'
import { hasExactProfileOption, windowsArguments } from '../process-family.mjs'

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && win32.isAbsolute(left) && win32.isAbsolute(right)
  && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()

// WQL escaping is distinct from PowerShell quoting. Pass the resulting filter
// as environment data, never as interpolated PowerShell source. Exact equality
// deliberately gives %, _ and [] no wildcard meaning.
export function updaterProcessFilter(target) {
  if (typeof target !== 'string' || !win32.isAbsolute(target) || target.length > 32768 || /[\x00-\x1f]/.test(target)) {
    throw new Error('Expected an absolute Windows updater target path.')
  }
  return "ExecutablePath = '" + target.replace(/[\\'"]/g, value => '\\' + value) + "'"
}

export function updaterQueryStages(stderr) {
  return String(stderr ?? '').split(/\r?\n/).slice(0, 64).flatMap(line => {
    const match = /^ION_CIM_PHASE (boot|query-start|query-end|json-end) (\d+(?:\.\d+)?)$/.exec(line)
    return match ? [{ phase: match[1], ms: Number(match[2]) }] : []
  })
}

export function rememberUpdaterProcesses(owners, inspected) {
  for (const row of inspected.owned) {
    owners.set(`${row.pid}:${row.created}`, { ...row })
    if (owners.size > 64) throw new Error('The disposable process ownership bound was exceeded.')
  }
}

export function assertUpdaterProcessesDrained(rows) {
  // This is the server-filtered executable-path snapshot, before any main-only
  // role selection. Children, malformed rows and another profile all prevent
  // uninstalling the disposable executable; none authorize termination.
  if (!Array.isArray(rows) || rows.length !== 0) {
    throw new Error('The disposable target process snapshot is not empty after cleanup; refusing uninstall.')
  }
}

// Test infrastructure only. These facts select a disposable installed-app
// fixture; they do not grant an updater capability or replace native checks.
export function inspectUpdaterProcesses(rows, { target, profile, previous }) {
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('The updater process snapshot exceeded its bound.')
  const inspected = rows.map(row => {
    const command = typeof row.command === 'string' && row.command.length <= 32768 ? row.command : ''
    const args = windowsArguments(command)
    const type = args.find(arg => arg === '--type' || arg.startsWith('--type='))
    const profiles = args.filter(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
    const targetMatch = samePath(row.executablePath, target) && samePath(args[0], target)
    const profileMatch = profiles.length === 1 && hasExactProfileOption(command, '--user-data-dir', profile, 'win32')
    const identityValid = Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parent)
      && row.parent >= 0 && typeof row.created === 'string' && /^\d{1,20}$/.test(row.created)
    const role = type === undefined ? 'main' : type === '--type' ? 'child' : type.slice(7, 87) || 'child'
    return { row, fact: { pid: row.pid, parent: row.parent, created: row.created, role,
      targetMatch, profileMatch, profileArgumentCount: profiles.length, newPid: row.pid !== previous },
      main: identityValid && targetMatch && profileMatch && type === undefined }
  })
  const mains = inspected.filter(item => item.main)
  const selected = mains.length === 1 && mains[0].row.pid !== previous ? mains[0].row : null
  return { selected, mainCount: mains.length, facts: inspected.map(item => item.fact),
    owned: mains.map(({ row }) => ({ pid: row.pid, parent: row.parent, created: row.created,
      executablePath: row.executablePath, command: row.command })) }
}
