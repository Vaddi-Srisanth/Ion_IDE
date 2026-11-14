import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { prepareRun } from '../src/main/run-console/plans'
import { createRunTrace, type RunTraceEvent } from '../src/main/run-console/trace'
import type { RunResult } from '../src/shared/contracts'
import { probeWindowsExitTargets } from '../scripts/windows/test-process-exit-probe'

test('real C compile/PTY/input/stop lifecycle remains owned under delay and CPU load', {
  skip: !['darwin', 'win32'].includes(process.platform), timeout: 120_000,
}, async (t) => {
  const execute = promisify(execFile)
  if (process.platform === 'darwin' && !await execute('/usr/bin/xcode-select', ['-p']).then(() => true, () => false)) {
    t.skip('Apple Command Line Tools are unavailable.')
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ion-c-lifecycle-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const requestedHelper = process.platform === 'win32' ? process.env.ION_WINDOWS_PROCESS_TEST_HELPER
    : join(scratch, 'ion-pty')
  assert.ok(requestedHelper, 'Build the native PTY helper before running this fixture.')
  const helper: string = process.platform === 'win32' ? await realpath(requestedHelper) : requestedHelper
  if (process.platform === 'darwin') await execute('/usr/bin/xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE',
    '-O2', '-Wall', '-Wextra', '-Werror', resolve('src/main/run-console/pty-helper.c'), '-o', helper])
  else await access(helper)
  const records: { id: string; events: RunTraceEvent[]; result?: RunResult; output?: string; error?: string }[] = []
  const windowsExitTargets = new Map<number, Set<string>>()
  let activeExecutables: { compiler?: string; program: string; helper: string } | undefined
  let cleanupObservations: Awaited<ReturnType<typeof probeWindowsExitTargets>> | undefined
  const key = Symbol.for('ion.main.run-trace.v1')
  const host = globalThis as typeof globalThis & { [key]?: (event: RunTraceEvent) => void }
  let active: RunTraceEvent[] = []
  host[key] = (event) => {
    active.push(event)
    if (process.platform !== 'win32' || typeof event.value !== 'number' || !activeExecutables) return
    const executable = event.stage === 'compiler-process' && event.event === 'spawned' ? activeExecutables.helper
      : event.stage === 'compiler-payload' && event.event === 'ready-observed' ? activeExecutables.compiler
        : event.stage === 'pty' && event.event === 'spawned' ? activeExecutables.helper
          : event.stage === 'pty' && event.event === 'ready' ? activeExecutables.program : undefined
    if (executable) {
      const paths = windowsExitTargets.get(event.value) ?? new Set<string>()
      paths.add(executable)
      windowsExitTargets.set(event.value, paths)
    }
  }
  t.after(async () => {
    delete host[key]
    try {
      if (process.env.ION_C_TRACE_REPORT) await writeFile(process.env.ION_C_TRACE_REPORT,
        JSON.stringify({ platform: process.platform, arch: process.arch, records, cleanupObservations }, null, 2))
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
  const source = join(scratch, 'program.c')
  const normal = '#include <stdio.h>\nint main(void){puts("ION-C-OK");return 0;}\n'
  const runner = new InteractiveRunner(helper, { compileMs: 15_000, programMs: 3_000, outputBytes: 8192 })

  async function run(id: string, code: string, mode: 'normal' | 'input' | 'stop' | 'delay' = 'normal', terminalHelper = helper) {
    const row = { id, events: [] as RunTraceEvent[], result: undefined as RunResult | undefined,
      output: '', error: undefined as string | undefined }
    records.push(row); active = row.events; activeExecutables = undefined
    const trace = createRunTrace(id), controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 20_000)
    try {
      await writeFile(source, code)
      const plan = await prepareRun({ path: source, root: scratch, scratch, signal: controller.signal, trace })
      activeExecutables = process.platform === 'win32'
        ? { compiler: plan.compile && await realpath(plan.compile.executable),
          program: join(await realpath(dirname(plan.run.executable)), basename(plan.run.executable)),
          helper: await realpath(terminalHelper) }
        : { compiler: plan.compile?.executable, program: plan.run.executable, helper: terminalHelper }
      let sent = false
      const engine = terminalHelper === helper ? runner : new InteractiveRunner(terminalHelper,
        { compileMs: 15_000, programMs: 3_000, outputBytes: 8192 })
      row.result = await engine.run(plan, (event) => {
        if (event.kind !== 'data') return
        row.output += event.text
        if (!sent && row.output.includes('INPUT>')) { sent = true; engine.input('hello\r') }
        if (mode === 'stop' && row.output.includes('LOOP>')) controller.abort()
      }, controller.signal, async () => { if (mode === 'delay') await delay(120); return true }, trace)
      return row
    } catch (error) { row.error = String(error); throw error } finally { clearTimeout(deadline) }
  }

  await t.test('repeated real compilations preserve ordered READY, completion and cleanup', async () => {
    const count = Number(process.env.ION_C_TRACE_CYCLES ?? 12)
    assert.ok(Number.isInteger(count) && count > 0 && count <= 100)
    for (let index = 0; index < count; index++) {
      const row = await run(`repeat-${index}`, normal)
      assert.equal(row.result?.status, 'success', JSON.stringify(row))
      assert.match(row.output, /ION-C-OK/)
      const indexOf = (stage: string, event: string) => row.events.findIndex((e) => e.stage === stage && e.event === event)
      assert.ok(indexOf('compile', 'start') < indexOf('compile', 'end'))
      assert.ok(indexOf('compile', 'end') < indexOf('pty', 'spawn-request'))
      assert.ok(indexOf('pty', 'ready') < indexOf('pty', 'close'))
      assert.equal(row.events.at(-1)?.event, 'cleanup')
    }
  })
  await t.test('real interactive stdin reaches C unchanged', async () => {
    const row = await run('input', '#include <stdio.h>\nint main(void){char s[32];printf("INPUT>");fflush(stdout);'
      + 'if(scanf("%31s",s)!=1)return 2;printf("GOT:%s\\n",s);return 0;}', 'input')
    assert.equal(row.result?.status, 'success', JSON.stringify(row))
    assert.match(row.output, /GOT:hello/)
    assert.ok(row.events.some((e) => e.stage === 'stdin' && e.event === 'written-bytes'))
  })
  await t.test('compiler error settles without launching a program', async () => {
    const row = await run('compile-error', 'int main(void){return 0}\n')
    assert.equal(row.result?.status, 'compile-error')
    assert.equal(row.events.some((e) => e.stage === 'pty'), false)
  })
  await t.test('Stop cancels the real running C process and drains its helper', async () => {
    const row = await run('stop', '#include <stdio.h>\nint main(void){puts("LOOP>");fflush(stdout);for(;;){} }', 'stop')
    assert.equal(row.result?.status, 'cancelled', JSON.stringify(row))
    assert.equal(row.result?.outputComplete, true)
    assert.ok(row.events.some((e) => e.stage === 'pty' && e.event === 'cleanup'))
  })
  await t.test('delayed source checks are visible rather than attributed to the compiler', async () => {
    const row = await run('source-delay', normal, 'delay')
    assert.equal(row.result?.status, 'success', JSON.stringify(row))
    for (const stage of ['source-check-before-compile', 'source-check-before-program']) {
      const events = row.events.filter((e) => e.stage === stage)
      assert.ok(events[1].ms - events[0].ms >= 100)
    }
  })
  await t.test('bounded CPU contention does not lose compiler/PTY completion', async () => {
    const load = spawn(process.execPath, ['-e', 'const end=Date.now()+1500;while(Date.now()<end){}'], { stdio: 'ignore' })
    const closed = once(load, 'close')
    try {
      const row = await run('cpu-load', normal)
      assert.equal(row.result?.status, 'success', JSON.stringify(row))
    } finally { load.kill(); await closed }
  })
  if (process.platform === 'darwin') await t.test('delayed helper startup is attributed before READY', async () => {
    const delayed = join(scratch, 'delayed-helper')
    const quotedHelper = "'" + helper.replaceAll("'", "'\\''") + "'"
    await writeFile(delayed, '#!/bin/sh\n/bin/sleep 0.15\nexec ' + quotedHelper + ' "$@"\n')
    await chmod(delayed, 0o700)
    const row = await run('pty-start-delay', normal, 'normal', delayed)
    assert.equal(row.result?.status, 'success', JSON.stringify(row))
    const start = row.events.find((e) => e.stage === 'pty' && e.event === 'spawn-request')!
    const ready = row.events.find((e) => e.stage === 'pty' && e.event === 'ready')!
    assert.ok(ready.ms - start.ms >= 140)
  })
  if (process.platform === 'darwin') await t.test('compiler timeout returns explicit status and cleans up instead of leaving Compiling pending', async () => {
    const id = 'compiler-timeout', events: RunTraceEvent[] = []
    const row = { id, events, result: undefined as RunResult | undefined }
    records.push(row); active = events
    const engine = new InteractiveRunner(helper, { compileMs: 50, programMs: 1000, outputBytes: 8192 })
    row.result = await engine.run({ language: 'c', cwd: scratch, label: 'timeout-fixture', toolchain: 'fixture',
      compile: { executable: '/bin/sh', args: ['-c', '/bin/sleep 10'] },
      run: { executable: '/never-executed', args: [] } }, () => {}, new AbortController().signal, undefined, createRunTrace(id))
    assert.equal(row.result.status, 'timeout')
    assert.ok(events.some((e) => e.stage === 'compiler-process' && e.event === 'stop' && e.value === 'timeout'))
    assert.equal(events.some((e) => e.stage === 'pty'), false)
    assert.equal(events.at(-1)?.event, 'cleanup')
  })
  await t.test('all observed compiler, helper and program processes have exited', async () => {
    if (process.platform === 'win32') {
      // Numeric PIDs are reusable, and libuv signal0 requests TERMINATE access
      // on Windows. A denied historical PID is not a liveness observation.
      // Query limited-rights native handles and compare exact executable images;
      // unresolved access errors remain failed/unverified, never false passes.
      assert.ok(windowsExitTargets.size > 0)
      const reported = records.flatMap(row => row.events.filter(event => typeof event.value === 'number' && (
        event.stage === 'compiler-process' && event.event === 'spawned'
        || event.stage === 'compiler-payload' && event.event === 'ready-observed'
        || event.stage === 'pty' && (event.event === 'spawned' || event.event === 'ready'))))
      assert.ok(reported.some(event => event.stage === 'compiler-payload'), 'Observe actual GCC, not just its supervisor.')
      for (const event of reported) assert.ok(windowsExitTargets.has(event.value as number), 'Every owned PID needs an expected image binding.')
      cleanupObservations = await probeWindowsExitTargets([...windowsExitTargets].map(([pid, paths]) =>
        ({ pid, executablePaths: [...paths] })))
      for (const observed of cleanupObservations) assert.equal(observed.verified, true, JSON.stringify(observed))
      return
    }
    const pids = new Set(records.flatMap((row) => row.events.filter((e) =>
      (e.event === 'spawned' || e.stage === 'pty' && e.event === 'ready') && typeof e.value === 'number')
      .map((e) => e.value as number)))
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Owned PID ${pid} remains alive`)
  })
})
