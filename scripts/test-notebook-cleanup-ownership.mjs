import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: {
  source: { type: 'string', default: 'src/main/notebooks/kernel-service.ts' },
  output: { type: 'string' },
  'expect-vulnerable': { type: 'boolean', default: false },
} })
const require = createRequire(import.meta.url)
const childModule = require('node:child_process')
const realSpawn = childModule.spawn
const previousHelper = process.env.ION_WINDOWS_PROCESS_TEST_HELPER
const root = resolve('.')
const sourcePath = resolve(values.source)
const source = await readFile(sourcePath, 'utf8')
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-notebook-cleanup-')))
const children = new Set()
const unhandled = []
const observeUnhandled = (error) => unhandled.push(String(error?.message ?? error))
process.on('unhandledRejection', observeUnhandled)
const report = { timestamp: new Date().toISOString(), platform: process.platform,
  source: relative(root, sourcePath), sourceSha256: createHash('sha256').update(source).digest('hex'),
  injection: 'TEST ONLY: spawn targets a fixed harmless Node broker and supervisor acknowledgement is injected. Actual child shutdown and service lifecycle remain real.',
  nativeWindowsJobVerification: false, cases: [], forcedTeardownCount: 0 }
const output = resolve(values.output ?? `remediation/notebook-cleanup-ownership-${values['expect-vulnerable'] ? 'before' : 'after'}.json`)
let completed = false
const began = performance.now()

async function bounded(promise, description) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description + ' exceeded 6 seconds.')), 6000)
    })])
  } finally { clearTimeout(timer) }
}
async function outcome(promise) {
  try { await bounded(promise, 'Owned notebook cleanup'); return { rejected: false } }
  catch (error) { return { rejected: true, message: String(error.message) } }
}
function track(session) { children.add(session.child); return session }
function injectUnverified(session) {
  let disposed = 0
  Object.defineProperty(session, 'ownership', { configurable: true, value: {
    finished: Promise.resolve(false),
    requestStop: async () => {
      // Windows hosts do not take the POSIX process-group branch. Stop this
      // exact harmless child cooperatively rather than simulating its exit.
      if (session.child.exitCode === null && session.child.signalCode === null) {
        session.child.stdin.end('{"op":"stop"}\n')
        await bounded(session.exited, 'Fixture child exit')
      }
      return false
    },
    dispose() { disposed++ },
  } })
  return () => disposed
}
async function assertExited(session) {
  await bounded(session.exited, 'Actual fixture process exit')
  assert.ok(session.child.exitCode !== null || session.child.signalCode !== null, 'The actual owned child must exit.')
}

try {
  const fixture = join(scratch, 'broker-fixture.cjs')
  await writeFile(fixture, `let input = '';
    process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => { input += text; let newline;
      while ((newline = input.indexOf('\\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline+1);
        const request = JSON.parse(line);
        if (request.op === 'stop') process.exit(0);
        if (request.op === 'run') process.stdout.write(JSON.stringify({type:'done',id:request.id,count:1,status:'ok'})+'\\n');
      }
    });`)
  const modulePath = join(scratch, 'kernel-test.cjs')
  await build({ stdin: { contents: source,
    resolveDir: sourcePath.endsWith('.cjs') ? dirname(sourcePath) : join(root, 'src/main/notebooks'),
    sourcefile: sourcePath, loader: sourcePath.endsWith('.cjs') ? 'js' : 'ts' }, outfile: modulePath,
    bundle: true, platform: 'node', format: 'cjs', loader: { '.py': 'text' }, logLevel: 'silent' })
  // Replace only the process boundary; test the exact frozen/current lifecycle
  // implementation without rewriting its shutdown or retirement logic.
  process.env.ION_WINDOWS_PROCESS_TEST_HELPER = process.execPath
  childModule.spawn = (_executable, _args, options) => {
    const child = realSpawn(process.execPath, [fixture], { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    return child
  }
  const { NotebookKernels } = require(modulePath)
  const environment = { id: 'cleanup-fixture', path: process.execPath, label: 'Synthetic broker fixture', names: [] }
  function service() {
    const instance = new NotebookKernels(() => {})
    // Interpreter authorization is independently exercised by test-notebook-trust.
    // This seam selects only the fixed fixture; service lifecycle methods stay real.
    instance.python.list = () => [environment]
    instance.python.verify = async (value) => value
    instance.python.assertCurrent = async () => {}
    return instance
  }
  async function start(instance, name) {
    const path = join(scratch, name + '.ipynb')
    const result = await bounded(instance.run(path, { id: name, code: 'fixture', environmentId: environment.id },
      async () => true, scratch), 'Service fixture readiness/run')
    assert.equal(result.status, 'ok')
    return { path, session: track(instance.sessions.get(path)) }
  }
  const directService = service()
  const { path: directPath, session: direct } = await start(directService, 'direct')
  const disposed = injectUnverified(direct)
  const directStop = outcome(direct.stop())
  const retired = directService.closing.get(directPath)
  assert.ok(retired, 'The real close path must publish its raw closing promise.')
  const raw = await outcome(retired)
  const stopped = await directStop
  await assertExited(direct)
  assert.equal(stopped.rejected, true, 'Explicit Stop must report failed cleanup.')
  assert.equal(disposed(), 1)
  await outcome(directService.dispose())
  report.cases.push({ name: 'raw retired promise propagates cleanup failure', ...raw, explicitStopRejected: stopped.rejected, actualChildExited: true })

  const automatic = service()
  const { path, session } = await start(automatic, 'retired')
  const pendingPath = join(scratch, 'already-pending.ipynb')
  const ticket = automatic.begin(pendingPath)
  injectUnverified(session)
  session.fail(new Error('Synthetic broker failure'))
  const closing = automatic.closing.get(path)
  assert.ok(closing, 'Exercise the actual service retirement callback, not a stub.')
  await outcome(closing)
  await assertExited(session)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(automatic.sessions.size, 0)
  assert.equal(automatic.closing.size, 0, 'The sticky failure must survive removal of the raw closing entry.')
  let beginBlocked = false, pendingBlocked = false
  try { automatic.begin(join(scratch, 'new.ipynb')) } catch (error) { beginBlocked = /cleanup/.test(error.message) }
  try { automatic.check(pendingPath, ticket) } catch (error) { pendingBlocked = /cleanup/.test(error.message) }
  const laterDispose = await outcome(automatic.dispose())
  report.cases.push({ name: 'automatic retirement retains failure after map removal', ...laterDispose,
    newOperationsBlocked: beginBlocked, pendingOperationsBlocked: pendingBlocked, actualChildExited: true })

  const nested = service()
  const a = await start(nested, 'nested-a'), b = await start(nested, 'nested-b')
  injectUnverified(a.session)
  const nestedDispose = await outcome(nested.dispose())
  await Promise.all([assertExited(a.session), assertExited(b.session)])
  assert.equal(nestedDispose.rejected, true)
  assert.equal(nested.sessions.size, 0)
  report.cases.push({ name: 'disposal drains both real children despite one cleanup failure', ...nestedDispose,
    actualChildrenExited: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [], 'Automatic cleanup must not create unhandled promise rejections.')
  if (values['expect-vulnerable']) {
    assert.equal(raw.rejected, false, 'The frozen baseline must demonstrate the raw-promise defect.')
    assert.equal(laterDispose.rejected, false, 'The frozen baseline must demonstrate lost cleanup evidence after retirement.')
    assert.equal(beginBlocked, false)
    assert.equal(pendingBlocked, false)
    report.result = 'confirmed-before-fix-raw-and-sticky-propagation-defects'
  } else {
    assert.equal(raw.rejected, true)
    assert.equal(laterDispose.rejected, true)
    assert.equal(beginBlocked, true)
    assert.equal(pendingBlocked, true)
    report.result = 'passed-raw-sticky-nested-disposal-regressions'
  }
  completed = true
} catch (error) {
  report.error = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      report.forcedTeardownCount++
      child.kill('SIGKILL') // Safety cleanup only: never counted as a passing verification.
    }
  }
  childModule.spawn = realSpawn
  if (previousHelper === undefined) delete process.env.ION_WINDOWS_PROCESS_TEST_HELPER
  else process.env.ION_WINDOWS_PROCESS_TEST_HELPER = previousHelper
  process.removeListener('unhandledRejection', observeUnhandled)
  report.complete = completed
  report.durationMs = performance.now() - began
  report.unhandledRejections = unhandled
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  await rm(scratch, { recursive: true, force: true })
  console.log(JSON.stringify({ result: report.result ?? 'failed', complete: report.complete,
    durationMs: report.durationMs, forcedTeardownCount: report.forcedTeardownCount, evidence: relative(root, output) }))
}
