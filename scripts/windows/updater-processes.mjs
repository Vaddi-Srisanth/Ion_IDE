import { win32 } from 'node:path'
import { hasExactProfileOption, windowsArguments } from '../process-family.mjs'

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && win32.isAbsolute(left) && win32.isAbsolute(right)
  && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()

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
  return { selected, mainCount: mains.length, facts: inspected.map(item => item.fact) }
}
