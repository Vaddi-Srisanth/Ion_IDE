import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { execute } from '../src/main/runner'
import { configureWindowsProcessHelper, monitorWindowsPipeProcess, windowsEnvironment, windowsToolPaths } from '../src/main/windows-process'

const windows = process.platform === 'win32'
const run = promisify(execFile)
const native = () => {
  const path = process.env.ION_WINDOWS_PROCESS_TEST_HELPER
  assert.ok(path, 'Use scripts/test.mjs so a fresh native helper is built.')
  configureWindowsProcessHelper(path)
  return path
}
async function scratch(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'ion-job-café-学习-'))
  t.after(() => rm(path, { recursive: true, force: true }))
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
  t.after(async () => {
    const pids = await readFile(pidfile, 'utf8').then(JSON.parse, () => null)
    if (pids) for (const pid of [pids.root, pids.worker]) await cleanup(pid, process.execPath, cwd)
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
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const pids = await marker(fixture.pidfile)
    const closed = once(child, 'close')
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
    t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL') })
    await once(owner, 'close')
    const pids = await marker(fixture.pidfile)
    const pid = Number(await readFile(supervisorPid, 'utf8'))
    t.after(() => cleanup(pid, helper, cwd))
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
    t.after(async () => {
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
