import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { execute, findWindowsCompiler } from '../src/main/runner'
import { configureWindowsProcessHelper, monitorWindowsPipeProcess, windowsEnvironment, windowsToolPaths, workspaceSafeWindowsToolPaths } from '../src/main/windows-process'

const windows = process.platform === 'win32'
const run = promisify(execFile)
type FixtureCleanup = () => void | Promise<void>
const fixtureOwners = new Map<TestContext, FixtureCleanup[]>()
function ownCleanup(t: TestContext, cleanup: FixtureCleanup) {
  const owners = fixtureOwners.get(t)
  assert.ok(owners, 'Register fixture resources only after acquiring scratch ownership.')
  owners.push(cleanup)
}
const native = () => {
  const path = process.env.ION_WINDOWS_PROCESS_TEST_HELPER
  assert.ok(path, 'Use scripts/test.mjs so a fresh native helper is built.')
  configureWindowsProcessHelper(path)
  return path
}
async function scratch(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'ion-job-café-学习-'))
  const owners: FixtureCleanup[] = []
  fixtureOwners.set(t, owners)
  // TestContext.after hooks run FIFO, not like a resource stack. One owning
  // hook must await dependent process/pipe cleanup before removing their cwd.
  t.after(async () => {
    const failures: unknown[] = []
    try {
      for (const cleanup of owners.reverse()) {
        try { await cleanup() } catch (error) { failures.push(error) }
      }
      if (failures.length) {
        console.error('Owned fixture cleanup failed; preserving scratch:', path)
        throw new AggregateError(failures, 'Owned process resources did not clean up before directory removal.')
      }
      await rm(path, { recursive: true, force: true })
    } finally { fixtureOwners.delete(t) }
  })
  return path
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function gone(pids: number[]) {
  const end = Date.now() + 2500
  while (pids.some(alive) && Date.now() < end) await delay(20)
  assert.deepEqual(pids.filter(alive), [], 'An exact owned process survived Job cleanup.')
}
async function marker(path: string) {
  const end = Date.now() + 4000
  while (Date.now() < end) {
    try { return JSON.parse(await readFile(path, 'utf8')) as { root: number; worker: number } } catch { await delay(10) }
  }
  assert.fail('The owned fixture never started its descendant.')
}
async function cleanup(pid: number, executable: string, token: string) {
  if (!alive(pid)) return
  // Fixture-only fallback: require the exact executable and unpredictable
  // scratch token. Never terminate by broad process names or profile prefixes.
  const script = '$p=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:ION_JOB_PID); '
    + 'if($p -and $p.ExecutablePath -eq $env:ION_JOB_EXE -and $p.CommandLine.Contains($env:ION_JOB_TOKEN)) '
    + '{ Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }'
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 5000,
    env: { ...process.env, ION_JOB_PID: String(pid), ION_JOB_EXE: executable, ION_JOB_TOKEN: token },
  })
}
async function program(t: TestContext, cwd: string, end: 'natural' | 'wait' | 'noisy' = 'wait') {
  const file = join(cwd, 'owned-command.js')
  const pidfile = join(cwd, 'owned-pids.json')
  const code = `const fs=require('node:fs'),{spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setTimeout(()=>{},12000)',${JSON.stringify(cwd)}],{detached:true,stdio:'ignore',windowsHide:true});
    worker.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(pidfile)},JSON.stringify({root:process.pid,worker:worker.pid}));
      ${end === 'natural' ? 'process.exit(0);' : end === 'noisy' ? "process.stdout.write('x'.repeat(1024*1024));setInterval(()=>{},1000);" : 'setInterval(()=>{},1000);'}});`
  await writeFile(file, code)
  ownCleanup(t, async () => {
    const pids = await readFile(pidfile, 'utf8').then(JSON.parse, () => null)
    if (pids) for (const pid of [pids.root, pids.worker]) await cleanup(pid, process.execPath, cwd)
    if (pids) await gone([pids.root, pids.worker])
  })
  return { file, pidfile }
}
function options(cwd: string, signal = new AbortController().signal, timeoutMs = 5000) {
  return { cwd, input: '', signal, timeoutMs, budget: { remaining: 64 * 1024 },
    environment: windowsEnvironment(windowsToolPaths(), cwd), splitOutput: true }
}

test('Windows pipe supervisor preserves structured argv, input, separate output and real exit 125',
  { skip: !windows, timeout: 10000 }, async t => {
    native()
    const cwd = await scratch(t)
    const args = ['café 学习', 'quote"and\\tail\\', '', '& echo NOT_A_SHELL']
    const script = 'let x="";process.stdin.on("data",b=>x+=b);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify([process.argv.slice(1),x]));process.stderr.write("actual-stderr");process.exitCode=125})'
    const result = await execute(process.execPath, ['-e', script, ...args], { ...options(cwd), input: 'input λ\n' })
    assert.equal(result.state, 'exited')
    assert.equal(result.exitCode, 125)
    assert.equal(result.outputComplete, true)
    assert.deepEqual(JSON.parse(result.stdout!), [args, 'input λ\n'])
    assert.equal(result.stderr, 'actual-stderr')
    assert.doesNotMatch(result.output, /READY |CLEAN|ERROR [0-9]/)
  })

test('Windows pipe Job owns detached descendants after natural leader exit',
  { skip: !windows, timeout: 15000 }, async t => {
    native()
    const cwd = await scratch(t), fixture = await program(t, cwd, 'natural')
    const result = await execute(process.execPath, [fixture.file], options(cwd))
    const pids = await marker(fixture.pidfile)
    assert.equal(result.state, 'exited')
    assert.equal(result.exitCode, 0)
    assert.equal(result.outputComplete, true)
    await gone([pids.root, pids.worker])
  })

for (const reason of ['cancelled', 'timeout', 'output-limit'] as const) {
  test('Windows pipe Job cleans descendants on ' + reason, { skip: !windows, timeout: 15000 }, async t => {
    native()
    const cwd = await scratch(t), fixture = await program(t, cwd, reason === 'output-limit' ? 'noisy' : 'wait')
    const controller = new AbortController()
    const settings = options(cwd, controller.signal, reason === 'timeout' ? 1800 : 5000)
    if (reason === 'output-limit') settings.budget.remaining = 16
    const running = execute(process.execPath, [fixture.file], settings)
    ownCleanup(t, async () => { controller.abort(); await running })
    const pids = await marker(fixture.pidfile)
    if (reason === 'cancelled') controller.abort()
    assert.equal((await running).state, reason)
    await gone([pids.root, pids.worker])
  })
}

test('Windows pipe Job kills descendants when the native supervisor is terminated',
  { skip: !windows, timeout: 15000 }, async t => {
    const helper = native(), cwd = await scratch(t), fixture = await program(t, cwd)
    const child = spawn(helper, ['--pipe', String(process.pid), process.execPath, fixture.file], {
      cwd, windowsHide: true, env: windowsEnvironment(windowsToolPaths(), cwd), stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    child.stdout!.resume(); child.stderr!.resume(); child.stdio[3]!.on('data', () => {})
    const closed = new Promise(resolve => child.once('close', resolve))
    ownCleanup(t, async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    })
    const pids = await marker(fixture.pidfile)
    assert.equal(child.kill('SIGKILL'), true)
    await closed
    await gone([pids.root, pids.worker])
  })

test('Windows pipe Job observes owner death without a persistent monitoring service',
  { skip: !windows, timeout: 15000 }, async t => {
    const helper = native(), cwd = await scratch(t), fixture = await program(t, cwd)
    const ownerFile = join(cwd, 'owner.js'), supervisorPid = join(cwd, 'supervisor.pid')
    await writeFile(ownerFile, `const fs=require('node:fs'),{spawn}=require('node:child_process');
      const helper=spawn(${JSON.stringify(helper)},['--pipe',String(process.pid),process.execPath,${JSON.stringify(fixture.file)}],
        {windowsHide:true,stdio:['ignore','ignore','ignore','pipe','pipe']});
      helper.stdio[3].on('data',()=>{});fs.writeFileSync(${JSON.stringify(supervisorPid)},String(helper.pid));
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(fixture.pidfile)}))process.exit(0)},10);`)
    const owner = spawn(process.execPath, [ownerFile], { cwd, windowsHide: true, stdio: 'ignore' })
    const closed = new Promise(resolve => owner.once('close', resolve))
    ownCleanup(t, async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await closed
    })
    await closed
    const pids = await marker(fixture.pidfile)
    const pid = Number(await readFile(supervisorPid, 'utf8'))
    ownCleanup(t, async () => { await cleanup(pid, helper, cwd); await gone([pid]) })
    await gone([pid, pids.root, pids.worker])
  })

test('Windows pipe supervisor repeats clean executions and fails closed when missing',
  { skip: !windows, timeout: 30000 }, async t => {
    const helper = native(), cwd = await scratch(t)
    for (let index = 0; index < 20; index++) {
      const result = await execute(process.execPath, ['-e', 'process.stdout.write("ok")'], options(cwd))
      assert.equal(result.state, 'exited')
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'ok')
      assert.equal(result.outputComplete, true)
    }
    configureWindowsProcessHelper(join(cwd, 'missing-helper.exe'))
    try {
      const result = await execute(process.execPath, ['-e', 'throw Error("must not run")'], options(cwd))
      assert.equal(result.state, 'error')
      assert.equal(result.stdout, '')
    } finally { configureWindowsProcessHelper(helper) }
  })


test('Windows pipe Stop waits for native Job drain and CLEAN acknowledgement',
  { skip: !windows, timeout: 15000 }, async t => {
    const helper = native(), cwd = await scratch(t), fixture = await program(t, cwd)
    const child = spawn(helper, ['--pipe', String(process.pid), process.execPath, fixture.file], {
      cwd, windowsHide: true, env: windowsEnvironment(windowsToolPaths(), cwd),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    }) as import('node:child_process').ChildProcessWithoutNullStreams
    const failures: string[] = []
    const ownership = monitorWindowsPipeProcess(child, message => failures.push(message))
    child.stdout.resume(); child.stderr.resume()
    const closed = new Promise(resolve => child.once('close', resolve))
    ownCleanup(t, async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      ownership.dispose()
    })
    const pids = await marker(fixture.pidfile)
    const first = ownership.requestStop()
    assert.equal(ownership.requestStop(), first, 'Repeated Stop requests share one operation.')
    assert.equal(await first, true, 'Only native Job/reader drain acknowledgement establishes clean Stop.')
    await closed
    assert.equal(ownership.verified, true)
    assert.deepEqual(failures, [])
    await gone([pids.root, pids.worker])
  })

test('fixture owning hook awaits LIFO resource closure before removing scratch under real TestContext FIFO hooks', async t => {
  const events: string[] = []
  await t.test('disposable resources', async scope => {
    const cwd = await scratch(scope)
    const handle = await open(join(cwd, 'owned-handle'), 'w')
    ownCleanup(scope, async () => {
      await access(cwd)
      await handle.close()
      events.push('file-closed')
    })
    ownCleanup(scope, async () => {
      await Promise.resolve()
      await access(cwd)
      events.push('dependent-owner-closed')
    })
    scope.after(async () => {
      assert.deepEqual(events, ['dependent-owner-closed', 'file-closed'])
      await assert.rejects(access(cwd), { code: 'ENOENT' })
      events.push('scratch-removed')
    })
  })
  assert.deepEqual(events, ['dependent-owner-closed', 'file-closed', 'scratch-removed'])
})

test('Windows pipe commands avoid a console session while preserving stdin, separate output, exit status and Job ownership',
  { skip: !windows, timeout: 45000 }, async t => {
    const helper = native(), baseline = process.env.ION_WINDOWS_PROCESS_BASELINE_TEST_HELPER
    const probe = process.env.ION_WINDOWS_CONSOLE_PROBE
    assert.ok(baseline && probe, 'Build the exact NO_WINDOW control and native console probe with scripts/test.mjs.')
    const cwd = await scratch(t), input = 'offline λ\n', bytes = Buffer.from(input, 'utf8')
    let inputHash = 2166136261
    for (const byte of bytes) inputHash = Math.imul(inputHash ^ byte, 16777619) >>> 0
    const receipt: Record<string, unknown> = { platform: process.platform, architecture: process.arch,
      inputBytes: bytes.length, inputHash, baselineIoContractPassed: false, baselineDetachedContractPassed: false,
      candidateIoContractPassed: false, candidateDetachedContractPassed: false }
    type ConsoleSnapshot = { consoleCodePage: number; consoleProcesses: number; consoleWindow: boolean;
      stdioTypes: number[]; inJob: boolean; jobQuery: boolean; inputBytes: number; inputHash: number;
      crtBytes: number; crtDescriptorCount: number }
    let primaryError: unknown
    async function capture(path: string) {
      configureWindowsProcessHelper(path)
      const controller = new AbortController()
      const began = performance.now()
      const job = execute(probe!, [], { ...options(cwd, controller.signal, 15000), input })
      ownCleanup(t, async () => { controller.abort(); await job })
      const result = await job
      let snapshot: ConsoleSnapshot | undefined, parseError: string | undefined
      try { snapshot = JSON.parse(result.stdout ?? '') as ConsoleSnapshot }
      catch (error) { parseError = String(error) }
      return { helperSha256: createHash('sha256').update(await readFile(path)).digest('hex'),
        elapsedMs: performance.now() - began, result, snapshot, parseError }
    }
    function validateIo(value: Awaited<ReturnType<typeof capture>>) {
      assert.equal(value.result.state, 'exited', JSON.stringify(value))
      assert.equal(value.result.exitCode, 125, JSON.stringify(value))
      assert.equal(value.result.outputComplete, true, JSON.stringify(value))
      assert.ok(value.snapshot, JSON.stringify(value))
      assert.deepEqual(value.snapshot.stdioTypes, [3, 3, 3])
      assert.equal(value.snapshot.jobQuery, true)
      assert.equal(value.snapshot.inJob, true)
      assert.equal(value.snapshot.inputBytes, bytes.length)
      assert.equal(value.snapshot.inputHash, inputHash)
      assert.equal(value.result.stderr?.replaceAll('\r\n', '\n'), 'ION-PIPE-STDERR\n')
    }
    try {
      // Keep actual control failures distinct. Candidate execution still runs
      // so the receipt does not hide it behind a failing control assertion.
      const before = await capture(baseline)
      receipt.before = before
      const after = await capture(helper)
      receipt.after = after
      validateIo(after)
      assert.equal(after.snapshot!.consoleCodePage, 0)
      assert.equal(after.snapshot!.consoleProcesses, 0)
      assert.equal(after.snapshot!.consoleWindow, false)
      assert.equal(after.snapshot!.crtDescriptorCount, 3, 'Only standard descriptors may be inherited; status and Stop are private.')
      assert.equal(after.snapshot!.crtBytes, 31, 'The x64 CRT table must have no struct padding or extra descriptors.')
      receipt.candidateIoContractPassed = true
      receipt.candidateDetachedContractPassed = true
      if (before.result.state === 'timeout') {
        assert.equal(before.result.outputComplete, true, 'A timed-out control must still prove native cleanup.')
        assert.equal(before.result.exitCode, 125)
        assert.equal(before.result.stdout, '', 'A control that reached user output is not an unobserved startup timeout.')
        assert.equal(before.result.stderr, '')
        receipt.comparison = 'baseline startup timeout; console APIs unavailable'
        receipt.comparisonVerified = false
      } else {
        validateIo(before)
        assert.ok(before.snapshot!.consoleCodePage !== 0 || before.snapshot!.consoleProcesses !== 0
          || before.snapshot!.consoleWindow, 'The control did not expose a distinguishable console session; retain evidence rather than assuming the policy changed.')
        receipt.baselineIoContractPassed = true
        receipt.comparison = 'both payloads observed; console APIs distinguish the launch policies'
        receipt.comparisonVerified = true
      }
    } catch (error) {
      primaryError = error
      receipt.failure = { message: String(error).slice(0, 2000) }
      throw error
    } finally {
      configureWindowsProcessHelper(helper)
      t.diagnostic(JSON.stringify(receipt))
      if (process.env.ION_PIPE_CONSOLE_REPORT) {
        try {
          await mkdir(dirname(process.env.ION_PIPE_CONSOLE_REPORT), { recursive: true })
          await writeFile(process.env.ION_PIPE_CONSOLE_REPORT, JSON.stringify(receipt, null, 2) + '\n')
        }
        catch (error) {
          if (!primaryError) throw error
          t.diagnostic('The console receipt could not be saved: ' + String(error).slice(0, 1000))
        }
      }
    }
  })

test('Windows selected compiler and GCC driver/frontend diagnostics survive detached CRT descriptor inheritance',
  { skip: !windows, timeout: 380000 }, async t => {
    const helper = native(), baseline = process.env.ION_WINDOWS_PROCESS_BASELINE_TEST_HELPER
    const detachedControl = process.env.ION_WINDOWS_PROCESS_DETACHED_CONTROL_HELPER
    assert.ok(baseline && detachedControl, 'Build both exact historical helper controls with scripts/test.mjs.')
    const cwd = await scratch(t)
    let gcc: string | null = null
    for (const directory of windowsToolPaths()) {
      const found = await findWindowsCompiler([directory], cwd)
      if (found && basename(found).toLowerCase() === 'gcc.exe') { gcc = found; break }
    }
    assert.ok(gcc, 'An actual installed GCC is required for the CRT child-diagnostic regression.')
    const selected = await findWindowsCompiler(await workspaceSafeWindowsToolPaths(cwd), cwd)
    assert.ok(selected, 'The application compiler selection must resolve in the same environment.')
    const compilers = [{ path: gcc, selectedByApplication: gcc.toLowerCase() === selected.toLowerCase() }]
    if (!compilers[0].selectedByApplication) compilers.push({ path: selected, selectedByApplication: true })
    assert.ok(compilers.length <= 2)
    const source = join(cwd, 'invalid.c'), sibling = join(cwd, 'untouched.c')
    const output = join(cwd, 'error-program.exe')
    const sourceText = '#error ION-COMPILER-FRONTEND-DIAGNOSTIC\nint main(void) { return 0; }\n'
    const siblingText = '/* unrelated source must remain byte-for-byte unchanged */\n'
    await writeFile(source, sourceText)
    await writeFile(sibling, siblingText)
    const variants = [
      { name: 'no-window-no-crt', path: baseline },
      { name: 'detached-no-crt', path: detachedControl },
      { name: 'detached-with-crt', path: helper },
    ]
    const cases = [
      { name: 'driver-option', marker: '--ion-compiler-invalid-option', args: ['--ion-compiler-invalid-option'] },
      { name: 'source-diagnostic', marker: 'ION-COMPILER-FRONTEND-DIAGNOSTIC',
        args: ['-x', 'c', '-std=c17', '-fdiagnostics-color=never', '-fsyntax-only', source] },
      // Clang/GCC may use a different driver/frontend process path for a full
      // compile than for -fsyntax-only. Match Ion's real invocation as well.
      { name: 'application-compile-link', marker: 'ION-COMPILER-FRONTEND-DIAGNOSTIC',
        args: ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', source, '-o', output] },
    ]
    type Observation = { compiler: string; selectedByApplication: boolean; variant: string; scenario: string; marker: string; helperSha256?: string;
      elapsedMs?: number; result?: Awaited<ReturnType<typeof execute>>; error?: string; markerInStderr?: boolean }
    const observations: Observation[] = []
    const receipt: Record<string, unknown> = { platform: process.platform, architecture: process.arch,
      applicationSelectedCompiler: basename(selected), compilers: compilers.map(compiler => ({
        name: basename(compiler.path), selectedByApplication: compiler.selectedByApplication })),
      plannedExecutions: compilers.length * variants.length * cases.length,
      observations, candidatePassed: false, unrelatedFilesUnchanged: false }
    let primaryError: unknown
    try {
      // Observe each configured execution once (at most eighteen), preserving
      // the unchanged 15s per-command limit. The matrix-level test budget also
      // covers each command's bounded cleanup; it does not alter product limits.
      for (const compiler of compilers) for (const variant of variants) for (const scenario of cases) {
        const row: Observation = { compiler: basename(compiler.path), selectedByApplication: compiler.selectedByApplication,
          variant: variant.name, scenario: scenario.name, marker: scenario.marker }
        observations.push(row)
        const began = performance.now()
        try {
          row.helperSha256 = createHash('sha256').update(await readFile(variant.path)).digest('hex')
          configureWindowsProcessHelper(variant.path)
          const controller = new AbortController()
          const job = execute(compiler.path, scenario.args, options(cwd, controller.signal, 15000))
          ownCleanup(t, async () => { controller.abort(); await job })
          row.result = await job
          row.markerInStderr = row.result.stderr?.includes(scenario.marker) ?? false
        } catch (error) { row.error = String(error) }
        finally { row.elapsedMs = performance.now() - began }
      }
      assert.equal(await readFile(source, 'utf8'), sourceText)
      assert.equal(await readFile(sibling, 'utf8'), siblingText)
      receipt.unrelatedFilesUnchanged = true
      assert.equal(observations.length, compilers.length * variants.length * cases.length)
      for (const row of observations) {
        assert.equal(row.error, undefined, 'The configured diagnostic could not execute: ' + JSON.stringify(row))
        assert.equal(row.result?.outputComplete, true, 'Every observed control/candidate must prove native cleanup: ' + JSON.stringify(row))
      }
      const candidates = observations.filter(row => row.variant === 'detached-with-crt')
      assert.equal(candidates.length, compilers.length * cases.length)
      for (const row of candidates) {
        assert.equal(row.result?.state, 'exited', JSON.stringify(row))
        assert.ok(Number.isInteger(row.result.exitCode) && row.result.exitCode !== 0, JSON.stringify(row))
        assert.equal(row.markerInStderr, true, 'Candidate lost the actual compiler diagnostic: ' + JSON.stringify(row))
        assert.ok(row.result.output.includes(row.marker), JSON.stringify(row))
      }
      receipt.candidatePassed = true
      receipt.detachedNoCrtObservations = observations.filter(row => row.variant === 'detached-no-crt')
        .map(row => ({ compiler: row.compiler, selectedByApplication: row.selectedByApplication,
          scenario: row.scenario, state: row.result?.state, exitCode: row.result?.exitCode,
          markerInStderr: row.markerInStderr }))
    } catch (error) {
      primaryError = error
      receipt.failure = String(error).slice(0, 2000)
      throw error
    } finally {
      configureWindowsProcessHelper(helper)
      t.diagnostic(JSON.stringify(receipt))
      if (process.env.ION_PIPE_COMPILER_REPORT) {
        try {
          await mkdir(dirname(process.env.ION_PIPE_COMPILER_REPORT), { recursive: true })
          await writeFile(process.env.ION_PIPE_COMPILER_REPORT, JSON.stringify(receipt, null, 2) + '\n')
        } catch (error) {
          if (!primaryError) throw error
          t.diagnostic('The compiler receipt could not be saved: ' + String(error).slice(0, 1000))
        }
      }
    }
  })
