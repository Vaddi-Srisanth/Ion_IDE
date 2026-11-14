// Test infrastructure only. Never imported by the application.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

export interface NativeExitObservation {
  pid: number
  state: 'missing' | 'exited' | 'running' | 'unknown'
  operation: string
  nativeError: number
  waitResult?: number
  creationFileTime?: string | null
  creationUnixMs?: number | null
  imagePath?: string | null
}
export interface ExpectedExitTarget { pid: number; executablePaths: string[] }

const normalizedImage = (value: string) => win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase()
export function classifyExitObservation(expected: ExpectedExitTarget, observed: NativeExitObservation) {
  assert.equal(observed.pid, expected.pid, 'The native observation belongs to a different PID.')
  assert.ok(expected.executablePaths.length > 0 && expected.executablePaths.every(path => win32.isAbsolute(path)))
  const image = observed.imagePath
  const imageAvailable = typeof image === 'string' && image.length > 0 && image.length <= 4096 && win32.isAbsolute(image)
  const sameImage = imageAvailable
    ? expected.executablePaths.some(path => normalizedImage(path) === normalizedImage(image)) : null
  // A signaled process handle proves exit even if its image can no longer be
  // queried. EPERM/access denied never becomes proof of absence.
  const running = observed.state === 'running' && observed.waitResult === 258 && observed.nativeError === 0
    && typeof observed.creationFileTime === 'string' && /^[0-9]{1,20}$/.test(observed.creationFileTime)
    && Number.isSafeInteger(observed.creationUnixMs)
  const status = observed.state === 'missing' && observed.nativeError === 87 ? 'gone'
    : observed.state === 'exited' && observed.waitResult === 0 ? 'exited'
      : running && sameImage === false ? 'pid-reused'
        : running && sameImage === true ? 'owned-process-live' : 'unverified'
  return { pid: expected.pid, status, verified: ['gone', 'exited', 'pid-reused'].includes(status),
    operation: observed.operation, nativeError: observed.nativeError, waitResult: observed.waitResult ?? null,
    creationFileTime: observed.creationFileTime ?? null, creationUnixMs: observed.creationUnixMs ?? null,
    expectedImageCount: expected.executablePaths.length, sameImage,
    imageSha256: imageAvailable ? createHash('sha256').update(normalizedImage(image)).digest('hex') : null }
}

export const nativeExitProbeSource = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IonTestExitProbe {
  const uint QUERY_LIMITED_INFORMATION=0x1000, SYNCHRONIZE=0x100000;
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FILETIME created, out FILETIME exited, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder image, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public sealed class Observation {
    public uint pid; public string state="unknown",operation="open-process-limited";
    public int nativeError; public uint waitResult=0xffffffff;
    public string creationFileTime,imagePath; public long? creationUnixMs;
  }
  public static Observation Read(uint id) {
    var result=new Observation {pid=id};
    var handle=OpenProcess(QUERY_LIMITED_INFORMATION|SYNCHRONIZE,false,id);
    if(handle==IntPtr.Zero) {
      result.nativeError=Marshal.GetLastWin32Error();
      if(result.nativeError==87)result.state="missing";
      return result;
    }
    try {
      result.operation="wait-process-handle";
      result.waitResult=WaitForSingleObject(handle,0);
      if(result.waitResult!=0 && result.waitResult!=258) {
        result.nativeError=Marshal.GetLastWin32Error(); return result;
      }
      result.state=result.waitResult==0 ? "exited" : "running";
      FILETIME created,exited,kernel,user;
      result.operation="query-process-creation";
      if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) {
        result.nativeError=Marshal.GetLastWin32Error();
        if(result.state!="exited")result.state="unknown";
        return result;
      }
      long ticks=((long)created.High<<32)|created.Low;
      result.creationFileTime=ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
      result.creationUnixMs=(ticks-116444736000000000L)/10000;
      result.operation="query-process-image";
      uint length=32768; var image=new StringBuilder((int)length);
      if(!QueryFullProcessImageName(handle,0,image,ref length)) {
        result.nativeError=Marshal.GetLastWin32Error();
        if(result.state!="exited")result.state="unknown";
        return result;
      }
      if(length>4096) {
        result.nativeError=111;
        if(result.state!="exited")result.state="unknown";
        return result;
      }
      result.imagePath=image.ToString();
      result.operation="completed";
      return result;
    } finally { CloseHandle(handle); }
  }
}`

// Windows PowerShell5 returns a JSON array as one pipeline object. Wrapping
// that pipeline in @() nests it; direct typed assignment converts its members.
export const nativeExitProbeInput = `[uint32[]]$ids=ConvertFrom-Json -InputObject $env:ION_TEST_EXIT_PIDS\n`
  + `if($ids.Count -lt 1 -or $ids.Count -gt 512){throw 'Invalid bounded PID count.'}\n`

export async function probeWindowsExitTargets(targets: ExpectedExitTarget[]) {
  assert.equal(process.platform, 'win32', 'The native exit probe requires Windows.')
  assert.ok(targets.length > 0 && targets.length <= 512)
  assert.equal(new Set(targets.map(target => target.pid)).size, targets.length)
  assert.ok(targets.every(target => Number.isInteger(target.pid) && target.pid > 0 && target.pid <= 0xffffffff))
  const script = `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n`
    + `Add-Type -TypeDefinition @'\n${nativeExitProbeSource}\n'@\n`
    + nativeExitProbeInput
    + `$rows=@(foreach($processId in $ids){if($processId -lt 1 -or $processId -gt 4294967295){throw 'Invalid PID.'};[IonTestExitProbe]::Read([uint32]$processId)})\n`
    + `ConvertTo-Json -Compress -Depth 4 -InputObject $rows\n`
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 ** 2,
      env: { ...process.env, ION_TEST_EXIT_PIDS: JSON.stringify(targets.map(target => target.pid)) } })
  const rows: NativeExitObservation[] = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
  assert.ok(Array.isArray(rows) && rows.length === targets.length, 'Incomplete native cleanup observations.')
  return targets.map((target, index) => classifyExitObservation(target, rows[index]))
}
