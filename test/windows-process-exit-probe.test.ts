import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { classifyExitObservation, nativeExitProbeInput, nativeExitProbeSource, type NativeExitObservation } from '../scripts/windows/test-process-exit-probe'

const expected = { pid: 42, executablePaths: ['C:\\temporary test\\ion-pty.exe'] }
const observation = (change: Partial<NativeExitObservation>): NativeExitObservation => ({ pid: 42,
  state: 'unknown', operation: 'open-process-limited', nativeError: 5, waitResult: 258,
  creationFileTime: '134000000000000000', creationUnixMs: 1755526400000, ...change })

test('native cleanup decisions preserve absent, exited, live, reused and access-denied distinctions', () => {
  assert.equal(classifyExitObservation(expected, observation({ state: 'missing', nativeError: 87 })).status, 'gone')
  assert.equal(classifyExitObservation(expected, observation({ state: 'exited', waitResult: 0 })).verified, true)
  const live = classifyExitObservation(expected, observation({ state: 'running', nativeError: 0, imagePath: '\\\\?\\c:\\temporary test\\ION-PTY.exe' }))
  assert.equal(live.status, 'owned-process-live')
  assert.equal(live.verified, false)
  const reused = classifyExitObservation(expected, observation({ state: 'running', nativeError: 0, imagePath: 'C:\\Windows\\System32\\svchost.exe' }))
  assert.equal(reused.status, 'pid-reused')
  assert.equal(reused.verified, true)
  assert.equal(classifyExitObservation(expected, observation({})).verified, false)
  assert.equal(classifyExitObservation(expected, observation({ state: 'running', imagePath: null })).verified, false)
  assert.equal(classifyExitObservation(expected, observation({ state: 'running', nativeError: 0,
    imagePath: 'relative.exe' })).verified, false)
  assert.equal(classifyExitObservation(expected, observation({ state: 'exited', waitResult: 258 })).verified, false)
  assert.equal(classifyExitObservation(expected, observation({ state: 'missing', nativeError: 5 })).verified, false)
})

test('probe observes exact handles without terminate permission or signaling processes and emits no private image paths', () => {
  assert.match(nativeExitProbeSource, /OpenProcess\(QUERY_LIMITED_INFORMATION\|SYNCHRONIZE,false,id\)/)
  assert.match(nativeExitProbeSource, /WaitForSingleObject\(handle,0\)/)
  assert.match(nativeExitProbeSource, /GetProcessTimes\(handle/)
  assert.match(nativeExitProbeSource, /QueryFullProcessImageName\(handle/)
  assert.match(nativeExitProbeSource, /finally \{ CloseHandle\(handle\); \}/)
  assert.doesNotMatch(nativeExitProbeSource, /TerminateProcess|PROCESS_TERMINATE|TerminateJobObject/)
  const result = classifyExitObservation(expected, observation({ state: 'running', nativeError: 0, imagePath: 'C:\\Windows\\System32\\svchost.exe' }))
  assert.equal('imagePath' in result, false)
  assert.equal('executablePaths' in result, false)
  assert.match(result.imageSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.throws(() => classifyExitObservation(expected, observation({ pid: 43 })), /different PID/)
})

test('generated input contract directly converts the bounded JSON array instead of nesting a PowerShell pipeline object', () => {
  assert.match(nativeExitProbeInput, /\[uint32\[\]\]\$ids=ConvertFrom-Json -InputObject \$env:ION_TEST_EXIT_PIDS/)
  assert.doesNotMatch(nativeExitProbeInput, /\$ids\s*=\s*@\(/)
  assert.match(nativeExitProbeInput, /\$ids.Count -lt 1 -or \$ids.Count -gt 512/)
})

test('native Windows PowerShell5 deserializes scalar PID members before the first liveness API', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const execute = promisify(execFile)
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n`
    + nativeExitProbeInput
    + `$out=@(foreach($processId in $ids){if($processId -lt 1 -or $processId -gt 4294967295){throw 'Invalid PID.'};[uint32]$processId})\n`
    + `ConvertTo-Json -Compress -InputObject $out\n`
  const command = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  const run = (ids: number[]) => execute(shell, command, { windowsHide: true, timeout: 5000, maxBuffer: 65536,
    env: { ...process.env, ION_TEST_EXIT_PIDS: JSON.stringify(ids) } })
  for (const values of [[42], [1, 42, 4294967295], Array.from({ length: 512 }, (_, index) => index + 1)]) {
    const { stdout } = await run(values)
    assert.deepEqual(JSON.parse(stdout.trim().replace(/^\uFEFF/, '')), values)
  }
  for (const values of [[], [0], [-1], [4294967296], Array.from({ length: 513 }, (_, index) => index + 1)]) {
    await assert.rejects(run(values))
  }
})
