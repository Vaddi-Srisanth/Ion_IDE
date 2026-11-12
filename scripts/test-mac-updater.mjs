import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { performance } from 'node:perf_hooks'

// Real native integration, not mocked filesystem or signature behavior. Fixtures
// use the production identifier and real Mach-O executables, ad-hoc signatures,
// kqueue parent exit, RENAME_SWAP, NSWorkspace restart and ditto rollback archive.
// All bundles/profiles are private, disposable, background-only and windowless.
// This does not cover Electron save/quit approval, downloaded-app Gatekeeper UI,
// Developer ID/notarization, DMG staging, or the normal renderer update buttons.
const { values } = parseArgs({ options: { helper: { type: 'string', default: 'dist/native/ion-update' },
  'keep-fixtures': { type: 'boolean' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('node scripts/test-mac-updater.mjs [--helper dist/native/ion-update] [--keep-fixtures]\nRequires macOS, Xcode command-line tools and the production native helper. Uses only private native fixtures; no Electron or installed Ion launch.')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'Run these real native checks on macOS.')
const execute = promisify(execFile)
const commandOptions = { timeout: 30000, maxBuffer: 128 * 1024, encoding: 'utf8' }
const helperSource = await realpath(resolve(values.helper))
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'ion-mac-updater-')))
const scratch = temporary + '.noindex'
await rename(temporary, scratch)
await chmod(scratch, 0o700)
const hostExecutable = join(scratch, 'fixture-host')
const knownProcesses = new Set()
const ownedBundles = new Set()
const cleanups = []
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), complete: false,
  helperSha256: createHash('sha256').update(await readFile(helperSource)).digest('hex'), cases: [],
  method: 'Native windowless locally built 0.9.6/0.9.7 .app fixtures with actual ad-hoc signatures and dev.ionide.desktop identifier. Real production updater helper. No network, Electron, installed applications, real user settings, or user projects are touched.',
  limitations: ['This verifies the native replacement boundary, not Electron unsaved-work approval or application runtime compatibility.',
    'Locally built unquarantined success fixtures do not verify downloaded-app Gatekeeper approval, Developer ID signing or notarization.',
    'Quarantined rejection fixtures verify retention only; the test never removes quarantine or bypasses OS approval.',
    'Atomic replacement is checked using staged/target directory identities, continuity observations, valid installed bytes and the exact old-version rollback archive; observations alone cannot prove every sub-millisecond state.'] }
const output = resolve('performance-results', `mac-updater-native-${Date.now()}.json`)
const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
await save()
const stopped = new AbortController()
const interrupt = () => stopped.abort(new Error('Native updater regression interrupted.'))
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

const nativeHost = String.raw`#import <AppKit/AppKit.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static volatile sig_atomic_t stopRequested = 0;
static void requestStop(int value) { (void)value; stopRequested = 1; }
@interface FixtureDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSString *profile;
@property(nonatomic) BOOL parent;
@end
@implementation FixtureDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  (void)note;
  NSBundle *bundle = NSBundle.mainBundle;
  NSString *variant = [NSString stringWithContentsOfFile:[bundle.bundlePath stringByAppendingPathComponent:@"Contents/Resources/variant.txt"] encoding:NSUTF8StringEncoding error:NULL];
  NSDictionary *value = @{ @"pid": @(getpid()), @"version": [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"unknown",
    @"profile": self.profile, @"bundle": bundle.bundlePath, @"variant": variant ?: @"unknown",
    @"activationPolicy": @([NSApp activationPolicy]), @"frontPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) };
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  NSString *name = self.parent ? @"fixture-parent.json" : @"fixture-launched.json";
  if (![json writeToFile:[self.profile stringByAppendingPathComponent:name] options:NSDataWritingAtomic error:NULL]) _exit(4);
  [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {
    (void)timer; if (stopRequested) [NSApp terminate:nil];
  }];
}
@end
int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "--inspect-pid") == 0) {
      char path[PROC_PIDPATHINFO_MAXSIZE]; pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
      if (proc_pidpath(pid, path, sizeof(path)) <= 0) return 1;
      NSDictionary *data = @{ @"path": @(path), @"frontPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) };
      NSData *json = [NSJSONSerialization dataWithJSONObject:data options:0 error:NULL];
      fwrite(json.bytes, 1, json.length, stdout); return 0;
    }
    NSString *profile = nil; BOOL parent = NO;
    for (int index = 1; index < argc; index++) {
      NSString *argument = @(argv[index]);
      if ([argument hasPrefix:@"--user-data-dir="]) profile = [argument substringFromIndex:16];
      if ([argument isEqual:@"--fixture-parent"]) parent = YES;
    }
    if (!profile.isAbsolutePath) return 2;
    signal(SIGTERM, requestStop); signal(SIGINT, requestStop);
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    FixtureDelegate *delegate = [FixtureDelegate new]; delegate.profile = profile; delegate.parent = parent;
    app.delegate = delegate; [app run];
  }
  return 0;
}
`

async function run(file, args, options = {}) {
  return execute(file, args, { ...commandOptions, ...options })
}
async function present(path) {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
}
async function eventually(check, message, timeoutMs = 10000, { allowAborted = false } = {}) {
  const deadline = performance.now() + timeoutMs
  do {
    if (!allowAborted) stopped.signal.throwIfAborted()
    if (await check()) return
    await sleep(20)
  } while (performance.now() < deadline)
  throw new Error(message)
}
async function deadline(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })])
  } finally { clearTimeout(timer) }
}
async function inspect(pid) {
  try { return JSON.parse((await run(hostExecutable, ['--inspect-pid', String(pid)])).stdout) }
  catch { return null }
}
function tracked(file, args, { group = false } = {}) {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: group,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } })
  const record = { child, file, group, stdout: '', stderr: '', error: null }
  record.closed = new Promise(resolveClosed => {
    child.once('error', error => { record.error = error; resolveClosed({ code: null, signal: null, error: error.message }) })
    child.once('close', (code, signal) => resolveClosed({ code, signal }))
  })
  child.stdout.setEncoding('utf8').on('data', text => { record.stdout = (record.stdout + text).slice(-16384) })
  child.stderr.setEncoding('utf8').on('data', text => { record.stderr = (record.stderr + text).slice(-16384) })
  knownProcesses.add(record)
  return record
}
async function terminate(record) {
  if (!record || record.child.exitCode !== null || record.child.signalCode !== null || record.error) return
  const native = await inspect(record.child.pid)
  if (!native || native.path !== record.file || !native.path.startsWith(scratch + '/')) return
  try { process.kill(record.group ? -record.child.pid : record.child.pid, 'SIGTERM') } catch {}
  const result = await deadline(record.closed, 3000, 'Owned fixture process did not stop.').catch(() => null)
  if (!result && (await inspect(record.child.pid))?.path === record.file) {
    try { process.kill(record.group ? -record.child.pid : record.child.pid, 'SIGKILL') } catch {}
    await deadline(record.closed, 3000, 'Owned fixture process survived cleanup.')
    cleanups.push({ forced: true, executable: basename(record.file) })
  }
}
async function fingerprint(path) {
  const hash = createHash('sha256')
  const walk = async (directory, relative = '') => {
    for (const name of (await readdir(directory)).sort()) {
      const entry = join(directory, name), key = relative + '/' + name
      const info = await lstat(entry)
      assert.ok(!info.isSymbolicLink(), 'Fixtures must not contain hidden symlink payloads.')
      hash.update(key + ':' + (info.mode & 0o777).toString(8) + ':')
      if (info.isDirectory()) await walk(entry, key)
      else hash.update(await readFile(entry))
    }
  }
  await walk(path)
  return hash.digest('hex')
}
async function sameFilesystemLocation(actual, expected, message) {
  // macOS native APIs may return canonically decomposed Unicode spellings.
  // Compare the actual filesystem object, never loosen checks to a substring.
  const a = await lstat(actual, { bigint: true })
  const b = await lstat(expected, { bigint: true })
  assert.equal(a.dev, b.dev, message)
  assert.equal(a.ino, b.ino, message)
  assert.equal(a.isSymbolicLink(), false, message)
}
async function sign(bundle) {
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'dev.ionide.desktop', bundle])
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
}
async function makeBundle(bundle, version, variant) {
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(bundle, 'Contents/Resources'))
  await copyFile(hostExecutable, join(bundle, 'Contents/MacOS/Ion IDE'))
  await chmod(join(bundle, 'Contents/MacOS/Ion IDE'), 0o755)
  await writeFile(join(bundle, 'Contents/Resources/variant.txt'), variant)
  await writeFile(join(bundle, 'Contents/PkgInfo'), 'APPL????')
  await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.ionide.desktop</string><key>CFBundleName</key><string>Ion IDE</string><key>CFBundleExecutable</key><string>Ion IDE</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSBackgroundOnly</key><true/><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`)
  await sign(bundle)
  ownedBundles.add(bundle)
}
async function setup(name) {
  const root = join(scratch, name + '-café-学习')
  const target = join(root, 'Ion IDE.app')
  const stage = join(root, '.ion-update-fixture.noindex')
  const candidate = join(stage, 'Ion IDE.app')
  const profile = join(root, 'profile-café-学习')
  await mkdir(stage, { recursive: true, mode: 0o700 })
  await chmod(stage, 0o700)
  await mkdir(join(profile, 'updates'), { recursive: true })
  await run('/usr/bin/ditto', [join(scratch, 'template-old/Ion IDE.app'), target])
  await run('/usr/bin/ditto', [join(scratch, 'template-new/Ion IDE.app'), candidate])
  ownedBundles.add(target); ownedBundles.add(candidate)
  const helper = join(stage, 'ion-update')
  await copyFile(helperSource, helper)
  await chmod(helper, 0o700)
  const preferences = '{"version":1,"settings":{"autoSave":false,"openFullScreen":false},"recents":[]}\n'
  const code = '#include <stdio.h>\nint main(void) { puts("preserve my work"); return 0; }\n'
  await writeFile(join(profile, 'preferences.json'), preferences)
  await writeFile(join(root, 'user-code.c'), code)
  const originalStat = await lstat(target, { bigint: true })
  const originalHash = await fingerprint(target)
  const parent = tracked(join(target, 'Contents/MacOS/Ion IDE'), [`--user-data-dir=${profile}`, '--fixture-parent'])
  await eventually(() => present(join(profile, 'fixture-parent.json')), 'Windowless native parent fixture did not become ready.')
  const marker = JSON.parse(await readFile(join(profile, 'fixture-parent.json'), 'utf8'))
  assert.equal(marker.version, '0.9.6')
  assert.equal(marker.activationPolicy, 2)
  assert.notEqual(marker.frontPid, parent.child.pid, 'Native fixture must not activate itself.')
  assert.equal((await inspect(parent.child.pid))?.path, join(target, 'Contents/MacOS/Ion IDE'))
  return { root, target, stage, candidate, profile, helper, parent, originalStat, originalHash, preferences, code }
}
function argumentsFor(context, overrides = {}) {
  return Object.entries({ '--protocol': '1', '--parent': String(context.parent.child.pid), '--target': context.target,
    '--stage': context.stage, '--version': '0.9.7', '--profile': context.profile,
    '--device': String(context.originalStat.dev), '--inode': String(context.originalStat.ino), ...overrides }).flat()
}
async function begin(context, overrides = {}) {
  const helper = tracked(context.helper, argumentsFor(context, overrides), { group: true })
  await eventually(() => {
    if (helper.error || helper.child.exitCode !== null || helper.child.signalCode !== null) {
      throw new Error('Helper exited before READY: ' + helper.stderr + ' ' + helper.stdout)
    }
    return helper.stdout.includes('READY\n')
  }, 'Native updater did not acknowledge READY.')
  assert.equal(context.parent.child.exitCode, null, 'READY must never kill the running application.')
  return helper
}
async function unchanged(context, { parentAlive = true } = {}) {
  assert.equal(await fingerprint(context.target), context.originalHash, 'Rejected update changed installed bytes.')
  const stat = await lstat(context.target, { bigint: true })
  assert.equal(stat.dev, context.originalStat.dev)
  assert.equal(stat.ino, context.originalStat.ino)
  assert.equal(await readFile(join(context.profile, 'preferences.json'), 'utf8'), context.preferences)
  assert.equal(await readFile(join(context.root, 'user-code.c'), 'utf8'), context.code)
  assert.equal(await present(join(context.profile, 'fixture-launched.json')), false, 'Rejected updates must not launch a replacement.')
  if (parentAlive) assert.equal(context.parent.child.exitCode, null, 'A rejected update must preserve its running parent.')
}
const quarantine = '0081;67400000;IonUpdaterRegression;'
async function quarantineCandidate(context) {
  await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, context.candidate])
}
async function retainedQuarantine(context) {
  assert.equal((await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', context.candidate])).stdout.trim(), quarantine)
}
async function rejected(context, overrides, expectedCode = 3) {
  const helper = tracked(context.helper, argumentsFor(context, overrides), { group: true })
  const status = await deadline(helper.closed, 10000, 'Rejected helper did not exit.')
  assert.equal(status.code, expectedCode, helper.stderr)
  assert.equal(helper.stdout.includes('READY\n'), false)
  await unchanged(context)
  await retainedQuarantine(context)
}
async function testCase(name, operation) {
  stopped.signal.throwIfAborted()
  const result = { name, startedAt: new Date().toISOString(), passed: false }
  report.cases.push(result)
  await save()
  let context
  try {
    context = await setup(name)
    await operation(context, result)
    result.passed = true
    console.log('PASS ' + name)
  } catch (error) { result.error = error.message; throw error }
  finally {
    for (const process of [...knownProcesses]) await terminate(process)
    result.endedAt = new Date().toISOString()
    await save()
  }
}

try {
  const source = join(scratch, 'fixture-host.m')
  await writeFile(source, nativeHost)
  await run('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', source,
    '-framework', 'AppKit', '-o', hostExecutable], { timeout: 60000 })
  await makeBundle(join(scratch, 'template-old/Ion IDE.app'), '0.9.6', 'old-original')
  await makeBundle(join(scratch, 'template-new/Ion IDE.app'), '0.9.7', 'new-approved')
  report.host = (await run('/usr/bin/sw_vers', [])).stdout.trim()
  await testCase('wrong-parent', async context => {
    await quarantineCandidate(context)
    await rejected(context, { '--parent': String(process.pid) })
  })
  await testCase('symlink-candidate', async context => {
    const realCandidate = join(context.root, 'actual-candidate.app')
    await rename(context.candidate, realCandidate)
    await symlink(realCandidate, context.candidate)
    await quarantineCandidate(context)
    await rejected(context, {})
  })
  await testCase('invalid-signature', async context => {
    await writeFile(join(context.candidate, 'Contents/Resources/variant.txt'), 'tampered unsigned resource')
    await quarantineCandidate(context)
    await rejected(context, {})
  })
  await testCase('stale-original-inode', async context => {
    await quarantineCandidate(context)
    await rejected(context, { '--inode': String(context.originalStat.ino + 1n) })
  })
  await testCase('natural-exit-timeout', async (context, result) => {
    await quarantineCandidate(context)
    const helper = await begin(context, { '--timeout-ms': '250' })
    const status = await deadline(helper.closed, 5000, 'Bounded natural-exit timeout did not expire.')
    assert.equal(status.code, 5, helper.stderr)
    await unchanged(context)
    await retainedQuarantine(context)
    const receipt = JSON.parse(await readFile(join(context.profile, 'updates/result.json'), 'utf8'))
    assert.equal(receipt.state, 'failed')
    result.receipt = receipt
  })
  await testCase('candidate-directory-changed-after-ready', async (context, result) => {
    const helper = await begin(context)
    const replacement = join(context.root, 'different-signed.app')
    await makeBundle(replacement, '0.9.7', 'different-valid-candidate')
    await rename(context.candidate, join(context.root, 'candidate-at-ready.app'))
    await rename(replacement, context.candidate)
    await quarantineCandidate(context)
    // The parent deliberately remains alive until the signed replacement is
    // complete. There is no timing-dependent attempt to win a filesystem race.
    await terminate(context.parent)
    const status = await deadline(helper.closed, 10000, 'Changed-candidate helper did not exit.')
    assert.equal(status.code, 6, helper.stderr)
    await unchanged(context, { parentAlive: false })
    await retainedQuarantine(context)
    result.receipt = JSON.parse(await readFile(join(context.profile, 'updates/result.json'), 'utf8'))
    assert.equal(result.receipt.state, 'failed')
  })
  await testCase('candidate-resigned-in-place-after-ready', async (context, result) => {
    const helper = await begin(context)
    await writeFile(join(context.candidate, 'Contents/Resources/variant.txt'), 'changed-in-place-with-valid-signature')
    await sign(context.candidate)
    await quarantineCandidate(context)
    await terminate(context.parent)
    const status = await deadline(helper.closed, 10000, 'Resigned-candidate helper did not exit.')
    assert.equal(status.code, 6, helper.stderr)
    await unchanged(context, { parentAlive: false })
    await retainedQuarantine(context)
    result.receipt = JSON.parse(await readFile(join(context.profile, 'updates/result.json'), 'utf8'))
    assert.equal(result.receipt.state, 'failed')
  })
  await testCase('atomic-replace-profile-restart-rollback', async (context, result) => {
    const preparedIdentity = await lstat(context.candidate, { bigint: true })
    const preparedHash = await fingerprint(context.candidate)
    await assert.rejects(run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', context.candidate]),
      'Success fixture must be locally built and unmarked; this test does not bypass Gatekeeper.')
    const helper = await begin(context)
    let observing = true
    let reads = 0, missing = 0
    const continuity = (async () => {
      while (observing) {
        try { await lstat(context.target); reads++ } catch (error) { if (error.code === 'ENOENT') missing++; else throw error }
        await sleep(2)
      }
    })()
    try {
      await terminate(context.parent)
      const status = await deadline(helper.closed, 30000, 'Successful native updater did not finish.')
      assert.equal(status.code, 0, helper.stderr)
    } finally { observing = false; await continuity }
    assert.ok(reads > 0)
    assert.equal(missing, 0, 'Installed application disappeared during observed replacement.')
    result.targetContinuity = { reads, missing }
    assert.equal(await fingerprint(context.target), preparedHash)
    const installedIdentity = await lstat(context.target, { bigint: true })
    assert.equal(installedIdentity.ino, preparedIdentity.ino, 'Replacement must install the prepared directory identity.')
    assert.equal(installedIdentity.dev, preparedIdentity.dev)
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', context.target])
    await eventually(() => present(join(context.profile, 'fixture-launched.json')), 'Updated native app did not relaunch with the same profile.', 15000)
    const launched = JSON.parse(await readFile(join(context.profile, 'fixture-launched.json'), 'utf8'))
    context.restartedPid = launched.pid
    assert.equal(launched.version, '0.9.7')
    assert.equal(launched.variant, 'new-approved')
    assert.equal(launched.profile, context.profile)
    await sameFilesystemLocation(launched.bundle, context.target, 'Restart must use the exact updated bundle location.')
    assert.equal(launched.activationPolicy, 2)
    assert.notEqual(launched.frontPid, launched.pid, 'Background fixture restart stole foreground focus.')
    const restarted = await inspect(launched.pid)
    assert.ok(restarted?.path.startsWith(scratch + '/'))
    await sameFilesystemLocation(restarted.path, join(context.target, 'Contents/MacOS/Ion IDE'), 'Restart must execute the prepared native fixture.')
    assert.equal(await readFile(join(context.profile, 'preferences.json'), 'utf8'), context.preferences)
    assert.equal(await readFile(join(context.root, 'user-code.c'), 'utf8'), context.code)
    result.receipt = JSON.parse(await readFile(join(context.profile, 'updates/result.json'), 'utf8'))
    assert.equal(result.receipt.state, 'installed')
    assert.equal(result.receipt.version, '0.9.7')
    const backup = join(context.profile, 'updates/rollback.zip')
    assert.ok((await lstat(backup)).size > 0)
    const extracted = join(context.root, 'verified-rollback.noindex')
    await mkdir(extracted)
    await run('/usr/bin/ditto', ['-x', '-k', backup, extracted])
    assert.equal(await fingerprint(join(extracted, 'Ion IDE.app')), context.originalHash, 'Rollback must retain exact original application contents.')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(extracted, 'Ion IDE.app')])
    assert.equal(await present(context.stage), false, 'Successful staging must be removed after rollback archive creation.')
    assert.equal(await inspect(helper.child.pid), null, 'Updater helper must exit after replacement.')
    result.rollbackBytes = (await lstat(backup)).size
    result.sameTargetPath = true
    result.restartedVersion = launched.version
    process.kill(launched.pid, 'SIGTERM')
    await eventually(async () => (await inspect(launched.pid)) === null, 'Background restarted fixture did not exit after normal SIGTERM.')
  })
  report.complete = true
} catch (error) {
  report.error = error.stack ?? error.message
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  // Only terminate records whose actual kernel executable path is inside this
  // private scratch tree. Never use name-based killall or touch installed Ion.
  for (const record of [...knownProcesses]) await terminate(record).catch(error => cleanups.push({ error: error.message }))
  const listing = await run('/bin/ps', ['-axww', '-o', 'pid=,comm=']).catch(() => ({ stdout: '' }))
  const remaining = listing.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match && match[2].startsWith(scratch + '/') ? [{ pid: Number(match[1]), path: match[2] }] : []
  })
  for (const record of remaining) {
    // ps may escape non-ASCII characters in C locales, whereas proc_pidpath
    // returns the real Unicode path. Use ps only to obtain candidate PIDs;
    // authorize cleanup using the kernel path inside this unique private tree.
    if (!(await inspect(record.pid))?.path.startsWith(scratch + '/')) continue
    try { process.kill(record.pid, 'SIGTERM') } catch {}
    await eventually(async () => (await inspect(record.pid)) === null, 'Owned native fixture survived cleanup.', 5000, { allowAborted: true })
      .catch(error => { cleanups.push({ error: error.message }); process.exitCode = 1 })
  }
  const finalListing = await run('/bin/ps', ['-axww', '-o', 'pid=,comm=']).catch(error => {
    cleanups.push({ error: 'Could not verify final fixture process inventory: ' + error.message })
    process.exitCode = 1
    return null
  })
  const survivors = finalListing?.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match && match[2].startsWith(scratch + '/') ? [Number(match[1])] : []
  }) ?? []
  report.cleanupVerification = { verified: Boolean(finalListing), remainingFixturePids: survivors }
  if (!finalListing || survivors.length || cleanups.some(item => item.error)) {
    report.complete = false
    process.exitCode = 1
  }
  // Remove only these disposable bundles' LaunchServices registrations; no
  // global cache reset or default-application association changes.
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  for (const bundle of ownedBundles) if (await present(bundle)) await run(lsregister, ['-u', bundle]).catch(() => {})
  report.cleanups = cleanups
  report.endedAt = new Date().toISOString()
  report.passed = report.cases.filter(item => item.passed).length
  await save()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (!values['keep-fixtures'] && finalListing && !survivors.length) await rm(scratch, { recursive: true, force: true })
  else console.log('Kept private fixtures: ' + scratch)
  console.log(`Native updater tests: ${report.passed}/${report.cases.length}; report ${output}`)
}
