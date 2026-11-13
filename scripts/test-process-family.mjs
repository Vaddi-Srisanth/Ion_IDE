import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { TestProcessFamily, hasExactProfileOption, identityCpuPercent, parseMacFamilyRows,
  windowsArguments } from './process-family.mjs'

const epoch = Date.UTC(2026, 10, 12, 15, 0, 0)
const date = 'Thu Nov 12 15:00:00 2026'
const bundle = '/Applications/Ion café 学习.app'
const executable = bundle + '/Contents/MacOS/Ion IDE'
const profile = '/tmp/ion profile café 学习'
const row = (pid, parent, command, started = date, startedMs = epoch) => ({ pid, parent, command,
  started, startedMs, identityResolutionMs: 1000, rssMiB: 10, cpuSeconds: 1 })
const main = () => row(100, 1, executable + ' --user-data-dir=' + profile)
const helper = (pid, value = profile, parent = 1) => row(pid, parent, bundle + '/Contents/Frameworks/Helper.app/Contents/MacOS/Helper --type=renderer --user-data-dir=' + value + ' --lang=en')
const session = () => ({ pid: 100, profile, executablePath: executable, mainCreationTime: epoch + 321 })

test('macOS ownership rejects sibling profiles, embedded mentions and different executables', () => {
  const family = new TestProcessFamily(session(), 'darwin')
  const other = helper(103); other.command = other.command.replace('/Applications/', '/Other/')
  const mention = helper(104); mention.command = mention.command.replace('--user-data-dir=', '--some-text=')
  const children = [row(105, 100, '/usr/bin/node --type=renderer'), row(106, 102, '/bin/foreign-child')]
  assert.deepEqual(family.select([main(), helper(101), helper(102, profile + '-other'), other, mention, ...children]).members.map(p => p.pid), [100, 101, 105])
  assert.equal(family.kind(children[0]), 'child')
  assert.equal(family.kind(helper(101)), 'renderer')
})

test('profile matching respects option boundaries and scoped macOS Unicode equivalence', () => {
  assert.equal(hasExactProfileOption('x --user-data-dir=' + profile + '-other --lang=en', '--user-data-dir', profile, 'darwin'), false)
  assert.equal(hasExactProfileOption('x --user-data-dir=' + profile.normalize('NFD') + ' --lang=en', '--user-data-dir', profile, 'darwin'), true)
  assert.equal(hasExactProfileOption('x --data=' + profile, '--user-data-dir', profile, 'darwin'), false)
})

test('known surviving children remain owned after reparenting; recycled roots and children do not', () => {
  const family = new TestProcessFamily(session(), 'darwin')
  const child = row(101, 100, '/bin/zsh -l')
  assert.equal(family.select([main(), child]).rootAlive, true)
  assert.deepEqual(family.select([{ ...child, parent: 1 }]).members.map(p => p.pid), [101])
  const later = 'Thu Nov 12 15:00:01 2026'
  assert.deepEqual(family.select([row(100, 1, executable, later, epoch + 1000), row(101, 1, '/bin/unrelated', later, epoch + 1000), row(102, 100, '/bin/unrelated', later, epoch + 1000)]).members, [])
})

test('launch-time identity prevents binding to an already recycled PID', () => {
  const family = new TestProcessFamily(session(), 'darwin')
  assert.deepEqual(family.select([{ ...main(), started: 'Thu Nov 12 15:00:02 2026', startedMs: epoch + 2000 }, helper(101)]).members, [])
})

test('trusted launch metrics retain known Chromium survivors even if first native snapshot is after quit', () => {
  const family = new TestProcessFamily(session(), 'darwin')
  family.seed([{ pid: 100, creationTime: epoch + 321 }, { pid: 101, creationTime: epoch + 700 }])
  const result = family.select([helper(101)])
  assert.equal(result.rootAlive, false)
  assert.deepEqual(result.members.map(p => p.pid), [101])
})

test('a child predating the current owner PID is excluded', () => {
  const family = new TestProcessFamily(session(), 'darwin')
  assert.deepEqual(family.select([main(), row(101, 100, '/bin/old-child', 'Thu Nov 12 14:59:00 2026', epoch - 60000)]).members.map(p => p.pid), [100])
})

test('Windows argv preserves quoted paths, empty arguments and escaped quotes', () => {
  assert.deepEqual(windowsArguments('"C:\\Program Files\\Ion IDE.exe" "--user-data-dir=C:\\User Files\\café 学习" --type=renderer'),
    ['C:\\Program Files\\Ion IDE.exe', '--user-data-dir=C:\\User Files\\café 学习', '--type=renderer'])
  assert.deepEqual(windowsArguments('x "" "a\\\"b"'), ['x', '', 'a"b'])
})

test('Windows final attribution rejects profile-other, argument mentions, wrong exe and recycled identity', () => {
  const exe = 'C:\\Apps\\Ion\\Ion IDE.exe', directory = 'C:\\User Files\\café 学习'
  const family = new TestProcessFamily({ pid: 100, profile: directory, executablePath: exe, mainCreationTime: epoch }, 'win32')
  const w = (pid, command, path = exe, parent = 1) => ({ pid, parent, command, executablePath: path, started: String(epoch), startedMs: epoch, identityResolutionMs: 1 })
  const good = w(101, '"' + exe + '" "--user-data-dir=' + directory.toUpperCase() + '" --type=renderer')
  const foreign = w(102, '"' + exe + '" "--user-data-dir=' + directory + '-other" --type=renderer')
  const mention = w(103, '"' + exe + '" "--description=' + directory + '"')
  const otherExe = w(104, 'x "--user-data-dir=' + directory + '"', 'C:\\Other\\Ion IDE.exe')
  assert.deepEqual(family.select([w(100, '"' + exe + '"'), good, foreign, mention, otherExe]).members.map(p => p.pid), [100, 101])
  assert.equal(family.kind(good), 'renderer')
  assert.deepEqual(family.select([{ ...good, started: String(epoch + 1), startedMs: epoch + 1 }]).members, [])
})

test('Windows Unicode is exact, without incorrectly equating distinct NTFS spellings', () => {
  const directory = 'C:\\café 学习'
  assert.equal(hasExactProfileOption('x "--user-data-dir=' + directory + '"', '--user-data-dir', directory, 'win32'), true)
  assert.equal(hasExactProfileOption('x "--user-data-dir=' + directory.normalize('NFD') + '"', '--user-data-dir', directory, 'win32'), false)
})

test('Mac parser preserves real Unicode paths, CPU seconds and UTC launch identity', () => {
  const [actual] = parseMacFamilyRows('100 1 20480 00:01.50 Thu Nov 12 15:00:00 2026 ' + main().command)
  assert.equal(actual.startedMs, epoch)
  assert.equal(actual.rssMiB, 20)
  assert.equal(actual.cpuSeconds, 1.5)
  assert.equal(actual.command, main().command)
})

test('CPU deltas use PID and creation identity, and exclude exited roots', () => {
  const before = { timeMs: 1000, rootAlive: true, cpuSecondsByIdentity: { '100:old': 10 } }
  assert.equal(identityCpuPercent(before, { timeMs: 2000, rootAlive: true, cpuSecondsByIdentity: { '100:old': 10.5 } }), 50)
  assert.equal(identityCpuPercent(before, { timeMs: 2000, rootAlive: true, cpuSecondsByIdentity: { '100:new': 100 } }), null)
  assert.equal(identityCpuPercent(before, { timeMs: 2000, rootAlive: false, cpuSecondsByIdentity: {} }), null)
})

test('real native macOS sibling processes cannot pollute the legacy collector', { skip: process.platform !== 'darwin' }, async () => {
  const { resourceSnapshot } = await import('./desktop-harness.mjs')
  const ownProfile = '/tmp/ion-observer-profile-café-学习-' + process.pid
  const spawnFixture = suffix => spawn(process.execPath, ['-e', 'process.stdin.resume()', '--', '--user-data-dir=' + ownProfile + suffix], { stdio: ['pipe', 'ignore', 'ignore'] })
  const owned = spawnFixture(''), other = spawnFixture('-other')
  const exits = [once(owned, 'close'), once(other, 'close')]
  try {
    await Promise.all([once(owned, 'spawn'), once(other, 'spawn')])
    const first = await resourceSnapshot({ pid: owned.pid, profile: ownProfile }, { details: true })
    assert.ok(first.members.some(p => p.pid === owned.pid))
    assert.ok(!first.members.some(p => p.pid === other.pid), 'Profile prefix sibling was wrongly attributed.')
    assert.equal(first.rootAlive, true)
  } finally {
    for (const child of [owned, other]) { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
    await Promise.all(exits)
  }
})
