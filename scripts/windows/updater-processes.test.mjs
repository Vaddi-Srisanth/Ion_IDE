import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUpdaterProcessesDrained, inspectUpdaterProcesses, rememberUpdaterProcesses, updaterProcessFilter, updaterQueryStages } from './updater-processes.mjs'

const target = 'C:\\Users\\Fixture\\AppData\\Local\\Programs\\Ion IDE\\App\\Ion IDE.exe'
const profile = 'C:\\Users\\Fixture\\AppData\\Local\\Temp\\profile café 学习'
const options = { target, profile, previous: 100 }
const row = (pid, extra = '', directory = profile, executablePath = target) => ({
  pid, parent: pid === 200 ? 1 : 200, created: String(638000000000000000n + BigInt(pid)),
  executablePath, command: `"${executablePath}" "--user-data-dir=${directory}" ${extra}`,
})

test('unit fixture: Chromium children make the old selector ambiguous; the exact main is unique', () => {
  const rows = [row(200), row(201, '--type=gpu-process'), row(202, '--type=renderer')]
  const oldMatches = rows.filter(item => item.executablePath === target && item.command.includes(profile))
  assert.equal(oldMatches.length, 3)
  const actual = inspectUpdaterProcesses(rows, options)
  assert.equal(actual.selected?.pid, 200)
  assert.equal(actual.mainCount, 1)
  assert.deepEqual(actual.facts.map(item => item.role), ['main', 'gpu-process', 'renderer'])
})

test('unit fixture: two actual mains and the previous PID fail closed', () => {
  assert.equal(inspectUpdaterProcesses([row(200), row(203)], options).selected, null)
  assert.equal(inspectUpdaterProcesses([row(100)], options).selected, null)
  assert.equal(inspectUpdaterProcesses([row(100), row(200)], options).selected, null)
})

test('unit fixture: exact argv boundaries reject neighbor profiles, mentions and different executables', () => {
  const mention = row(205); mention.command = mention.command.replace('--user-data-dir=', '--description=')
  const neighboring = row(206, '', profile + '-other')
  const wrong = row(207, '', profile, 'C:\\Other\\Ion IDE.exe')
  const duplicated = row(208, `"--user-data-dir=${profile}-other"`)
  assert.equal(inspectUpdaterProcesses([mention, neighboring, wrong, duplicated], options).selected, null)
  assert.equal(inspectUpdaterProcesses([row(200, '--description=--type=renderer')], options).selected?.pid, 200)
  assert.equal(inspectUpdaterProcesses([row(200, '--type renderer')], options).selected, null)
  assert.equal(inspectUpdaterProcesses([row(200, '--type=')], options).selected, null)
})

test('unit fixture: Windows casing is accepted while distinct Unicode spellings remain distinct', () => {
  const actual = row(200, '', profile.toUpperCase(), target.toUpperCase())
  assert.equal(inspectUpdaterProcesses([actual], options).selected?.pid, 200)
  assert.equal(inspectUpdaterProcesses([row(200, '', profile.normalize('NFD'))], options).selected, null)
  const decomposedTarget = target.replace('Ion IDE', 'Ion café').normalize('NFD')
  assert.equal(inspectUpdaterProcesses([row(200, '', profile, decomposedTarget)],
    { ...options, target: target.replace('Ion IDE', 'Ion café') }).selected, null)
})

test('unit fixture: missing identity, command spoofing and oversized snapshots fail closed', () => {
  const missing = row(200); delete missing.created
  const spoofed = row(201); spoofed.command = spoofed.command.replace(target, 'C:\\Other\\Ion IDE.exe')
  assert.equal(inspectUpdaterProcesses([missing, spoofed], options).selected, null)
  assert.throws(() => inspectUpdaterProcesses(Array.from({ length: 65 }, (_, i) => row(200 + i)), options), /bound/)
})

test('exact WQL filters escape quote/backslash data and do not introduce wildcard or PowerShell evaluation', () => {
  assert.equal(updaterProcessFilter('C:\\Users\\O\'Brian\\Ion IDE.exe'), "ExecutablePath = 'C:\\\\Users\\\\O\\'Brian\\\\Ion IDE.exe'")
  const unusual = 'C:\\café 学习\\%_[]";$(not-a-command)\\Ion IDE.exe'
  const filter = updaterProcessFilter(unusual)
  assert.ok(filter.startsWith("ExecutablePath = '"))
  assert.ok(filter.includes('\\";$(not-a-command)'))
  assert.ok(filter.includes('%_[]'))
  assert.equal(filter.includes('LIKE'), false)
  assert.throws(() => updaterProcessFilter('Ion IDE.exe'), /absolute/)
  assert.throws(() => updaterProcessFilter('C:\\bad\npath.exe'), /absolute/)
})

test('a rollback restart observed during final diagnostics remains owned when selection/frame verification throws', () => {
  const owners = new Map()
  // The failing CI observed nothing during findRestart, then found the exact
  // main in final diagnostics. activePid was never assigned in the old test.
  const inspected = inspectUpdaterProcesses([row(4600), row(4601, '--type=gpu-process')], options)
  rememberUpdaterProcesses(owners, inspected)
  assert.equal(owners.size, 1)
  assert.equal([...owners.values()][0].pid, 4600)
  assert.equal([...owners.values()][0].created, row(4600).created)
  inspected.owned[0].command = 'mutated observer result'
  assert.notEqual([...owners.values()][0].command, 'mutated observer result')
  rememberUpdaterProcesses(owners, inspectUpdaterProcesses([row(4600), row(4602)], options))
  assert.equal(owners.size, 2, 'Ambiguous mains remain unselected for normal operations but both exact fixture identities can be rechecked for teardown.')
  assert.equal(inspectUpdaterProcesses([row(4600), row(4602)], options).selected, null)
  const wrong = row(999, '', profile + '-other')
  rememberUpdaterProcesses(owners, inspectUpdaterProcesses([wrong], options))
  assert.equal(owners.size, 2)
})

test('CIM stage receipts distinguish process startup, provider query and serialization without arbitrary stderr', () => {
  assert.deepEqual(updaterQueryStages(''), [])
  assert.deepEqual(updaterQueryStages('private path\nION_CIM_PHASE boot 0\nION_CIM_PHASE query-start 1.25\n'),
    [{ phase: 'boot', ms: 0 }, { phase: 'query-start', ms: 1.25 }])
  assert.deepEqual(updaterQueryStages('ION_CIM_PHASE arbitrary 0\nION_CIM_PHASE query-end not-a-number'), [])
})

test('post-drain verification rejects child-only, malformed and different-profile target snapshots', () => {
  assert.doesNotThrow(() => assertUpdaterProcessesDrained([]))
  const orphan = row(4601, '--type=gpu-process')
  assert.equal(inspectUpdaterProcesses([orphan], options).mainCount, 0)
  assert.throws(() => assertUpdaterProcessesDrained([orphan]), /refusing uninstall/)
  assert.throws(() => assertUpdaterProcessesDrained([{}]), /refusing uninstall/)
  assert.throws(() => assertUpdaterProcessesDrained([row(4602, '', profile + '-other')]), /refusing uninstall/)
})
