import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyExitObservation, nativeExitProbeSource, type NativeExitObservation } from '../scripts/windows/test-process-exit-probe'

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
