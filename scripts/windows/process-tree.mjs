import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const script = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [int]$env:ION_TEST_ROOT_PID
$profile = $env:ION_TEST_PROFILE
$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name)
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($root)
foreach ($item in $all) {
  if ($profile -and $item.CommandLine -and
      $item.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $item.Name -match '^(electron|ion ide|crashpad_handler)\\.exe$') {
    [void]$owned.Add([int]$item.ProcessId)
  }
}
do {
  $count = $owned.Count
  foreach ($item in $all) {
    if ($owned.Contains([int]$item.ParentProcessId)) { [void]$owned.Add([int]$item.ProcessId) }
  }
} while ($owned.Count -gt $count)
$rows = @(
  foreach ($item in $all) {
    if (!$owned.Contains([int]$item.ProcessId)) { continue }
    try {
      $proc = Get-Process -Id $item.ProcessId -ErrorAction Stop
      $kind = 'child'
      if ($item.ProcessId -eq $root) { $kind = 'main' }
      elseif ($item.CommandLine -match '--type=([^ "]+)') { $kind = $Matches[1] }
      elseif ($item.Name -match 'crashpad') { $kind = 'crashpad' }
      [pscustomobject]@{
        pid = [int]$item.ProcessId
        parent = [int]$item.ParentProcessId
        name = $item.Name
        kind = $kind
        workingSet = $proc.WorkingSet64
        privateBytes = $proc.PrivateMemorySize64
        cpuSeconds = $proc.TotalProcessorTime.TotalSeconds
      }
    } catch {
      if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
  }
)
ConvertTo-Json -Compress -InputObject $rows
`, 'utf16le').toString('base64')

export async function windowsProcessTree(session) {
  if (process.platform !== 'win32') throw new Error('Use native Windows for the process-tree probe.')
  const began = performance.now()
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    windowsHide: true, timeout: 20_000, maxBuffer: 1_000_000,
    env: { ...process.env, ION_TEST_ROOT_PID: String(session.pid), ION_TEST_PROFILE: session.profile },
  })
  const members = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
  return {
    timeMs: (began + performance.now()) / 2,
    workingSetMiB: members.reduce((sum, item) => sum + item.workingSet, 0) / 1024 ** 2,
    privateMiB: members.reduce((sum, item) => sum + item.privateBytes, 0) / 1024 ** 2,
    members,
  }
}

export function windowsTreeCPU(first, last) {
  const prior = new Map(first.members.map(({ pid, cpuSeconds }) => [pid, cpuSeconds]))
  const cpu = last.members.reduce((sum, item) => sum + Math.max(0, item.cpuSeconds - (prior.get(item.pid) ?? item.cpuSeconds)), 0)
  return cpu * 100_000 / (last.timeMs - first.timeMs)
}
