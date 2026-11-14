import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUpdaterProcessesDrained, inspectUpdaterProcesses, parseUpdaterProcessSnapshot, rememberUpdaterProcesses, updaterProcessFilter, updaterQueryStages } from './updater-processes.mjs'

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

const encode = text => Buffer.from(text, 'utf8').toString('base64')
const wireRow = value => ['P', value.pid, value.parent, value.created, encode(value.executablePath), encode(value.command)].join('\t')
const snapshot = (rows, newline = '\r\n') => ['ION_PROCESS_SNAPSHOT\t1', ...rows.map(wireRow), 'END\t' + rows.length, ''].join(newline)

test('versioned process snapshots preserve Unicode, quoting, control text in argv and exact creation ticks', () => {
  const actual = row(200)
  actual.command += ' "commas,quotes\\slashes" "line1\nline2"'
  assert.deepEqual(parseUpdaterProcessSnapshot(snapshot([actual])), [actual])
  assert.equal(typeof parseUpdaterProcessSnapshot(snapshot([actual]))[0].created, 'string')
  assert.deepEqual(parseUpdaterProcessSnapshot('\uFEFF' + snapshot([actual], '\n')), [actual])
  const inspected = inspectUpdaterProcesses(parseUpdaterProcessSnapshot(snapshot([row(200), row(201, '--type=renderer')])), options)
  assert.equal(inspected.selected?.pid, 200)
  assert.equal(inspected.facts[1].role, 'renderer')
})

test('only an explicit complete zero-count frame can prove an empty process snapshot', () => {
  assert.deepEqual(parseUpdaterProcessSnapshot(snapshot([])), [])
  for (const incomplete of ['', '\n', '[]\n', 'null\n', 'ION_PROCESS_SNAPSHOT\t1\n', 'ION_PROCESS_SNAPSHOT\t1\nEND\t0',
    'ION_PROCESS_SNAPSHOT\t1\nEND\t1\n', 'ION_PROCESS_SNAPSHOT\t2\nEND\t0\n', snapshot([]) + '\n']) {
    assert.throws(() => parseUpdaterProcessSnapshot(incomplete), /snapshot/)
  }
})

test('partial, duplicated, extra or count-mismatched rows never become an accepted snapshot', () => {
  const item = wireRow(row(200)), header = 'ION_PROCESS_SNAPSHOT\t1\n'
  for (const invalid of [header + item + '\n', header + item + '\nEND\t0\n', header + item + '\nEND\t2\n',
    header + item + '\n' + item + '\nEND\t2\n', header + item + '\nEND\t1\nextra\n',
    header + item + '\textra\nEND\t1\n', header + item.slice(0, -2) + '\nEND\t1\n']) {
    assert.throws(() => parseUpdaterProcessSnapshot(invalid), /snapshot/)
  }
})

test('noncanonical Base64, invalid UTF-8 and NULs cannot silently mutate executable or command identity', () => {
  const item = wireRow(row(200)).split('\t')
  for (const encoded of ['@@==', 'Zg=', 'Zh==', '/w==', '7aCA', encode('x\0y')]) {
    const parts = [...item]; parts[5] = encoded
    assert.throws(() => parseUpdaterProcessSnapshot('ION_PROCESS_SNAPSHOT\t1\n' + parts.join('\t') + '\nEND\t1\n'), /snapshot/)
  }
  const parts = [...item]; parts[4] = encode('C:\\invalid\npath.exe')
  assert.throws(() => parseUpdaterProcessSnapshot('ION_PROCESS_SNAPSHOT\t1\n' + parts.join('\t') + '\nEND\t1\n'), /snapshot/)
})

test('wire row and payload limits reject oversized snapshots and unsafe numeric identities', () => {
  assert.equal(parseUpdaterProcessSnapshot(snapshot(Array.from({ length: 64 }, (_, i) => row(200 + i)))).length, 64)
  assert.throws(() => parseUpdaterProcessSnapshot(snapshot(Array.from({ length: 65 }, (_, i) => row(200 + i)))), /snapshot/)
  const item = wireRow(row(200)).split('\t')
  for (const [index, value] of [[1, '0'], [1, '01'], [1, '-1'], [1, '4294967296'], [2, '-1'], [3, '1.2'], [3, '1'.repeat(21)]]) {
    const parts = [...item]; parts[index] = value
    assert.throws(() => parseUpdaterProcessSnapshot('ION_PROCESS_SNAPSHOT\t1\n' + parts.join('\t') + '\nEND\t1\n'), /snapshot/)
  }
  assert.throws(() => parseUpdaterProcessSnapshot(snapshot([{ ...row(200), command: 'x'.repeat(32769) }])), /snapshot/)
  assert.throws(() => parseUpdaterProcessSnapshot('x'.repeat(512 * 1024) + '\n'), /snapshot/)
})

test('old json-end diagnostic history remains readable alongside new serialization-end receipts', () => {
  assert.deepEqual(updaterQueryStages('ION_CIM_PHASE query-end 4136.4149\nION_CIM_PHASE json-end 4200\nION_CIM_PHASE serialization-end 4300\n'),
    [{ phase: 'query-end', ms: 4136.4149 }, { phase: 'json-end', ms: 4200 }, { phase: 'serialization-end', ms: 4300 }])
})
